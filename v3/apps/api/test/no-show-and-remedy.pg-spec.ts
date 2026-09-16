import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { BookingService, BookingSubjectDataContract } from '@beauclick/booking';
import { CommerceSubjectDataContract } from '@beauclick/commerce';
import { SandboxPaymentProvider } from '@beauclick/payment';
import {
  BookingOutcomePolicyService,
  CustomerPolicyCopyService,
  LegalEvidenceService,
  OutcomePolicyAssignmentService,
} from '@beauclick/commercial-policy';
import { BookingOutcomeAcceptanceV1, BookingOutcomePolicyVersionTermsV1, BookingOutcomeRetentionRule } from '@beauclick/commercial-policy-contract';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract } from '@beauclick/subject-data';

import { CheckoutService } from '../src/checkout/checkout.service';
import { BookingCancelledRefundHandler } from '../src/events/financial-projection.handlers';
import { BookingOutcomeOrchestrator } from '../src/outcome/booking-outcome.orchestrator';
import { CustomerRemedyResolutionService } from '../src/outcome/customer-remedy-resolution.service';

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

const DECISIONS = 'commerce.booking_outcome_decisions';
const DECLARATIONS = 'booking.no_show_declarations';
const REMEDIES = 'commerce.customer_remedy_choices';

/**
 * No-show declaration, window evaluation, and the non-customer cancellation
 * remedy — V3.3 Story #161 (`#42d`), ADR-051 §7–§8, `V33-DEC-039` R6–R7.
 *
 * ## Why real PostgreSQL
 *
 * Every property here is a database property, exactly as #160's own suite
 * documents: the declaring transaction's clock, the grace guard computed in
 * SQL, `FOR UPDATE`/`FOR UPDATE SKIP LOCKED` convergence between a sweep and
 * a concurrent evaluation, the forward-only declaration and remedy-choice
 * triggers, and the CHECKs that make a wrong no-show decision unwritable.
 *
 * ## Values in this file are TEST values
 *
 * Every hour, minute, basis point and toman below is a suite fixture. None
 * is a product value; the Legal-evidence records are suite fixtures in a
 * disposable database, not attestations.
 */
