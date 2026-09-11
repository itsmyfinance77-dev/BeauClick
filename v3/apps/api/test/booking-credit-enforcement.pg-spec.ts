import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import request from 'supertest';

import { PRIVILEGED_CAPABILITIES } from '@beauclick/auth';
import { BookingService } from '@beauclick/booking';
import {
  BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY,
  BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE,
  BOOKING_ENTITLEMENT_LOCK_NAMESPACE,
  BookingCreditAccountingService,
  BookingCreditEnforcementControlService,
  BookingCreditEnforcementGovernanceService,
  EnforcementControlMalformedError,
  SellerSubscriptionService,
  SubscriberPartyType,
  BookingCreditEnforcementSubjectDataContract,
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
  seedBusiness,
  seedMembership,
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

  /**
   * `admin.admin_audit_log` is append-only and outside `resetDatabase`'s
   * reach -- the application role cannot TRUNCATE it, by design -- so every
   * audit assertion below is scoped to rows written after this test began,
   * by the DATABASE clock (`now()` is the insert's transaction start, and a
   * transaction that begins after this read cannot predate it).
   */
  let auditWatermark: string;

  beforeEach(async () => {
    await resetDatabase(dataSource);
    auditWatermark = (await dataSource.query('SELECT clock_timestamp() AS t'))[0].t;
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
      // Claimed by the control plane's OWN contract, so the subscription
      // contract's "every claim is retained" invariant stays exactly as #56a
      // pinned it (ADR-050 §8).
      const owner = contracts.find((c) => c.tables.some((t) => t.table === CONTROL))!;
      expect(owner.moduleKey).toBe('commercial-enforcement');
      expect(owner.tables.map((t) => t.table).sort()).toEqual([CONTROL, GOVERNANCE]);
      expect(contracts.find((c) => c.moduleKey === 'commercial-subscription')!.tables.every((t) => t.disposition === 'retained')).toBe(true);
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

    it("an ACTIVE rollout is the pre-ledger decision 'active' -- never the legacy path, never a guess (V3.3 #141 gave it its outcomes)", async () => {
      const decision = await dataSource.transaction(async (m) => {
        await m.query(`UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 1, activated_at = now(), activation_audit_id = $1 WHERE id = 1`, [uuidv7()]);
        const control = await enforcement.readForConfirmation(m);
        const pre = enforcement.decideBeforeLedger(control);
        // Governance may only be consulted under an active rollout; the reverse is a malformed call.
        expect(() => enforcement.decideGovernance({ ...control, rolloutState: 'inactive' }, null)).toThrow(EnforcementControlMalformedError);
        return pre;
      });
      expect(decision).toEqual({ kind: 'active' });
      // The active rollout outcomes themselves are booking-credit-activation.pg-spec.ts's subject;
      // this suite's fixture reset (TRUNCATE + reseed) returns the row to inactive for the next case.
      expect((await controlRow()).rollout_state).toBe('active');
      await resetDatabase(dataSource);
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

    it('the seam is additive: every pre-#95 member of BookingConfirmationEntitlement is present verbatim, and the control-plane member names exactly the three control refusals (case 30)', () => {
      const ports = readFileSync(join(__dirname, '..', '..', '..', 'services', 'commerce', 'src', 'ports.ts'), 'utf8');
      expect(ports).toContain("| { outcome: 'permitted'; detail: 'consumed' | 'already_consumed' | 'not_configured' }");
      expect(ports).toContain("| { outcome: 'insufficient_credit' }");
      expect(ports).toContain("| { outcome: 'ineligible'; reason: 'no_order' | 'no_subscription' }");
      // #95 named the kill switch; #141 (`#58b-2`) widened the SAME member by exactly the two active-rollout refusals.
      expect(ports).toContain("| { outcome: 'control_refused'; reason: 'kill_switch_active' | 'business_policy_disabled' | 'entitlement_missing' };");
      // `rollout_disabled` is never a refusal at the seam: an inactive rollout IS the legacy path.
      expect(ports).not.toMatch(/control_refused'[^;]*rollout_disabled/);
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
  // =========================================================================
  // §E  The administrator surface: authorization (ADR-050 §5; cases 17, 18)
  // =========================================================================

  const BASE = '/api/v1/admin/commercial/booking-credit-enforcement';
  const ROUTES: Array<['get' | 'post', string]> = [
    ['get', BASE],
    ['get', `${BASE}/preview`],
    ['post', `${BASE}/transitions`],
    ['post', `${BASE}/exemptions`],
    ['post', `${BASE}/kill-switch/engage`],
    ['post', `${BASE}/kill-switch/release`],
  ];
  const REASON = { reason: 'operator action recorded by the enforcement suite' };

  async function seedAdmin(): Promise<SeededUser> {
    return seedUser(app, dataSource, nextPhone(), ['administrator']);
  }

  const auditRows = async () =>
    dataSource.query(
      `SELECT action, actor_user_id, reason, after_state FROM admin.admin_audit_log
        WHERE target_type = 'commercial.booking_credit_enforcement' AND created_at > $1
        ORDER BY created_at, id`,
      [auditWatermark],
    );

  describe('§E authorization over the real route table (ADR-050 §5.2; cases 17, 18)', () => {
    it('the capability is PRIVILEGED, which confers the live re-check and the boot assertion', () => {
      expect(PRIVILEGED_CAPABILITIES).toContain('bc_manage_commercial_plans');
    });

    it('every one of the seven routes refuses an unauthenticated caller with 401, and a sibling nonexistent route is 404', async () => {
      for (const [method, path] of [...ROUTES, ['post', `${BASE}/activation`] as const]) {
        const server = app.getHttpServer();
        const response = await (method === 'get' ? request(server).get(path) : request(server).post(path).send(REASON));
        expect({ path, status: response.status }).toEqual({ path, status: 401 });
      }
      // There is no activation/preview and no deactivation: 404, not 401 (ADR-050 §5.2, `V33-DEC-036` R9).
      for (const path of [`${BASE}/activation/preview`, `${BASE}/deactivation`]) {
        const missing = await request(app.getHttpServer()).post(path).send(REASON);
        expect({ path, status: missing.status }).toEqual({ path, status: 404 });
      }
    });

    it('refuses a CUSTOMER and a PLATFORM_OPERATOR on every route', async () => {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const operator = await seedUser(app, dataSource, nextPhone(), ['platform_operator']);
      for (const caller of [customer, operator]) {
        for (const [method, path] of ROUTES) {
          const server = app.getHttpServer();
          const response = await (method === 'get'
            ? request(server).get(path).set('Authorization', `Bearer ${caller.accessToken}`)
            : request(server).post(path).set('Authorization', `Bearer ${caller.accessToken}`).send(REASON));
          expect({ path, status: response.status }).toEqual({ path, status: 403 });
        }
      }
      expect(await auditRows()).toEqual([]);
    });

    it('admits an ADMINISTRATOR on both reads', async () => {
      const admin = await seedAdmin();
      const status = await request(app.getHttpServer()).get(BASE).set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status.status).toBe(200);
      expect(status.body.data).toEqual({ rolloutState: 'inactive', killSwitchState: 'released', activationGeneration: 0, activatedAt: null, killSwitchChangedAt: null });
      const preview = await request(app.getHttpServer()).get(`${BASE}/preview`).set('Authorization', `Bearer ${admin.accessToken}`);
      expect(preview.status).toBe(200);
    });

    it('refuses on the next request after the role is revoked, with the SAME token, on reads and mutations (case 17)', async () => {
      const admin = await seedAdmin();
      expect((await request(app.getHttpServer()).get(BASE).set('Authorization', `Bearer ${admin.accessToken}`)).status).toBe(200);

      await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1`, [admin.id]);

      for (const [method, path] of ROUTES) {
        const server = app.getHttpServer();
        const response = await (method === 'get'
          ? request(server).get(path).set('Authorization', `Bearer ${admin.accessToken}`)
          : request(server).post(path).set('Authorization', `Bearer ${admin.accessToken}`).send(REASON));
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
      }
      expect((await controlRow()).kill_switch_state).toBe('released');
      expect(await auditRows()).toEqual([]);
    });

    it('a business_staff member holding every non-privileged capability reaches no route, and accepting a membership writes no governance row (case 18)', async () => {
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن');
      const staffUser = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const staffProfessional = await seedProfessional(dataSource, staffUser.id, 'کارمند', 0);
      const membershipId = await seedMembership(dataSource, business.id, staffUser.id, 'manager', owner.id, staffProfessional.id);
      await dataSource.query(`UPDATE business.business_staff SET status = 'active', responded_at = now() WHERE id = $1`, [membershipId]);

      for (const [method, path] of ROUTES) {
        const server = app.getHttpServer();
        const response = await (method === 'get'
          ? request(server).get(path).set('Authorization', `Bearer ${staffUser.accessToken}`)
          : request(server).post(path).set('Authorization', `Bearer ${staffUser.accessToken}`).send(REASON));
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
      }
      // The OWNER of the business is a seller, not an administrator: also refused.
      expect((await request(app.getHttpServer()).get(BASE).set('Authorization', `Bearer ${owner.accessToken}`)).status).toBe(403);
      // Affiliation triggers nothing: no governance row for the staff member's own party or the business.
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM ${GOVERNANCE}`)).toEqual([{ n: 0 }]);
    });

    it('rejects an unknown body field, a missing reason and a whitespace reason before anything is written', async () => {
      const admin = await seedAdmin();
      const server = app.getHttpServer();
      const auth = (r: request.Test) => r.set('Authorization', `Bearer ${admin.accessToken}`);

      expect((await auth(request(server).post(`${BASE}/kill-switch/engage`)).send({ ...REASON, partyId: uuidv7() })).status).toBe(400);
      expect((await auth(request(server).post(`${BASE}/transitions`)).send({ ...REASON, ownerUserId: uuidv7() })).status).toBe(400);
      expect((await auth(request(server).post(`${BASE}/exemptions`)).send({ ...REASON, businessId: uuidv7() })).status).toBe(400);
      expect((await auth(request(server).post(`${BASE}/kill-switch/engage`)).send({})).status).toBe(400);
      expect((await auth(request(server).post(`${BASE}/kill-switch/engage`)).send({ reason: 'x' })).status).toBe(400);
      const whitespace = await auth(request(server).post(`${BASE}/kill-switch/engage`)).send({ reason: '     ' });
      expect(whitespace.status).toBeGreaterThanOrEqual(400);
      expect(whitespace.status).toBeLessThan(500);

      expect((await controlRow()).kill_switch_state).toBe('released');
      expect(await auditRows()).toEqual([]);
    });

    it('no read or response carries an actor, audit, owner, party or seller identifier', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller();
      await grantCredits(seller, 1);
      const auth = (r: request.Test) => r.set('Authorization', `Bearer ${admin.accessToken}`);

      const bodies = [
        (await auth(request(app.getHttpServer()).post(`${BASE}/kill-switch/engage`)).send(REASON)).body.data,
        (await auth(request(app.getHttpServer()).post(`${BASE}/kill-switch/release`)).send(REASON)).body.data,
        (await auth(request(app.getHttpServer()).post(`${BASE}/transitions`)).send(REASON)).body.data,
        (await auth(request(app.getHttpServer()).post(`${BASE}/exemptions`)).send(REASON)).body.data,
        (await auth(request(app.getHttpServer()).get(BASE))).body.data,
        (await auth(request(app.getHttpServer()).get(`${BASE}/preview`))).body.data,
      ];
      const serialized = JSON.stringify(bodies);
      expect(serialized).not.toContain(admin.id);
      expect(serialized).not.toContain(seller.partyId);
      expect(serialized).not.toContain(seller.ownerId);
      expect(serialized).not.toMatch(/audit|actor|user_id|userId|partyId|party_id|ownerId|phone/i);
      expect(bodies[2]).toEqual({ affected: 1, skipped: 0 });
      expect(bodies[3]).toEqual({ affected: 0, skipped: 0 });
    });
  });

  // =========================================================================
  // §F  Preview (ADR-050 §5.4; cases 1, 2, 22)
  // =========================================================================

  describe('§F preview (ADR-050 §5.4; cases 1, 2, 22)', () => {
    let admin: SeededUser;
    beforeEach(async () => {
      admin = await seedAdmin();
    });
    const previewAs = async () => {
      const response = await request(app.getHttpServer()).get(`${BASE}/preview`).set('Authorization', `Bearer ${admin.accessToken}`);
      expect(response.status).toBe(200);
      return response.body.data as Record<string, unknown>;
    };

    it('returns exactly the §5.4 contract, and a fresh database counts zero everywhere', async () => {
      expect(await previewAs()).toEqual({
        rolloutState: 'inactive',
        killSwitchState: 'released',
        activationGeneration: 0,
        eligible: 0,
        governed: 0,
        legacyExempt: 0,
        unresolved: 0,
        wouldBeRefused: 0,
      });
    });

    it('counts exactly the ADR-050 §3.1 eligible parties: non-deleted professionals and businesses, dual owners twice, staff never, deleted never, subscription irrelevant (case 2)', async () => {
      // 1. a plain professional (no subscription row at all)
      await newSeller();
      // 2. a business owner
      const bizOwner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
      await seedBusiness(dataSource, bizOwner.id, 'کسب‌وکار');
      // 3+4. a DUAL owner: one user, two parties
      const dual = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
      await seedProfessional(dataSource, dual.id, 'دوگانه', 0);
      await seedBusiness(dataSource, dual.id, 'کسب‌وکار دوگانه');
      // a deleted professional and a deleted business: ineligible
      const gone = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
      const goneP = await seedProfessional(dataSource, gone.id, 'حذف‌شده', 0);
      const goneB = await seedBusiness(dataSource, gone.id, 'حذف‌شده');
      await dataSource.query(`UPDATE provider.professionals SET deleted_at = now() WHERE id = $1`, [goneP.id]);
      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [goneB.id]);
      // a staff member of the business: eligible ONLY as their own professional party, never as the employer
      const staffUser = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const staffP = await seedProfessional(dataSource, staffUser.id, 'کارمند', 0);
      const business = (await dataSource.query(`SELECT id FROM business.businesses WHERE owner_id = $1`, [bizOwner.id]))[0].id;
      const membershipId = await seedMembership(dataSource, business, staffUser.id, 'staff', bizOwner.id, staffP.id);
      await dataSource.query(`UPDATE business.business_staff SET status = 'active', responded_at = now() WHERE id = $1`, [membershipId]);
      // a suspended-by-hand professional stays eligible: verification is orthogonal (ADR-050 Context)
      const susp = await newSeller();
      await dataSource.query(`UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1`, [susp.professionalId]);

      const preview = await previewAs();
      // professional(1) + business(2) + dual-professional(3) + dual-business(4) + staff-professional(5) + suspended(6)
      expect(preview).toMatchObject({ eligible: 6, governed: 0, legacyExempt: 0, unresolved: 6, wouldBeRefused: 0 });
    });

    it('partitions governed / legacy_exempt / unresolved, and wouldBeRefused uses grants minus active consumptions INCLUDING a governed party with no positive grant', async () => {
      const govNoGrant = await newSeller();
      await governAs(govNoGrant, 'governed'); // governed, never granted -> would be refused
      const govFunded = await newSeller();
      await governAs(govFunded, 'governed');
      await grantCredits(govFunded, 2); // balance 2 -> not refused
      const govSpent = await newSeller();
      await governAs(govSpent, 'governed');
      await grantCredits(govSpent, 1);
      await exhaust(govSpent); // balance 0 -> would be refused
      const govReturned = await newSeller();
      await governAs(govReturned, 'governed');
      await grantCredits(govReturned, 1);
      const a = await bookZeroCollectible(govReturned); // consumes the one credit
      await bookings.cancel(a.bookingId, { type: 'professional', id: govReturned.ownerId }, 'بازگشت'); // returned -> balance 1 -> not refused
      const exempt = await newSeller();
      await governAs(exempt, 'legacy_exempt');
      await newSeller(); // unresolved

      expect(await previewAs()).toMatchObject({ eligible: 6, governed: 4, legacyExempt: 1, unresolved: 1, wouldBeRefused: 2 });
    });

    it('is non-mutating: no governance row, no audit row, no control change, and it holds NO row lock and NO advisory lock (case 1)', async () => {
      await newSeller();
      const before = [await dataSource.query(`SELECT * FROM ${GOVERNANCE}`), await auditRows(), await controlRow()];

      // Hold the control row FOR UPDATE and the coordination lock EXCLUSIVELY in another
      // transaction; a preview that took either lock would block here.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let ready!: () => void;
      const isReady = new Promise<void>((r) => (ready = r));
      const holder = dataSource.transaction(async (m) => {
        await m.query(`SELECT id FROM ${CONTROL} WHERE id = 1 FOR UPDATE`);
        await m.query('SELECT pg_advisory_xact_lock($1, $2)', [BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE, BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY]);
        ready();
        await held;
      });
      await isReady;

      const timed = await Promise.race([previewAs().then(() => 'completed'), new Promise<string>((r) => setTimeout(() => r('blocked'), 2_500))]);
      release();
      await holder;
      expect(timed).toBe('completed');

      const after = [await dataSource.query(`SELECT * FROM ${GOVERNANCE}`), await auditRows(), await controlRow()];
      expect(after).toEqual(before);
    });

    it('issues the same number of statements for one seller as for fifty (case 22)', async () => {
      const governance = app.get(BookingCreditEnforcementGovernanceService);
      const countStatements = async () => {
        let queries = 0;
        const original = dataSource.logger;
        dataSource.logger = {
          logQuery: () => {
            queries += 1;
          },
          logQueryError: () => undefined,
          logQuerySlow: () => undefined,
          logSchemaBuild: () => undefined,
          logMigration: () => undefined,
          log: () => undefined,
        };
        try {
          await governance.preview();
        } finally {
          dataSource.logger = original;
        }
        return queries;
      };
      await newSeller();
      const withOne = await countStatements();
      for (let i = 0; i < 49; i += 1) await newSeller();
      await governAs(await newSeller(), 'governed');
      const withFifty = await countStatements();
      expect(withOne).toBeGreaterThan(0);
      expect(withFifty).toBe(withOne);
      expect((await previewAs()).eligible).toBe(51);
    });

    it('reads one consistent snapshot: a seller created while the preview transaction is open is not counted by it', async () => {
      // The REPEATABLE READ snapshot is asserted through the service, which
      // exposes the transaction boundary; the route is the same call.
      await newSeller();
      const governance = app.get(BookingCreditEnforcementGovernanceService);
      const snapshot = await dataSource.transaction('REPEATABLE READ', async (m) => {
        const first = await governance.partition(m);
        await newSeller(); // committed on another connection while this snapshot is open
        const second = await governance.partition(m);
        return { first, second };
      });
      expect(snapshot.second).toEqual(snapshot.first);
      expect((await previewAs()).eligible).toBe(2);
    });
  });

  // =========================================================================
  // §G  Transition, exemption and the kill switch (ADR-050 §3.3, §6; cases 11-13, 19, 20)
  // =========================================================================

  describe('§G explicit transition and exemption (ADR-050 §3.3; cases 11, 12, 13, 19)', () => {
    let admin: SeededUser;
    let governance: BookingCreditEnforcementGovernanceService;
    beforeAll(() => {
      governance = app.get(BookingCreditEnforcementGovernanceService);
    });
    beforeEach(async () => {
      admin = await seedAdmin();
    });
    const post = (path: string, body: Record<string, unknown> = REASON) =>
      request(app.getHttpServer()).post(`${BASE}${path}`).set('Authorization', `Bearer ${admin.accessToken}`).send(body);
    const governanceRows = async () => dataSource.query(`SELECT party_type, party_id, state, cause, proof_grant_id, recorded_by_user_id, recorded_by_label, audit_id, governed_at FROM ${GOVERNANCE} ORDER BY party_type, party_id`);

    it('governs every entitled party with the OLDEST positive grant as proof, skips the unentitled, writes no grant, and leaves the skipped party unresolved (case 11)', async () => {
      const entitled = await newSeller();
      const older = await grantCredits(entitled, 1);
      const newer = await grantCredits(entitled, 3);
      const zeroOnly = await newSeller();
      await ensureBasePlan();
      await subscriptions.ensureBaseSubscription(zeroOnly); // the seeded-shape zero grant: NOT a positive entitlement
      const nothing = await newSeller();
      const grantsBefore = await dataSource.query('SELECT * FROM commercial.booking_credit_grants ORDER BY id');

      const response = await post('/transitions');
      expect(response.status).toBe(201);
      expect(response.body.data).toEqual({ affected: 1, skipped: 2 });

      const rows = await governanceRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ party_type: 'professional', party_id: entitled.partyId, state: 'governed', cause: 'explicit_transition', proof_grant_id: older, recorded_by_user_id: admin.id, recorded_by_label: null });
      expect(rows[0].proof_grant_id).not.toBe(newer);
      expect(rows[0].governed_at).not.toBeNull();
      void nothing;
      void zeroOnly;

      // No grant, subscription, consumption, return or balance was written (case 12).
      expect(await dataSource.query('SELECT * FROM commercial.booking_credit_grants ORDER BY id')).toEqual(grantsBefore);
      expect(await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_consumptions')).toEqual([{ n: 0 }]);
      expect(await credits.balanceFor(dataSource.manager, entitled)).toBe(4);

      // One audit row, attributed to the session actor, carrying only counts.
      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'commercial.enforcement_parties_governed', actor_user_id: admin.id, reason: REASON.reason, after_state: { affected: 1, skipped: 2 } });
      expect(JSON.stringify(audit[0].after_state)).not.toContain(entitled.partyId);
      expect(rows[0].audit_id).toBeDefined();
      const [auditRow] = await dataSource.query('SELECT id FROM admin.admin_audit_log WHERE id = $1', [rows[0].audit_id]);
      expect(auditRow).toBeDefined();
    });

    it('is idempotent under replay: a second run affects nothing and writes no audit row (case 13)', async () => {
      const entitled = await newSeller();
      await grantCredits(entitled, 1);
      expect((await post('/transitions')).body.data).toEqual({ affected: 1, skipped: 0 });
      const rowsAfterFirst = await governanceRows();
      const auditAfterFirst = await auditRows();

      expect((await post('/transitions')).body.data).toEqual({ affected: 0, skipped: 0 });
      expect(await governanceRows()).toEqual(rowsAfterFirst);
      expect(await auditRows()).toEqual(auditAfterFirst);
    });

    it('moves a legacy_exempt party to governed once it holds a positive grant -- the one permitted update, and never the reverse', async () => {
      const seller = await newSeller();
      expect((await post('/exemptions')).body.data).toEqual({ affected: 1, skipped: 0 });
      const [exempt] = await governanceRows();
      expect(exempt).toMatchObject({ state: 'legacy_exempt', cause: 'explicit_exemption', proof_grant_id: null });

      await grantCredits(seller, 1);
      expect((await post('/transitions')).body.data).toEqual({ affected: 1, skipped: 0 });
      const [governed] = await governanceRows();
      expect(governed).toMatchObject({ party_id: seller.partyId, state: 'governed', cause: 'explicit_transition' });
      expect(governed.proof_grant_id).not.toBeNull();

      // Exemption never touches a resolved party: the governed row stays governed.
      expect((await post('/exemptions')).body.data).toEqual({ affected: 0, skipped: 0 });
      expect((await governanceRows())[0].state).toBe('governed');
    });

    it('exempts only UNRESOLVED parties without a positive grant, and counts the entitled ones as skipped', async () => {
      const entitled = await newSeller();
      await grantCredits(entitled, 1);
      const plain = await newSeller();
      const alreadyExempt = await newSeller();
      await governAs(alreadyExempt, 'legacy_exempt');

      expect((await post('/exemptions')).body.data).toEqual({ affected: 1, skipped: 1 });
      const rows = await governanceRows();
      expect(rows.map((r: { party_id: string; state: string }) => `${r.party_id}:${r.state}`).sort()).toEqual(
        [`${plain.partyId}:legacy_exempt`, `${alreadyExempt.partyId}:legacy_exempt`].sort(),
      );
      expect(rows.find((r: { party_id: string }) => r.party_id === plain.partyId)).toMatchObject({ cause: 'explicit_exemption', recorded_by_user_id: admin.id });
      // Together the two commands resolve every seller: nothing remains unresolved.
      // The two legacy_exempt parties stay transition CANDIDATES (a later positive
      // grant would move them), so the transition truthfully reports them skipped.
      expect((await post('/transitions')).body.data).toEqual({ affected: 1, skipped: 2 });
      const preview = await request(app.getHttpServer()).get(`${BASE}/preview`).set('Authorization', `Bearer ${admin.accessToken}`);
      expect(preview.body.data).toMatchObject({ eligible: 3, governed: 1, legacyExempt: 2, unresolved: 0 });
    });

    it('two CONCURRENT batches produce one row per party and one audit row each at most, never a duplicate (case 13)', async () => {
      const sellers = await Promise.all([newSeller(), newSeller(), newSeller()]);
      for (const seller of sellers) await grantCredits(seller, 1);

      const results = await Promise.allSettled([
        governance.transitionEntitledParties(admin.id, 'batch one'),
        governance.transitionEntitledParties(admin.id, 'batch two'),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const affected = results.map((r) => (r as PromiseFulfilledResult<{ affected: number }>).value.affected);
      expect(affected.reduce((a, b) => a + b, 0)).toBe(3);

      const rows = await governanceRows();
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r: { party_id: string }) => r.party_id)).size).toBe(3);
      const audit = await auditRows();
      expect(audit.length).toBe(affected.filter((n) => n > 0).length);
    });

    it('a dual owner is two independent parties, transitioned independently (case 19)', async () => {
      const dual = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
      const professional = await seedProfessional(dataSource, dual.id, 'دوگانه', 0);
      const business = await seedBusiness(dataSource, dual.id, 'کسب‌وکار دوگانه');
      await grantCredits({ partyType: 'professional', partyId: professional.id }, 1);

      expect((await post('/transitions')).body.data).toEqual({ affected: 1, skipped: 1 });
      let rows = await governanceRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ party_type: 'professional', party_id: professional.id, state: 'governed' });

      await grantCredits({ partyType: 'business', partyId: business.id }, 1);
      expect((await post('/transitions')).body.data).toEqual({ affected: 1, skipped: 0 });
      rows = await governanceRows();
      expect(rows.map((r: { party_type: string; party_id: string }) => `${r.party_type}:${r.party_id}`).sort()).toEqual(
        [`business:${business.id}`, `professional:${professional.id}`].sort(),
      );
    });

    it('a transition and a confirmation for the SAME party serialise on the bcre party lock', async () => {
      const seller = await newSeller();
      await grantCredits(seller, 1);
      let releaseHolder!: () => void;
      const holderDone = new Promise<void>((r) => (releaseHolder = r));
      let signalReady!: () => void;
      const holderReady = new Promise<void>((r) => (signalReady = r));
      // A confirmation-shaped holder of the party lock.
      const holder = dataSource.transaction(async (m) => {
        await m.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [BOOKING_ENTITLEMENT_LOCK_NAMESPACE, `${seller.partyType}:${seller.partyId}`]);
        signalReady();
        await holderDone;
      });
      await holderReady;

      let done = false;
      const transition = governance.transitionEntitledParties(admin.id, 'racing a confirmation').then(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 750));
      expect(done).toBe(false);
      releaseHolder();
      await holder;
      await transition;
      expect(done).toBe(true);
      expect((await governanceRows())[0]).toMatchObject({ party_id: seller.partyId, state: 'governed' });
    }, 20_000);
  });

  describe('§G the kill switch through the administrator surface (ADR-050 §6; case 20)', () => {
    let admin: SeededUser;
    beforeEach(async () => {
      admin = await seedAdmin();
    });
    const post = (path: string, body: Record<string, unknown> = REASON) =>
      request(app.getHttpServer()).post(`${BASE}${path}`).set('Authorization', `Bearer ${admin.accessToken}`).send(body);

    it('engages and releases, each once, audited once, idempotent on replay, and never touches rollout, generation or governance', async () => {
      const seller = await newSeller();
      await governAs(seller, 'legacy_exempt');
      const governanceBefore = await dataSource.query(`SELECT * FROM ${GOVERNANCE}`);

      const engaged = await post('/kill-switch/engage');
      expect(engaged.status).toBe(201);
      expect(engaged.body.data).toMatchObject({ rolloutState: 'inactive', killSwitchState: 'engaged', activationGeneration: 0, activatedAt: null });
      expect(engaged.body.data.killSwitchChangedAt).not.toBeNull();
      const row = await controlRow();
      expect(row).toMatchObject({ rollout_state: 'inactive', activation_generation: 0, kill_switch_state: 'engaged' });
      expect(row.kill_switch_audit_id).not.toBeNull();
      const [auditRow] = await dataSource.query('SELECT action, actor_user_id, reason, before_state, after_state FROM admin.admin_audit_log WHERE id = $1', [row.kill_switch_audit_id]);
      expect(auditRow).toEqual({ action: 'commercial.enforcement_kill_switch_engaged', actor_user_id: admin.id, reason: REASON.reason, before_state: { killSwitchState: 'released' }, after_state: { killSwitchState: 'engaged' } });

      // Replay: no new audit row, same audit pointer, same instant.
      const replay = await post('/kill-switch/engage', { reason: 'engaging again by mistake' });
      expect(replay.status).toBe(201);
      expect(replay.body.data.killSwitchChangedAt).toBe(engaged.body.data.killSwitchChangedAt);
      expect((await controlRow()).kill_switch_audit_id).toBe(row.kill_switch_audit_id);
      expect(await auditRows()).toHaveLength(1);

      // A confirmation is refused while engaged, through the real route-driven state.
      const blocked = await newSeller();
      await grantCredits(blocked, 1);
      expect((await tryBookZeroCollectible(blocked)).refusal?.reason).toBe('control_refused');

      const released = await post('/kill-switch/release');
      expect(released.body.data.killSwitchState).toBe('released');
      expect(await auditRows()).toHaveLength(2);
      expect((await auditRows())[1].action).toBe('commercial.enforcement_kill_switch_released');
      expect((await post('/kill-switch/release')).status).toBe(201);
      expect(await auditRows()).toHaveLength(2);

      expect(await dataSource.query(`SELECT * FROM ${GOVERNANCE}`)).toEqual(governanceBefore);
      expect((await controlRow())).toMatchObject({ rollout_state: 'inactive', activation_generation: 0, activated_at: null, activation_audit_id: null });
      const a = await bookZeroCollectible(blocked);
      expect((await bookingRow(a.bookingId)).status).toBe('confirmed');
    });

    it('a failure at the control UPDATE -- after the audit insert -- rolls back BOTH: the audit row must not survive (case 20)', async () => {
      // The audit row is written FIRST and the control update follows. A planted
      // PostgreSQL trigger refuses that update, so the transaction fails at the
      // point where an audit written in its OWN transaction would already have
      // committed. The rollback must take the audit row with it.
      await dataSource.query(`
        CREATE OR REPLACE FUNCTION commercial.planted_refuse_kill_switch() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'planted failure at the control update' USING ERRCODE = 'raise_exception'; END $$;
        CREATE TRIGGER tg_planted_refuse_kill_switch BEFORE UPDATE OF kill_switch_state ON ${CONTROL}
          FOR EACH ROW EXECUTE FUNCTION commercial.planted_refuse_kill_switch();`);
      try {
        const response = await post('/kill-switch/engage');
        expect(response.status).toBe(500);
        expect((await controlRow()).kill_switch_state).toBe('released');
        expect((await controlRow()).kill_switch_audit_id).toBeNull();
        expect(await auditRows()).toEqual([]);
      } finally {
        await dataSource.query(`DROP TRIGGER IF EXISTS tg_planted_refuse_kill_switch ON ${CONTROL}; DROP FUNCTION IF EXISTS commercial.planted_refuse_kill_switch();`);
      }
      // Non-vacuity: the same call succeeds once nothing is planted.
      expect((await post('/kill-switch/engage')).status).toBe(201);
      expect(await auditRows()).toHaveLength(1);
    });
  });
  // =========================================================================
  // §I  Privacy: export, erasure, no process cache, restart (ADR-050 §8; cases 7, 27)
  // =========================================================================

  describe('§I export, erasure and the absence of any process cache (ADR-050 §8; case 27)', () => {
    let contract: BookingCreditEnforcementSubjectDataContract;
    beforeAll(() => {
      contract = app.get(BookingCreditEnforcementSubjectDataContract);
    });

    it('an OWNER receives state, cause, recordedAt and governedAt for each owned party -- and never the actor, audit id or proof grant', async () => {
      const admin = await seedAdmin();
      const dual = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
      const professional = await seedProfessional(dataSource, dual.id, 'دوگانه', 0);
      const business = await seedBusiness(dataSource, dual.id, 'کسب‌وکار دوگانه');
      const proofGrant = await grantCredits({ partyType: 'professional', partyId: professional.id }, 1);
      await request(app.getHttpServer()).post(`${BASE}/transitions`).set('Authorization', `Bearer ${admin.accessToken}`).send(REASON).expect(201);
      await request(app.getHttpServer()).post(`${BASE}/exemptions`).set('Authorization', `Bearer ${admin.accessToken}`).send(REASON).expect(201);
      const rows = await dataSource.query(`SELECT audit_id FROM ${GOVERNANCE}`);
      expect(rows).toHaveLength(2);

      const sections = await dataSource.transaction((m) => contract.exportSubjectData(m, dual.id));
      const section = sections.find((s) => s.key === 'commercial.booking_credit_party_governance');
      expect(section).toBeDefined();
      expect(section!.rows).toHaveLength(2);
      for (const row of section!.rows) {
        expect(Object.keys(row).sort()).toEqual(['cause', 'governedAt', 'recordedAt', 'state', 'subscriberPartyType']);
      }
      expect(section!.rows.map((r) => `${r.subscriberPartyType}:${r.state}:${r.cause}`).sort()).toEqual([
        'business:legacy_exempt:explicit_exemption',
        'professional:governed:explicit_transition',
      ]);
      const serialized = JSON.stringify(sections);
      expect(serialized).not.toContain(admin.id);
      expect(serialized).not.toContain(proofGrant);
      for (const { audit_id } of rows) expect(serialized).not.toContain(audit_id);
      expect(serialized).not.toMatch(/recorded_by|recordedBy|audit|proof/i);
      void business;
    });

    it('a CUSTOMER and a STAFF member receive none of it', async () => {
      const seller = await newSeller();
      await governAs(seller, 'governed');
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن');
      await governAs({ partyType: 'business', partyId: business.id }, 'legacy_exempt');
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const staff = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const membershipId = await seedMembership(dataSource, business.id, staff.id, 'manager', owner.id, null);
      await dataSource.query(`UPDATE business.business_staff SET status = 'active', responded_at = now() WHERE id = $1`, [membershipId]);

      const forCustomer = await dataSource.transaction((m) => contract.exportSubjectData(m, customer.id));
      expect(forCustomer).toEqual([]);
      const forStaff = await dataSource.transaction((m) => contract.exportSubjectData(m, staff.id));
      expect(forStaff.find((s) => s.key === 'commercial.booking_credit_party_governance')).toBeUndefined();
      expect(JSON.stringify(forStaff)).not.toContain(business.id);
    });

    it('erasure retains both tables completely and says so', async () => {
      const seller = await newSeller();
      await governAs(seller, 'governed');
      await setKillSwitch('engaged');
      const before = [await dataSource.query(`SELECT * FROM ${GOVERNANCE} ORDER BY id`), await controlRow()];

      const outcome = await contract.eraseSubjectData();
      expect(outcome.anonymized).toBe(0);
      expect(outcome.deleted).toBe(0);
      expect(outcome.retained.map((r) => r.table)).toEqual(expect.arrayContaining([CONTROL, GOVERNANCE]));

      expect([await dataSource.query(`SELECT * FROM ${GOVERNANCE} ORDER BY id`), await controlRow()]).toEqual(before);
    });

    it('the reads (GET and preview) write no audit row', async () => {
      const admin = await seedAdmin();
      await request(app.getHttpServer()).get(BASE).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
      await request(app.getHttpServer()).get(`${BASE}/preview`).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
      expect(await auditRows()).toEqual([]);
      expect(await dataSource.query(`SELECT count(*)::int AS n FROM admin.admin_audit_log WHERE created_at > $1`, [auditWatermark])).toEqual([{ n: 0 }]);
    });

    it('holds no control data in process memory: a row changed underneath the running app is seen by the very next read', async () => {
      const governance = app.get(BookingCreditEnforcementGovernanceService);
      expect((await governance.status()).killSwitchState).toBe('released');
      await setKillSwitch('engaged'); // by direct SQL, not through the service
      expect((await governance.status()).killSwitchState).toBe('engaged');
      const seller = await newSeller();
      expect((await tryBookZeroCollectible(seller)).refusal?.reason).toBe('control_refused');
      await setKillSwitch('released');
      expect((await governance.status()).killSwitchState).toBe('released');
    });
  });

  // =========================================================================
  // §J  Restart survival (ADR-050 §10 case 7) -- LAST, because it replaces the app
  // =========================================================================

  describe('§J control and governance state survive app.close() and a fresh boot (case 7)', () => {
    it('an engaged switch and a governed party are exactly as they were after a fresh createPgTestApp against the same database', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller();
      await grantCredits(seller, 1);
      await request(app.getHttpServer()).post(`${BASE}/transitions`).set('Authorization', `Bearer ${admin.accessToken}`).send(REASON).expect(201);
      await request(app.getHttpServer()).post(`${BASE}/kill-switch/engage`).set('Authorization', `Bearer ${admin.accessToken}`).send(REASON).expect(201);
      const controlBefore = await controlRow();
      const governanceBefore = await dataSource.query(`SELECT * FROM ${GOVERNANCE} ORDER BY id`);

      await app.close();
      ctx = await createPgTestApp();
      app = ctx.app;
      dataSource = ctx.dataSource;
      checkout = app.get(CheckoutService);
      bookings = app.get(BookingService);
      credits = app.get(BookingCreditAccountingService);
      subscriptions = app.get(SellerSubscriptionService);
      sandbox = app.get(SandboxPaymentProvider);
      enforcement = app.get(BookingCreditEnforcementControlService);

      expect(await controlRow()).toEqual(controlBefore);
      expect(await dataSource.query(`SELECT * FROM ${GOVERNANCE} ORDER BY id`)).toEqual(governanceBefore);
      const status = await request(app.getHttpServer()).get(BASE).set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status.body.data).toMatchObject({ killSwitchState: 'engaged', rolloutState: 'inactive', activationGeneration: 0 });
      // And the fresh process enforces the persisted switch immediately.
      const other = await newSeller();
      await grantCredits(other, 1);
      expect((await tryBookZeroCollectible(other)).refusal?.reason).toBe('control_refused');
      const preview = await request(app.getHttpServer()).get(`${BASE}/preview`).set('Authorization', `Bearer ${admin.accessToken}`);
      expect(preview.body.data).toMatchObject({ governed: 1, unresolved: 1, killSwitchState: 'engaged' });
    }, 60_000);
  });
});
