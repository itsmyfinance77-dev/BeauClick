import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BookingService } from '@beauclick/booking';
import {
  BookingCreditAccountingService,
  BookingCreditEnforcementControlService,
  EnforcementControlMalformedError,
  SellerSubscriptionService,
  SubscriberPartyType,
} from '@beauclick/commercial-policy';
import { SandboxPaymentProvider } from '@beauclick/payment';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage, SubjectDataCoverageService } from '@beauclick/subject-data';

import { CheckoutService, ZeroCollectibleConfirmationRefusedException } from '../src/checkout/checkout.service';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/**
 * REAL PostgreSQL: V3.3 Story #95 (`#58b-1`) -- the booking-credit
 * enforcement control foundation, ADR-050.
 *
 * Every claim here is about a CHECK, a trigger, a row lock, an advisory lock,
 * a `REPEATABLE READ` snapshot or a rollback; pg-mem honours none of them.
 * Section numbers follow ADR-050 §10's matrix so a probe can be traced to the
 * test it must kill.
 */
describePg('booking-credit enforcement control foundation (#95 / #58b-1, real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let checkout: CheckoutService;
  let bookings: BookingService;
  let credits: BookingCreditAccountingService;
  let subscriptions: SellerSubscriptionService;
  let sandbox: SandboxPaymentProvider;
  let enforcement: BookingCreditEnforcementControlService;

  let sequence = 0;
  const nextPhone = (): string => `+98916${String(1000000 + (sequence += 1)).slice(-7)}`;
  const CALLBACK_BASE = 'http://localhost:3099/api/v1/payments/callback';

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    checkout = app.get(CheckoutService);
    bookings = app.get(BookingService);
    credits = app.get(BookingCreditAccountingService);
    subscriptions = app.get(SellerSubscriptionService);
    sandbox = app.get(SandboxPaymentProvider);
    enforcement = app.get(BookingCreditEnforcementControlService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const CONTROL = 'commercial.booking_credit_enforcement_control';
  const GOVERNANCE = 'commercial.booking_credit_party_governance';

  const controlRow = async () => (await dataSource.query(`SELECT * FROM ${CONTROL} WHERE id = 1`))[0];

  /** Run SQL that must be refused, and return the SQLSTATE it was refused with. */
  async function refused(sql: string, params: unknown[] = []): Promise<string> {
    try {
      await dataSource.query(sql, params);
    } catch (err) {
      return (err as { code?: string }).code ?? 'unknown';
    }
    throw new Error(`expected a refusal for: ${sql}`);
  }

  async function plantedGovernance(state: 'legacy_exempt' | 'governed', overrides: Record<string, unknown> = {}): Promise<string> {
    const id = uuidv7();
    const row = {
      party_type: 'professional',
      party_id: uuidv7(),
      state,
      cause: state === 'governed' ? 'created_under_enforcement' : 'explicit_exemption',
      proof_grant_id: null,
      governed_at: state === 'governed' ? new Date() : null,
      recorded_by_user_id: null,
      recorded_by_label: 'suite',
      audit_id: uuidv7(),
      ...overrides,
    };
    await dataSource.query(
      `INSERT INTO ${GOVERNANCE}
         (id, party_type, party_id, state, cause, proof_grant_id, governed_at, recorded_by_user_id, recorded_by_label, audit_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, row.party_type, row.party_id, row.state, row.cause, row.proof_grant_id, row.governed_at, row.recorded_by_user_id, row.recorded_by_label, row.audit_id],
    );
    return id;
  }

  // =========================================================================
  // §A  Schema: the migration produced exactly the ratified shape (case 26)
  // =========================================================================

  describe('§A schema and constraints (ADR-050 §2, case 26)', () => {
    it('seeded exactly one control row in its initial safe state', async () => {
      const rows = await dataSource.query(`SELECT * FROM ${CONTROL}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 1,
        rollout_state: 'inactive',
        activation_generation: 0,
        activated_at: null,
        activation_audit_id: null,
        kill_switch_state: 'released',
        kill_switch_changed_at: null,
        kill_switch_audit_id: null,
      });
    });

    it('ck_bcec_singleton refuses a second row, whatever its id', async () => {
      expect(await refused(`INSERT INTO ${CONTROL} (id, rollout_state, activation_generation, kill_switch_state) VALUES (2, 'inactive', 0, 'released')`)).toBe('23514');
      expect(await refused(`INSERT INTO ${CONTROL} (id, rollout_state, activation_generation, kill_switch_state) VALUES (1, 'inactive', 0, 'released')`)).toBe('23505');
    });

    it('the control row refuses every value outside its vocabularies', async () => {
      expect(await refused(`UPDATE ${CONTROL} SET rollout_state = 'paused' WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET kill_switch_state = 'armed' WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET activation_generation = -1 WHERE id = 1`)).toMatch(/23514|23001/);
    });

    it('ck_bcec_activation_consistent binds the activation facts together', async () => {
      // An active rollout with no instant, no audit pointer or generation zero.
      expect(await refused(`UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 1 WHERE id = 1`)).toBe('23514');
      // An inactive rollout carrying activation facts.
      expect(await refused(`UPDATE ${CONTROL} SET activated_at = now() WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET activation_audit_id = $1 WHERE id = 1`, [uuidv7()])).toBe('23514');
    });

    it('ck_bcec_kill_switch_consistent binds the kill-switch facts together', async () => {
      expect(await refused(`UPDATE ${CONTROL} SET kill_switch_state = 'engaged' WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET kill_switch_changed_at = now() WHERE id = 1`)).toBe('23514');
      expect(await refused(`UPDATE ${CONTROL} SET kill_switch_audit_id = $1 WHERE id = 1`, [uuidv7()])).toBe('23514');
      // Control: the consistent shape is accepted, in both directions.
      await dataSource.query(`UPDATE ${CONTROL} SET kill_switch_state = 'engaged', kill_switch_changed_at = now(), kill_switch_audit_id = $1 WHERE id = 1`, [uuidv7()]);
      expect((await controlRow()).kill_switch_state).toBe('engaged');
      await dataSource.query(`UPDATE ${CONTROL} SET kill_switch_state = 'released', kill_switch_changed_at = now(), kill_switch_audit_id = $1 WHERE id = 1`, [uuidv7()]);
      expect((await controlRow()).kill_switch_state).toBe('released');
    });

    it('uq_bcpg_party refuses a second row for one party', async () => {
      const partyId = uuidv7();
      await plantedGovernance('legacy_exempt', { party_id: partyId });
      expect(await refused(
        `INSERT INTO ${GOVERNANCE} (id, party_type, party_id, state, cause, recorded_by_label, audit_id)
         VALUES ($1, 'professional', $2, 'legacy_exempt', 'explicit_exemption', 'suite', $3)`,
        [uuidv7(), partyId, uuidv7()],
      )).toBe('23505');
      // Non-vacuity: the same party id under the OTHER party type is a different party.
      await plantedGovernance('legacy_exempt', { party_type: 'business', party_id: partyId });
    });

    it('ck_bcpg_cause_state, ck_bcpg_proof, ck_bcpg_governed_at and ck_bcpg_actor refuse every illegal combination', async () => {
      const base = (over: Record<string, unknown>) => plantedGovernance('governed', over);
      // exemption cause on a governed row / transition cause on an exempt row
      await expect(base({ cause: 'explicit_exemption' })).rejects.toMatchObject({ code: '23514' });
      await expect(plantedGovernance('legacy_exempt', { cause: 'explicit_transition', proof_grant_id: uuidv7() })).rejects.toMatchObject({ code: '23514' });
      // explicit_transition without proof; any other cause with proof
      await expect(base({ cause: 'explicit_transition', proof_grant_id: null })).rejects.toMatchObject({ code: '23514' });
      await expect(base({ cause: 'created_under_enforcement', proof_grant_id: uuidv7() })).rejects.toMatchObject({ code: '23514' });
      // governed without governed_at; exempt with governed_at
      await expect(base({ governed_at: null })).rejects.toMatchObject({ code: '23514' });
      await expect(plantedGovernance('legacy_exempt', { governed_at: new Date() })).rejects.toMatchObject({ code: '23514' });
      // actor XOR
      await expect(base({ recorded_by_user_id: uuidv7(), recorded_by_label: 'suite' })).rejects.toMatchObject({ code: '23514' });
      await expect(base({ recorded_by_user_id: null, recorded_by_label: null })).rejects.toMatchObject({ code: '23514' });
      // vocabularies
      await expect(base({ state: 'suspended', governed_at: null })).rejects.toMatchObject({ code: '23514' });
      await expect(base({ party_type: 'staff' })).rejects.toMatchObject({ code: '23514' });
      // proof must be a REAL grant
      await expect(base({ cause: 'explicit_transition', proof_grant_id: uuidv7() })).rejects.toMatchObject({ code: '23503' });
      // Control: a legal governed row and a legal exempt row are accepted.
      await base({});
      await plantedGovernance('legacy_exempt');
    });

    it('carries no commercial number: no column named for an allowance, price, quantity or bound', async () => {
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'commercial' AND table_name IN ('booking_credit_enforcement_control', 'booking_credit_party_governance')`,
        )
      ).map((r: { column_name: string }) => r.column_name);
      expect(columns.length).toBe(21);
      for (const column of columns) expect(column).not.toMatch(/credit|allowance|quota|price|quantity|min|max|grace|expir/i);
    });
  });

  // =========================================================================
  // §B  Triggers: one-way rollout, monotonic governance, no DELETE (case 25)
  // =========================================================================

  describe('§B triggers (ADR-050 §2, case 25)', () => {
    it('the control row cannot be deleted', async () => {
      expect(await refused(`DELETE FROM ${CONTROL} WHERE id = 1`)).toBe('23001');
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM ${CONTROL}`)).toEqual([{ n: 1 }]);
    });

    it('the rollout cannot go active -> inactive, and activation facts are immutable once active', async () => {
      // The trigger admits the #141 transition shape so that story needs no
      // schema change; everything after it is refused. Proven inside one
      // rolled-back transaction, so no suite ever leaves the row active.
      await expect(
        dataSource.transaction(async (m) => {
          await m.query(
            `UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 1, activated_at = now(), activation_audit_id = $1 WHERE id = 1`,
            [uuidv7()],
          );
          expect((await m.query(`SELECT rollout_state FROM ${CONTROL}`))[0].rollout_state).toBe('active');

          for (const sql of [
            `UPDATE ${CONTROL} SET rollout_state = 'inactive', activation_generation = 0, activated_at = NULL, activation_audit_id = NULL WHERE id = 1`,
            `UPDATE ${CONTROL} SET activation_generation = 2 WHERE id = 1`,
            `UPDATE ${CONTROL} SET activated_at = now() - interval '1 day' WHERE id = 1`,
            `UPDATE ${CONTROL} SET activation_audit_id = '${uuidv7()}' WHERE id = 1`,
          ]) {
            await m.query('SAVEPOINT probe');
            try {
              await m.query(sql);
              throw new Error(`accepted: ${sql}`);
            } catch (err) {
              expect((err as { code?: string }).code).toBe('23001');
            } finally {
              await m.query('ROLLBACK TO SAVEPOINT probe');
            }
          }
          // The kill switch still moves while active.
          await m.query(`UPDATE ${CONTROL} SET kill_switch_state = 'engaged', kill_switch_changed_at = now(), kill_switch_audit_id = $1 WHERE id = 1`, [uuidv7()]);
          throw new Error('planted rollback');
        }),
      ).rejects.toThrow('planted rollback');
      expect((await controlRow()).rollout_state).toBe('inactive');
    });

    it('activation must increment the generation by exactly one, and the generation cannot move while inactive', async () => {
      expect(await refused(`UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 2, activated_at = now(), activation_audit_id = $1 WHERE id = 1`, [uuidv7()])).toBe('23001');
      expect(await refused(`UPDATE ${CONTROL} SET activation_generation = 1 WHERE id = 1`)).toBe('23001');
      expect(await refused(`UPDATE ${CONTROL} SET id = 1, created_at = now() - interval '1 day' WHERE id = 1`)).toBe('23001');
    });

    it('governance rows cannot be deleted', async () => {
      const id = await plantedGovernance('legacy_exempt');
      expect(await refused(`DELETE FROM ${GOVERNANCE} WHERE id = $1`, [id])).toBe('23001');
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM ${GOVERNANCE}`)).toEqual([{ n: 1 }]);
    });

    it('governed -> legacy_exempt is refused, as is every rewrite of a governed row', async () => {
      const id = await plantedGovernance('governed');
      expect(await refused(`UPDATE ${GOVERNANCE} SET state = 'legacy_exempt', cause = 'explicit_exemption', governed_at = NULL WHERE id = $1`, [id])).toBe('23001');
      expect(await refused(`UPDATE ${GOVERNANCE} SET governed_at = now() WHERE id = $1`, [id])).toBe('23001');
      expect(await refused(`UPDATE ${GOVERNANCE} SET recorded_by_label = 'someone' WHERE id = $1`, [id])).toBe('23001');
      expect(await refused(`UPDATE ${GOVERNANCE} SET party_id = $2 WHERE id = $1`, [id, uuidv7()])).toBe('23001');
    });

    it('legacy_exempt -> governed by explicit transition is the ONE permitted update, and only in its full shape', async () => {
      const id = await plantedGovernance('legacy_exempt');
      // A real grant to point the proof at.
      const grantId = await plantGrant();

      for (const sql of [
        `UPDATE ${GOVERNANCE} SET state = 'governed' WHERE id = $1`,
        `UPDATE ${GOVERNANCE} SET state = 'governed', cause = 'created_under_enforcement', governed_at = now() WHERE id = $1`,
        `UPDATE ${GOVERNANCE} SET state = 'governed', cause = 'explicit_transition', governed_at = now() WHERE id = $1`,
        `UPDATE ${GOVERNANCE} SET recorded_by_label = 'other' WHERE id = $1`,
        `UPDATE ${GOVERNANCE} SET recorded_at = now() - interval '1 day' WHERE id = $1`,
      ]) {
        expect(await refused(sql, [id])).toMatch(/23001|23514/);
      }

      await dataSource.query(
        `UPDATE ${GOVERNANCE}
            SET state = 'governed', cause = 'explicit_transition', governed_at = now(), proof_grant_id = $2, audit_id = $3
          WHERE id = $1`,
        [id, grantId, uuidv7()],
      );
      const [row] = await dataSource.query(`SELECT state, cause, proof_grant_id FROM ${GOVERNANCE} WHERE id = $1`, [id]);
      expect(row).toEqual({ state: 'governed', cause: 'explicit_transition', proof_grant_id: grantId });
    });
  });

  async function plantGrant(): Promise<string> {
    // A minimal, real grant row: `proof_grant_id` is a genuine FK, so the
    // trigger test above needs a genuine grant. Built through the catalogue
    // and subscription tables exactly as the #58a suite plants its grants.
    const scheduleVersionId = uuidv7();
    await dataSource.query(`INSERT INTO commercial.price_schedules (schedule_key, purpose, created_by_label) VALUES ('enf-base', 'seller_plan', 'suite') ON CONFLICT DO NOTHING`);
    await dataSource.query(
      `INSERT INTO commercial.price_schedule_versions (id, schedule_key, version, display_name, currency_code, min_purchase_quantity, max_purchase_quantity, ui_preset_quantities, activation_starts_at, created_by_label)
       VALUES ($1, 'enf-base', 1, 'enf base', 'IRT', 1, 1, '{}', '1970-01-01T00:00:00Z', 'suite')`,
      [scheduleVersionId],
    );
    await dataSource.query(`INSERT INTO commercial.price_tiers (id, schedule_version_id, min_quantity, max_quantity, unit_price_toman, created_by_label) VALUES ($1, $2, 1, 1, 0, 'suite')`, [uuidv7(), scheduleVersionId]);
    await dataSource.query(`UPDATE commercial.price_schedule_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1`, [scheduleVersionId]);
    const planVersionId = uuidv7();
    await dataSource.query(`INSERT INTO commercial.plans (plan_key, created_by_label) VALUES ('ENF-BASE', 'suite') ON CONFLICT DO NOTHING`);
    await dataSource.query(
      `INSERT INTO commercial.plan_versions (id, plan_key, version, display_name, billing_term_days, included_booking_credits, staff_seats, included_locations, capability_keys, price_schedule_version_id, auto_assignable, activation_starts_at, created_by_label)
       VALUES ($1, 'ENF-BASE', 1, 'enf base', NULL, 0, 0, 0, '{}', $2, true, '1970-01-01T00:00:00Z', 'suite')`,
      [planVersionId, scheduleVersionId],
    );
    await dataSource.query(`UPDATE commercial.plan_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1`, [planVersionId]);
    const subscriptionId = uuidv7();
    const partyId = uuidv7();
    await dataSource.query(
      `INSERT INTO commercial.seller_subscriptions
         (id, subscriber_party_type, subscriber_party_id, plan_version_id, lifecycle_state, snapshot_plan_key, snapshot_version, snapshot_billing_term_days,
          snapshot_included_booking_credits, snapshot_staff_seats, snapshot_included_locations, snapshot_capability_keys, snapshot_currency_code,
          snapshot_unit_price_toman, snapshot_price_schedule_version_id, effective_at, created_by_label)
       VALUES ($1, 'professional', $2, $3, 'active', 'ENF-BASE', 1, NULL, 0, 0, 0, '{}', 'IRT', 0, $4, now(), 'suite')`,
      [subscriptionId, partyId, planVersionId, scheduleVersionId],
    );
    const grantId = uuidv7();
    await dataSource.query(
      `INSERT INTO commercial.booking_credit_grants (id, subscription_id, plan_version_id, subscriber_party_type, subscriber_party_id, source, quantity, period_index)
       VALUES ($1, $2, $3, 'professional', $4, 'plan_included', 1, 0)`,
      [grantId, subscriptionId, planVersionId, partyId],
    );
    return grantId;
  }

  // =========================================================================
  // §C  ADR-027 dispositions, pinned (case 27)
  // =========================================================================

  describe('§C ADR-027 dispositions (ADR-050 §8, case 27)', () => {
    let contracts: SubjectDataContract[];
    let coverage: SubjectDataCoverageService;

    beforeAll(() => {
      contracts = app.get(SUBJECT_DATA_CONTRACTS);
      coverage = app.get(SubjectDataCoverageService);
    });

    it('claims the control row no_subject_data and the governance table retained, each exactly once with a reason', () => {
      const claims = contracts.flatMap((c) => c.tables.filter((t) => t.table.startsWith('commercial.booking_credit_enforcement') || t.table === GOVERNANCE));
      expect(claims.map((c) => `${c.table}:${c.disposition}`).sort()).toEqual([
        'commercial.booking_credit_enforcement_control:no_subject_data',
        'commercial.booking_credit_party_governance:retained',
      ]);
      for (const claim of claims) expect((claim.reason ?? '').length).toBeGreaterThan(40);
    });

    it('the live catalogue is fully claimed, both new tables included', async () => {
      const catalogue = await coverage.readCatalogue();
      const names = catalogue.map((t) => `${t.schema}.${t.name}`);
      expect(names).toContain(CONTROL);
      expect(names).toContain(GOVERNANCE);
      expect(evaluateCoverage(catalogue, contracts).violations).toEqual([]);
    });

    it('a dishonest no_subject_data claim on the governance table is DETECTED (wrongly_declared_empty)', async () => {
      const catalogue = await coverage.readCatalogue();
      const dishonest = contracts.map((c) => ({
        ...c,
        tables: c.tables.map((t) => (t.table === GOVERNANCE ? { ...t, disposition: 'no_subject_data' as const, reason: 'dishonest' } : t)),
      })) as SubjectDataContract[];
      const violations = evaluateCoverage(catalogue, dishonest).violations;
      expect(violations.map((v) => `${v.kind}:${v.table}`)).toContain(`wrongly_declared_empty:${GOVERNANCE}`);
    });

    it('the heuristic CANNOT detect a dishonest claim on the control row -- which is why the pin above exists', async () => {
      // Non-vacuity of the explicit pin: if the detector could see it, the pin
      // would be redundant. It cannot, because the row has no `_by` or
      // `_user_id` column -- and that is the honest reason it is no_subject_data.
      const catalogue = await coverage.readCatalogue();
      const control = catalogue.find((t) => `${t.schema}.${t.name}` === CONTROL)!;
      expect(control.columns.some((c) => c.endsWith('_by') || c.endsWith('_user_id'))).toBe(false);
    });
  });
  // =========================================================================
  // Fixtures shared by the behavioural sections: the #58a suite's own shapes
  // =========================================================================

  interface Seller {
    ownerId: string;
    professionalId: string;
    serviceId: string;
    partyType: SubscriberPartyType;
    partyId: string;
  }

  /** A professional seller party, before any booking exists for it. */
  async function newSeller(priceToman = 0): Promise<Seller> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, priceToman === 0 ? 'متخصص کنترل' : 'متخصص پرداختی', priceToman);
    return { ownerId: owner.id, professionalId: professional.id, serviceId: professional.serviceId, partyType: 'professional', partyId: professional.id };
  }

  interface Attempt {
    customer: SeededUser;
    bookingId: string;
    orderId: string;
  }

  /**
   * A zero-priced booking through the real checkout: #81's path, which
   * CONFIRMS inside `checkout()` itself. The party's state (grant, governance,
   * kill switch) must therefore be arranged BEFORE this call.
   */
  async function bookZeroCollectible(seller: Seller): Promise<Attempt> {
    sequence += 1;
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const slotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(48 + sequence));
    const result = await checkout.checkout({ customerId: customer.id, professionalId: seller.professionalId, slotId, serviceId: seller.serviceId, callbackBaseUrl: CALLBACK_BASE });
    return { customer, bookingId: result.bookingId, orderId: result.order.order.id };
  }

  /** The same, but returning the refusal instead of throwing it. */
  async function tryBookZeroCollectible(seller: Seller): Promise<{ attempt?: Attempt; refusal?: ZeroCollectibleConfirmationRefusedException }> {
    try {
      return { attempt: await bookZeroCollectible(seller) };
    } catch (err) {
      if (err instanceof ZeroCollectibleConfirmationRefusedException) return { refusal: err };
      throw err;
    }
  }

  interface PaidAttempt extends Attempt {
    reference: string;
    priceToman: number;
  }

  /** A positively priced booking left waiting on the gateway: #82's confirmation path. */
  async function bookPaid(seller: Seller, priceToman: number): Promise<PaidAttempt> {
    sequence += 1;
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const slotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(300 + sequence));
    const result = await checkout.checkout({ customerId: customer.id, professionalId: seller.professionalId, slotId, serviceId: seller.serviceId, callbackBaseUrl: CALLBACK_BASE });
    const [attempt] = await dataSource.query('SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1', [result.paymentIntentId]);
    return { customer, bookingId: result.bookingId, orderId: result.order.order.id, reference: attempt.provider_reference, priceToman };
  }

  const captureOf = async (booked: PaidAttempt) => {
    await sandbox.decide(booked.reference, 'success');
    return checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
  };

  const bookingRow = async (bookingId: string) => (await dataSource.query('SELECT * FROM booking.bookings WHERE id = $1', [bookingId]))[0];
  const consumptionsOf = async (bookingId: string) => dataSource.query('SELECT * FROM commercial.booking_credit_consumptions WHERE booking_id = $1', [bookingId]);
  const refundsFor = async (orderId: string) => dataSource.query('SELECT amount_toman, request_key FROM payment.refunds WHERE order_id = $1', [orderId]);

  async function ensureBasePlan(): Promise<void> {
    const [existing] = await dataSource.query("SELECT id FROM commercial.plan_versions WHERE auto_assignable = true AND lifecycle_state = 'published' LIMIT 1");
    if (existing) return;
    const scheduleVersionId = uuidv7();
    await dataSource.query("INSERT INTO commercial.price_schedules (schedule_key, purpose, created_by_label) VALUES ('enf-suite', 'seller_plan', 'suite') ON CONFLICT DO NOTHING");
    await dataSource.query(
      `INSERT INTO commercial.price_schedule_versions (id, schedule_key, version, display_name, currency_code, min_purchase_quantity, max_purchase_quantity, ui_preset_quantities, activation_starts_at, created_by_label)
       VALUES ($1, 'enf-suite', 1, 'enf suite', 'IRT', 1, 1, '{}', '1970-01-01T00:00:00Z', 'suite')`,
      [scheduleVersionId],
    );
    await dataSource.query(`INSERT INTO commercial.price_tiers (id, schedule_version_id, min_quantity, max_quantity, unit_price_toman, created_by_label) VALUES ($1, $2, 1, 1, 0, 'suite')`, [uuidv7(), scheduleVersionId]);
    await dataSource.query("UPDATE commercial.price_schedule_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1", [scheduleVersionId]);
    const planVersionId = uuidv7();
    await dataSource.query("INSERT INTO commercial.plans (plan_key, created_by_label) VALUES ('ENF-SUITE', 'suite') ON CONFLICT DO NOTHING");
    await dataSource.query(
      `INSERT INTO commercial.plan_versions (id, plan_key, version, display_name, billing_term_days, included_booking_credits, staff_seats, included_locations, capability_keys, price_schedule_version_id, auto_assignable, activation_starts_at, created_by_label)
       VALUES ($1, 'ENF-SUITE', 1, 'enf suite', NULL, 0, 0, 0, '{}', $2, true, '1970-01-01T00:00:00Z', 'suite')`,
      [planVersionId, scheduleVersionId],
    );
    await dataSource.query("UPDATE commercial.plan_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1", [planVersionId]);
  }

  /** A positive grant, planted exactly as the #58a suite plants one. */
  async function grantCredits(party: { partyType: SubscriberPartyType; partyId: string }, quantity: number): Promise<string> {
    await ensureBasePlan();
    await subscriptions.ensureBaseSubscription(party);
    const [sub] = await dataSource.query(`SELECT id, plan_version_id FROM commercial.seller_subscriptions WHERE subscriber_party_type = $1 AND subscriber_party_id = $2 LIMIT 1`, [party.partyType, party.partyId]);
    const [{ next_period }] = await dataSource.query(`SELECT coalesce(max(period_index), 0) + 1 AS next_period FROM commercial.booking_credit_grants WHERE subscription_id = $1`, [sub.id]);
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO commercial.booking_credit_grants (id, subscription_id, plan_version_id, subscriber_party_type, subscriber_party_id, source, quantity, period_index)
       VALUES ($1, $2, $3, $4, $5, 'plan_included', $6, $7)`,
      [id, sub.id, sub.plan_version_id, party.partyType, party.partyId, quantity, Number(next_period)],
    );
    return id;
  }

  async function exhaust(party: { partyType: SubscriberPartyType; partyId: string }): Promise<void> {
    let balance = await credits.balanceFor(dataSource.manager, party);
    while (balance > 0) {
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, uuidv7(), party));
      balance -= 1;
    }
  }

  /** Records a governance fact for a party by direct SQL -- the administrator command is §E's subject, not this section's. */
  async function governAs(party: { partyType: SubscriberPartyType; partyId: string }, state: 'legacy_exempt' | 'governed'): Promise<void> {
    await plantedGovernance(state, { party_type: party.partyType, party_id: party.partyId });
  }

  /** Engages or releases the kill switch by direct SQL, in the exact shape the service will write. */
  async function setKillSwitch(state: 'engaged' | 'released'): Promise<void> {
    await dataSource.query(`UPDATE ${CONTROL} SET kill_switch_state = $1, kill_switch_changed_at = now(), kill_switch_audit_id = $2, updated_at = now() WHERE id = 1`, [state, uuidv7()]);
  }

  /** Every row of every table the kill switch must never rewrite, as one comparable snapshot. */
  async function ledgerSnapshot(
    tables: string[] = [
      'commercial.booking_credit_grants',
      'commercial.booking_credit_consumptions',
      'commercial.booking_credit_returns',
      'commercial.seller_subscriptions',
      'booking.bookings',
      'commerce.orders',
    ],
  ): Promise<string> {
    const parts: string[] = [];
    for (const table of tables) parts.push(table, JSON.stringify(await dataSource.query(`SELECT * FROM ${table} ORDER BY id`)));
    return parts.join('\n');
  }

  const GOVERNANCES = [['unresolved'], ['legacy_exempt'], ['governed']] as const;

  // =========================================================================
  // §D  The seam and the kill switch (ADR-050 §4, §6; cases 10, 14-16, 21, 23)
  // =========================================================================

  describe('§D the four-plane seam under an INACTIVE rollout (ADR-050 §4.3, case 10)', () => {
    it.each(GOVERNANCES)(
      'a %s party confirms, consumes and is refused EXACTLY as #58a does: dormant proceeds, positive consumes, exhausted refuses',
      async (governance) => {
        // Dormant: never held a positive grant -> confirmed, nothing consumed.
        const dormant = await newSeller();
        if (governance !== 'unresolved') await governAs(dormant, governance);
        const a = await bookZeroCollectible(dormant);
        expect((await bookingRow(a.bookingId)).status).toBe('confirmed');
        expect(await consumptionsOf(a.bookingId)).toHaveLength(0);

        // Positive grant -> confirmed, exactly one consumption.
        const funded = await newSeller();
        if (governance !== 'unresolved') await governAs(funded, governance);
        await grantCredits(funded, 1);
        const b = await bookZeroCollectible(funded);
        expect((await bookingRow(b.bookingId)).status).toBe('confirmed');
        expect(await consumptionsOf(b.bookingId)).toHaveLength(1);

        // Exhausted -> refused with the existing generic body, nothing consumed, nothing collected.
        const spent = await newSeller();
        if (governance !== 'unresolved') await governAs(spent, governance);
        await grantCredits(spent, 1);
        await exhaust(spent);
        const { refusal } = await tryBookZeroCollectible(spent);
        expect(refusal?.reason).toBe('insufficient_credit');
        expect(await dataSource.query('SELECT count(*)::int AS n FROM booking.bookings WHERE professional_id = $1 AND status = $2', [spent.professionalId, 'confirmed'])).toEqual([{ n: 0 }]);
      },
    );

    it('the pre-ledger decision is legacy while inactive and released, whatever governance says', async () => {
      await dataSource.transaction(async (m) => {
        const control = await enforcement.readForConfirmation(m);
        expect(enforcement.decideBeforeLedger(control)).toEqual({ kind: 'legacy' });
      });
    });
  });

  describe('§D the kill switch (ADR-050 §6; cases 14, 15, 16, 21)', () => {
    it.each(GOVERNANCES)(
      'engaged, it refuses a %s party on the ZERO-COLLECTIBLE path before anything is consumed, even with credit available',
      async (governance) => {
        const seller = await newSeller();
        if (governance !== 'unresolved') await governAs(seller, governance);
        await grantCredits(seller, 1);
        await setKillSwitch('engaged');
        const before = await ledgerSnapshot(['commercial.booking_credit_grants', 'commercial.booking_credit_consumptions', 'commercial.booking_credit_returns', 'commercial.seller_subscriptions']);

        const { refusal, attempt } = await tryBookZeroCollectible(seller);
        expect(attempt).toBeUndefined();
        expect(refusal?.reason).toBe('control_refused');

        // Refused BEFORE the ledger: balance untouched, no consumption, no confirmed booking, nothing collected, no refund.
        expect(await credits.balanceFor(dataSource.manager, seller)).toBe(1);
        expect(await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_consumptions')).toEqual([{ n: 0 }]);
        expect(await dataSource.query('SELECT count(*)::int AS n FROM booking.bookings WHERE status = $1', ['confirmed'])).toEqual([{ n: 0 }]);
        expect(await dataSource.query('SELECT count(*)::int AS n FROM payment.refunds')).toEqual([{ n: 0 }]);
        // The LEDGER is byte-identical: the attempt's own pending booking and
        // pending order legitimately exist (created before the confirmation
        // transaction, exactly as #58a's refusal leaves them), and the
        // confirmation that would have consumed rolled back.
        expect(await ledgerSnapshot(['commercial.booking_credit_grants', 'commercial.booking_credit_consumptions', 'commercial.booking_credit_returns', 'commercial.seller_subscriptions'])).toBe(before);
        const [pending] = await dataSource.query('SELECT status FROM booking.bookings WHERE professional_id = $1', [seller.professionalId]);
        expect(pending.status).toBe('pending');
        const [order] = await dataSource.query('SELECT status, collected_total_toman FROM commerce.orders WHERE seller_party_id = $1', [seller.partyId]);
        expect(order).toEqual({ status: 'pending', collected_total_toman: '0' });
      },
    );

    it.each(GOVERNANCES)(
      'engaged, it refuses a %s party on the VERIFIED-CAPTURE path: the capture stands, nothing is consumed, the collected amount is refunded once',
      async (governance) => {
        const seller = await newSeller(250_000);
        if (governance !== 'unresolved') await governAs(seller, governance);
        await grantCredits(seller, 1);
        const booked = await bookPaid(seller, 250_000);
        await setKillSwitch('engaged');

        const result = await captureOf(booked);

        const [order] = await dataSource.query('SELECT collected_total_toman FROM commerce.orders WHERE id = $1', [booked.orderId]);
        expect(Number(order.collected_total_toman)).toBe(booked.priceToman);
        expect((await bookingRow(booked.bookingId)).status).toBe('pending');
        expect(await consumptionsOf(booked.bookingId)).toHaveLength(0);
        expect(await credits.balanceFor(dataSource.manager, seller)).toBe(1);
        const refunds = await refundsFor(booked.orderId);
        expect(refunds).toHaveLength(1);
        expect(Number(refunds[0].amount_toman)).toBe(booked.priceToman);
        expect(result.refundIssued).toBe(true);

        // A gateway retry refunds nothing further -- #82's idempotency, unchanged.
        await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
        expect(await refundsFor(booked.orderId)).toHaveLength(1);
      },
    );

    it('released again, the same party confirms exactly as before -- no fallback and no residue', async () => {
      const seller = await newSeller();
      await grantCredits(seller, 1);
      await setKillSwitch('engaged');
      expect((await tryBookZeroCollectible(seller)).refusal?.reason).toBe('control_refused');
      await setKillSwitch('released');
      const a = await bookZeroCollectible(seller);
      expect((await bookingRow(a.bookingId)).status).toBe('confirmed');
      expect(await consumptionsOf(a.bookingId)).toHaveLength(1);
    });

    it('engaging rewrites nothing: every grant, consumption, return, subscription, booking and order row is byte-identical (case 15)', async () => {
      const seller = await newSeller();
      await grantCredits(seller, 2);
      const a = await bookZeroCollectible(seller);
      const before = await ledgerSnapshot();

      await setKillSwitch('engaged');
      expect(await ledgerSnapshot()).toBe(before);

      // Existing confirmed bookings stay readable and manageable.
      expect((await bookingRow(a.bookingId)).status).toBe('confirmed');
      expect(await bookings.findById(a.bookingId)).toMatchObject({ id: a.bookingId, status: 'confirmed' });
    });

    it('engaged, a professional cancellation still writes the credit RETURN, and reschedule and completion still operate (case 16)', async () => {
      const seller = await newSeller();
      await grantCredits(seller, 2);
      const a = await bookZeroCollectible(seller);
      const b = await bookZeroCollectible(seller);
      const [consumptionA] = await consumptionsOf(a.bookingId);
      expect(consumptionA).toBeDefined();
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(0);

      await setKillSwitch('engaged');

      // Reschedule: a new slot for the same professional, moved while engaged; consumes nothing extra.
      const newSlotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(700 + sequence));
      const moved = await bookings.reschedule(a.bookingId, newSlotId, { type: 'customer', id: a.customer.id }, null);
      expect(moved.slotId).toBe(newSlotId);
      expect(await consumptionsOf(a.bookingId)).toHaveLength(1);

      // Cancellation by the professional returns the credit, exactly as #58a does.
      await bookings.cancel(a.bookingId, { type: 'professional', id: seller.ownerId }, 'لغو در حین توقف اضطراری');
      const returns = await dataSource.query('SELECT return_cause FROM commercial.booking_credit_returns WHERE consumption_id = $1', [consumptionA.id]);
      expect(returns).toEqual([{ return_cause: 'seller_cancelled' }]);
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(1);

      // Completion of the other confirmed booking is untouched by the switch.
      await dataSource.query(`UPDATE booking.bookings SET slot_start = now() - interval '2 hours', slot_end = now() - interval '1 hour' WHERE id = $1`, [b.bookingId]);
      expect(await bookings.complete(b.bookingId, { type: 'professional', id: seller.ownerId })).toBe(true);
      expect((await bookingRow(b.bookingId)).status).toBe('completed');
    });

    it('the customer sees the SAME public body for a kill-switch refusal and an exhausted balance (case 21)', async () => {
      const spentSeller = await newSeller();
      await grantCredits(spentSeller, 1);
      await exhaust(spentSeller);
      const exhausted = (await tryBookZeroCollectible(spentSeller)).refusal!;

      const blockedSeller = await newSeller();
      await grantCredits(blockedSeller, 1);
      await setKillSwitch('engaged');
      const killed = (await tryBookZeroCollectible(blockedSeller)).refusal!;

      expect(exhausted.reason).toBe('insufficient_credit');
      expect(killed.reason).toBe('control_refused');
      // The internal reason is a property on the exception, never in the response.
      expect(killed.getResponse()).toEqual(exhausted.getResponse());
      expect(killed.getStatus()).toBe(exhausted.getStatus());
      expect(JSON.stringify(killed.getResponse())).not.toMatch(/control_refused|kill_switch|insufficient/);
      expect((killed.getResponse() as { code: string }).code).toBe('BOOKING_NOT_CONFIRMABLE');
    });
  });

  describe('§D fail-closed and linearization (ADR-050 §4.2, §9)', () => {
    it("a MISSING control row fails closed, loudly, inside the caller's transaction", async () => {
      await expect(
        dataSource.transaction(async (m) => {
          // DDL is transactional in PostgreSQL: the trigger is disabled, the row
          // removed and the read attempted, all rolled back together.
          await m.query(`ALTER TABLE ${CONTROL} DISABLE TRIGGER tg_bcec_protect`);
          await m.query(`DELETE FROM ${CONTROL} WHERE id = 1`);
          await enforcement.readForConfirmation(m);
        }),
      ).rejects.toBeInstanceOf(EnforcementControlMalformedError);
      expect(await controlRow()).toMatchObject({ id: 1, rollout_state: 'inactive' });
    });

    it('an ACTIVE rollout is a state this release refuses to honour -- neither the legacy path nor a guess (story boundary)', async () => {
      await expect(
        dataSource.transaction(async (m) => {
          await m.query(`UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 1, activated_at = now(), activation_audit_id = $1 WHERE id = 1`, [uuidv7()]);
          const control = await enforcement.readForConfirmation(m);
          enforcement.decideBeforeLedger(control);
        }),
      ).rejects.toThrow(/no active-rollout confirmation outcome/);
      expect((await controlRow()).rollout_state).toBe('inactive');
    });

    it('a confirmation holds the control row FOR SHARE, so an engagement (FOR UPDATE) waits for it -- and a second FOR SHARE does not', async () => {
      let releaseHolder!: () => void;
      const holderDone = new Promise<void>((r) => (releaseHolder = r));
      let signalReady!: () => void;
      const holderReady = new Promise<void>((r) => (signalReady = r));

      const holder = dataSource.transaction(async (m) => {
        await enforcement.readForConfirmation(m); // FOR SHARE, held until this transaction ends
        signalReady();
        await holderDone;
      });
      await holderReady;

      // Another FOR SHARE reader is NOT blocked: shared locks are compatible.
      await dataSource.transaction(async (m) => {
        const row = await enforcement.readForConfirmation(m);
        expect(row.killSwitchState).toBe('released');
      });

      let engaged = false;
      const engagement = dataSource
        .transaction(async (m) => {
          await m.query(`SELECT id FROM ${CONTROL} WHERE id = 1 FOR UPDATE`);
          await m.query(`UPDATE ${CONTROL} SET kill_switch_state = 'engaged', kill_switch_changed_at = now(), kill_switch_audit_id = $1 WHERE id = 1`, [uuidv7()]);
        })
        .then(() => {
          engaged = true;
        });

      // Bounded wait: if the engagement was going to slip past the shared lock, it has by now.
      await new Promise((r) => setTimeout(r, 750));
      expect(engaged).toBe(false);
      expect((await controlRow()).kill_switch_state).toBe('released');

      releaseHolder();
      await holder;
      await engagement;
      expect(engaged).toBe(true);
      expect((await controlRow()).kill_switch_state).toBe('engaged');
    }, 20_000);
  });

  // =========================================================================
  // §H  #58a is byte-identical (ADR-050 §10 case 23; V33-DEC-036 R13)
  // =========================================================================

  describe('§H #58a is not redesigned (case 23)', () => {
    it('booking-credit-accounting.service.ts is byte-identical to the #58a source', () => {
      const source = readFileSync(
        join(__dirname, '..', '..', '..', 'services', 'commercial-policy', 'src', 'subscription', 'booking-credit-accounting.service.ts'),
        'utf8',
      ).replace(/\r\n/g, '\n');
      expect(createHash('sha256').update(source, 'utf8').digest('hex')).toBe('c17a569fff734309a5a61795b4769df96f9e370c014c8b16734a82f68dc09052');
    });

    it('the three ledger tables carry exactly the #58a constraint definitions', async () => {
      const rows: Array<{ t: string; conname: string; def: string }> = await dataSource.query(
        `SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid IN ('commercial.booking_credit_grants'::regclass, 'commercial.booking_credit_consumptions'::regclass, 'commercial.booking_credit_returns'::regclass)
          ORDER BY 1, 2`,
      );
      expect(rows.map((r) => `${r.t}|${r.conname}|${r.def}`)).toEqual([
        'commercial.booking_credit_consumptions|booking_credit_consumptions_grant_id_fkey|FOREIGN KEY (grant_id) REFERENCES commercial.booking_credit_grants(id)',
        'commercial.booking_credit_consumptions|booking_credit_consumptions_pkey|PRIMARY KEY (id)',
        'commercial.booking_credit_consumptions|booking_credit_consumptions_subscription_id_fkey|FOREIGN KEY (subscription_id) REFERENCES commercial.seller_subscriptions(id)',
        "commercial.booking_credit_consumptions|ck_bcc_party_type|CHECK (((subscriber_party_type)::text = ANY ((ARRAY['professional'::character varying, 'business'::character varying])::text[])))",
        'commercial.booking_credit_consumptions|ck_bcc_period|CHECK ((period_index >= 0))',
        'commercial.booking_credit_consumptions|fk_bcc_grant_identity|FOREIGN KEY (grant_id, subscription_id, period_index, subscriber_party_type, subscriber_party_id) REFERENCES commercial.booking_credit_grants(id, subscription_id, period_index, subscriber_party_type, subscriber_party_id)',
        'commercial.booking_credit_consumptions|uq_bcc_booking_once|UNIQUE (booking_id)',
        'commercial.booking_credit_grants|booking_credit_grants_pkey|PRIMARY KEY (id)',
        'commercial.booking_credit_grants|booking_credit_grants_plan_version_id_fkey|FOREIGN KEY (plan_version_id) REFERENCES commercial.plan_versions(id)',
        'commercial.booking_credit_grants|booking_credit_grants_subscription_id_fkey|FOREIGN KEY (subscription_id) REFERENCES commercial.seller_subscriptions(id)',
        'commercial.booking_credit_grants|ck_booking_credit_grants_no_expiry|CHECK ((expires_at IS NULL))',
        "commercial.booking_credit_grants|ck_booking_credit_grants_party_type|CHECK (((subscriber_party_type)::text = ANY ((ARRAY['professional'::character varying, 'business'::character varying])::text[])))",
        'commercial.booking_credit_grants|ck_booking_credit_grants_period|CHECK ((period_index >= 0))',
        'commercial.booking_credit_grants|ck_booking_credit_grants_quantity|CHECK (((quantity >= 0) AND (quantity <= 1000000000)))',
        "commercial.booking_credit_grants|ck_booking_credit_grants_source|CHECK (((source)::text = 'plan_included'::text))",
        'commercial.booking_credit_grants|uq_bcg_identity|UNIQUE (id, subscription_id, period_index, subscriber_party_type, subscriber_party_id)',
        'commercial.booking_credit_grants|uq_booking_credit_grants_once|UNIQUE (subscription_id, source, period_index)',
        'commercial.booking_credit_returns|booking_credit_returns_consumption_id_fkey|FOREIGN KEY (consumption_id) REFERENCES commercial.booking_credit_consumptions(id)',
        'commercial.booking_credit_returns|booking_credit_returns_pkey|PRIMARY KEY (id)',
        "commercial.booking_credit_returns|ck_bcr_cause|CHECK (((return_cause)::text = ANY ((ARRAY['seller_cancelled'::character varying, 'platform_cancelled'::character varying])::text[])))",
        'commercial.booking_credit_returns|uq_bcr_consumption_once|UNIQUE (consumption_id)',
      ]);
    });

    it('the seam is additive: every pre-#95 member of BookingConfirmationEntitlement is present verbatim, and the new one names only the kill switch (case 30)', () => {
      const ports = readFileSync(join(__dirname, '..', '..', '..', 'services', 'commerce', 'src', 'ports.ts'), 'utf8');
      expect(ports).toContain("| { outcome: 'permitted'; detail: 'consumed' | 'already_consumed' | 'not_configured' }");
      expect(ports).toContain("| { outcome: 'insufficient_credit' }");
      expect(ports).toContain("| { outcome: 'ineligible'; reason: 'no_order' | 'no_subscription' }");
      expect(ports).toContain("| { outcome: 'control_refused'; reason: 'kill_switch_active' }");
      expect(ports).not.toMatch(/control_refused'; reason: '(?!kill_switch_active')/);
    });

    it('both production confirmation paths still call the one entitlement port, and the adapter reads the control row BEFORE the ledger', () => {
      const checkoutSource = readFileSync(join(__dirname, '..', 'src', 'checkout', 'checkout.service.ts'), 'utf8');
      expect(checkoutSource.match(/onBookingConfirmation\(/g) ?? []).toHaveLength(2);
      const adapter = readFileSync(join(__dirname, '..', 'src', 'composition', 'booking-credit-entitlement.adapter.ts'), 'utf8');
      const readAt = adapter.indexOf('this.enforcement.readForConfirmation(manager)');
      const consumeAt = adapter.indexOf('this.credits.consumeForConfirmation(manager, bookingId');
      const orderAt = adapter.indexOf("reason: 'no_order'");
      expect(readAt).toBeGreaterThan(orderAt);
      expect(consumeAt).toBeGreaterThan(readAt);
    });
  });
});
