import { INestApplication, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import request from 'supertest';

import { AdminAuditService } from '@beauclick/audit';
import { BookingService } from '@beauclick/booking';
import { BusinessService } from '@beauclick/business';
import { OrderService } from '@beauclick/commerce';
import {
  BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY,
  BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE,
  BOOKING_ENTITLEMENT_LOCK_NAMESPACE,
  BookingCreditAccountingService,
  BookingCreditEnforcementGovernanceService,
  BookingCreditEnforcementSubjectDataContract,
  CommercialEnforcementActivationRefusedException,
  ENFORCEMENT_AUDIT_ACTIONS,
  SellerSubscriptionService,
  SubscriberPartyType,
} from '@beauclick/commercial-policy';
import { SandboxPaymentProvider } from '@beauclick/payment';
import { ProviderService } from '@beauclick/provider';

import { CheckoutService, ZeroCollectibleConfirmationRefusedException } from '../src/checkout/checkout.service';
import { BookingCreditEntitlementAdapter } from '../src/composition/booking-credit-entitlement.adapter';

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
 * REAL PostgreSQL: V3.3 Story #141 (`#58b-2`) -- global booking-credit
 * activation and enforcement, ADR-050 §3.4, §4.3 (the `active` rows), §7 and
 * §10 cases 3-6, 8, 9, 28.
 *
 * Everything here is about an advisory lock, a row lock, a trigger, a
 * rollback or a genuine race; pg-mem honours none of them. The #95 foundation
 * suite (`booking-credit-enforcement.pg-spec.ts`) runs AFTER this one in the
 * battery, so it is also the proof that an activated rollout does not leak
 * out of this suite: its fixture reset returns the singleton to the seeded
 * dormant state (§O below).
 */
describePg('booking-credit enforcement activation (#141 / #58b-2, real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let checkout: CheckoutService;
  let bookings: BookingService;
  let credits: BookingCreditAccountingService;
  let subscriptions: SellerSubscriptionService;
  let sandbox: SandboxPaymentProvider;
  let governance: BookingCreditEnforcementGovernanceService;
  let providers: ProviderService;
  let businessService: BusinessService;
  let hook: BookingCreditEntitlementAdapter;
  let audit: AdminAuditService;
  let orders: OrderService;

  let sequence = 0;
  const nextPhone = (): string => `+98917${String(1000000 + (sequence += 1)).slice(-7)}`;
  const CALLBACK_BASE = 'http://localhost:3099/api/v1/payments/callback';
  const BASE = '/api/v1/admin/commercial/booking-credit-enforcement';
  const REASON = { reason: 'global activation recorded by the #141 suite' };
  const CONTROL = 'commercial.booking_credit_enforcement_control';
  const GOVERNANCE = 'commercial.booking_credit_party_governance';

  function bind(): void {
    app = ctx.app;
    dataSource = ctx.dataSource;
    checkout = app.get(CheckoutService);
    bookings = app.get(BookingService);
    credits = app.get(BookingCreditAccountingService);
    subscriptions = app.get(SellerSubscriptionService);
    sandbox = app.get(SandboxPaymentProvider);
    governance = app.get(BookingCreditEnforcementGovernanceService);
    providers = app.get(ProviderService);
    businessService = app.get(BusinessService);
    hook = app.get(BookingCreditEntitlementAdapter);
    audit = app.get(AdminAuditService);
    orders = app.get(OrderService);
  }

  beforeAll(async () => {
    ctx = await createPgTestApp();
    bind();
  });

  afterAll(async () => {
    await app.close();
  });

  let auditWatermark: string;

  beforeEach(async () => {
    await resetDatabase(dataSource);
    auditWatermark = (await dataSource.query('SELECT clock_timestamp() AS t'))[0].t;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const controlRow = async () => (await dataSource.query(`SELECT * FROM ${CONTROL} WHERE id = 1`))[0];
  const governanceRows = async () => dataSource.query(`SELECT * FROM ${GOVERNANCE} ORDER BY party_type, party_id`);
  const governanceOf = async (party: { partyType: string; partyId: string }) =>
    (await dataSource.query(`SELECT * FROM ${GOVERNANCE} WHERE party_type = $1 AND party_id = $2`, [party.partyType, party.partyId]))[0] ?? null;
  interface AuditRow {
    id: string;
    action: string;
    actor_user_id: string | null;
    actor_label: string | null;
    target_id: string | null;
    reason: string | null;
    before_state: unknown;
    after_state: unknown;
  }
  const auditRows = async (): Promise<AuditRow[]> =>
    dataSource.query(
      `SELECT id, action, actor_user_id, actor_label, target_id, reason, before_state, after_state FROM admin.admin_audit_log
        WHERE target_type = 'commercial.booking_credit_enforcement' AND created_at > $1
        ORDER BY created_at, id`,
      [auditWatermark],
    );
  const auditRowById = async (id: string) => (await dataSource.query('SELECT * FROM admin.admin_audit_log WHERE id = $1', [id]))[0] ?? null;

  const seedAdmin = (): Promise<SeededUser> => seedUser(app, dataSource, nextPhone(), ['administrator']);
  const authed = (user: SeededUser) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${user.accessToken}`),
    post: (path: string) => request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${user.accessToken}`),
  });

  interface Seller {
    ownerId: string;
    professionalId: string;
    serviceId: string;
    partyType: SubscriberPartyType;
    partyId: string;
  }

  /** A professional seeded by SQL: eligible and UNRESOLVED, exactly as every pre-activation seller is. */
  async function newSeller(priceToman = 0): Promise<Seller> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, priceToman === 0 ? 'متخصص فعال‌سازی' : 'متخصص پرداختی', priceToman);
    return { ownerId: owner.id, professionalId: professional.id, serviceId: professional.serviceId, partyType: 'professional', partyId: professional.id };
  }

  /** A professional created through the REAL service -- the path the creation hook lives on. */
  async function createProfessionalViaService(): Promise<{ ownerId: string; professionalId: string }> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const created = await providers.create(owner.id, { displayName: `حرفه‌ای ${sequence}` });
    return { ownerId: owner.id, professionalId: created.id };
  }

  async function createBusinessViaService(ownerId?: string): Promise<{ ownerId: string; businessId: string }> {
    const owner = ownerId ?? (await seedUser(app, dataSource, nextPhone(), ['customer'])).id;
    const created = await businessService.create(owner, { displayName: `سالن ${sequence}` });
    return { ownerId: owner, businessId: created.id };
  }

  interface Attempt {
    customer: SeededUser;
    bookingId: string;
    orderId: string;
  }

  async function bookZeroCollectible(seller: Seller): Promise<Attempt> {
    const seq = (sequence += 1); // captured NOW: concurrent callers must not share a slot time
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const slotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(48 + seq));
    const result = await checkout.checkout({ customerId: customer.id, professionalId: seller.professionalId, slotId, serviceId: seller.serviceId, callbackBaseUrl: CALLBACK_BASE });
    return { customer, bookingId: result.bookingId, orderId: result.order.order.id };
  }

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

  async function bookPaid(seller: Seller, priceToman: number): Promise<PaidAttempt> {
    const seq = (sequence += 1);
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const slotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(300 + seq));
    const result = await checkout.checkout({ customerId: customer.id, professionalId: seller.professionalId, slotId, serviceId: seller.serviceId, callbackBaseUrl: CALLBACK_BASE });
    const [attempt] = await dataSource.query('SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1', [result.paymentIntentId]);
    return { customer, bookingId: result.bookingId, orderId: result.order.order.id, reference: attempt.provider_reference, priceToman };
  }

  const captureOf = async (booked: PaidAttempt) => {
    await sandbox.decide(booked.reference, 'success');
    return checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
  };

  /**
   * A pending booking and its pending order -- checkout's FIRST transaction --
   * without the confirmation that `checkout()` would run next, so a test can
   * drive the seam itself on a manager of its choosing.
   */
  async function pendingBookingFor(seller: Seller, manager = dataSource.manager): Promise<string> {
    const seq = (sequence += 1);
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const slotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(90 + seq));
    const created = await bookings.create({ customerId: customer.id, professionalId: seller.professionalId, slotId, serviceId: seller.serviceId, idempotencyKey: null }, manager);
    await orders.createForBooking({ bookingId: created.id, customerId: customer.id, professionalId: seller.professionalId, serviceId: seller.serviceId }, manager);
    return created.id;
  }

  const bookingRow = async (bookingId: string) => (await dataSource.query('SELECT * FROM booking.bookings WHERE id = $1', [bookingId]))[0];
  const orderRow = async (orderId: string) => (await dataSource.query('SELECT * FROM commerce.orders WHERE id = $1', [orderId]))[0];
  const consumptionsOf = async (bookingId: string) => dataSource.query('SELECT * FROM commercial.booking_credit_consumptions WHERE booking_id = $1', [bookingId]);
  const refundsFor = async (orderId: string) => dataSource.query('SELECT amount_toman, request_key FROM payment.refunds WHERE order_id = $1', [orderId]);
  const bookingOutboxFor = async (bookingId: string) =>
    dataSource.query(`SELECT event_type FROM booking.outbox_events WHERE aggregate_id = $1 AND event_type = 'BookingConfirmed'`, [bookingId]);

  async function ensureBasePlan(): Promise<void> {
    const [existing] = await dataSource.query("SELECT id FROM commercial.plan_versions WHERE auto_assignable = true AND lifecycle_state = 'published' LIMIT 1");
    if (existing) return;
    const scheduleVersionId = uuidv7();
    await dataSource.query("INSERT INTO commercial.price_schedules (schedule_key, purpose, created_by_label) VALUES ('act-suite', 'seller_plan', 'suite') ON CONFLICT DO NOTHING");
    await dataSource.query(
      `INSERT INTO commercial.price_schedule_versions (id, schedule_key, version, display_name, currency_code, min_purchase_quantity, max_purchase_quantity, ui_preset_quantities, activation_starts_at, created_by_label)
       VALUES ($1, 'act-suite', 1, 'act suite', 'IRT', 1, 1, '{}', '1970-01-01T00:00:00Z', 'suite')`,
      [scheduleVersionId],
    );
    await dataSource.query(`INSERT INTO commercial.price_tiers (id, schedule_version_id, min_quantity, max_quantity, unit_price_toman, created_by_label) VALUES ($1, $2, 1, 1, 0, 'suite')`, [uuidv7(), scheduleVersionId]);
    await dataSource.query("UPDATE commercial.price_schedule_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1", [scheduleVersionId]);
    const planVersionId = uuidv7();
    await dataSource.query("INSERT INTO commercial.plans (plan_key, created_by_label) VALUES ('ACT-SUITE', 'suite') ON CONFLICT DO NOTHING");
    await dataSource.query(
      `INSERT INTO commercial.plan_versions (id, plan_key, version, display_name, billing_term_days, included_booking_credits, staff_seats, included_locations, capability_keys, price_schedule_version_id, auto_assignable, activation_starts_at, created_by_label)
       VALUES ($1, 'ACT-SUITE', 1, 'act suite', NULL, 0, 0, 0, '{}', $2, true, '1970-01-01T00:00:00Z', 'suite')`,
      [planVersionId, scheduleVersionId],
    );
    await dataSource.query("UPDATE commercial.plan_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1", [planVersionId]);
  }

  /** A positive grant, planted exactly as the #58a and #95 suites plant one. */
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

  async function setKillSwitch(state: 'engaged' | 'released'): Promise<void> {
    await dataSource.query(`UPDATE ${CONTROL} SET kill_switch_state = $1, kill_switch_changed_at = now(), kill_switch_audit_id = $2, updated_at = now() WHERE id = 1`, [state, uuidv7()]);
  }

  /**
   * Resolves EVERY eligible seller through the two #95 commands -- the only
   * production way a pre-activation seller is classified -- then activates
   * through the real command. Returns the administrator that did it.
   */
  async function resolveAll(admin: SeededUser): Promise<void> {
    await governance.transitionEntitledParties(admin.id, REASON.reason);
    await governance.exemptUnentitledParties(admin.id, REASON.reason);
  }

  async function activateAs(admin: SeededUser): Promise<request.Response> {
    return authed(admin).post(`${BASE}/activation`).send(REASON);
  }

  async function resolveAndActivate(): Promise<SeededUser> {
    const admin = await seedAdmin();
    await resolveAll(admin);
    const response = await activateAs(admin);
    expect(response.status).toBe(201);
    expect(response.body.data.rolloutState).toBe('active');
    return admin;
  }

  async function ledgerSnapshot(
    tables: string[] = [
      'commercial.booking_credit_grants',
      'commercial.booking_credit_consumptions',
      'commercial.booking_credit_returns',
      'commercial.seller_subscriptions',
      'commercial.plan_versions',
      'commercial.price_schedule_versions',
      'commercial.price_tiers',
      'booking.bookings',
      'commerce.orders',
      'payment.refunds',
    ],
  ): Promise<string> {
    const parts: string[] = [];
    for (const table of tables) parts.push(table, JSON.stringify(await dataSource.query(`SELECT * FROM ${table} ORDER BY id`)));
    return parts.join('\n');
  }

  /** A manual transaction on its own connection, for the races below. */
  async function openTransaction(): Promise<QueryRunner> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    return runner;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Resolves to 'settled' if the promise settles within `ms`, else 'pending' -- without consuming a rejection. */
  async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
    const sentinel = Symbol('pending');
    const outcome = await Promise.race([promise.then(() => 'settled' as const, () => 'settled' as const), sleep(ms).then(() => sentinel)]);
    return outcome === sentinel ? 'pending' : 'settled';
  }

  /** The bcgv coordination lock as held by a backend, from pg_locks. */
  async function coordinationLocks(): Promise<Array<{ pid: number; mode: string; granted: boolean }>> {
    return dataSource.query(
      `SELECT pid, mode, granted FROM pg_locks
        WHERE locktype = 'advisory' AND classid = $1::bigint::oid AND objid = $2::bigint::oid AND objsubid = 2
        ORDER BY pid`,
      [BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE, BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY],
    );
  }

  /** The bcre party lock for ONE party, held by the given backend. */
  async function partyLockHeldBy(pid: number, party: { partyType: string; partyId: string }): Promise<boolean> {
    const rows = await dataSource.query(
      `SELECT granted FROM pg_locks
        WHERE locktype = 'advisory' AND pid = $1 AND classid = $2::bigint::oid AND objsubid = 2
          AND objid = ((hashtext($3)::bigint) & 4294967295)::oid`,
      [pid, BOOKING_ENTITLEMENT_LOCK_NAMESPACE, `${party.partyType}:${party.partyId}`],
    );
    return rows.length === 1 && rows[0].granted === true;
  }

  const pidOf = async (runner: QueryRunner): Promise<number> => Number((await runner.query('SELECT pg_backend_pid() AS pid'))[0].pid);

  // =========================================================================
  // §K  The activation command (ADR-050 §7, §9; cases 3, 4)
  // =========================================================================

  describe('§K the activation command over the real route table (ADR-050 §5.2, §7, §9)', () => {
    it('the preview route still exists, is read-only, and there is no activation/preview and no deactivation', async () => {
      const admin = await seedAdmin();
      const preview = await authed(admin).get(`${BASE}/preview`);
      expect(preview.status).toBe(200);
      expect(Object.keys(preview.body.data).sort()).toEqual(['activationGeneration', 'eligible', 'governed', 'killSwitchState', 'legacyExempt', 'rolloutState', 'unresolved', 'wouldBeRefused']);
      expect(await auditRows()).toEqual([]);
      expect((await authed(admin).post(`${BASE}/activation/preview`).send(REASON)).status).toBe(404);
      expect((await authed(admin).get(`${BASE}/activation/preview`)).status).toBe(404);
      expect((await authed(admin).post(`${BASE}/deactivation`).send(REASON)).status).toBe(404);
      expect((await authed(admin).get(`${BASE}/activation`)).status).toBe(404);
    });

    it('refuses an unauthenticated caller with 401, and a customer, an operator, a business_staff member and a seller owner with 403 -- writing nothing', async () => {
      expect((await request(app.getHttpServer()).post(`${BASE}/activation`).send(REASON)).status).toBe(401);

      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const operator = await seedUser(app, dataSource, nextPhone(), ['platform_operator']);
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business', 'professional']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن');
      const staffUser = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const staffProfessional = await seedProfessional(dataSource, staffUser.id, 'کارمند', 0);
      const membershipId = await seedMembership(dataSource, business.id, staffUser.id, 'manager', owner.id, staffProfessional.id);
      await dataSource.query(`UPDATE business.business_staff SET status = 'active', responded_at = now() WHERE id = $1`, [membershipId]);

      for (const caller of [customer, operator, owner, staffUser]) {
        expect((await activateAs(caller)).status).toBe(403);
      }
      expect((await controlRow()).rollout_state).toBe('inactive');
      expect(await auditRows()).toEqual([]);
    });

    it('rejects an unknown body field, an unknown query parameter and a missing reason with 400 before anything is written', async () => {
      const admin = await seedAdmin();
      expect((await authed(admin).post(`${BASE}/activation`).send({ ...REASON, generation: 2 })).status).toBe(400);
      expect((await authed(admin).post(`${BASE}/activation`).send({ ...REASON, partyId: uuidv7() })).status).toBe(400);
      expect((await authed(admin).post(`${BASE}/activation?force=true`).send(REASON)).status).toBe(400);
      expect((await authed(admin).post(`${BASE}/activation`).send({})).status).toBe(400);
      expect((await authed(admin).post(`${BASE}/activation`).send({ reason: 'x' })).status).toBe(400);
      expect((await controlRow()).rollout_state).toBe('inactive');
      expect(await auditRows()).toEqual([]);
    });

    it('refuses with ONE unresolved eligible seller: 409, exactly the preview counts, and nothing written -- not even an audit row (case 3)', async () => {
      const admin = await seedAdmin();
      const governed = await newSeller();
      await grantCredits(governed, 1);
      await newSeller(); // eligible, unresolved, no grant
      await governance.transitionEntitledParties(admin.id, REASON.reason); // governs the first; the second stays unresolved
      const before = { control: await controlRow(), governance: await governanceRows(), ledger: await ledgerSnapshot() };
      const preview = (await authed(admin).get(`${BASE}/preview`)).body.data;
      expect(preview).toMatchObject({ eligible: 2, governed: 1, legacyExempt: 0, unresolved: 1 });

      const response = await activateAs(admin);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('COMMERCIAL_ENFORCEMENT_ACTIVATION_REFUSED');
      expect(response.body.error.details).toEqual(preview);
      expect(JSON.stringify(response.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);

      expect(await controlRow()).toEqual(before.control);
      expect(await governanceRows()).toEqual(before.governance);
      expect(await ledgerSnapshot()).toBe(before.ledger);
      expect((await auditRows()).map((r) => r.action)).toEqual(['commercial.enforcement_parties_governed']);

      // Through the service, the same refusal is the same typed exception with the same details.
      await expect(governance.activate(admin.id, REASON.reason)).rejects.toBeInstanceOf(CommercialEnforcementActivationRefusedException);
    });

    it('succeeds once every eligible seller is governed or legacy_exempt: generation +1 exactly once, activated_at from the database clock, the audit row pointed at -- and a replay writes nothing (case 4)', async () => {
      const admin = await seedAdmin();
      const entitled = await newSeller();
      await grantCredits(entitled, 2);
      const legacy = await newSeller();
      await resolveAll(admin);
      expect(await governanceOf(entitled)).toMatchObject({ state: 'governed', cause: 'explicit_transition' });
      expect(await governanceOf(legacy)).toMatchObject({ state: 'legacy_exempt', cause: 'explicit_exemption' });
      const ledgerBefore = await ledgerSnapshot();
      const [{ now: dbBefore }] = await dataSource.query('SELECT now()');

      const first = await activateAs(admin);
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({ rolloutState: 'active', activationGeneration: 1, killSwitchState: 'released', killSwitchChangedAt: null });
      expect(Object.keys(first.body.data).sort()).toEqual(['activatedAt', 'activationGeneration', 'killSwitchChangedAt', 'killSwitchState', 'rolloutState']);

      const row = await controlRow();
      expect(row.rollout_state).toBe('active');
      expect(row.activation_generation).toBe(1);
      expect(new Date(row.activated_at).getTime()).toBeGreaterThanOrEqual(new Date(dbBefore).getTime());
      expect(row.kill_switch_state).toBe('released');
      const activationAudit = await auditRowById(row.activation_audit_id);
      expect(activationAudit).toMatchObject({
        action: ENFORCEMENT_AUDIT_ACTIONS.activated,
        actor_user_id: admin.id,
        actor_label: null,
        target_type: 'commercial.booking_credit_enforcement',
        target_id: 'booking_credit_enforcement_control',
        reason: REASON.reason,
        before_state: { rolloutState: 'inactive', activationGeneration: 0 },
        after_state: { rolloutState: 'active', activationGeneration: 1, eligible: 2, governed: 1, legacyExempt: 1, unresolved: 0, wouldBeRefused: 0 },
      });
      // Activation rewrote nothing: no grant, subscription, consumption, plan, price, booking, order or refund row moved.
      expect(await ledgerSnapshot()).toBe(ledgerBefore);
      expect((await auditRows()).map((r) => r.action)).toEqual([
        'commercial.enforcement_parties_governed',
        'commercial.enforcement_parties_exempted',
        'commercial.enforcement_activated',
      ]);

      // Replay: same answer, no second audit row, generation unchanged.
      const second = await activateAs(admin);
      expect(second.status).toBe(201);
      expect(second.body.data).toEqual(first.body.data);
      expect(await controlRow()).toEqual(row);
      expect((await auditRows()).filter((r) => r.action === 'commercial.enforcement_activated')).toHaveLength(1);

      // And PostgreSQL still forbids every reverse or drift, whoever asks.
      for (const sql of [
        `UPDATE ${CONTROL} SET rollout_state = 'inactive', activated_at = NULL, activation_audit_id = NULL, activation_generation = 0 WHERE id = 1`,
        `UPDATE ${CONTROL} SET activation_generation = 0 WHERE id = 1`,
        `UPDATE ${CONTROL} SET activation_generation = 2 WHERE id = 1`,
        `UPDATE ${CONTROL} SET activated_at = now() WHERE id = 1`,
        `DELETE FROM ${CONTROL} WHERE id = 1`,
      ]) {
        await expect(dataSource.query(sql)).rejects.toMatchObject({ code: '23001' });
      }
      expect(await controlRow()).toEqual(row);
    });

    it('two CONCURRENT activations produce one activation, one audit row and generation 1 -- the other is a replay', async () => {
      const admin = await seedAdmin();
      const other = await seedAdmin();
      await grantCredits(await newSeller(), 1);
      await resolveAll(admin);

      const results = await Promise.allSettled([governance.activate(admin.id, REASON.reason), governance.activate(other.id, REASON.reason)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      for (const r of results) if (r.status === 'fulfilled') expect(r.value).toMatchObject({ rolloutState: 'active', activationGeneration: 1 });
      expect((await controlRow()).activation_generation).toBe(1);
      expect((await auditRows()).filter((r) => r.action === 'commercial.enforcement_activated')).toHaveLength(1);
    });

    it('a failure at the control UPDATE -- after the audit insert -- rolls back BOTH, and the singleton stays inactive', async () => {
      const admin = await seedAdmin();
      await grantCredits(await newSeller(), 1);
      await resolveAll(admin);
      await dataSource.query(`
        CREATE OR REPLACE FUNCTION commercial.planted_refuse_activation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'planted failure at the activation update' USING ERRCODE = 'raise_exception'; END $$;
        CREATE TRIGGER tg_planted_refuse_activation BEFORE UPDATE OF rollout_state ON ${CONTROL}
          FOR EACH ROW EXECUTE FUNCTION commercial.planted_refuse_activation();`);
      try {
        const response = await activateAs(admin);
        expect(response.status).toBe(500);
        expect(await controlRow()).toMatchObject({ rollout_state: 'inactive', activation_generation: 0, activation_audit_id: null, activated_at: null });
        expect((await auditRows()).map((r) => r.action)).toEqual(['commercial.enforcement_parties_governed']);
      } finally {
        await dataSource.query(`DROP TRIGGER IF EXISTS tg_planted_refuse_activation ON ${CONTROL}; DROP FUNCTION IF EXISTS commercial.planted_refuse_activation();`);
      }
      // Non-vacuity: with nothing planted the same call activates.
      expect((await activateAs(admin)).status).toBe(201);
      expect((await auditRows()).map((r) => r.action)).toContain('commercial.enforcement_activated');
    });

    it('an engaged kill switch is not a precondition and is not bypassed: activation succeeds, confirmations stay refused until release', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller();
      await grantCredits(seller, 1);
      await resolveAll(admin);
      await authed(admin).post(`${BASE}/kill-switch/engage`).send(REASON).expect(201);

      const response = await activateAs(admin);
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ rolloutState: 'active', killSwitchState: 'engaged' });
      expect((await tryBookZeroCollectible(seller)).refusal?.reason).toBe('control_refused');
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(1);

      await authed(admin).post(`${BASE}/kill-switch/release`).send(REASON).expect(201);
      const { attempt } = await tryBookZeroCollectible(seller);
      expect(attempt).toBeDefined();
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(0);
    });
  });

  // =========================================================================
  // §K'  Activation under concurrency (ADR-050 §7.2; cases 5, 6)
  // =========================================================================

  describe("§K' activation is linearised against seller creation, explicit transition and the preview partition (cases 5, 6)", () => {
    it('a seller mid-creation under an INACTIVE rollout holds activation until it commits, and activation then REFUSES because that seller is unresolved (case 5, creation first)', async () => {
      const admin = await seedAdmin();
      await grantCredits(await newSeller(), 1);
      await resolveAll(admin);
      expect((await governance.preview()).unresolved).toBe(0);

      // T1: exactly what the creation hook does under an inactive rollout --
      // the seller row is in, bcgv is held shared, nothing else is written,
      // and the transaction is still open.
      const t1 = await openTransaction();
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await t1.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE, BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY]);
      await t1.query(`INSERT INTO provider.professionals (id, owner_id, display_name, verification_status) VALUES ($1, $2, 'در حال ساخت', 'unverified')`, [uuidv7(), owner.id]);
      await t1.query(`SELECT * FROM ${CONTROL} WHERE id = 1 FOR SHARE`);

      const activation = governance.activate(admin.id, REASON.reason);
      expect(await settlesWithin(activation, 700)).toBe('pending');
      expect((await coordinationLocks()).filter((l) => l.mode === 'ExclusiveLock')).toEqual([expect.objectContaining({ granted: false })]);

      await t1.commitTransaction();
      await t1.release();
      await expect(activation).rejects.toBeInstanceOf(CommercialEnforcementActivationRefusedException);
      expect((await controlRow()).rollout_state).toBe('inactive');
      expect((await governance.preview()).unresolved).toBe(1);
    });

    it('a creation that starts while activation holds the lock waits, reads ACTIVE, and governs itself in its own transaction (case 5, activation first)', async () => {
      const admin = await seedAdmin();
      await grantCredits(await newSeller(), 1);
      await resolveAll(admin);

      // T1: activation in progress -- bcgv exclusive, singleton FOR UPDATE,
      // the UPDATE written but not yet committed.
      const t1 = await openTransaction();
      await t1.query('SELECT pg_advisory_xact_lock($1, $2)', [BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE, BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY]);
      await t1.query(`SELECT * FROM ${CONTROL} WHERE id = 1 FOR UPDATE`);
      await t1.query(`UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 1, activated_at = now(), activation_audit_id = $1 WHERE id = 1`, [uuidv7()]);

      const creation = createProfessionalViaService();
      expect(await settlesWithin(creation, 700)).toBe('pending');
      expect((await coordinationLocks()).filter((l) => l.mode === 'ShareLock')).toEqual([expect.objectContaining({ granted: false })]);

      await t1.commitTransaction();
      await t1.release();
      const created = await creation;
      expect(await governanceOf({ partyType: 'professional', partyId: created.professionalId })).toMatchObject({
        state: 'governed',
        cause: 'created_under_enforcement',
        proof_grant_id: null,
        recorded_by_user_id: null,
        recorded_by_label: 'system',
      });
      expect((await governance.preview()).unresolved).toBe(0);
    });

    it('activation and seller creation under Promise.allSettled never leave an unresolved seller under an active rollout (case 5, repeated)', async () => {
      const admin = await seedAdmin();
      await grantCredits(await newSeller(), 1);
      await resolveAll(admin);

      for (let round = 0; round < 4; round += 1) {
        const outcomes = await Promise.allSettled([
          createProfessionalViaService(),
          governance.activate(admin.id, REASON.reason),
          createBusinessViaService(),
          createProfessionalViaService(),
        ]);
        const row = await controlRow();
        const preview = await governance.preview();
        if (row.rollout_state === 'active') {
          expect(preview.unresolved).toBe(0);
        } else {
          // Activation refused because a creation committed first: every creation still succeeded, nothing is governed by it.
          expect(outcomes[1].status).toBe('rejected');
          expect(preview.unresolved).toBeGreaterThan(0);
          await resolveAll(admin);
        }
        for (const [i, o] of outcomes.entries()) if (i !== 1) expect(o.status).toBe('fulfilled');
      }
      expect((await controlRow()).rollout_state).toBe('active');
      expect((await governance.preview()).unresolved).toBe(0);
    });

    it('an explicit transition in flight holds activation; it commits WHOLLY before activation reads (case 6)', async () => {
      const admin = await seedAdmin();
      const late = await newSeller();
      await grantCredits(late, 1);
      const other = await newSeller();
      await grantCredits(other, 1);
      await resolveAll(admin); // both governed
      // One NEW unresolved, entitled seller, for the in-flight transition to govern.
      const fresh = await newSeller();
      await grantCredits(fresh, 1);
      expect((await governance.preview()).unresolved).toBe(1);

      // T1: the transition command's locks and its uncommitted governance write for `fresh`.
      const t1 = await openTransaction();
      await t1.query('SELECT pg_advisory_xact_lock_shared($1, $2)', [BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE, BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY]);
      await t1.query(`SELECT * FROM ${CONTROL} WHERE id = 1 FOR SHARE`);
      await t1.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [BOOKING_ENTITLEMENT_LOCK_NAMESPACE, `${fresh.partyType}:${fresh.partyId}`]);
      const [grant] = await t1.query('SELECT id FROM commercial.booking_credit_grants WHERE subscriber_party_id = $1', [fresh.partyId]);
      await t1.query(
        `INSERT INTO ${GOVERNANCE} (id, party_type, party_id, state, cause, proof_grant_id, governed_at, recorded_by_user_id, recorded_by_label, audit_id)
         VALUES ($1, $2, $3, 'governed', 'explicit_transition', $4, now(), $5, NULL, $6)`,
        [uuidv7(), fresh.partyType, fresh.partyId, grant.id, admin.id, uuidv7()],
      );

      const activation = governance.activate(admin.id, REASON.reason);
      expect(await settlesWithin(activation, 700)).toBe('pending');
      await t1.commitTransaction();
      await t1.release();
      // The transition committed before activation's read: activation sees zero unresolved and succeeds.
      await expect(activation).resolves.toMatchObject({ rolloutState: 'active', activationGeneration: 1 });
      expect((await auditRowById((await controlRow()).activation_audit_id)).after_state).toMatchObject({ unresolved: 0, governed: 3 });
    });

    it('preview and activation agree on the partition AT the linearisation point: with activation\'s locks held, preview sees exactly what activation will commit, and no writer can slip between', async () => {
      const admin = await seedAdmin();
      await grantCredits(await newSeller(), 1);
      await newSeller();
      await resolveAll(admin);

      const t1 = await openTransaction();
      await t1.query('SELECT pg_advisory_xact_lock($1, $2)', [BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE, BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY]);
      await t1.query(`SELECT * FROM ${CONTROL} WHERE id = 1 FOR UPDATE`);
      const underLocks = await governance.partition(t1.manager); // the same function, on activation's manager
      const preview = await governance.preview(); // takes no lock: never blocked, same snapshot
      expect(preview).toMatchObject(underLocks);

      // A creation and a transition attempted now cannot commit a governance change before T1 does.
      const creation = createProfessionalViaService();
      const transition = governance.transitionEntitledParties(admin.id, REASON.reason);
      expect(await settlesWithin(creation, 500)).toBe('pending');
      expect(await settlesWithin(transition, 200)).toBe('pending');
      expect(await governance.partition(t1.manager)).toEqual(underLocks);

      await t1.rollbackTransaction();
      await t1.release();
      await Promise.all([creation, transition]);
      // Now the real activation: its audit counts equal a preview taken immediately before under its own locks.
      const before = await governance.preview();
      const response = await activateAs(admin);
      expect(response.status).toBe(409); // the creation above left one unresolved seller
      expect(response.body.error.details).toEqual(before);
    });
  });

  // =========================================================================
  // §L  The creation hook (ADR-050 §3.4; case 28) and the system audit id
  // =========================================================================

  describe('§L seller creation writes governance under an ACTIVE rollout only, atomically, with its audit row (case 28)', () => {
    it('under an INACTIVE rollout, neither creation path writes a governance row or an enforcement audit row', async () => {
      const professional = await createProfessionalViaService();
      const business = await createBusinessViaService();
      expect(await governanceRows()).toEqual([]);
      expect(await auditRows()).toEqual([]);
      // Both sellers exist -- creation was not blocked by the hook.
      expect(await dataSource.query('SELECT id FROM provider.professionals WHERE id = $1', [professional.professionalId])).toHaveLength(1);
      expect(await dataSource.query('SELECT id FROM business.businesses WHERE id = $1', [business.businessId])).toHaveLength(1);
      // The hook still took part: bcgv was released at commit and nothing lingers.
      expect(await coordinationLocks()).toEqual([]);
    });

    it('under an ACTIVE rollout, a professional and a business are each governed in their own creating transaction: created_under_enforcement, no grant, system actor, audit row pointed at (case 28)', async () => {
      await resolveAndActivate();
      const professional = await createProfessionalViaService();
      const business = await createBusinessViaService();

      for (const party of [
        { partyType: 'professional', partyId: professional.professionalId },
        { partyType: 'business', partyId: business.businessId },
      ]) {
        const row = await governanceOf(party);
        expect(row).toMatchObject({ state: 'governed', cause: 'created_under_enforcement', proof_grant_id: null, recorded_by_user_id: null, recorded_by_label: 'system' });
        expect(row.governed_at).not.toBeNull();
        const auditRow = await auditRowById(row.audit_id);
        expect(auditRow).toMatchObject({
          action: ENFORCEMENT_AUDIT_ACTIONS.partyGovernedAtCreation,
          actor_user_id: null,
          actor_label: 'system',
          target_type: 'commercial.booking_credit_enforcement',
          target_id: 'booking_credit_party_governance',
          after_state: { partyType: party.partyType, state: 'governed', cause: 'created_under_enforcement' },
        });
        // No party id, owner id or user id in the audit row's states.
        expect(JSON.stringify([auditRow.before_state, auditRow.after_state])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        expect(await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_grants WHERE subscriber_party_id = $1', [party.partyId])).toEqual([{ n: 0 }]);
      }
      expect((await auditRows()).filter((r) => r.action === ENFORCEMENT_AUDIT_ACTIONS.partyGovernedAtCreation)).toHaveLength(2);
      expect((await governance.preview()).unresolved).toBe(0);
    });

    it('a dual owner creating a professional AND a business under an active rollout gets two independent governed rows', async () => {
      await resolveAndActivate();
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const professional = await providers.create(owner.id, { displayName: 'دوگانه' });
      const business = await businessService.create(owner.id, { displayName: 'سالن دوگانه' });
      const rows = await governanceRows();
      expect(rows.map((r: { party_type: string; party_id: string }) => `${r.party_type}:${r.party_id}`).sort()).toEqual(
        [`business:${business.id}`, `professional:${professional.id}`].sort(),
      );
      expect(new Set(rows.map((r: { audit_id: string }) => r.audit_id)).size).toBe(2);
    });

    it('a failing hook creates NO seller: the professional row, the owner role and the system audit row all roll back together (case 28; recordSystem regression)', async () => {
      await resolveAndActivate();
      await dataSource.query(`
        CREATE OR REPLACE FUNCTION commercial.planted_refuse_governance() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'planted failure at the governance insert' USING ERRCODE = 'raise_exception'; END $$;
        CREATE TRIGGER tg_planted_refuse_governance BEFORE INSERT ON ${GOVERNANCE}
          FOR EACH ROW EXECUTE FUNCTION commercial.planted_refuse_governance();`);
      const auditsBefore = (await auditRows()).length;
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const businessOwner = await seedUser(app, dataSource, nextPhone(), ['customer']);
      try {
        await expect(providers.create(owner.id, { displayName: 'ناموفق' })).rejects.toThrow(/planted failure/);
        await expect(businessService.create(businessOwner.id, { displayName: 'سالن ناموفق' })).rejects.toThrow(/planted failure/);
      } finally {
        await dataSource.query(`DROP TRIGGER IF EXISTS tg_planted_refuse_governance ON ${GOVERNANCE}; DROP FUNCTION IF EXISTS commercial.planted_refuse_governance();`);
      }
      expect(await dataSource.query('SELECT id FROM provider.professionals WHERE owner_id = $1', [owner.id])).toEqual([]);
      expect(await dataSource.query('SELECT id FROM business.businesses WHERE owner_id = $1', [businessOwner.id])).toEqual([]);
      expect(await dataSource.query(`SELECT role_slug FROM identity.user_roles WHERE user_id = $1 AND role_slug IN ('professional', 'business')`, [owner.id])).toEqual([]);
      expect(await dataSource.query(`SELECT role_slug FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'business'`, [businessOwner.id])).toEqual([]);
      // The system audit row written BEFORE the refused insert did not survive: `recordSystem` is in the caller's transaction.
      expect((await auditRows()).length).toBe(auditsBefore);
      // Non-vacuity: with nothing planted the same owner creates a governed professional.
      const created = await providers.create(owner.id, { displayName: 'موفق' });
      expect(await governanceOf({ partyType: 'professional', partyId: created.id })).toMatchObject({ state: 'governed' });
    });

    it('recordSystem returns the id of the row it persisted, and that row does not outlive a rolled-back transaction', async () => {
      let returned = '';
      await dataSource.transaction(async (m) => {
        returned = await audit.recordSystem(m, { actorLabel: 'system', action: ENFORCEMENT_AUDIT_ACTIONS.partyGovernedAtCreation, targetType: 'commercial.booking_credit_enforcement', targetId: 'suite' });
        expect(returned).toMatch(/^[0-9a-f-]{36}$/);
        const [row] = await m.query('SELECT id, actor_label FROM admin.admin_audit_log WHERE id = $1', [returned]);
        expect(row).toEqual({ id: returned, actor_label: 'system' });
      });
      expect(await auditRowById(returned)).not.toBeNull();

      let rolledBack = '';
      await expect(
        dataSource.transaction(async (m) => {
          rolledBack = await audit.recordSystem(m, { actorLabel: 'system', action: ENFORCEMENT_AUDIT_ACTIONS.partyGovernedAtCreation, targetType: 'commercial.booking_credit_enforcement', targetId: 'suite' });
          throw new Error('planted after the audit insert');
        }),
      ).rejects.toThrow('planted after the audit insert');
      expect(await auditRowById(rolledBack)).toBeNull();
    });

    it('staff invitation and acceptance under an ACTIVE rollout write no governance row: affiliation is not ownership', async () => {
      await resolveAndActivate();
      const business = await createBusinessViaService();
      const rowsAfterCreation = await governanceRows();
      const staffUser = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const membershipId = await seedMembership(dataSource, business.businessId, staffUser.id, 'manager', business.ownerId, null);
      await dataSource.query(`UPDATE business.business_staff SET status = 'active', responded_at = now() WHERE id = $1`, [membershipId]);
      expect(await governanceRows()).toEqual(rowsAfterCreation);
      expect((await auditRows()).filter((r) => r.action === ENFORCEMENT_AUDIT_ACTIONS.partyGovernedAtCreation)).toHaveLength(1);
    });
  });

  // =========================================================================
  // §M  The four planes under an ACTIVE rollout, on both checkout paths
  //     (ADR-050 §4.3 active rows; cases 8, 9, 21)
  // =========================================================================

  describe('§M the four-plane outcome table under an ACTIVE rollout (ADR-050 §4.3; cases 8, 9)', () => {
    /** Sellers arranged BEFORE activation, then activation through the real command. */
    async function activatedWorld(): Promise<{ admin: SeededUser; governedFunded: Seller; governedExhausted: Seller; legacyDormant: Seller; legacyExhausted: Seller }> {
      const admin = await seedAdmin();
      const governedFunded = await newSeller();
      await grantCredits(governedFunded, 1);
      const governedExhausted = await newSeller();
      await grantCredits(governedExhausted, 1);
      const legacyDormant = await newSeller();
      const legacyExhausted = await newSeller();
      await resolveAll(admin); // funded/exhausted -> governed; the two without grants -> legacy_exempt
      await exhaust(governedExhausted);
      // A legacy_exempt seller that LATER received a grant and spent it: #58a's selective path applies to it.
      await grantCredits(legacyExhausted, 1);
      await exhaust(legacyExhausted);
      expect((await activateAs(admin)).status).toBe(201);
      return { admin, governedFunded, governedExhausted, legacyDormant, legacyExhausted };
    }

    it('a governed seller that never held a positive grant is REFUSED on the zero-collectible path: not_configured is no longer a permit (case 9)', async () => {
      await resolveAndActivate();
      const created = await createProfessionalViaService(); // governed at creation, no grant
      await dataSource.query(`INSERT INTO provider.services (id, professional_id, name, duration_minutes, price_toman) VALUES ($1, $2, 'خدمت', 60, 0)`, [uuidv7(), created.professionalId]);
      const [{ id: serviceId }] = await dataSource.query('SELECT id FROM provider.services WHERE professional_id = $1', [created.professionalId]);
      const seller: Seller = { ownerId: created.ownerId, professionalId: created.professionalId, serviceId, partyType: 'professional', partyId: created.professionalId };
      const before = await ledgerSnapshot(['commercial.booking_credit_grants', 'commercial.booking_credit_consumptions', 'commercial.booking_credit_returns']);

      const { refusal, attempt } = await tryBookZeroCollectible(seller);
      expect(attempt).toBeUndefined();
      expect(refusal?.reason).toBe('control_refused');
      expect(refusal?.getResponse()).toMatchObject({ code: 'BOOKING_NOT_CONFIRMABLE' });
      expect(await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_consumptions')).toEqual([{ n: 0 }]);
      expect(await ledgerSnapshot(['commercial.booking_credit_grants', 'commercial.booking_credit_consumptions', 'commercial.booking_credit_returns'])).toBe(before);
      const [pending] = await dataSource.query('SELECT status FROM booking.bookings WHERE professional_id = $1', [seller.professionalId]);
      expect(pending.status).toBe('pending');
      const [order] = await dataSource.query('SELECT status, collected_total_toman FROM commerce.orders WHERE seller_party_id = $1', [seller.partyId]);
      expect(order).toEqual({ status: 'pending', collected_total_toman: '0' });
      // The internal reason, at the seam: governed + not_configured -> entitlement_missing.
      const [{ id: bookingId }] = await dataSource.query('SELECT id FROM booking.bookings WHERE professional_id = $1', [seller.professionalId]);
      const decision = await dataSource.transaction((m) => hook.onBookingConfirmation(m, bookingId));
      expect(decision).toEqual({ outcome: 'control_refused', reason: 'entitlement_missing' });
    });

    it('a governed seller with ZERO remaining credit is refused on BOTH paths; a governed seller with credit consumes exactly one (case 8)', async () => {
      const world = await activatedWorld();

      // Zero-collectible, exhausted: refused, nothing consumed, nothing collected.
      const refusedFree = await tryBookZeroCollectible(world.governedExhausted);
      expect(refusedFree.refusal?.reason).toBe('control_refused');
      expect(await credits.balanceFor(dataSource.manager, world.governedExhausted)).toBe(0);

      // Zero-collectible, funded: consumed once.
      const ok = await bookZeroCollectible(world.governedFunded);
      expect((await bookingRow(ok.bookingId)).status).toBe('confirmed');
      expect(await consumptionsOf(ok.bookingId)).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, world.governedFunded)).toBe(0);
      // ... and the next first confirmation for the same seller is refused.
      expect((await tryBookZeroCollectible(world.governedFunded)).refusal?.reason).toBe('control_refused');

      // Verified-capture path, exhausted: the capture stands, no consumption, booking pending, ONE refund.
      const paidSeller = await newSeller(250_000);
      await grantCredits(paidSeller, 1);
      await governance.transitionEntitledParties(world.admin.id, REASON.reason);
      await exhaust(paidSeller);
      const booked = await bookPaid(paidSeller, 250_000);
      const result = await captureOf(booked);
      expect(Number((await orderRow(booked.orderId)).collected_total_toman)).toBe(250_000);
      expect((await bookingRow(booked.bookingId)).status).toBe('pending');
      expect(await consumptionsOf(booked.bookingId)).toHaveLength(0);
      expect(await bookingOutboxFor(booked.bookingId)).toEqual([]);
      const refunds = await refundsFor(booked.orderId);
      expect(refunds).toEqual([{ amount_toman: '250000', request_key: `booking-unconfirmable:${booked.orderId}` }]);
      expect(result.refundIssued).toBe(true);
      // A gateway retry refunds nothing further and consumes nothing.
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
      expect(await refundsFor(booked.orderId)).toHaveLength(1);
      expect(await consumptionsOf(booked.bookingId)).toHaveLength(0);
    });

    it('a governed seller WITH credit on the verified-capture path consumes exactly once, confirms, and emits the confirmation event -- and a callback replay consumes nothing more', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller(300_000);
      await grantCredits(seller, 1);
      await resolveAll(admin);
      expect((await activateAs(admin)).status).toBe(201);
      const booked = await bookPaid(seller, 300_000);
      const result = await captureOf(booked);
      expect(result.refundIssued).toBe(false);
      expect((await bookingRow(booked.bookingId)).status).toBe('confirmed');
      expect(await consumptionsOf(booked.bookingId)).toHaveLength(1);
      expect(await bookingOutboxFor(booked.bookingId)).toHaveLength(1);
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
      expect(await consumptionsOf(booked.bookingId)).toHaveLength(1);
      expect(await refundsFor(booked.orderId)).toEqual([]);
    });

    it('a legacy_exempt seller confirms EXACTLY as before activation: dormant proceeds without consumption, exhausted refuses (the #58a selective path)', async () => {
      const world = await activatedWorld();
      const dormant = await bookZeroCollectible(world.legacyDormant);
      expect((await bookingRow(dormant.bookingId)).status).toBe('confirmed');
      expect(await consumptionsOf(dormant.bookingId)).toHaveLength(0);
      const decisionDormant = await dataSource.transaction((m) => hook.onBookingConfirmation(m, dormant.bookingId));
      expect(decisionDormant).toEqual({ outcome: 'permitted', detail: 'not_configured' });

      const { refusal } = await tryBookZeroCollectible(world.legacyExhausted);
      expect(refusal?.reason).toBe('insufficient_credit');
      expect(await credits.balanceFor(dataSource.manager, world.legacyExhausted)).toBe(0);
    });

    it('an UNRESOLVED seller under an active rollout (a malformed state made by hand) is refused as business_policy_disabled and the ledger is never consulted', async () => {
      await resolveAndActivate();
      const seller = await newSeller(); // seeded by SQL after activation: unresolved -- the state the hook makes unreachable in production
      await grantCredits(seller, 5); // credit available, and still refused: no plane substitutes for another
      const before = await ledgerSnapshot(['commercial.booking_credit_grants', 'commercial.booking_credit_consumptions', 'commercial.booking_credit_returns']);

      const { refusal, attempt } = await tryBookZeroCollectible(seller);
      expect(attempt).toBeUndefined();
      expect(refusal?.reason).toBe('control_refused');
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(5);
      expect(await ledgerSnapshot(['commercial.booking_credit_grants', 'commercial.booking_credit_consumptions', 'commercial.booking_credit_returns'])).toBe(before);
      const [booking] = await dataSource.query('SELECT id, status FROM booking.bookings WHERE professional_id = $1', [seller.professionalId]);
      expect(booking.status).toBe('pending');
      expect(await dataSource.transaction((m) => hook.onBookingConfirmation(m, booking.id))).toEqual({ outcome: 'control_refused', reason: 'business_policy_disabled' });

      // Paid path: capture stands, nothing consumed, refunded once.
      const paid = await newSeller(120_000);
      await grantCredits(paid, 5);
      const booked = await bookPaid(paid, 120_000);
      await captureOf(booked);
      expect((await bookingRow(booked.bookingId)).status).toBe('pending');
      expect(await consumptionsOf(booked.bookingId)).toHaveLength(0);
      expect(await refundsFor(booked.orderId)).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, paid)).toBe(5);
    });

    it('the kill switch, engaged under an active rollout, refuses governed-with-credit, legacy_exempt and unresolved sellers alike, with no fallback and no consumption; released, the governed seller consumes', async () => {
      const world = await activatedWorld();
      const unresolved = await newSeller();
      await grantCredits(unresolved, 1);
      await setKillSwitch('engaged');
      for (const seller of [world.governedFunded, world.legacyDormant, unresolved]) {
        expect((await tryBookZeroCollectible(seller)).refusal?.reason).toBe('control_refused');
      }
      expect(await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_consumptions WHERE booking_id IN (SELECT id FROM booking.bookings)')).toEqual([{ n: 0 }]);
      await setKillSwitch('released');
      const ok = await bookZeroCollectible(world.governedFunded);
      expect(await consumptionsOf(ok.bookingId)).toHaveLength(1);
      expect((await tryBookZeroCollectible(unresolved)).refusal?.reason).toBe('control_refused'); // still unresolved: business_policy_disabled
    });

    it('the customer sees ONE identical public body for every control refusal and for exhaustion (case 21)', async () => {
      const world = await activatedWorld();
      const unresolved = await newSeller();
      const bodies: string[] = [];
      for (const seller of [world.governedExhausted, world.legacyExhausted, unresolved]) {
        const { refusal } = await tryBookZeroCollectible(seller);
        bodies.push(JSON.stringify(refusal?.getResponse()));
        expect(refusal?.getStatus()).toBe(409);
      }
      await setKillSwitch('engaged');
      const { refusal } = await tryBookZeroCollectible(world.governedFunded);
      bodies.push(JSON.stringify(refusal?.getResponse()));
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).not.toMatch(/kill|rollout|entitlement|policy|balance|credit|governed|unresolved/i);
    });

    it('a booking confirmed BEFORE activation stays confirmed and manageable afterwards: cancellation still returns the credit, completion still works', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller();
      await grantCredits(seller, 2);
      const earlier = await bookZeroCollectible(seller); // legacy path, consumed 1
      await resolveAll(admin);
      expect((await activateAs(admin)).status).toBe(201);
      expect((await bookingRow(earlier.bookingId)).status).toBe('confirmed');
      await bookings.cancel(earlier.bookingId, { type: 'professional', id: seller.ownerId }, 'seller unavailable');
      expect(await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_returns')).toEqual([{ n: 1 }]);
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(2);
      const later = await bookZeroCollectible(seller);
      await dataSource.query(`UPDATE booking.bookings SET slot_start = now() - interval '2 hours', slot_end = now() - interval '1 hour' WHERE id = $1`, [later.bookingId]);
      expect(await bookings.complete(later.bookingId, { type: 'professional', id: seller.ownerId })).toBe(true);
      expect((await bookingRow(later.bookingId)).status).toBe('completed');
    });

    it('a staff professional\'s order charges the BUSINESS: the business\'s governance decides, never the professional\'s own party and never live affiliation', async () => {
      const admin = await seedAdmin();
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن کارفرما');
      const staffUser = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const staffProfessional = await seedProfessional(dataSource, staffUser.id, 'کارمند', 0);
      const membershipId = await seedMembership(dataSource, business.id, staffUser.id, 'staff', owner.id, staffProfessional.id);
      await dataSource.query(`UPDATE business.business_staff SET status = 'active', responded_at = now() WHERE id = $1`, [membershipId]);
      const businessParty = { partyType: 'business' as const, partyId: business.id };
      await grantCredits(businessParty, 1);
      // The staff member's OWN professional party: no grant -> legacy_exempt; the business: grant -> governed.
      await resolveAll(admin);
      expect(await governanceOf(businessParty)).toMatchObject({ state: 'governed' });
      expect(await governanceOf({ partyType: 'professional', partyId: staffProfessional.id })).toMatchObject({ state: 'legacy_exempt' });
      expect((await activateAs(admin)).status).toBe(201);

      const seller: Seller = { ownerId: staffUser.id, professionalId: staffProfessional.id, serviceId: staffProfessional.serviceId, partyType: 'business', partyId: business.id };
      const first = await bookZeroCollectible(seller);
      expect((await orderRow(first.orderId)).seller_party_id).toBe(business.id);
      expect(await consumptionsOf(first.bookingId)).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, businessParty)).toBe(0);
      // Second: the business is exhausted -> refused, although the professional's own (legacy_exempt) party would have been dormant.
      expect((await tryBookZeroCollectible(seller)).refusal?.reason).toBe('control_refused');
      // Deactivating the affiliation NOW changes nothing for the order already snapshotted to the business.
      await dataSource.query(`UPDATE business.business_staff SET status = 'inactive' WHERE id = $1`, [membershipId]);
      const [pending] = await dataSource.query(`SELECT id FROM booking.bookings WHERE professional_id = $1 AND status = 'pending'`, [staffProfessional.id]);
      expect(await dataSource.transaction((m) => hook.onBookingConfirmation(m, pending.id))).toEqual({ outcome: 'control_refused', reason: 'entitlement_missing' });
    });

    it('under an INACTIVE rollout a governed row changes nothing: governance is not consulted and the legacy path stands (case 10 for #141)', async () => {
      const seller = await newSeller();
      await dataSource.query(
        `INSERT INTO ${GOVERNANCE} (id, party_type, party_id, state, cause, proof_grant_id, governed_at, recorded_by_user_id, recorded_by_label, audit_id)
         VALUES ($1, 'professional', $2, 'governed', 'created_under_enforcement', NULL, now(), NULL, 'suite', $3)`,
        [uuidv7(), seller.partyId, uuidv7()],
      );
      const attempt = await bookZeroCollectible(seller);
      expect((await bookingRow(attempt.bookingId)).status).toBe('confirmed');
      expect(await dataSource.transaction((m) => hook.onBookingConfirmation(m, attempt.bookingId))).toEqual({ outcome: 'permitted', detail: 'not_configured' });
    });
  });

  // =========================================================================
  // §N  Concurrency, locks and atomicity on the confirmation path
  // =========================================================================

  describe('§N the governance read is under the party lock, on the caller\'s manager, for the whole transaction; activation and confirmation never mix', () => {
    it('the confirmation transaction holds the bcre party lock from the governance read until commit, and a transition of the SAME party waits behind it', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller(); // no grant -> legacy_exempt at resolution
      await resolveAll(admin);
      expect((await activateAs(admin)).status).toBe(201);
      await grantCredits(seller, 2); // now the transition command WANTS this party (legacy_exempt with a positive grant)
      const bookingId = await pendingBookingFor(seller);

      // T1: a confirmation in flight, stopped right after the seam -- legacy_exempt under active: the #58a path consumes.
      const t1 = await openTransaction();
      const pid = await pidOf(t1);
      expect(await hook.onBookingConfirmation(t1.manager, bookingId)).toEqual({ outcome: 'permitted', detail: 'consumed' });
      expect(await partyLockHeldBy(pid, seller)).toBe(true);

      // The same party's transition (bcgv shared -> control FOR SHARE -> bcre) blocks on bcre until T1 commits.
      const transition = governance.transitionEntitledParties(admin.id, REASON.reason);
      expect(await settlesWithin(transition, 700)).toBe('pending');
      await t1.commitTransaction();
      await t1.release();
      await expect(transition).resolves.toEqual({ affected: 1, skipped: 0 });
      expect(await partyLockHeldBy(pid, seller)).toBe(false);
      expect(await governanceOf(seller)).toMatchObject({ state: 'governed', cause: 'explicit_transition' });
      // The consumption T1 wrote committed exactly once; the party is now governed with one credit left.
      expect(await consumptionsOf(bookingId)).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(1);
    });

    it('the seam holds the bcre party lock even when the ledger is never consulted: an unresolved refusal under an active rollout leaves the lock held until commit', async () => {
      await resolveAndActivate();
      const seller = await newSeller(); // seeded by SQL after activation: unresolved
      await grantCredits(seller, 1);
      const bookingId = await pendingBookingFor(seller);
      const t1 = await openTransaction();
      const pid = await pidOf(t1);
      expect(await partyLockHeldBy(pid, seller)).toBe(false);
      expect(await hook.onBookingConfirmation(t1.manager, bookingId)).toEqual({ outcome: 'control_refused', reason: 'business_policy_disabled' });
      // No consumption was attempted, so the only way this lock can be held is the seam's own acquisition before the governance read.
      expect(await partyLockHeldBy(pid, seller)).toBe(true);
      expect(await t1.query('SELECT count(*)::int AS n FROM commercial.booking_credit_consumptions WHERE booking_id = $1', [bookingId])).toEqual([{ n: 0 }]);
      await t1.rollbackTransaction();
      await t1.release();
      expect(await partyLockHeldBy(pid, seller)).toBe(false);
    });

    it('the BookingConfirmed outbox event is written on the confirming transaction\'s own manager: rolling that transaction back leaves no event, no confirmation and no consumption', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller();
      await grantCredits(seller, 1);
      await resolveAll(admin);
      expect((await activateAs(admin)).status).toBe(201);
      const bookingId = await pendingBookingFor(seller);
      const t1 = await openTransaction();
      expect(await hook.onBookingConfirmation(t1.manager, bookingId)).toEqual({ outcome: 'permitted', detail: 'consumed' });
      expect(await bookings.confirm(bookingId, { type: 'system', id: null }, t1.manager)).toBe(true);
      // Visible inside T1 ...
      expect(await t1.query(`SELECT count(*)::int AS n FROM booking.outbox_events WHERE aggregate_id = $1 AND event_type = 'BookingConfirmed'`, [bookingId])).toEqual([{ n: 1 }]);
      await t1.rollbackTransaction();
      await t1.release();
      // ... and gone with it.
      expect(await bookingOutboxFor(bookingId)).toEqual([]);
      expect((await bookingRow(bookingId)).status).toBe('pending');
      expect(await consumptionsOf(bookingId)).toHaveLength(0);
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(1);
    });

    it('the governance read uses the CALLER\'s manager: a governance row written in the same, still-open transaction is honoured by the seam', async () => {
      await resolveAndActivate();
      const seller = await newSeller();
      await grantCredits(seller, 1);
      // Unresolved as far as any other connection is concerned.
      expect(await governanceOf(seller)).toBeNull();
      const t1 = await openTransaction();
      await t1.query(
        `INSERT INTO ${GOVERNANCE} (id, party_type, party_id, state, cause, proof_grant_id, governed_at, recorded_by_user_id, recorded_by_label, audit_id)
         VALUES ($1, 'professional', $2, 'governed', 'created_under_enforcement', NULL, now(), NULL, 'suite', $3)`,
        [uuidv7(), seller.partyId, uuidv7()],
      );
      const bookingId = await pendingBookingFor(seller, t1.manager);
      // Seen on T1's manager: governed, so the ledger is consulted and consumes.
      expect(await hook.onBookingConfirmation(t1.manager, bookingId)).toEqual({ outcome: 'permitted', detail: 'consumed' });
      await t1.rollbackTransaction();
      await t1.release();
      expect(await governanceOf(seller)).toBeNull();
      expect(await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_consumptions')).toEqual([{ n: 0 }]);
    });

    it('activation racing a confirmation yields one complete policy state: a confirmation holding the control row FOR SHARE finishes on the legacy path and activation waits; one starting after activation commits is decided by the active rows', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller();
      await resolveAll(admin); // legacy_exempt (no grant)
      const governedNoGrant = await createProfessionalViaService();
      await dataSource.query(`INSERT INTO provider.services (id, professional_id, name, duration_minutes, price_toman) VALUES ($1, $2, 'خدمت', 60, 0)`, [uuidv7(), governedNoGrant.professionalId]);
      // Govern `governedNoGrant` explicitly before activation would refuse it: plant the row an activation-era creation would have written.
      await dataSource.query(
        `INSERT INTO ${GOVERNANCE} (id, party_type, party_id, state, cause, proof_grant_id, governed_at, recorded_by_user_id, recorded_by_label, audit_id)
         VALUES ($1, 'professional', $2, 'governed', 'created_under_enforcement', NULL, now(), NULL, 'suite', $3)`,
        [uuidv7(), governedNoGrant.professionalId, uuidv7()],
      );

      // T1: a confirmation for the governed-no-grant seller, in flight under the INACTIVE rollout.
      const [{ id: serviceId }] = await dataSource.query('SELECT id FROM provider.services WHERE professional_id = $1', [governedNoGrant.professionalId]);
      const seller2: Seller = { ownerId: governedNoGrant.ownerId, professionalId: governedNoGrant.professionalId, serviceId, partyType: 'professional', partyId: governedNoGrant.professionalId };
      const bookingId = await pendingBookingFor(seller2);
      const t1 = await openTransaction();
      expect(await hook.onBookingConfirmation(t1.manager, bookingId)).toEqual({ outcome: 'permitted', detail: 'not_configured' }); // legacy: governance not consulted

      const activation = governance.activate(admin.id, REASON.reason);
      expect(await settlesWithin(activation, 700)).toBe('pending'); // FOR UPDATE waits behind T1's FOR SHARE
      await t1.commitTransaction();
      await t1.release();
      await expect(activation).resolves.toMatchObject({ rolloutState: 'active' });

      // After activation, the SAME seller's next first confirmation is decided by the active rows: refused.
      expect((await tryBookZeroCollectible(seller2)).refusal?.reason).toBe('control_refused');
      // And a legacy_exempt seller is untouched by the activation.
      const ok = await bookZeroCollectible(seller);
      expect((await bookingRow(ok.bookingId)).status).toBe('confirmed');
    });

    it('a confirmation that starts while activation is UNCOMMITTED waits on the control row and is then decided by the committed active state', async () => {
      const admin = await seedAdmin();
      await grantCredits(await newSeller(), 1);
      await resolveAll(admin);
      // A governed party with NO grant: the legacy path would permit it (not_configured), the active rows refuse it --
      // so which state decided the confirmation is observable.
      const governedNoGrant = await newSeller();
      await dataSource.query(
        `INSERT INTO ${GOVERNANCE} (id, party_type, party_id, state, cause, proof_grant_id, governed_at, recorded_by_user_id, recorded_by_label, audit_id)
         VALUES ($1, 'professional', $2, 'governed', 'created_under_enforcement', NULL, now(), NULL, 'suite', $3)`,
        [uuidv7(), governedNoGrant.partyId, uuidv7()],
      );

      const t1 = await openTransaction();
      await t1.query('SELECT pg_advisory_xact_lock($1, $2)', [BOOKING_ENFORCEMENT_COORDINATION_LOCK_NAMESPACE, BOOKING_ENFORCEMENT_COORDINATION_LOCK_KEY]);
      await t1.query(`SELECT * FROM ${CONTROL} WHERE id = 1 FOR UPDATE`);
      await t1.query(`UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 1, activated_at = now(), activation_audit_id = $1 WHERE id = 1`, [uuidv7()]);

      const confirmation = tryBookZeroCollectible(governedNoGrant);
      expect(await settlesWithin(confirmation, 700)).toBe('pending'); // FOR SHARE waits behind T1's FOR UPDATE
      await t1.commitTransaction();
      await t1.release();
      const { refusal, attempt } = await confirmation;
      expect(attempt).toBeUndefined();
      expect(refusal?.reason).toBe('control_refused'); // decided by the ACTIVE rows: governed + not_configured -> entitlement_missing
    });

    it('two concurrent first confirmations for one governed seller with ONE credit consume exactly one; replays of the same booking consume nothing more', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller();
      await grantCredits(seller, 1);
      await resolveAll(admin);
      expect((await activateAs(admin)).status).toBe(201);
      const outcomes = await Promise.allSettled([tryBookZeroCollectible(seller), tryBookZeroCollectible(seller), tryBookZeroCollectible(seller)]);
      const attempts = outcomes.filter((o) => o.status === 'fulfilled' && o.value.attempt).length;
      const refusals = outcomes.filter((o) => o.status === 'fulfilled' && o.value.refusal).length;
      const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected').map((o) => String(o.reason));
      expect({ attempts, refusals, rejected }).toEqual({ attempts: 1, refusals: 2, rejected: [] });
      expect(await dataSource.query('SELECT count(*)::int AS n FROM commercial.booking_credit_consumptions')).toEqual([{ n: 1 }]);
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(0);
    });

    it('the seam replayed for ONE booking consumes once: the second call is already_consumed, and the party\'s balance moves by exactly one', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller();
      await grantCredits(seller, 2);
      await resolveAll(admin);
      expect((await activateAs(admin)).status).toBe(201);
      const bookingId = await pendingBookingFor(seller);
      expect(await dataSource.transaction((m) => hook.onBookingConfirmation(m, bookingId))).toEqual({ outcome: 'permitted', detail: 'consumed' });
      expect(await dataSource.transaction((m) => hook.onBookingConfirmation(m, bookingId))).toEqual({ outcome: 'permitted', detail: 'already_consumed' });
      // And twice inside ONE transaction, the shape a retried orchestrator step could take.
      const twice = await dataSource.transaction(async (m) => [await hook.onBookingConfirmation(m, bookingId), await hook.onBookingConfirmation(m, bookingId)]);
      expect(twice).toEqual([{ outcome: 'permitted', detail: 'already_consumed' }, { outcome: 'permitted', detail: 'already_consumed' }]);
      expect(await consumptionsOf(bookingId)).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(1);
    });

    it('a planted failure at the LAST step of the zero-collectible transaction rolls back the order transition, the consumption and the outbox event together', async () => {
      const admin = await seedAdmin();
      const seller = await newSeller();
      await grantCredits(seller, 1);
      await resolveAll(admin);
      expect((await activateAs(admin)).status).toBe(201);
      await dataSource.query(`
        CREATE OR REPLACE FUNCTION booking.planted_refuse_confirm() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status = 'confirmed' THEN RAISE EXCEPTION 'planted failure at booking confirmation' USING ERRCODE = 'raise_exception'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER tg_planted_refuse_confirm BEFORE UPDATE ON booking.bookings
          FOR EACH ROW EXECUTE FUNCTION booking.planted_refuse_confirm();`);
      try {
        await expect(bookZeroCollectible(seller)).rejects.toThrow(/planted failure/);
      } finally {
        await dataSource.query('DROP TRIGGER IF EXISTS tg_planted_refuse_confirm ON booking.bookings; DROP FUNCTION IF EXISTS booking.planted_refuse_confirm();');
      }
      const [booking] = await dataSource.query('SELECT id, status FROM booking.bookings WHERE professional_id = $1', [seller.professionalId]);
      expect(booking.status).toBe('pending');
      expect(await consumptionsOf(booking.id)).toHaveLength(0);
      expect(await bookingOutboxFor(booking.id)).toEqual([]);
      const [order] = await dataSource.query('SELECT status FROM commerce.orders WHERE seller_party_id = $1', [seller.partyId]);
      expect(order.status).toBe('pending');
      expect(await credits.balanceFor(dataSource.manager, seller)).toBe(1);
      // Non-vacuity: with nothing planted, the same seller confirms and consumes.
      const ok = await bookZeroCollectible(seller);
      expect(await consumptionsOf(ok.bookingId)).toHaveLength(1);
      expect(await bookingOutboxFor(ok.bookingId)).toHaveLength(1);
    });

    it('the adapter reads the control row, then governance under the party lock, then the ledger -- in that order, on the caller\'s manager (structural pin)', () => {
      const adapter = readFileSync(join(__dirname, '..', 'src', 'composition', 'booking-credit-entitlement.adapter.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const orderAt = adapter.indexOf("reason: 'no_order'");
      const controlAt = adapter.indexOf('this.enforcement.readForConfirmation(manager)');
      const governanceAt = adapter.indexOf('this.enforcement.readGovernanceForConfirmation(manager, party)');
      const policyAt = adapter.indexOf('this.enforcement.decideGovernance(control, governance)');
      const consumeAt = adapter.indexOf('this.credits.consumeForConfirmation(manager, bookingId, party)');
      const verdictAt = adapter.indexOf('this.enforcement.decideGovernedLedger(result.outcome)');
      expect([orderAt, controlAt, governanceAt, policyAt, consumeAt, verdictAt].every((i) => i > 0)).toBe(true);
      expect(orderAt).toBeLessThan(controlAt);
      expect(controlAt).toBeLessThan(governanceAt);
      expect(governanceAt).toBeLessThan(policyAt);
      expect(policyAt).toBeLessThan(consumeAt);
      expect(consumeAt).toBeLessThan(verdictAt);
      // The party is selected ONCE from the order and passed to both reads; nothing else is consulted.
      expect(adapter).toContain('const party = { partyType: order.sellerPartyType, partyId: order.sellerPartyId };');
      expect(adapter).not.toMatch(/business_staff|BusinessStaff|ownerId|owner_id|dataSource/);
    });
  });

  // =========================================================================
  // §O  The test harness: activation cannot leak into a later suite
  // =========================================================================

  describe('§O the fixture reset after activation (TRUNCATE + deterministic reseed) leaves production monotonicity intact', () => {
    it('after an activation, resetDatabase returns the singleton to the seeded dormant state; the protect trigger is still enabled and still refuses active -> inactive', async () => {
      await resolveAndActivate();
      expect((await controlRow()).rollout_state).toBe('active');

      await resetDatabase(dataSource);

      expect(await dataSource.query(`SELECT count(*)::int AS n FROM ${CONTROL}`)).toEqual([{ n: 1 }]);
      expect(await controlRow()).toMatchObject({ id: 1, rollout_state: 'inactive', activation_generation: 0, activated_at: null, activation_audit_id: null, kill_switch_state: 'released', kill_switch_changed_at: null, kill_switch_audit_id: null });
      expect(await dataSource.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'tg_bcec_protect'`)).toEqual([{ tgenabled: 'O' }]);
      expect(await dataSource.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'tg_bcpg_protect'`)).toEqual([{ tgenabled: 'O' }]);
      // Activate again by SQL in the trigger's legal shape, then prove the reverse is still refused -- the reset did not weaken anything.
      await dataSource.query(`UPDATE ${CONTROL} SET rollout_state = 'active', activation_generation = 1, activated_at = now(), activation_audit_id = $1 WHERE id = 1`, [uuidv7()]);
      await expect(dataSource.query(`UPDATE ${CONTROL} SET rollout_state = 'inactive', activation_generation = 0, activated_at = NULL, activation_audit_id = NULL WHERE id = 1`)).rejects.toMatchObject({ code: '23001' });
      // And a seller created now is governed: the reseeded row is the real, honoured control state, not a cached one.
      const created = await createProfessionalViaService();
      expect(await governanceOf({ partyType: 'professional', partyId: created.professionalId })).toMatchObject({ state: 'governed' });
    });

    it('the reset helper is test-only: no production source imports the factory, and the api build excludes the test directory', () => {
      const root = join(__dirname, '..', '..', '..');
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const full = join(dir, name);
          if (name === 'node_modules' || name === 'dist' || name === 'test') return [];
          // Specs beside production code are excluded from the build by `**/*.spec.ts`; only shippable files count.
          return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
        });
      const importers = [...walk(join(root, 'apps', 'api', 'src')), ...walk(join(root, 'services')), ...walk(join(root, 'libs'))].filter((file) =>
        /pg-test-app\.factory|resetEnforcementControl|resetDatabase\(/.test(readFileSync(file, 'utf8')),
      );
      expect(importers.map((f) => f.replace(root, ''))).toEqual([]);
      // The build config's roots are `src/**` only and every spec is excluded, so `apps/api/test/**` cannot be emitted.
      const tsconfig = readFileSync(join(root, 'apps', 'api', 'tsconfig.json'), 'utf8');
      expect(tsconfig).toContain('"include": ["src/**/*.ts"]');
      expect(tsconfig).toContain('"exclude": ["**/*.spec.ts"]');
    });
  });

  // =========================================================================
  // §P  Audit, privacy and logs
  // =========================================================================

  describe('§P audit closure, privacy dispositions and log hygiene', () => {
    it('every audit row #141 writes carries an action from the closed vocabulary, transactional, and never a party id in its states', async () => {
      const admin = await resolveAndActivate();
      await createProfessionalViaService();
      const rows = await auditRows();
      const closed = new Set<string>(Object.values(ENFORCEMENT_AUDIT_ACTIONS));
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        expect(closed.has(row.action)).toBe(true);
        expect(JSON.stringify([row.before_state, row.after_state])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        expect(row.actor_user_id === null ? row.actor_label : null).toBe(row.actor_user_id === null ? 'system' : null);
      }
      expect(rows.find((r) => r.action === ENFORCEMENT_AUDIT_ACTIONS.activated)?.actor_user_id).toBe(admin.id);
    });

    it('an owner\'s export carries a creation-governed party\'s state and cause and never the actor label, audit id or proof grant; the dispositions are unchanged and truthful', async () => {
      await resolveAndActivate();
      const created = await createProfessionalViaService();
      const contract = app.get(BookingCreditEnforcementSubjectDataContract);
      const sections = await dataSource.transaction((m) => contract.exportSubjectData(m, created.ownerId));
      const text = JSON.stringify(sections);
      expect(text).toContain('created_under_enforcement');
      expect(text).toContain('governed');
      expect(text).not.toMatch(/recorded_by|recordedBy|audit_id|auditId|proof_grant|proofGrant|"system"/);
      const claims = contract.tables;
      expect(claims.find((c) => c.table === 'commercial.booking_credit_enforcement_control')?.disposition).toBe('no_subject_data');
      expect(claims.find((c) => c.table === 'commercial.booking_credit_party_governance')?.disposition).toBe('retained');
    });

    it('a refused confirmation and a creation-time governance write log no party id, no balance, no reason detail and no secret', async () => {
      const lines: string[] = [];
      const spies = (['log', 'error', 'warn', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(function (this: unknown, message: unknown, ...rest: unknown[]) {
          lines.push([message, ...rest].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
        }),
      );
      const staticSpies = (['log', 'error', 'warn', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger, level).mockImplementation((message: unknown, ...rest: unknown[]) => {
          lines.push([message, ...rest].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
        }),
      );
      try {
        const admin = await seedAdmin();
        const paid = await newSeller(90_000);
        const free = await newSeller();
        await grantCredits(paid, 1);
        await grantCredits(free, 1);
        await resolveAll(admin);
        await exhaust(paid);
        await exhaust(free);
        expect((await activateAs(admin)).status).toBe(201);
        const created = await createProfessionalViaService();
        const booked = await bookPaid(paid, 90_000);
        await captureOf(booked);
        const { refusal } = await tryBookZeroCollectible(free);
        expect(refusal).toBeDefined();
        /*
         * Out of scope, and named rather than hidden: `ProviderService.create`
         * has written a `provider.created` OPERATIONAL audit line carrying the
         * new professional's id since V3.3 #75 (`AuditLogger`, the structured
         * application log -- not the privileged audit trail). That line is not
         * #141's and #141 does not change it; every line #141's own paths emit
         * -- the hook, activation, the refused confirmations and the
         * compensation -- is what is scanned here.
         */
        const scanned = lines.filter((line) => !/"action":"(provider|business)\.created"/.test(line));
        const joined = scanned.join('\n');
        expect(scanned.length).toBeGreaterThan(0); // the refused capture logs its compensation line: the scan is not vacuous
        expect(joined).toMatch(/refunded|Auto-refunding|refused/i);
        expect(joined).not.toContain(paid.partyId);
        expect(joined).not.toContain(free.partyId);
        expect(joined).not.toContain(created.professionalId);
        expect(joined).not.toContain(created.ownerId);
        expect(joined).not.toMatch(/balance|entitlement_missing|business_policy_disabled|kill_switch_active|not_configured|insufficient_credit/);
        expect(joined).not.toMatch(/postgres:\/\/|password|secret/i);
      } finally {
        for (const spy of [...spies, ...staticSpies]) spy.mockRestore();
      }
    });
  });
});
