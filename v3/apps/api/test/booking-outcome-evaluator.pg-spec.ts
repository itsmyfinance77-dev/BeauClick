import { INestApplication } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { BookingService } from '@beauclick/booking';
import { CommerceSubjectDataContract } from '@beauclick/commerce';
import { PaymentService, SandboxPaymentProvider } from '@beauclick/payment';
import {
  BookingOutcomePolicyService,
  CustomerPolicyCopyService,
  LegalEvidenceService,
  OutcomePolicyAssignmentService,
} from '@beauclick/commercial-policy';
import {
  BookingOutcomeAcceptanceV1,
  BookingOutcomePolicyVersionTermsV1,
  BookingOutcomeRetentionRule,
} from '@beauclick/commercial-policy-contract';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage } from '@beauclick/subject-data';

import { CheckoutService } from '../src/checkout/checkout.service';
import { BookingCancelledRefundHandler } from '../src/events/financial-projection.handlers';
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

/**
 * The booking outcome evaluator, its decision record and its execution —
 * V3.3 Story #160 (`#42c`), ADR-051 §6 (with its 2026-09-15 note),
 * `V33-DEC-039` R1, R2, R4, R5, R8, R14.
 *
 * ## Why real PostgreSQL
 *
 * Every property here is a database property: the cancelling transaction's
 * clock, microsecond boundaries, `FOR UPDATE` ordering, the partial unique
 * index, the CHECKs and triggers that make a wrong decision unwritable, and
 * two transactions racing a refund. pg-mem honours none of them.
 *
 * ## Values in this file are TEST values
 *
 * Every hour, basis point and toman below is a suite fixture chosen to exercise
 * a rule. None is a product value; the Legal-evidence records are suite
 * fixtures in a disposable database, not attestations; the Persian copy is a
 * fixture, not approved text.
 */