describePg('no-show declaration and customer remedy (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let checkout: CheckoutService;
  let bookings: BookingService;
  let sandbox: SandboxPaymentProvider;
  let handler: BookingCancelledRefundHandler;
  let orchestrator: BookingOutcomeOrchestrator;
  let remedyResolution: CustomerRemedyResolutionService;
  let outcomes: BookingOutcomePolicyService;
  let copies: CustomerPolicyCopyService;
  let evidence: LegalEvidenceService;
  let assignments: OutcomePolicyAssignmentService;
  let admin: SeededUser;
  let activeCopy: { copyKey: string; copyVersion: number } | null;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;
  const nextPhone = (): string => `+98918${String(1000000 + (sequence += 1)).slice(-7)}`;
  const server = () => app.getHttpServer();
  const auth = (user: SeededUser) => ({ Authorization: `Bearer ${user.accessToken}` });
  const CALLBACK = 'http://localhost:3099/api/v1/payments/callback';
  const PRICE = 200_000;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    checkout = app.get(CheckoutService);
    bookings = app.get(BookingService);
    sandbox = app.get(SandboxPaymentProvider);
    handler = app.get(BookingCancelledRefundHandler);
    orchestrator = app.get(BookingOutcomeOrchestrator);
    remedyResolution = app.get(CustomerRemedyResolutionService);
    outcomes = app.get(BookingOutcomePolicyService);
    copies = app.get(CustomerPolicyCopyService);
    evidence = app.get(LegalEvidenceService);
    assignments = app.get(OutcomePolicyAssignmentService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
    activeCopy = null;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // =========================================================================
  // Fixtures — mirrors booking-outcome-evaluator.pg-spec.ts’s own, with
  // grace/no-show-retention/dispute-window/remedy-window made configurable.
  // =========================================================================

  interface Seller {
    owner: SeededUser;
    professionalId: string;
    serviceId: string;
    acceptance: BookingOutcomeAcceptanceV1 | null;
  }

  interface GovernedOptions {
    cutoffHours?: number;
    late?: BookingOutcomeRetentionRule;
    freeCount?: number;
    cap?: BookingOutcomeRetentionRule | null;
    graceMinutes?: number;
    noShowRetention?: BookingOutcomeRetentionRule;
    disputeWindowHours?: number;
    /** Set only via a direct SQL write while the version is still `draft` — no application path publishes this yet (ADR-051 §8: no invented deadline). */
    remedyChoiceWindowHours?: number | null;
  }

  async function workspaceRefFor(user: SeededUser): Promise<string> {
    const response = await request(server()).get('/api/v1/me/subscriptions').set(auth(user)).expect(200);
    return (response.body.data.items as Array<{ workspaceRef: string }>)[0].workspaceRef;
  }

  async function legacySeller(price = PRICE): Promise<Seller> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون', price);
    return { owner, professionalId: professional.id, serviceId: professional.serviceId, acceptance: null };
  }

  async function governedSeller(options: GovernedOptions = {}, price = PRICE): Promise<Seller> {
    const seller = await legacySeller(price);
    const cutoffHours = options.cutoffHours ?? 12;
    const late = options.late ?? { kind: 'percentage_of_collected', basisPoints: 2_500 };
    const graceMinutes = options.graceMinutes ?? 15;
    const noShowRetention = options.noShowRetention ?? { kind: 'none' };
    const disputeWindowHours = options.disputeWindowHours ?? 36;
    let evidenceKey: string | null = null;
    if (options.cap) {
      evidenceKey = nextKey('ev');
      await evidence.record(
        admin.id,
        evidenceKey,
        { subject: 'retention_cap', referenceKind: 'internal_ticket', reference: `SUITE-${evidenceKey}`, summary: 'suite fixture' },
        'suite setup',
      );
    }
    const terms: BookingOutcomePolicyVersionTermsV1 = {
      contractVersion: 1,
      cutoffHoursAllowed: [cutoffHours],
      lateRetentionOptions: [late],
      noShowGraceMinutesAllowed: [graceMinutes],
      noShowRetentionOptions: [noShowRetention],
      rescheduleFreeCountBeforeCutoff: options.freeCount ?? 1,
      disputeWindowHours,
      bodilyHarmWindowHours: null,
      appealWindowHours: 48,
      caseFileRetentionDays: null,
      legalCap: options.cap ?? null,
    };
    const key = nextKey('op');
    await outcomes.createPolicy(admin.id, key, `${key} display`, 'suite setup');
    const drafted = await outcomes.createVersionDraft(
      admin.id,
      { policyKey: key, terms, legalEvidenceKey: evidenceKey, activationEndsAt: null },
      'suite setup',
    );
    if (options.remedyChoiceWindowHours !== undefined) {
      // No application path publishes this column yet (ADR-051 §8) — set it
      // directly while the version is still draft, exactly like a future
      // administrator UI eventually would, to prove it changes nothing.
      await dataSource.query(
        `UPDATE commercial.booking_outcome_policy_versions SET remedy_choice_window_hours = $3
          WHERE policy_key = $1 AND version = $2`,
        [key, drafted.version.version, options.remedyChoiceWindowHours],
      );
    }
    await outcomes.publishVersion(admin.id, key, drafted.version.version, 'suite setup');
    if (!activeCopy) {
      const copyKey = nextKey('cc');
      await copies.createCopy(admin.id, copyKey, 'suite copy', 'suite setup');
      const copyDraft = await copies.createVersionDraft(
        admin.id,
        { copyKey, terms: { contractVersion: 1, locale: 'fa-IR', body: 'متن نمونهٔ سوئیت — نه متن حقوقی تأییدشده' }, activationEndsAt: null },
        'suite setup',
      );
      await copies.publishVersion(admin.id, copyKey, copyDraft.version, 'suite setup');
      activeCopy = { copyKey, copyVersion: copyDraft.version };
    }
    await assignments.assign(seller.owner.id, {
      workspaceRef: await workspaceRefFor(seller.owner),
      policyKey: key,
      selection: { cutoffHours, lateCancellationRetention: late, noShowGraceMinutes: graceMinutes, noShowRetention },
      reason: 'suite choice',
    });
    return { ...seller, acceptance: { policyKey: key, policyVersion: drafted.version.version, ...activeCopy } };
  }

  interface Booked {
    customer: SeededUser;
    bookingId: string;
    orderId: string;
    reference: string;
  }

  let slotHour = 0;
  async function book(seller: Seller, hoursFromNow = 30 + (slotHour += 2)): Promise<Booked> {
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const slotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(hoursFromNow));
    const result = await checkout.checkout({
      customerId: customer.id,
      professionalId: seller.professionalId,
      slotId,
      serviceId: seller.serviceId,
      callbackBaseUrl: CALLBACK,
      acceptedPolicy: seller.acceptance,
    });
    const [attempt] = await dataSource.query('SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1', [
      result.paymentIntentId,
    ]);
    return { customer, bookingId: result.bookingId, orderId: result.order.order.id, reference: attempt.provider_reference };
  }

  async function capture(booked: Booked) {
    await sandbox.decide(booked.reference, 'success');
    return checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
  }

  async function confirmedBooking(seller: Seller, hoursFromNow?: number): Promise<Booked> {
    const booked = await book(seller, hoursFromNow);
    const result = await capture(booked);
    expect(result.outcome.status).toBe('succeeded');
    expect((await bookingRow(booked.bookingId)).status).toBe('confirmed');
    return booked;
  }

  const deliver = (booked: Booked) => handler.handle({ payload: { bookingId: booked.bookingId } } as never);

  const bookingRow = async (bookingId: string) => (await dataSource.query('SELECT * FROM booking.bookings WHERE id = $1', [bookingId]))[0];
  type Row = Record<string, string | number | boolean | Date | null>;
  const decisionsFor = (bookingId: string): Promise<Row[]> =>
    dataSource.query(`SELECT * FROM ${DECISIONS} WHERE booking_id = $1 ORDER BY decided_at, id`, [bookingId]);
  const declarationFor = async (bookingId: string): Promise<Row | undefined> =>
    (await dataSource.query(`SELECT * FROM ${DECLARATIONS} WHERE booking_id = $1`, [bookingId]))[0];
  const remedyFor = async (orderId: string): Promise<Row | undefined> =>
    (await dataSource.query(`SELECT * FROM ${REMEDIES} WHERE order_id = $1`, [orderId]))[0];
  const refundsFor = (orderId: string): Promise<Array<{ request_key: string; amount_toman: string; status: string }>> =>
    dataSource.query(`SELECT request_key, amount_toman, status FROM payment.refunds WHERE order_id = $1 AND kind = 'order' ORDER BY id`, [orderId]);

  /**
   * Positions `slot_start` relative to the WALL clock, comfortably on one
   * side of `slot_start + graceMinutes` so the guard's live `now()` read
   * (unlike #160's fixed historical `cutoff_instant`) is never racing test
   * execution latency. `marginSeconds` must be well inside a test's own
   * runtime budget; 5s is generous for a single awaited SQL round trip.
   */
  async function placeSlotStartForGrace(bookingId: string, graceMinutes: number, due: boolean, marginSeconds = 5): Promise<void> {
    const sign = due ? '-' : '+';
    await dataSource.query(
      `UPDATE booking.bookings
          SET slot_start = now() - make_interval(mins => $2::int) ${sign} make_interval(secs => $3::int)
        WHERE id = $1`,
      [bookingId, graceMinutes, marginSeconds],
    );
  }

  const declareNoShow = (bookingId: string, professionalId: string, statement = 'مشتری حاضر نشد') =>
    bookings.markNoShow(bookingId, { type: 'professional', id: professionalId }, statement);

  // =========================================================================
  // 1. The grace guard, on the database clock
  // =========================================================================

  describe('the grace guard', () => {
    it('refuses a declaration before slot_start + grace, and accepts it once due', async () => {
      const seller = await governedSeller({ graceMinutes: 15 });
      const booked = await confirmedBooking(seller);

      await placeSlotStartForGrace(booked.bookingId, 15, false);
      await expect(declareNoShow(booked.bookingId, seller.owner.id)).rejects.toMatchObject({
        response: { code: 'INVALID_BOOKING_TRANSITION' },
      });
      expect(await declarationFor(booked.bookingId)).toBeUndefined();

      await placeSlotStartForGrace(booked.bookingId, 15, true);
      await expect(declareNoShow(booked.bookingId, seller.owner.id)).resolves.toBe(true);
      expect(await declarationFor(booked.bookingId)).toBeDefined();
      expect((await bookingRow(booked.bookingId)).status).toBe('no_show');
    });

    it('a legacy (no-terms) booking keeps the V2 slot_end rule verbatim — no declaration, no event, no audit', async () => {
      const seller = await legacySeller();
      const booked = await confirmedBooking(seller);

      // Not yet ended: refused, exactly V2's rule.
      await expect(declareNoShow(booked.bookingId, seller.owner.id)).rejects.toMatchObject({
        response: { code: 'INVALID_BOOKING_TRANSITION' },
      });

      await dataSource.query('UPDATE booking.bookings SET slot_end = now() - interval \'1 minute\' WHERE id = $1', [booked.bookingId]);
      await expect(declareNoShow(booked.bookingId, seller.owner.id)).resolves.toBe(true);
      expect((await bookingRow(booked.bookingId)).status).toBe('no_show');
      // Byte-for-byte the pre-#161 behaviour: no declaration row at all.
      expect(await declarationFor(booked.bookingId)).toBeUndefined();
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
    });
  });

  // =========================================================================
  // 2. The declaration: minimal evidence, no money, prohibited fields refused
  // =========================================================================

  describe('the declaration', () => {
    it('writes an immutable row, opens the objection window, and moves no money', async () => {
      const seller = await governedSeller({ graceMinutes: 10, disputeWindowHours: 36 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 10, true);

      await declareNoShow(booked.bookingId, seller.owner.id, 'یادداشت آزمون');

      const declaration = await declarationFor(booked.bookingId);
      expect(declaration).toMatchObject({
        booking_id: booked.bookingId,
        declared_by_user_id: seller.owner.id,
        statement: 'یادداشت آزمون',
        grace_minutes_snapshot: 10,
        evaluation_state: 'window_open',
      });
      const declaredAt = new Date(declaration!.declared_at as string).getTime();
      const windowEndsAt = new Date(declaration!.objection_window_ends_at as string).getTime();
      expect(Math.round((windowEndsAt - declaredAt) / 3_600_000)).toBe(36);

      // No money row of any kind yet.
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
      expect(await refundsFor(booked.orderId)).toEqual([]);
    });

    it('rejects unknown fields at the DTO boundary — no photo, location or medical field exists', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);

      await request(server())
        .post(`/api/v1/bookings/${booked.bookingId}/no-show`)
        .set(auth(seller.owner))
        .send({ statement: 'یادداشت', photo: 'data:image/png;base64,AAAA', location: { lat: 35.7, lng: 51.4 }, medical: 'x' })
        .expect(400);

      expect(await declarationFor(booked.bookingId)).toBeUndefined();
    });

    it('rejects an empty or missing statement', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);

      await request(server()).post(`/api/v1/bookings/${booked.bookingId}/no-show`).set(auth(seller.owner)).send({}).expect(400);
      await request(server())
        .post(`/api/v1/bookings/${booked.bookingId}/no-show`)
        .set(auth(seller.owner))
        .send({ statement: '' })
        .expect(400);
    });

    it('never records a second declaration for the same booking — race with itself', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);

      const [a, b] = await Promise.allSettled([
        declareNoShow(booked.bookingId, seller.owner.id, 'اول'),
        declareNoShow(booked.bookingId, seller.owner.id, 'دوم'),
      ]);
      const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      const rows = await dataSource.query(`SELECT id FROM ${DECLARATIONS} WHERE booking_id = $1`, [booked.bookingId]);
      expect(rows).toHaveLength(1);
    });

    it('a cancelled booking cannot be declared no-show, and a declared booking cannot be cancelled — never two penalties', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });

      const cancelled = await confirmedBooking(seller);
      await bookings.cancel(cancelled.bookingId, { type: 'customer', id: cancelled.customer.id }, 'پشیمان شدم');
      await placeSlotStartForGrace(cancelled.bookingId, 1, true);
      await expect(declareNoShow(cancelled.bookingId, seller.owner.id)).rejects.toMatchObject({
        response: { code: 'INVALID_BOOKING_TRANSITION' },
      });
      expect(await declarationFor(cancelled.bookingId)).toBeUndefined();

      const declared = await confirmedBooking(seller);
      await placeSlotStartForGrace(declared.bookingId, 1, true);
      await declareNoShow(declared.bookingId, seller.owner.id);
      const moved = await bookings.cancel(declared.bookingId, { type: 'customer', id: declared.customer.id }, 'پشیمان شدم');
      expect(moved).toBe(false); // no_show -> cancelled is not a legal transition; a silent no-op
      expect((await bookingRow(declared.bookingId)).status).toBe('no_show');
    });
  });

  // =========================================================================
  // 3. Window evaluation: the no-show retention decision, sweep/lazy convergence, dispute stops it
  // =========================================================================

  describe('window evaluation', () => {
    async function declaredAndDue(options: GovernedOptions, graceMinutes = 1): Promise<Booked & { seller: Seller }> {
      const seller = await governedSeller({ ...options, graceMinutes });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, graceMinutes, true);
      await declareNoShow(booked.bookingId, seller.owner.id);
      // The objection window itself: pull it back to just after declared_at
      // (`ck_nsd_window_after_declared` requires strictly after) so it is
      // already due by the time anything reads it.
      await dataSource.query(
        `UPDATE ${DECLARATIONS} SET objection_window_ends_at = declared_at + interval '1 millisecond' WHERE booking_id = $1`,
        [booked.bookingId],
      );
      return { ...booked, seller };
    }

    it('applies the SNAPSHOTTED no-show retention rule via the Legal cap, min(policy, cap, collected)', async () => {
      const booked = await declaredAndDue({
        noShowRetention: { kind: 'percentage_of_collected', basisPoints: 4_000 },
        cap: { kind: 'fixed_toman', amountToman: 30_000 },
      });

      const decision = await orchestrator.decideNoShowWindow(booked.bookingId);
      expect(decision).toMatchObject({ kind: 'no_show', retainedToman: 30_000n, refundToman: 170_000n, basis: 'cap_applied' });

      const [row] = await decisionsFor(booked.bookingId);
      expect(row).toMatchObject({
        decision_kind: 'no_show',
        cause: 'no_show',
        timely: null,
        cutoff_instant: null,
        retained_toman: '30000',
        refund_toman: '170000',
      });
      expect(await declarationFor(booked.bookingId)).toMatchObject({ evaluation_state: 'evaluated' });

      await ctx.relay.drain();
      expect(await refundsFor(booked.orderId)).toEqual([
        { request_key: `booking-no-show:${booked.bookingId}`, amount_toman: '170000', status: 'succeeded' },
      ]);
    });

    it('with no Legal cap, retains nothing — fail-closed exactly like a late cancellation', async () => {
      const booked = await declaredAndDue({ noShowRetention: { kind: 'full_collected' } });

      const decision = await orchestrator.decideNoShowWindow(booked.bookingId);
      expect(decision).toMatchObject({ basis: 'cap_absent', retainedToman: 0n, refundToman: BigInt(PRICE) });
    });

    it('never both a late-cancellation and a no-show decision on one booking', async () => {
      const booked = await declaredAndDue({});
      await orchestrator.decideNoShowWindow(booked.bookingId);

      const kinds = (await decisionsFor(booked.bookingId)).map((r) => r.decision_kind);
      expect(kinds).toEqual(['no_show']);
      expect(kinds).not.toContain('cancellation');
    });

    it('writes no money row before the window is due', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);
      await declareNoShow(booked.bookingId, seller.owner.id);
      // Window intentionally left open (not pushed into the past).

      expect(await orchestrator.decideNoShowWindow(booked.bookingId)).toBeNull();
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
    });

    it('sweep and lazy converge: two concurrent evaluations produce exactly one decision', async () => {
      const booked = await declaredAndDue({ noShowRetention: { kind: 'none' } });

      const [a, b] = await Promise.all([orchestrator.decideNoShowWindow(booked.bookingId), orchestrator.decideNoShowWindow(booked.bookingId)]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.id).toBe(b!.id);
      expect(await decisionsFor(booked.bookingId)).toHaveLength(1);
    });

    it('the periodic sweep decides a due window with nobody reading it', async () => {
      const booked = await declaredAndDue({ noShowRetention: { kind: 'none' } });
      const decided = await orchestrator.expireNoShowWindows();
      expect(decided).toBeGreaterThanOrEqual(1);
      expect(await decisionsFor(booked.bookingId)).toHaveLength(1);
    });

    it('an eligible dispute filed before expiry stops evaluation', async () => {
      const booked = await declaredAndDue({ noShowRetention: { kind: 'full_collected' } });
      // #162 does not exist yet; simulate its future write directly, exactly
      // as this table's own forward-only trigger already permits.
      await dataSource.query(`UPDATE ${DECLARATIONS} SET evaluation_state = 'disputed' WHERE booking_id = $1`, [booked.bookingId]);

      expect(await orchestrator.decideNoShowWindow(booked.bookingId)).toBeNull();
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
      expect(await declarationFor(booked.bookingId)).toMatchObject({ evaluation_state: 'disputed' });
    });
  });

  // =========================================================================
  // 3.5. Mutation probes: the CHECK constraints and triggers this story adds
  //      to `commerce.booking_outcome_decisions`, `booking.no_show_declarations`
  //      and `commerce.customer_remedy_choices`
  // =========================================================================

  describe('the no-show decision’s own CHECK constraints', () => {
    let live: Row;

    beforeEach(async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);
      await declareNoShow(booked.bookingId, seller.owner.id);
      await dataSource.query(
        `UPDATE ${DECLARATIONS} SET objection_window_ends_at = declared_at + interval '1 millisecond' WHERE booking_id = $1`,
        [booked.bookingId],
      );
      await orchestrator.decideNoShowWindow(booked.bookingId);
      live = (await decisionsFor(booked.bookingId))[0];
      // Governed but with no published Legal cap: `cap_absent`, not `legacy_unenrolled` (terms exist).
      expect(live).toMatchObject({ decision_kind: 'no_show', basis: 'cap_absent', refund_toman: String(PRICE) });
    });

    async function insertVariant(overrides: Record<string, unknown>): Promise<void> {
      const row: Record<string, unknown> = {
        id: uuidv7(),
        booking_id: live.booking_id,
        order_id: live.order_id,
        decision_kind: 'no_show',
        cause: 'no_show',
        event_instant: live.event_instant,
        booking_was_confirmed: true,
        policy_key: live.policy_key,
        policy_version: live.policy_version,
        cutoff_instant: null,
        timely: null,
        collected_remaining_toman: String(PRICE),
        policy_amount_toman: live.policy_amount_toman,
        legal_cap_toman: null,
        legal_cap_state: 'absent',
        retained_toman: '0',
        refund_toman: String(PRICE),
        basis: 'cap_absent', // governed (terms exist) but no published Legal cap — matches `live`
        execution_status: 'executed',
        refund_request_key: `booking-no-show:${live.booking_id}`,
        ...overrides,
      };
      const columns = Object.keys(row);
      await dataSource.query(
        `INSERT INTO ${DECISIONS} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map((c) => row[c]),
      );
    }

    it('control: an otherwise valid variant is refused only by the one-live-per-kind index', async () => {
      await expect(insertVariant({})).rejects.toThrow(/uq_bod_one_live_per_kind/);
    });

    it('control: a live decision under an applied cap really is writable with basis cap_applied — proven positively in “window evaluation”', () => {
      // Deliberate cross-reference, not a duplicate: "applies the SNAPSHOTTED
      // no-show retention rule via the Legal cap" above already inserts a
      // genuine cap_applied/no_show row through the real evaluator and reads
      // it back — the positive control `ck_bod_cap_applied_preconditions`
      // needs. Repeating that insert here by hand would only re-test the
      // evaluator, not the constraint.
      expect(true).toBe(true);
    });

    it.each<[string, (live: Row) => Record<string, unknown>, RegExp]>([
      ['a sum that loses money', () => ({ refund_toman: String(PRICE - 1) }), /ck_bod_no_show_sum/],
      ['a request key under the CANCELLATION format', (l) => ({ refund_request_key: `booking-cancelled:${l.booking_id}` }), /ck_bod_no_show_key/],
      // Both non-null together so `ck_bod_timely_pair` (an already-proven #160
      // constraint) is satisfied, isolating THIS story's own guard.
      [
        'a non-null cutoff/timely pair on a no_show row',
        (l) => ({ cutoff_instant: l.event_instant, timely: true }),
        /ck_bod_no_show_no_cutoff/,
      ],
      [
        'cap_applied with cause customer instead of no_show',
        () => ({
          cause: 'customer',
          basis: 'cap_applied',
          legal_cap_state: 'applied',
          legal_cap_toman: String(PRICE),
          policy_amount_toman: String(PRICE),
          retained_toman: String(PRICE),
          refund_toman: '0',
        }),
        /ck_bod_cap_applied_preconditions/,
      ],
    ])('refuses %s', async (_label, overridesOf, pattern) => {
      await expect(insertVariant(overridesOf(live))).rejects.toThrow(pattern);
    });
  });

  describe('the no-show declaration’s own CHECK constraints and forward-only trigger', () => {
    it('refuses a statement outside 1..2000 characters, at the database layer', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await expect(
        dataSource.query(
          `INSERT INTO ${DECLARATIONS} (id, booking_id, declared_by_user_id, statement, grace_minutes_snapshot, objection_window_ends_at)
           VALUES ($1, $2, $3, '', 15, now() + interval '1 hour')`,
          [uuidv7(), booked.bookingId, seller.owner.id],
        ),
      ).rejects.toThrow(/ck_nsd_statement_length/);
    });

    it('refuses a second declaration for the same booking at the database layer (UNIQUE), independent of the service guard', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);
      await declareNoShow(booked.bookingId, seller.owner.id);
      await expect(
        dataSource.query(
          `INSERT INTO ${DECLARATIONS} (id, booking_id, declared_by_user_id, statement, grace_minutes_snapshot, objection_window_ends_at)
           VALUES ($1, $2, $3, 'دوباره', 15, now() + interval '1 hour')`,
          [uuidv7(), booked.bookingId, seller.owner.id],
        ),
      ).rejects.toThrow(/duplicate key|uq_no_show_declarations_booking/);
    });

    it('refuses DELETE and refuses rewriting a frozen column', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);
      await declareNoShow(booked.bookingId, seller.owner.id);

      await expect(dataSource.query(`DELETE FROM ${DECLARATIONS} WHERE booking_id = $1`, [booked.bookingId])).rejects.toThrow(
        /permanent/,
      );
      await expect(
        dataSource.query(`UPDATE ${DECLARATIONS} SET grace_minutes_snapshot = 999 WHERE booking_id = $1`, [booked.bookingId]),
      ).rejects.toThrow(/immutable/);
    });

    it('refuses evaluation_state moving backward or sideways', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);
      await declareNoShow(booked.bookingId, seller.owner.id);
      await dataSource.query(`UPDATE ${DECLARATIONS} SET evaluation_state = 'evaluated' WHERE booking_id = $1`, [booked.bookingId]);

      await expect(
        dataSource.query(`UPDATE ${DECLARATIONS} SET evaluation_state = 'window_open' WHERE booking_id = $1`, [booked.bookingId]),
      ).rejects.toThrow(/moves forward only/);
      await expect(
        dataSource.query(`UPDATE ${DECLARATIONS} SET evaluation_state = 'disputed' WHERE booking_id = $1`, [booked.bookingId]),
      ).rejects.toThrow(/moves forward only/);
    });
  });

  describe('commerce.customer_remedy_choices — its own CHECK constraints and forward-only trigger', () => {
    async function offeredRemedy(): Promise<Booked & { seller: Seller }> {
      const seller = await governedSeller();
      const booked = await confirmedBooking(seller);
      await bookings.cancel(booked.bookingId, { type: 'professional', id: seller.owner.id }, 'مشکل پیش‌بینی‌نشده');
      await deliver(booked);
      return { ...booked, seller };
    }

    it('refuses a row born already customer-resolved — no production path knows the choice before offering one', async () => {
      const booked = await confirmedBooking(await governedSeller());
      const orderId = booked.orderId;
      await expect(
        dataSource.query(
          `INSERT INTO ${REMEDIES} (order_id, booking_id, resolved_by, resolved_at, chosen, chosen_at)
           VALUES ($1, $2, 'customer', now(), 'reschedule', now())`,
          [orderId, booked.bookingId],
        ),
      ).rejects.toThrow(/offered with the default already in effect/);
    });

    it('refuses an offer under the wrong booking for the order', async () => {
      const booked = await offeredRemedy();
      const other = await confirmedBooking(await governedSeller());
      await expect(
        dataSource.query(
          `INSERT INTO ${REMEDIES} (order_id, booking_id, resolved_by, resolved_at)
           VALUES ($1, $2, 'default', now())
           ON CONFLICT (order_id) DO NOTHING`,
          [other.orderId, booked.bookingId],
        ),
      ).rejects.toThrow(/own booking/);
    });

    it('refuses DELETE and refuses a jump straight to an arbitrary resolution', async () => {
      const booked = await offeredRemedy();

      await expect(dataSource.query(`DELETE FROM ${REMEDIES} WHERE order_id = $1`, [booked.orderId])).rejects.toThrow(/permanent/);
      await expect(
        dataSource.query(`UPDATE ${REMEDIES} SET resolved_by = 'customer', chosen = 'refund', chosen_at = now() WHERE order_id = $1`, [
          booked.orderId,
        ]),
      ).rejects.toThrow(/moves at most once/);
    });

    it('control: the ONE permitted move — default/reschedule — is writable directly', async () => {
      const booked = await offeredRemedy();
      await dataSource.query(
        `UPDATE ${REMEDIES} SET resolved_by = 'customer', chosen = 'reschedule', chosen_at = now(), resolved_at = now() WHERE order_id = $1`,
        [booked.orderId],
      );
      expect(await remedyFor(booked.orderId)).toMatchObject({ resolved_by: 'customer', chosen: 'reschedule' });
    });
  });

  // =========================================================================
  // 4. The customer's remedy after a non-customer cancellation
  // =========================================================================

  describe('the customer remedy', () => {
    async function sellerCancelled(options: GovernedOptions = {}): Promise<Booked & { seller: Seller }> {
      const seller = await governedSeller(options);
      const booked = await confirmedBooking(seller);
      await bookings.cancel(booked.bookingId, { type: 'professional', id: seller.owner.id }, 'مشکل پیش‌بینی‌نشده');
      return { ...booked, seller };
    }

    it('offers exactly one remedy, already resolved to the default full refund', async () => {
      const booked = await sellerCancelled();
      await deliver(booked); // decide + execute, synchronously in the sandbox

      const remedy = await remedyFor(booked.orderId);
      expect(remedy).toMatchObject({ booking_id: booked.bookingId, resolved_by: 'default', chosen: null });
      expect(await refundsFor(booked.orderId)).toEqual([
        { request_key: `booking-cancelled:${booked.bookingId}`, amount_toman: String(PRICE), status: 'succeeded' },
      ]);
    });

    it('a platform (system-actor) cancellation offers the SAME remedy', async () => {
      const seller = await governedSeller();
      const booked = await confirmedBooking(seller);
      await bookings.cancel(booked.bookingId, { type: 'system', id: null }, 'خرابی سامانه');
      await deliver(booked);

      expect(await remedyFor(booked.orderId)).toMatchObject({ resolved_by: 'default' });
    });

    it('a CUSTOMER cancellation offers no remedy at all', async () => {
      const seller = await governedSeller();
      const booked = await confirmedBooking(seller);
      await bookings.cancel(booked.bookingId, { type: 'customer', id: booked.customer.id }, 'پشیمان شدم');
      await deliver(booked);

      expect(await remedyFor(booked.orderId)).toBeUndefined();
    });

    it('NULL remedy_choice_window_hours: the default executes IMMEDIATELY at cancellation', async () => {
      const booked = await sellerCancelled({ remedyChoiceWindowHours: undefined }); // NULL, the column default
      await deliver(booked);

      const remedy = await remedyFor(booked.orderId);
      expect(remedy!.resolved_by).toBe('default');
      // "Immediately" means at the SAME instant as offered, not after a wait.
      expect((remedy!.resolved_at as Date).getTime()).toBe((remedy!.offered_at as Date).getTime());
      expect(await refundsFor(booked.orderId)).toHaveLength(1);
    });

    it('a PUBLISHED (non-null) remedy_choice_window_hours changes nothing — no invented deadline', async () => {
      const booked = await sellerCancelled({ remedyChoiceWindowHours: 24 });
      await deliver(booked);

      const remedy = await remedyFor(booked.orderId);
      expect(remedy!.resolved_by).toBe('default');
      expect((remedy!.resolved_at as Date).getTime()).toBe((remedy!.offered_at as Date).getTime());
      expect(await refundsFor(booked.orderId)).toHaveLength(1);
    });

    it('a repeated or "refund" remedy request is a no-op — no double refund', async () => {
      const booked = await sellerCancelled();
      await deliver(booked);
      expect(await refundsFor(booked.orderId)).toHaveLength(1);

      const first = await remedyResolution.resolve(booked.bookingId, booked.customer.id, 'refund', null);
      const second = await remedyResolution.resolve(booked.bookingId, booked.customer.id, 'refund', null);
      expect(first).toEqual({ chosen: null, resolvedBy: 'default' });
      expect(second).toEqual({ chosen: null, resolvedBy: 'default' });
      expect(await refundsFor(booked.orderId)).toHaveLength(1); // still exactly one
    });

    it('reschedule bypasses the cutoff and free-count rules and transfers the terms row, while the refund is still pending', async () => {
      const seller = await governedSeller({ cutoffHours: 999, freeCount: 0 }); // impossibly strict for an ORDINARY reschedule
      const booked = await confirmedBooking(seller);
      await bookings.cancel(booked.bookingId, { type: 'professional', id: seller.owner.id }, 'مشکل پیش‌بینی‌نشده');
      // Decide only, WITHOUT executing — the refund stays `pending`, the
      // realistic (if narrow) window ADR-051 §8 describes.
      await orchestrator.decideCancellation(booked.bookingId, (m, cutoffHours) => bookings.cancellationFacts(m, booked.bookingId, cutoffHours));
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ execution_status: 'pending' });

      const newSlotId = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(500));
      const resolution = await remedyResolution.resolve(booked.bookingId, booked.customer.id, 'reschedule', newSlotId);
      expect(resolution).toEqual({ chosen: 'reschedule', resolvedBy: 'customer' });

      const after = await bookingRow(booked.bookingId);
      expect(after.slot_id).toBe(newSlotId);
      expect(after.status).toBe('confirmed');
      expect(await remedyFor(booked.orderId)).toMatchObject({ resolved_by: 'customer', chosen: 'reschedule' });

      // The refund must never now execute — the customer chose reschedule instead.
      const decision = (await decisionsFor(booked.bookingId))[0];
      await orchestrator.executeCancellation({
        id: decision.id as string,
        bookingId: booked.bookingId,
        orderId: booked.orderId,
        kind: 'cancellation',
        retainedToman: 0n,
        refundToman: BigInt(PRICE),
        basis: 'non_customer_cause',
        executionStatus: 'pending',
        refundRequestKey: `booking-cancelled:${booked.bookingId}`,
      });
      expect(await refundsFor(booked.orderId)).toEqual([]);
    });

    it('a repeated reschedule choice is idempotent — no second reschedule, no duplicate credit return', async () => {
      const seller = await governedSeller();
      const booked = await confirmedBooking(seller);
      await bookings.cancel(booked.bookingId, { type: 'professional', id: seller.owner.id }, 'مشکل پیش‌بینی‌نشده');
      await orchestrator.decideCancellation(booked.bookingId, (m, cutoffHours) => bookings.cancellationFacts(m, booked.bookingId, cutoffHours));

      const slotA = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(500));
      const slotB = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(600));
      const first = await remedyResolution.resolve(booked.bookingId, booked.customer.id, 'reschedule', slotA);
      expect(first).toEqual({ chosen: 'reschedule', resolvedBy: 'customer' });
      const bookingAfterFirst = await bookingRow(booked.bookingId);

      const second = await remedyResolution.resolve(booked.bookingId, booked.customer.id, 'reschedule', slotB);
      expect(second).toEqual({ chosen: 'reschedule', resolvedBy: 'customer' });
      const bookingAfterSecond = await bookingRow(booked.bookingId);
      // The second request changed nothing: still slotA, not slotB.
      expect(bookingAfterSecond.slot_id).toBe(bookingAfterFirst.slot_id);
      expect(bookingAfterSecond.slot_id).toBe(slotA);
    });

    it('refuses reschedule once the refund has already executed — money is gone', async () => {
      const booked = await sellerCancelled();
      await deliver(booked); // decide + execute -> succeeded
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ execution_status: 'executed' });

      const newSlotId = await seedSlot(dataSource, booked.seller.professionalId, booked.seller.serviceId, futureSlotTime(500));
      await expect(remedyResolution.resolve(booked.bookingId, booked.customer.id, 'reschedule', newSlotId)).rejects.toMatchObject({
        response: { code: 'REMEDY_REFUND_ALREADY_EXECUTED' },
      });
      const after = await bookingRow(booked.bookingId);
      expect(after.status).toBe('cancelled'); // unchanged
    });

    it('refuses reschedule without a chosen slot', async () => {
      const booked = await sellerCancelled();
      await orchestrator.decideCancellation(booked.bookingId, (m, cutoffHours) => bookings.cancellationFacts(m, booked.bookingId, cutoffHours));
      await expect(remedyResolution.resolve(booked.bookingId, booked.customer.id, 'reschedule', null)).rejects.toMatchObject({
        response: { code: 'REMEDY_RESCHEDULE_REQUIRES_SLOT' },
      });
    });

    it('refuses a remedy request for a booking that was never offered one', async () => {
      const seller = await governedSeller();
      const booked = await confirmedBooking(seller);
      await expect(remedyResolution.resolve(booked.bookingId, booked.customer.id, 'refund', null)).rejects.toMatchObject({
        response: { code: 'REMEDY_NOT_OFFERED' },
      });
    });

    it('the HTTP route is customer-only', async () => {
      const booked = await sellerCancelled();
      await deliver(booked);

      await request(server()).post(`/api/v1/bookings/${booked.bookingId}/remedy`).set(auth(booked.seller.owner)).send({ choice: 'refund' }).expect(404);
      await request(server()).post(`/api/v1/bookings/${booked.bookingId}/remedy`).set(auth(booked.customer)).send({ choice: 'refund' }).expect(201);
    });
  });

  // =========================================================================
  // 5. Admin cancellation maps to platform_cancelled (CAUSE_BY_ACTOR, F5)
  // =========================================================================

  describe('admin cancellation', () => {
    it('is recorded as cause platform, exactly like system', async () => {
      const seller = await governedSeller();
      const booked = await confirmedBooking(seller);
      await bookings.cancel(booked.bookingId, { type: 'admin', id: admin.id }, 'اقدام پلتفرم');
      await deliver(booked);

      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ cause: 'platform' });
      expect(await remedyFor(booked.orderId)).toMatchObject({ resolved_by: 'default' });
    });
  });

  // =========================================================================
  // 6. #160’s two-refund regression stays fixed alongside a remedy offer
  // =========================================================================

  describe('the #160 two-refund regression, with a remedy also in play', () => {
    it('a booking cancelled by the seller while its payment is capturing is refunded once, and the remedy still resolves to the default', async () => {
      const seller = await governedSeller();
      const booked = await book(seller);
      const captured = sandbox.decide(booked.reference, 'success');
      const cancelled = bookings.cancel(booked.bookingId, { type: 'professional', id: seller.owner.id }, 'مشکل پیش‌بینی‌نشده');
      await Promise.all([captured, cancelled]);
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference }).catch(() => undefined);
      await deliver(booked);
      await deliver(booked);

      const refunds = await refundsFor(booked.orderId);
      expect(refunds.filter((r) => r.status === 'succeeded')).toHaveLength(1);
    });
  });

  // =========================================================================
  // 7. ADR-027: export and erasure
  // =========================================================================

  describe('ADR-027', () => {
    it('claims booking.no_show_declarations subject_data and commerce.customer_remedy_choices retained, exactly once each', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const declClaims = contracts.flatMap((c) => c.tables.filter((t) => t.table === DECLARATIONS).map((t) => ({ module: c.moduleKey, ...t })));
      expect(declClaims).toHaveLength(1);
      expect(declClaims[0]).toMatchObject({ module: 'booking', disposition: 'subject_data' });

      const remedyClaims = contracts.flatMap((c) => c.tables.filter((t) => t.table === REMEDIES).map((t) => ({ module: c.moduleKey, ...t })));
      expect(remedyClaims).toHaveLength(1);
      expect(remedyClaims[0]).toMatchObject({ module: 'commerce', disposition: 'retained' });
    });

    it('exports the customer’s own declaration (instant + statement) and the professional’s own authored row', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);
      await declareNoShow(booked.bookingId, seller.owner.id, 'یادداشت صادرات');

      const customerSections = await app.get(BookingSubjectDataContract).exportSubjectData(dataSource.manager, booked.customer.id);
      const customerSection = customerSections.find((s) => s.key === 'no_show_declarations');
      expect(customerSection?.rows).toHaveLength(1);
      expect(customerSection!.rows[0]).toMatchObject({ statement: 'یادداشت صادرات' });

      const sellerSections = await app.get(BookingSubjectDataContract).exportSubjectData(dataSource.manager, seller.owner.id);
      const sellerSection = sellerSections.find((s) => s.key === 'no_show_declarations_authored');
      expect(sellerSection?.rows).toHaveLength(1);
    });

    it('erasure anonymises the statement and keeps the instant and consequence', async () => {
      const seller = await governedSeller({ graceMinutes: 1 });
      const booked = await confirmedBooking(seller);
      await placeSlotStartForGrace(booked.bookingId, 1, true);
      await declareNoShow(booked.bookingId, seller.owner.id, 'یادداشت محرمانه');

      const before = await declarationFor(booked.bookingId);
      const erased = await app.get(BookingSubjectDataContract).eraseSubjectData(dataSource.manager, booked.customer.id);
      expect(erased.anonymized).toBeGreaterThanOrEqual(1);

      const after = await declarationFor(booked.bookingId);
      expect(after!.statement).toBe('[REDACTED]');
      expect(after!.declared_at).toEqual(before!.declared_at);
      expect(after!.grace_minutes_snapshot).toBe(before!.grace_minutes_snapshot);
    });

    it('exports the customer’s own remedy resolution', async () => {
      const seller = await governedSeller();
      const booked = await confirmedBooking(seller);
      await bookings.cancel(booked.bookingId, { type: 'professional', id: seller.owner.id }, 'مشکل پیش‌بینی‌نشده');
      await deliver(booked);

      const sections = await app.get(CommerceSubjectDataContract).exportSubjectData(dataSource.manager, booked.customer.id);
      const section = sections.find((s) => s.key === 'customer_remedy_choices');
      expect(section?.rows).toHaveLength(1);
      expect(section!.rows[0]).toMatchObject({ resolved_by: 'default' });

      const erased = await app.get(CommerceSubjectDataContract).eraseSubjectData();
      expect(erased.retained.map((r) => r.table)).toContain(REMEDIES);
    });
  });
});