describePg('booking outcome evaluator, decision and execution (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let checkout: CheckoutService;
  let bookings: BookingService;
  let payments: PaymentService;
  let sandbox: SandboxPaymentProvider;
  let handler: BookingCancelledRefundHandler;
  let outcomes: BookingOutcomePolicyService;
  let copies: CustomerPolicyCopyService;
  let evidence: LegalEvidenceService;
  let assignments: OutcomePolicyAssignmentService;
  let admin: SeededUser;
  let activeCopy: { copyKey: string; copyVersion: number } | null;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;
  const nextPhone = (): string => `+98917${String(1000000 + (sequence += 1)).slice(-7)}`;
  const server = () => app.getHttpServer();
  const auth = (user: SeededUser) => ({ Authorization: `Bearer ${user.accessToken}` });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const CALLBACK = 'http://localhost:3099/api/v1/payments/callback';
  const PRICE = 200_000;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    checkout = app.get(CheckoutService);
    bookings = app.get(BookingService);
    payments = app.get(PaymentService);
    sandbox = app.get(SandboxPaymentProvider);
    handler = app.get(BookingCancelledRefundHandler);
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
  // Fixtures
  // =========================================================================

  interface Seller {
    owner: SeededUser;
    professionalId: string;
    serviceId: string;
    acceptance: BookingOutcomeAcceptanceV1 | null;
    evidenceKey: string | null;
  }

  interface GovernedOptions {
    cutoffHours?: number;
    late?: BookingOutcomeRetentionRule;
    freeCount?: number;
    cap?: BookingOutcomeRetentionRule | null;
  }

  async function workspaceRefFor(user: SeededUser): Promise<string> {
    const response = await request(server()).get('/api/v1/me/subscriptions').set(auth(user)).expect(200);
    return (response.body.data.items as Array<{ workspaceRef: string }>)[0].workspaceRef;
  }

  async function legacySeller(price = PRICE): Promise<Seller> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون', price);
    return { owner, professionalId: professional.id, serviceId: professional.serviceId, acceptance: null, evidenceKey: null };
  }

  /** A seller whose customers accept outcome terms: a published version, the platform copy, a selection. */
  async function governedSeller(options: GovernedOptions = {}, price = PRICE): Promise<Seller> {
    const seller = await legacySeller(price);
    const cutoffHours = options.cutoffHours ?? 12;
    const late = options.late ?? { kind: 'percentage_of_collected', basisPoints: 2_500 };
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
      noShowGraceMinutesAllowed: [10],
      noShowRetentionOptions: [{ kind: 'none' }],
      rescheduleFreeCountBeforeCutoff: options.freeCount ?? 1,
      disputeWindowHours: 36,
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
      selection: { cutoffHours, lateCancellationRetention: late, noShowGraceMinutes: 10, noShowRetention: { kind: 'none' } },
      reason: 'suite choice',
    });
    return {
      ...seller,
      evidenceKey,
      acceptance: { policyKey: key, policyVersion: drafted.version.version, ...activeCopy },
    };
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

  const cancelAsCustomer = (booked: Booked) => bookings.cancel(booked.bookingId, { type: 'customer', id: booked.customer.id }, 'suite');
  const deliver = (booked: Booked) => handler.handle({ payload: { bookingId: booked.bookingId } } as never);

  const bookingRow = async (bookingId: string) => (await dataSource.query('SELECT * FROM booking.bookings WHERE id = $1', [bookingId]))[0];
  const orderRow = async (orderId: string) => (await dataSource.query('SELECT * FROM commerce.orders WHERE id = $1', [orderId]))[0];
  /** A raw decision row: `pg` returns BIGINT as text, instants as Date, booleans as boolean. */
  type DecisionRow = Record<string, string | number | boolean | Date | null>;
  const decisionsFor = (bookingId: string): Promise<DecisionRow[]> =>
    dataSource.query(`SELECT * FROM ${DECISIONS} WHERE booking_id = $1 ORDER BY decided_at, id`, [bookingId]);
  const refundsFor = (orderId: string): Promise<Array<{ request_key: string; amount_toman: string; status: string }>> =>
    dataSource.query(`SELECT request_key, amount_toman, status FROM payment.refunds WHERE order_id = $1 AND kind = 'order' ORDER BY id`, [orderId]);

  /**
   * Places the booking's cutoff instant relative to the DATABASE instant of its
   * cancelling transaction: `slot_start = cancelled_at_db + cutoffHours + offset`.
   * Offset 0 puts the cancellation exactly ON the cutoff; −1 µs puts it one
   * microsecond after.
   */
  async function placeCutoff(bookingId: string, cutoffHours: number, offsetMicros: number): Promise<void> {
    await dataSource.query(
      `UPDATE booking.bookings b
          SET slot_start = h.created_at + make_interval(hours => $2::int) + ($3::bigint * interval '1 microsecond'),
              slot_end   = h.created_at + make_interval(hours => $2::int) + ($3::bigint * interval '1 microsecond') + interval '1 hour'
         FROM booking.booking_history h
        WHERE h.booking_id = b.id AND h.event = 'cancelled' AND b.id = $1`,
      [bookingId, cutoffHours, offsetMicros],
    );
  }

  // =========================================================================
  // 1. Legacy continuity — no terms row is today's full refund, recorded
  // =========================================================================

  describe('an order without outcome terms keeps today’s full refund', () => {
    it('refunds the whole collected amount once, under the booking key, and records why', async () => {
      const booked = await confirmedBooking(await legacySeller());
      await cancelAsCustomer(booked);
      await deliver(booked);
      await deliver(booked);

      expect(await refundsFor(booked.orderId)).toEqual([
        { request_key: `booking-cancelled:${booked.bookingId}`, amount_toman: String(PRICE), status: 'succeeded' },
      ]);
      const [decision, ...rest] = await decisionsFor(booked.bookingId);
      expect(rest).toEqual([]);
      expect(decision).toMatchObject({
        decision_kind: 'cancellation',
        cause: 'customer',
        basis: 'legacy_unenrolled',
        policy_key: null,
        timely: null,
        cutoff_instant: null,
        legal_cap_state: 'absent',
        retained_toman: '0',
        refund_toman: String(PRICE),
        collected_remaining_toman: String(PRICE),
        execution_status: 'executed',
        booking_was_confirmed: true,
      });
    });

    it('cancels a never-collected order with no provider call, in the deciding transaction', async () => {
      const booked = await book(await legacySeller());
      await cancelAsCustomer(booked);
      await deliver(booked);

      expect(await refundsFor(booked.orderId)).toEqual([]);
      expect((await orderRow(booked.orderId)).status).toBe('cancelled');
      expect(await decisionsFor(booked.bookingId)).toMatchObject([
        { basis: 'legacy_unenrolled', refund_toman: '0', execution_status: 'executed', booking_was_confirmed: false },
      ]);
    });

    it('moves no money on a BookingCancelled whose booking records no cancellation', async () => {
      const booked = await confirmedBooking(await legacySeller());
      await deliver(booked); // never cancelled

      expect(await refundsFor(booked.orderId)).toEqual([]);
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
      expect((await orderRow(booked.orderId)).status).toBe('paid');
    });
  });

  // =========================================================================
  // 2. Timeliness on the cancelling transaction's database clock
  // =========================================================================

  describe('timeliness is judged at the cancelling transaction’s database instant', () => {
    const CAPPED: GovernedOptions = { cutoffHours: 12, late: { kind: 'full_collected' }, cap: { kind: 'full_collected' } };

    it('a cancellation EXACTLY at the cutoff instant is timely: full refund even under an applied cap', async () => {
      const booked = await confirmedBooking(await governedSeller(CAPPED));
      await cancelAsCustomer(booked);
      await placeCutoff(booked.bookingId, 12, 0);
      await deliver(booked);

      const [decision] = await decisionsFor(booked.bookingId);
      expect(decision).toMatchObject({ timely: true, basis: 'timely', legal_cap_state: 'applied', retained_toman: '0', refund_toman: String(PRICE) });
      const [{ equal }] = await dataSource.query(`SELECT event_instant = cutoff_instant AS equal FROM ${DECISIONS} WHERE id = $1`, [decision.id]);
      expect(equal).toBe(true);
      expect(await refundsFor(booked.orderId)).toHaveLength(1);
    });

    it('one microsecond after the cutoff is late, and retains min(policy, cap, collected)', async () => {
      const booked = await confirmedBooking(
        await governedSeller({ cutoffHours: 12, late: { kind: 'percentage_of_collected', basisPoints: 2_500 }, cap: { kind: 'fixed_toman', amountToman: 30_000 } }),
      );
      await cancelAsCustomer(booked);
      await placeCutoff(booked.bookingId, 12, -1);
      await deliver(booked);

      const [decision] = await decisionsFor(booked.bookingId);
      expect(decision).toMatchObject({
        timely: false,
        basis: 'cap_applied',
        policy_amount_toman: '50000',
        legal_cap_toman: '30000',
        retained_toman: '30000',
        refund_toman: '170000',
        execution_status: 'executed',
      });
      const [{ micro }] = await dataSource.query(
        `SELECT extract(microseconds FROM (event_instant - cutoff_instant))::int AS micro FROM ${DECISIONS} WHERE id = $1`,
        [decision.id],
      );
      expect(micro).toBe(1);
      expect(await refundsFor(booked.orderId)).toEqual([
        { request_key: `booking-cancelled:${booked.bookingId}`, amount_toman: '170000', status: 'succeeded' },
      ]);
      await ctx.relay.drain();
      const order = await orderRow(booked.orderId);
      expect({ status: order.status, refunded: Number(order.refunded_total_toman), collected: Number(order.collected_total_toman) }).toEqual({
        status: 'partially_refunded',
        refunded: 170_000,
        collected: PRICE,
      });
    });

    it('a timely cancellation delivered after the cutoff has passed is STILL timely', async () => {
      const booked = await confirmedBooking(await governedSeller(CAPPED));
      await cancelAsCustomer(booked);
      // The cutoff falls 20 ms after the cancellation; the consumer runs later.
      await placeCutoff(booked.bookingId, 12, 20_000);
      await sleep(150);
      await deliver(booked);

      const [decision] = await decisionsFor(booked.bookingId);
      const [{ decided_after_cutoff }] = await dataSource.query(
        `SELECT decided_at > cutoff_instant AS decided_after_cutoff FROM ${DECISIONS} WHERE id = $1`,
        [decision.id],
      );
      expect(decided_after_cutoff).toBe(true);
      expect(decision).toMatchObject({ timely: true, basis: 'timely', retained_toman: '0' });
    });

    it('floors a percentage exactly and keeps retained + refund = collected on an odd amount', async () => {
      const booked = await confirmedBooking(
        await governedSeller({ cutoffHours: 12, late: { kind: 'percentage_of_collected', basisPoints: 2_500 }, cap: { kind: 'full_collected' } }, 200_001),
      );
      await cancelAsCustomer(booked);
      await placeCutoff(booked.bookingId, 12, -1);
      await deliver(booked);

      const [decision] = await decisionsFor(booked.bookingId);
      expect(decision).toMatchObject({ policy_amount_toman: '50000', legal_cap_toman: '200001', retained_toman: '50000', refund_toman: '150001' });
      expect(BigInt(decision.retained_toman as string) + BigInt(decision.refund_toman as string)).toBe(
        BigInt(decision.collected_remaining_toman as string),
      );
    });
  });

  // =========================================================================
  // 3. The Legal cap — anything but a current retention_cap record retains 0
  // =========================================================================

  describe('the Legal cap is read at the decision instant', () => {
    async function lateCancellation(seller: Seller, before?: (booked: Booked) => Promise<void>) {
      const booked = await confirmedBooking(seller);
      if (before) await before(booked);
      await cancelAsCustomer(booked);
      await placeCutoff(booked.bookingId, 12, -1);
      await deliver(booked);
      return { booked, decision: (await decisionsFor(booked.bookingId))[0] };
    }
    const LATE = { cutoffHours: 12, late: { kind: 'full_collected' } as BookingOutcomeRetentionRule };

    it('no published cap: zero retention, full refund', async () => {
      const { decision } = await lateCancellation(await governedSeller({ ...LATE, cap: null }));
      expect(decision).toMatchObject({ basis: 'cap_absent', legal_cap_state: 'absent', legal_cap_toman: null, retained_toman: '0', refund_toman: String(PRICE) });
    });

    it('evidence retired after the booking: zero retention, and no published row is rewritten', async () => {
      const seller = await governedSeller({ ...LATE, cap: { kind: 'full_collected' } });
      const { booked, decision } = await lateCancellation(seller, async () => {
        await evidence.retire(admin.id, seller.evidenceKey as string, 'suite retirement');
      });
      expect(decision).toMatchObject({ basis: 'cap_retired', legal_cap_state: 'retired', retained_toman: '0', refund_toman: String(PRICE) });
      const [terms] = await dataSource.query('SELECT legal_cap_kind FROM commerce.order_outcome_terms WHERE order_id = $1', [booked.orderId]);
      expect(terms.legal_cap_kind).toBe('full_collected');
    });

    it('evidence of another subject: zero retention', async () => {
      const seller = await governedSeller({ ...LATE, cap: { kind: 'full_collected' } });
      const { decision } = await lateCancellation(seller, async () => {
        // Fixture concession: the lifecycle trigger forbids changing a subject, by design.
        await dataSource.query('ALTER TABLE commercial.legal_evidence_records DISABLE TRIGGER tg_ler_lifecycle');
        try {
          await dataSource.query(`UPDATE commercial.legal_evidence_records SET subject = 'policy_copy' WHERE evidence_key = $1`, [seller.evidenceKey]);
        } finally {
          await dataSource.query('ALTER TABLE commercial.legal_evidence_records ENABLE TRIGGER tg_ler_lifecycle');
        }
      });
      expect(decision).toMatchObject({ basis: 'cap_absent', legal_cap_state: 'absent', retained_toman: '0' });
    });

    it('an evidence id that resolves to no record: zero retention', async () => {
      const seller = await governedSeller({ ...LATE, cap: { kind: 'full_collected' } });
      const { decision } = await lateCancellation(seller, async (booked) => {
        await dataSource.query('ALTER TABLE commerce.order_outcome_terms DISABLE TRIGGER tg_oot_append_only');
        try {
          await dataSource.query('UPDATE commerce.order_outcome_terms SET legal_evidence_id = $2 WHERE order_id = $1', [booked.orderId, uuidv7()]);
        } finally {
          await dataSource.query('ALTER TABLE commerce.order_outcome_terms ENABLE TRIGGER tg_oot_append_only');
        }
      });
      expect(decision).toMatchObject({ basis: 'cap_absent', legal_cap_state: 'absent', retained_toman: '0' });
    });

    it('control: the same seller with the record current DOES retain', async () => {
      const { decision } = await lateCancellation(await governedSeller({ ...LATE, cap: { kind: 'full_collected' } }));
      expect(decision).toMatchObject({ basis: 'cap_applied', retained_toman: String(PRICE), refund_toman: '0', execution_status: 'executed' });
    });
  });

  // =========================================================================
  // 4. Cause and confirmation
  // =========================================================================

  describe('only a customer’s late cancellation of a confirmed booking can retain', () => {
    const CAPPED: GovernedOptions = { cutoffHours: 12, late: { kind: 'full_collected' }, cap: { kind: 'full_collected' } };

    it('a professional’s late cancellation retains zero, cause derived from the booking', async () => {
      const seller = await governedSeller(CAPPED);
      const booked = await confirmedBooking(seller);
      await bookings.cancel(booked.bookingId, { type: 'professional', id: seller.owner.id }, 'suite');
      await placeCutoff(booked.bookingId, 12, -1);
      await deliver(booked);
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ cause: 'seller', basis: 'non_customer_cause', timely: false, retained_toman: '0' });
    });

    it('a pending booking cancelled and then captured is refunded once and retains zero (preflight C14, capture first)', async () => {
      const seller = await governedSeller(CAPPED);
      const booked = await book(seller);
      await ctx.relay.drain();
      await cancelAsCustomer(booked);
      await placeCutoff(booked.bookingId, 12, -1);
      const result = await capture(booked); // drains, so the consumer also runs
      expect(result.refundIssued).toBe(true);
      const [{ published }] = await dataSource.query(
        `SELECT count(*)::int AS published FROM booking.outbox_events WHERE aggregate_id = $1 AND event_type = 'BookingCancelled' AND published_at IS NOT NULL`,
        [booked.bookingId],
      );
      expect(published).toBe(1); // positive control: the cancellation consumer ran

      expect(await refundsFor(booked.orderId)).toEqual([
        { request_key: `booking-cancelled:${booked.bookingId}`, amount_toman: String(PRICE), status: 'succeeded' },
      ]);
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ basis: 'pre_existing_refund', retained_toman: '0', refund_toman: String(PRICE) });
    });

    it('the same race with the consumer running first still refunds once (C14, consumer first)', async () => {
      const booked = await book(await governedSeller(CAPPED));
      await ctx.relay.drain();
      await cancelAsCustomer(booked);
      await sandbox.decide(booked.reference, 'success');
      const internals = checkout as unknown as { payments: PaymentService };
      const original = internals.payments.refund.bind(internals.payments);
      let interposed = false;
      jest.spyOn(internals.payments, 'refund').mockImplementation(async (input) => {
        if (!interposed) {
          interposed = true;
          await deliver(booked);
        }
        return original(input);
      });
      const result = await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
      expect(result.refundIssued).toBe(true);
      expect(interposed).toBe(true);

      expect(await refundsFor(booked.orderId)).toHaveLength(1);
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ basis: 'not_confirmed', booking_was_confirmed: false, retained_toman: '0' });
    });

    it('control: a capture that cannot confirm an EXPIRED hold keeps the per-order compensation key', async () => {
      const booked = await book(await legacySeller());
      await dataSource.query(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [booked.bookingId]);
      await bookings.expireStaleHolds();
      const result = await capture(booked);
      expect(result.refundIssued).toBe(true);
      expect(await refundsFor(booked.orderId)).toEqual([
        { request_key: `booking-unconfirmable:${booked.orderId}`, amount_toman: String(PRICE), status: 'succeeded' },
      ]);
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
    });

    it('nets out an order refund already issued under another key, projected or not', async () => {
      const booked = await confirmedBooking(await legacySeller());
      await payments.refund({ orderId: booked.orderId, amountToman: 80_000, reason: 'suite prior refund', requestKey: 'suite-prior', actorType: 'system', actorId: null });
      // The RefundCompleted projection has NOT run: refunded_total_toman is still 0.
      expect(Number((await orderRow(booked.orderId)).refunded_total_toman)).toBe(0);
      await cancelAsCustomer(booked);
      await deliver(booked);

      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ collected_remaining_toman: '120000', refund_toman: '120000' });
      expect((await refundsFor(booked.orderId)).map((r) => r.amount_toman)).toEqual(['80000', '120000']);
    });
  });

  // =========================================================================
  // 5. One decision, one refund, truthful execution
  // =========================================================================

  describe('idempotency and execution', () => {
    it('concurrent duplicate deliveries produce one decision and one refund', async () => {
      const booked = await confirmedBooking(await legacySeller());
      await cancelAsCustomer(booked);
      await Promise.all([deliver(booked), deliver(booked), deliver(booked)]);
      expect(await decisionsFor(booked.bookingId)).toHaveLength(1);
      expect(await refundsFor(booked.orderId)).toHaveLength(1);
    });

    it('a refund that ends manual_required is recorded, and a replay adds nothing', async () => {
      const booked = await confirmedBooking(await legacySeller());
      const provider = sandbox as unknown as { supportsAutomaticRefund: boolean };
      provider.supportsAutomaticRefund = false;
      try {
        await cancelAsCustomer(booked);
        await deliver(booked);
        await deliver(booked);
      } finally {
        provider.supportsAutomaticRefund = true;
      }
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ execution_status: 'manual_required' });
      expect(await refundsFor(booked.orderId)).toEqual([expect.objectContaining({ status: 'manual_required' })]);
    });

    it('a failed refund is reported as failed and is not re-executed by a replay', async () => {
      const booked = await confirmedBooking(await legacySeller());
      const providerCall = jest.spyOn(sandbox, 'refund').mockResolvedValue({ outcome: 'failed', providerRefundReference: null, failureCode: 'suite_failure' });
      await cancelAsCustomer(booked);
      await deliver(booked);
      await deliver(booked);
      expect(providerCall).toHaveBeenCalledTimes(1);
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ execution_status: 'failed' });
      expect(await refundsFor(booked.orderId)).toEqual([expect.objectContaining({ status: 'failed' })]);
    });

    it('the decision commits before execution: a crash in the refund call is finished by the retry, once', async () => {
      const booked = await confirmedBooking(await legacySeller());
      await cancelAsCustomer(booked);
      jest.spyOn(payments, 'refund').mockRejectedValueOnce(new Error('suite crash before the refund'));
      await expect(deliver(booked)).rejects.toThrow('suite crash');
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ execution_status: 'pending' });
      expect(await refundsFor(booked.orderId)).toEqual([]);

      jest.restoreAllMocks();
      await deliver(booked);
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ execution_status: 'executed' });
      expect(await refundsFor(booked.orderId)).toHaveLength(1);
    });

    it('a cancellation refunded before #160 and replayed after it records that refund and issues none', async () => {
      const booked = await confirmedBooking(await legacySeller());
      await cancelAsCustomer(booked);
      await payments.refund({
        orderId: booked.orderId,
        amountToman: PRICE,
        reason: 'suite pre-#160 refund',
        requestKey: `booking-cancelled:${booked.bookingId}`,
        actorType: 'system',
        actorId: null,
      });
      const providerCall = jest.spyOn(sandbox, 'refund');
      await deliver(booked);
      expect(providerCall).not.toHaveBeenCalled();
      expect(await refundsFor(booked.orderId)).toHaveLength(1);
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ basis: 'pre_existing_refund', refund_toman: String(PRICE), execution_status: 'executed' });
    });
  });

  // =========================================================================
  // 6. Lock order: the order row before the booking row
  // =========================================================================

  describe('lock order (ADR-050): order before booking', () => {
    async function holdOrder(orderId: string): Promise<QueryRunner> {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      await runner.query('SELECT id FROM commerce.orders WHERE id = $1 FOR UPDATE', [orderId]);
      return runner;
    }

    async function bookingLockable(bookingId: string): Promise<boolean> {
      const probe = dataSource.createQueryRunner();
      await probe.connect();
      await probe.startTransaction();
      try {
        await probe.query('SELECT id FROM booking.bookings WHERE id = $1 FOR UPDATE NOWAIT', [bookingId]);
        return true;
      } catch {
        return false;
      } finally {
        await probe.rollbackTransaction();
        await probe.release();
      }
    }

    async function waitForLockWait(): Promise<void> {
      for (let i = 0; i < 100; i += 1) {
        const [{ waiting }] = await dataSource.query(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
        );
        if (waiting > 0) return;
        await sleep(20);
      }
      throw new Error('no backend ever waited on a lock');
    }

    it('control: NOWAIT does detect a held booking lock', async () => {
      const booked = await confirmedBooking(await legacySeller());
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      await runner.query('SELECT id FROM booking.bookings WHERE id = $1 FOR UPDATE', [booked.bookingId]);
      expect(await bookingLockable(booked.bookingId)).toBe(false);
      await runner.rollbackTransaction();
      await runner.release();
    });

    it('the cancellation consumer waits on the order and has not touched the booking', async () => {
      const booked = await confirmedBooking(await legacySeller());
      await cancelAsCustomer(booked);
      const runner = await holdOrder(booked.orderId);
      const pending = deliver(booked);
      await waitForLockWait();
      expect(await bookingLockable(booked.bookingId)).toBe(true);
      await runner.rollbackTransaction();
      await runner.release();
      await pending;
      expect(await decisionsFor(booked.bookingId)).toHaveLength(1);
    });

    it('a governed customer reschedule waits on the order and has not touched the booking', async () => {
      const seller = await governedSeller({ cutoffHours: 12 });
      const booked = await confirmedBooking(seller, 40);
      const slot = await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(41));
      const runner = await holdOrder(booked.orderId);
      const pending = bookings.reschedule(booked.bookingId, slot, { type: 'customer', id: booked.customer.id });
      await waitForLockWait();
      expect(await bookingLockable(booked.bookingId)).toBe(true);
      await runner.rollbackTransaction();
      await runner.release();
      await pending;
      expect((await bookingRow(booked.bookingId)).slot_id).toBe(slot);
    });
  });

  // =========================================================================
  // 7. Customer reschedule under accepted terms
  // =========================================================================

  describe('a governed customer reschedule', () => {
    const post = (booked: Booked, newSlotId: string, body: Record<string, unknown> = {}, user = booked.customer) =>
      request(server()).post(`/api/v1/bookings/${booked.bookingId}/reschedule`).set(auth(user)).send({ newSlotId, ...body });

    async function setup(options: GovernedOptions = { cutoffHours: 12 }) {
      const seller = await governedSeller(options);
      const booked = await confirmedBooking(seller, 60);
      const slots: string[] = [];
      for (let h = 61; h <= 66; h += 1) slots.push(await seedSlot(dataSource, seller.professionalId, seller.serviceId, futureSlotTime(h)));
      return { seller, booked, slots };
    }

    it('the first before the cutoff is free: moved, no decision', async () => {
      const { booked, slots } = await setup();
      await post(booked, slots[0]).expect(201);
      expect((await bookingRow(booked.bookingId)).slot_id).toBe(slots[0]);
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
    });

    it('the second shows its consequence first, writes nothing, then moves with the decision on confirmation', async () => {
      const { booked, slots } = await setup();
      await post(booked, slots[0]).expect(201);

      const shown = await post(booked, slots[1]);
      expect(shown.status).toBe(409);
      expect(shown.body.error.code).toBe('RESCHEDULE_CONSEQUENCE_REQUIRED');
      expect(shown.body.error.details).toEqual({ retainedToman: '0', cutoffAt: expect.stringMatching(/Z$/), freeRemaining: 0 });
      expect(JSON.stringify(shown.body)).not.toMatch(/legal|cap|evidence|policy/i);
      expect((await bookingRow(booked.bookingId)).slot_id).toBe(slots[0]);
      expect(await decisionsFor(booked.bookingId)).toEqual([]);

      await post(booked, slots[1], { acceptConsequence: true }).expect(201);
      expect((await bookingRow(booked.bookingId)).slot_id).toBe(slots[1]);
      expect(await decisionsFor(booked.bookingId)).toMatchObject([
        { decision_kind: 'reschedule_consequence', cause: 'customer', basis: 'timely', timely: true, retained_toman: '0', refund_toman: '0', execution_status: 'executed', superseded_by_id: null },
      ]);
    });

    it('the first AFTER the cutoff is not free', async () => {
      const { booked, slots } = await setup({ cutoffHours: 96 });
      const shown = await post(booked, slots[0]);
      expect(shown.body.error.code).toBe('RESCHEDULE_CONSEQUENCE_REQUIRED');
      expect(shown.body.error.details.freeRemaining).toBe(1);
      await post(booked, slots[0], { acceptConsequence: true }).expect(201);
      expect((await decisionsFor(booked.bookingId))[0]).toMatchObject({ basis: 'cap_absent', timely: false, retained_toman: '0' });
    });

    it('each later consequence supersedes the previous one: one live row', async () => {
      const { booked, slots } = await setup({ cutoffHours: 12, freeCount: 0 });
      await post(booked, slots[0], { acceptConsequence: true }).expect(201);
      await post(booked, slots[1], { acceptConsequence: true }).expect(201);
      await post(booked, slots[2], { acceptConsequence: true }).expect(201);
      const rows = await decisionsFor(booked.bookingId);
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.superseded_by_id === null)).toHaveLength(1);
      expect(rows[0].superseded_by_id).toBe(rows[1].id);
      expect(rows[1].superseded_by_id).toBe(rows[2].id);
    });

    it('a professional’s reschedule consumes no free reschedule and keeps today’s guards', async () => {
      const { seller, booked, slots } = await setup();
      await bookings.reschedule(booked.bookingId, slots[0], { type: 'professional', id: seller.owner.id });
      await post(booked, slots[1]).expect(201); // still the customer's free one
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
      // reschedule_count is now 2: the professional meets today's max_reached guard.
      await expect(bookings.reschedule(booked.bookingId, slots[2], { type: 'professional', id: seller.owner.id })).rejects.toMatchObject({
        response: { code: 'RESCHEDULE_NOT_ALLOWED', details: { reason: 'max_reached' } },
      });
    });

    it('a consequence that would carry money is refused and nothing is written', async () => {
      const { booked, slots } = await setup({ cutoffHours: 96, late: { kind: 'full_collected' }, cap: { kind: 'full_collected' } });
      const refused = await post(booked, slots[0], { acceptConsequence: true });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatchObject({ code: 'RESCHEDULE_NOT_ALLOWED', details: { reason: 'consequence_unavailable' } });
      expect((await bookingRow(booked.bookingId)).reschedule_count).toBe(0);
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
    });

    it('a stranger gets the same refusal as a booking that does not exist', async () => {
      const { booked, slots } = await setup();
      const stranger = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const foreign = await post(booked, slots[0], { acceptConsequence: true }, stranger);
      const missing = await request(server())
        .post(`/api/v1/bookings/${uuidv7()}/reschedule`)
        .set(auth(stranger))
        .send({ newSlotId: slots[0], acceptConsequence: true });
      expect({ status: foreign.status, error: foreign.body.error }).toEqual({ status: missing.status, error: missing.body.error });
      expect(foreign.status).toBe(404);
    });

    it('a legacy booking’s customer reschedule keeps max_reached, and acceptConsequence changes nothing', async () => {
      const seller = await legacySeller();
      const booked = await confirmedBooking(seller, 60);
      const slots = [61, 62, 63].map((h) => futureSlotTime(h));
      const ids: string[] = [];
      for (const at of slots) ids.push(await seedSlot(dataSource, seller.professionalId, seller.serviceId, at));
      await post(booked, ids[0], { acceptConsequence: true }).expect(201);
      await post(booked, ids[1], { acceptConsequence: true }).expect(201);
      const third = await post(booked, ids[2], { acceptConsequence: true });
      expect(third.body.error).toMatchObject({ code: 'RESCHEDULE_NOT_ALLOWED', details: { reason: 'max_reached' } });
      expect(await decisionsFor(booked.bookingId)).toEqual([]);
    });

    it('rejects a non-boolean acceptConsequence', async () => {
      const { booked, slots } = await setup();
      await post(booked, slots[0], { acceptConsequence: 'yes' }).expect(400);
    });
  });

  // =========================================================================
  // 8. The database makes a wrong decision unwritable
  // =========================================================================

  describe('the decision table’s constraints', () => {
    let booked: Booked;
    let live: DecisionRow;

    /** A governed booking cancelled well before its cutoff: the live row is a `timely` cancellation. */
    beforeEach(async () => {
      booked = await confirmedBooking(await governedSeller({ cutoffHours: 12 }));
      await cancelAsCustomer(booked);
      await deliver(booked);
      live = (await decisionsFor(booked.bookingId))[0];
      expect(live).toMatchObject({ basis: 'timely', timely: true, refund_toman: String(PRICE) });
    });

    /** A raw insert of a variant of the live row. Each case breaks exactly one rule. */
    async function insertVariant(overrides: Record<string, unknown>): Promise<void> {
      const row: Record<string, unknown> = {
        id: uuidv7(),
        booking_id: live.booking_id,
        order_id: live.order_id,
        decision_kind: 'cancellation',
        cause: 'customer',
        event_instant: live.event_instant,
        booking_was_confirmed: true,
        policy_key: live.policy_key,
        policy_version: live.policy_version,
        cutoff_instant: live.cutoff_instant,
        timely: true,
        collected_remaining_toman: String(PRICE),
        policy_amount_toman: live.policy_amount_toman,
        legal_cap_toman: null,
        legal_cap_state: 'absent',
        retained_toman: '0',
        refund_toman: String(PRICE),
        basis: 'timely',
        execution_status: 'executed',
        refund_request_key: `booking-cancelled:${live.booking_id}`,
        ...overrides,
      };
      const columns = Object.keys(row);
      await dataSource.query(
        `INSERT INTO ${DECISIONS} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map((c) => row[c]),
      );
    }

    const RESCHEDULE = { decision_kind: 'reschedule_consequence', refund_request_key: null, refund_toman: '0' };

    it('control: an otherwise valid row is refused only by the one-live-per-kind index', async () => {
      await expect(insertVariant({})).rejects.toThrow(/uq_bod_one_live_per_kind/);
    });

    it('control: a valid reschedule consequence for the same booking IS writable', async () => {
      await insertVariant(RESCHEDULE);
      expect((await decisionsFor(booked.bookingId)).map((r) => r.decision_kind).sort()).toEqual(['cancellation', 'reschedule_consequence']);
    });

    it.each<[string, Record<string, unknown>, RegExp]>([
      ['retention without an applied cap', { retained_toman: '1', refund_toman: String(PRICE - 1) }, /ck_bod_retention_requires_cap_applied/],
      [
        'cap_applied on a timely decision',
        { basis: 'cap_applied', legal_cap_state: 'applied', legal_cap_toman: String(PRICE), policy_amount_toman: String(PRICE), retained_toman: String(PRICE), refund_toman: '0' },
        /ck_bod_cap_applied_preconditions/,
      ],
      ['a sum that loses money', { refund_toman: String(PRICE - 1) }, /ck_bod_cancellation_sum/],
      ['a timely flag inconsistent with its instants', { ...RESCHEDULE, timely: false, basis: 'cap_absent' }, /ck_bod_timely_is_boundary/],
      ['a reschedule consequence carrying money', { ...RESCHEDULE, refund_toman: '1' }, /ck_bod_reschedule_consequence_dormant/],
      ['a cancellation under another request key', { refund_request_key: 'suite-other-key' }, /ck_bod_cancellation_key/],
      ['a pending execution with nothing to refund', { collected_remaining_toman: '0', refund_toman: '0', execution_status: 'pending' }, /ck_bod_execution_needs_refund/],
      // V3.3 #161 (`#42d`) unlocked `no_show`; `dispute_outcome` (#162) is the
      // one kind this story still defines no rules for.
      ['a kind no story yet defines rules for', { decision_kind: 'dispute_outcome', refund_request_key: null }, /ck_bod_kind_defined/],
      ['terms other than the order’s own', { ...RESCHEDULE, policy_key: 'suite-other' }, /must record the order's own accepted terms/],
      ['a booking that is not the order’s', { ...RESCHEDULE, booking_id: uuidv7() }, /must decide the booking its order was created for/],
      ['a supplied decided_at', { ...RESCHEDULE, decided_at: '2030-01-01T00:00:00Z' }, /decided_at must be the database transaction instant/],
    ])('refuses %s', async (_label, overrides, pattern) => {
      await expect(insertVariant(overrides)).rejects.toThrow(pattern);
    });

    it('freezes amounts and instants; lets execution move once forward; refuses DELETE', async () => {
      await expect(dataSource.query(`UPDATE ${DECISIONS} SET refund_toman = 1 WHERE id = $1`, [live.id])).rejects.toThrow(/is immutable/);
      await expect(dataSource.query(`UPDATE ${DECISIONS} SET event_instant = now() WHERE id = $1`, [live.id])).rejects.toThrow(/is immutable/);
      await expect(dataSource.query(`UPDATE ${DECISIONS} SET execution_status = 'pending' WHERE id = $1`, [live.id])).rejects.toThrow(/moves once, forward from pending/);
      await expect(dataSource.query(`DELETE FROM ${DECISIONS} WHERE id = $1`, [live.id])).rejects.toThrow(/permanent/);
      await expect(dataSource.query(`UPDATE ${DECISIONS} SET superseded_by_id = $2 WHERE id = $1`, [live.id, uuidv7()])).rejects.toThrow();
    });

    it('control: pending → executed is the one permitted execution move', async () => {
      const pendingBooked = await confirmedBooking(await legacySeller());
      await cancelAsCustomer(pendingBooked);
      jest.spyOn(payments, 'refund').mockRejectedValueOnce(new Error('suite: stop before execution'));
      await expect(deliver(pendingBooked)).rejects.toThrow('suite: stop');
      const [row] = await decisionsFor(pendingBooked.bookingId);
      expect(row.execution_status).toBe('pending');
      await dataSource.query(`UPDATE ${DECISIONS} SET execution_status = 'executed' WHERE id = $1`, [row.id]);
      await expect(dataSource.query(`UPDATE ${DECISIONS} SET execution_status = 'failed' WHERE id = $1`, [row.id])).rejects.toThrow(/moves once/);
    });
  });

  // =========================================================================
  // 9. Privacy: the claim, the export, and why the claim is pinned
  // =========================================================================

  describe('ADR-027', () => {
    it('claims the table retained with a reason, exactly once', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const claims = contracts.flatMap((c) => c.tables.filter((t) => t.table === DECISIONS).map((t) => ({ module: c.moduleKey, ...t })));
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ module: 'commerce', disposition: 'retained' });
      expect(claims[0].reason).toMatch(/financial/);
    });

    it('control: the coverage heuristic alone would accept a dishonest no_subject_data claim here', async () => {
      const [table] = await dataSource.query(
        `SELECT 'commerce' AS schema, 'booking_outcome_decisions' AS name,
                array_agg(column_name::text ORDER BY ordinal_position) AS columns
           FROM information_schema.columns WHERE table_schema = 'commerce' AND table_name = 'booking_outcome_decisions'`,
      );
      const dishonest = {
        moduleKey: 'planted',
        tables: [{ table: DECISIONS, disposition: 'no_subject_data', reason: 'planted' }],
      } as unknown as SubjectDataContract;
      expect(evaluateCoverage([table], [dishonest]).violations).toEqual([]);
    });

    it('exports the customer’s own decision amounts and instants, never the cap, basis or policy amount', async () => {
      const booked = await confirmedBooking(await governedSeller({ cutoffHours: 12, late: { kind: 'full_collected' }, cap: { kind: 'full_collected' } }));
      await cancelAsCustomer(booked);
      await placeCutoff(booked.bookingId, 12, -1);
      await deliver(booked);

      const sections = await app.get(CommerceSubjectDataContract).exportSubjectData(dataSource.manager, booked.customer.id);
      const section = sections.find((s) => s.key === 'booking_outcome_decisions');
      expect(section?.rows).toHaveLength(1);
      expect(Object.keys(section!.rows[0]).sort()).toEqual(
        ['collected_remaining_toman', 'cutoff_instant', 'decided_at', 'decision_kind', 'event_instant', 'execution_status', 'order_id', 'refund_toman', 'retained_toman', 'timely'].sort(),
      );
      expect(section!.rows[0]).toMatchObject({ retained_toman: String(PRICE), refund_toman: '0' });

      const erased = await app.get(CommerceSubjectDataContract).eraseSubjectData();
      expect(erased.retained.map((r) => r.table)).toContain(DECISIONS);
    });
  });
});
