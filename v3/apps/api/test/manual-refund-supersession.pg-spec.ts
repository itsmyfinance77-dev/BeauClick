import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { BookingService, SlotUnavailableException } from '@beauclick/booking';
import { BookingOutcomeDecisionService } from '@beauclick/commerce';
import { OutboxRelay } from '@beauclick/events';
import { PaymentService, SandboxPaymentProvider } from '@beauclick/payment';

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

/**
 * REAL PostgreSQL: demo F-10 / F-11 complete fix (owner-approved option B;
 * design demo/F10-DESIGN.md).
 *
 * A seller cancellation's default refund that became `manual_required` (sandbox
 * decision "bank without a refund API") can be SUPERSEDED by the customer's
 * #212 free reschedule only while nobody has claimed its manual execution; the
 * operator's durable claim, an uncertain outcome or a recorded execution block
 * it; the supersession is atomic with the reschedule; a later cancellation of the
 * revived booking is refunded normally (F-11). Both race orders, retries, a crash
 * window, legacy rows and unauthorized callers are covered.
 */
describePg('Manual refund execution + #212 supersession (demo F-10/F-11, real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let bookings: BookingService;
  let checkout: CheckoutService;
  let sandbox: SandboxPaymentProvider;
  let payments: PaymentService;
  let handler: BookingCancelledRefundHandler;
  let orchestrator: BookingOutcomeOrchestrator;
  let remedy: CustomerRemedyResolutionService;
  let relay: OutboxRelay;
  let admin: SeededUser;
  let seq = 0;
  let hour = 0;
  const PRICE = 300_000;
  const phone = () => `+98912${String(5000000 + (seq += 1)).slice(-7)}`;
  const server = () => app.getHttpServer();
  const auth = (u: SeededUser) => ({ Authorization: `Bearer ${u.accessToken}` });

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    bookings = app.get(BookingService);
    checkout = app.get(CheckoutService);
    sandbox = app.get(SandboxPaymentProvider);
    payments = app.get(PaymentService);
    handler = app.get(BookingCancelledRefundHandler);
    orchestrator = app.get(BookingOutcomeOrchestrator);
    remedy = app.get(CustomerRemedyResolutionService);
    relay = ctx.relay;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, phone(), ['administrator']);
  });

  interface Case {
    owner: SeededUser;
    customer: SeededUser;
    professionalId: string;
    serviceId: string;
    bookingId: string;
    orderId: string;
  }

  /** Booked, paid (manual-refund bank or automatic), then cancelled by the professional. `deliver` decides (+ executes). */
  async function sellerCancelled(opts: { manual?: boolean; deliver?: 'decide+execute' | 'decide-only' | 'none' } = {}): Promise<Case> {
    const owner = await seedUser(app, dataSource, phone(), ['customer', 'professional']);
    const pro = await seedProfessional(dataSource, owner.id, 'متخصص', PRICE);
    const customer = await seedUser(app, dataSource, phone(), ['customer']);
    const slotId = await seedSlot(dataSource, pro.id, pro.serviceId, futureSlotTime(40 + (hour += 2)));
    const result = await checkout.checkout({ customerId: customer.id, professionalId: pro.id, slotId, serviceId: pro.serviceId, callbackBaseUrl: 'http://x/cb' });
    const [att] = await dataSource.query(`SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1`, [result.paymentIntentId]);
    await sandbox.decide(att.provider_reference, opts.manual === false ? 'success' : 'success_manual_refund');
    await checkout.handleCallback('sandbox', att.provider_reference, { reference: att.provider_reference });
    await bookings.cancel(result.bookingId, { type: 'professional', id: owner.id }, 'مشکل پیش‌بینی‌نشده');
    if ((opts.deliver ?? 'decide+execute') === 'decide+execute') {
      await handler.handle({ payload: { bookingId: result.bookingId } } as never);
    } else if (opts.deliver === 'decide-only') {
      await orchestrator.decideCancellation(result.bookingId, (m, h) => bookings.cancellationFacts(m, result.bookingId, h));
    }
    return { owner, customer, professionalId: pro.id, serviceId: pro.serviceId, bookingId: result.bookingId, orderId: result.order.order.id };
  }

  const newSlot = (c: Case) => seedSlot(dataSource, c.professionalId, c.serviceId, futureSlotTime(300 + (hour += 2)));
  const refunds = (orderId: string) =>
    dataSource.query(`SELECT id, request_key, amount_toman::int AS amount, status, manual_tracked, superseded_at IS NOT NULL AS superseded FROM payment.refunds WHERE order_id = $1 AND kind = 'order' ORDER BY created_at, id`, [orderId]);
  const decisions = (bookingId: string) =>
    dataSource.query(`SELECT id, execution_status, refund_request_key, superseded_by_id FROM commerce.booking_outcome_decisions WHERE booking_id = $1 AND decision_kind = 'cancellation' ORDER BY decided_at, id`, [bookingId]);
  const remedyRow = async (orderId: string) => (await dataSource.query(`SELECT resolved_by, chosen FROM commerce.customer_remedy_choices WHERE order_id = $1`, [orderId]))[0];
  const booking = async (id: string) => (await dataSource.query(`SELECT status, slot_id FROM booking.bookings WHERE id = $1`, [id]))[0];
  const refundCompletedEvents = async (refundId: string) =>
    Number((await dataSource.query(`SELECT count(*)::int n FROM payment.outbox_events WHERE event_type = 'RefundCompleted' AND payload->>'refundId' = $1`, [refundId]))[0].n);
  const claim = (refundId: string, as: SeededUser = admin) => request(server()).post(`/api/v1/admin/refunds/manual/${refundId}/claim`).set(auth(as)).send({ note: 'آزمون' });
  const resolveExec = (executionId: string, outcome: string, externalReference?: string) =>
    request(server()).post(`/api/v1/admin/refunds/manual/executions/${executionId}/resolve`).set(auth(admin)).send({ outcome, ...(externalReference ? { externalReference } : {}) });
  const reschedule = (c: Case, slotId: string) => remedy.resolve(c.bookingId, c.customer.id, 'reschedule', slotId);

  describe('supersession when nobody claimed the manual execution', () => {
    it('reschedule supersedes the tracked manual refund atomically: booking revived, refund superseded (kept), decision superseded, no RefundCompleted, commitments freed', async () => {
      const c = await sellerCancelled();
      const [r0] = await refunds(c.orderId);
      expect(r0).toMatchObject({ status: 'manual_required', manual_tracked: true, amount: PRICE });
      expect((await remedy.read(c.bookingId)).rescheduleStillAvailable).toBe(true);

      const slot = await newSlot(c);
      expect(await reschedule(c, slot)).toEqual({ chosen: 'reschedule', resolvedBy: 'customer' });

      expect(await booking(c.bookingId)).toEqual({ status: 'confirmed', slot_id: slot });
      const [r1] = await refunds(c.orderId);
      expect(r1).toMatchObject({ id: r0.id, status: 'superseded', superseded: true, amount: PRICE });
      expect((await decisions(c.bookingId))[0].execution_status).toBe('superseded');
      expect(await remedyRow(c.orderId)).toEqual({ resolved_by: 'customer', chosen: 'reschedule' });
      expect(await refundCompletedEvents(r0.id)).toBe(0);
      const commitments = await payments.orderRefundCommitments(dataSource.manager, c.orderId, 'probe');
      expect(commitments.otherCommittedToman).toBe(0n);
    });

    it('a retried reschedule is a no-op (no second move, nothing else written)', async () => {
      const c = await sellerCancelled();
      const s1 = await newSlot(c);
      const s2 = await newSlot(c);
      await reschedule(c, s1);
      expect(await reschedule(c, s2)).toEqual({ chosen: 'reschedule', resolvedBy: 'customer' });
      expect((await booking(c.bookingId)).slot_id).toBe(s1);
      expect((await refunds(c.orderId)).map((r: { status: string }) => r.status)).toEqual(['superseded']);
    });

    it('an unavailable slot rolls EVERYTHING back (refund, decision, remedy, booking untouched)', async () => {
      const c = await sellerCancelled();
      const slot = await newSlot(c);
      const other = await seedUser(app, dataSource, phone(), ['customer']);
      await bookings.create({ customerId: other.id, professionalId: c.professionalId, slotId: slot, serviceId: c.serviceId });
      await expect(reschedule(c, slot)).rejects.toBeInstanceOf(SlotUnavailableException);
      expect((await refunds(c.orderId))[0].status).toBe('manual_required');
      expect((await decisions(c.bookingId))[0].execution_status).toBe('manual_required');
      expect(await remedyRow(c.orderId)).toEqual({ resolved_by: 'default', chosen: null });
      expect((await booking(c.bookingId)).status).toBe('cancelled');
    });
  });

  describe('the durable claim blocks supersession (both race orders)', () => {
    it('claim first → reschedule refused REMEDY_REFUND_IN_EXECUTION; nothing changed; view hides the option', async () => {
      const c = await sellerCancelled();
      const [r] = await refunds(c.orderId);
      const claimed = await claim(r.id).expect(201);
      expect(claimed.body.data.state).toBe('claimed');
      expect((await remedy.read(c.bookingId)).rescheduleStillAvailable).toBe(false);
      await expect(reschedule(c, await newSlot(c))).rejects.toMatchObject({ response: { code: 'REMEDY_REFUND_IN_EXECUTION' } });
      expect((await refunds(c.orderId))[0].status).toBe('manual_required');
      expect((await booking(c.bookingId)).status).toBe('cancelled');
      expect(await remedyRow(c.orderId)).toEqual({ resolved_by: 'default', chosen: null });
    });

    it('reschedule first → claim refused REFUND_NOT_CLAIMABLE; no execution row', async () => {
      const c = await sellerCancelled();
      const [r] = await refunds(c.orderId);
      await reschedule(c, await newSlot(c));
      const res = await claim(r.id).expect(409);
      expect(res.body.error.code).toBe('REFUND_NOT_CLAIMABLE');
      expect(await dataSource.query(`SELECT 1 FROM payment.manual_refund_executions WHERE refund_id = $1`, [r.id])).toEqual([]);
    });

    it('genuinely concurrent claim vs reschedule: exactly one wins, and the state is consistent with the winner', async () => {
      for (let i = 0; i < 3; i++) {
        const c = await sellerCancelled();
        const [r] = await refunds(c.orderId);
        const slot = await newSlot(c);
        const [cl, rs] = await Promise.allSettled([claim(r.id), reschedule(c, slot)]);
        const claimWon = cl.status === 'fulfilled' && (cl.value as request.Response).status === 201;
        const rescheduleWon = rs.status === 'fulfilled';
        expect(claimWon !== rescheduleWon).toBe(true);
        const [after] = await refunds(c.orderId);
        const execs = await dataSource.query(`SELECT state FROM payment.manual_refund_executions WHERE refund_id = $1`, [r.id]);
        if (claimWon) {
          expect(after.status).toBe('manual_required');
          expect(execs).toEqual([{ state: 'claimed' }]);
          expect((await booking(c.bookingId)).status).toBe('cancelled');
        } else {
          expect(after.status).toBe('superseded');
          expect(execs).toEqual([]);
          expect((await booking(c.bookingId)).status).toBe('confirmed');
        }
      }
    });

    it('a second claim is refused; there is never a timeout release', async () => {
      const c = await sellerCancelled();
      const [r] = await refunds(c.orderId);
      await claim(r.id).expect(201);
      expect((await claim(r.id).expect(409)).body.error.code).toBe('REFUND_NOT_CLAIMABLE');
      await dataSource.query(`UPDATE payment.manual_refund_executions SET claimed_at = claimed_at - interval '30 days' WHERE refund_id = $1`, [r.id]).catch(() => undefined);
      await expect(reschedule(c, await newSlot(c))).rejects.toMatchObject({ response: { code: 'REMEDY_REFUND_IN_EXECUTION' } });
    });
  });

  describe('execution outcomes', () => {
    it('uncertain keeps blocking; released (operator attests no transfer) unblocks the reschedule', async () => {
      const c = await sellerCancelled();
      const [r] = await refunds(c.orderId);
      const exec = (await claim(r.id).expect(201)).body.data.executionId;
      await resolveExec(exec, 'uncertain').expect(201);
      await expect(reschedule(c, await newSlot(c))).rejects.toMatchObject({ response: { code: 'REMEDY_REFUND_IN_EXECUTION' } });
      await resolveExec(exec, 'released').expect(201);
      expect((await remedy.read(c.bookingId)).rescheduleStillAvailable).toBe(true);
      await reschedule(c, await newSlot(c));
      expect((await refunds(c.orderId))[0].status).toBe('superseded');
      const history = await dataSource.query(`SELECT state FROM payment.manual_refund_executions WHERE refund_id = $1`, [r.id]);
      expect(history).toEqual([{ state: 'released' }]);
    });

    it('executed: reference required; refund succeeded + RefundCompleted + decision executed; reschedule then refused (money left)', async () => {
      const c = await sellerCancelled();
      const [r] = await refunds(c.orderId);
      const exec = (await claim(r.id).expect(201)).body.data.executionId;
      expect((await resolveExec(exec, 'executed').expect(400)).body.error.code).toBe('MANUAL_REFUND_REFERENCE_REQUIRED');
      const done = await resolveExec(exec, 'executed', 'SIM-TRANSFER-001').expect(201);
      expect(done.body.data.refundStatus).toBe('succeeded');
      expect(await refundCompletedEvents(r.id)).toBe(1);
      expect((await decisions(c.bookingId))[0].execution_status).toBe('executed');
      expect((await resolveExec(exec, 'released').expect(409)).body.error.code).toBe('MANUAL_REFUND_TRANSITION_NOT_ALLOWED');
      await expect(reschedule(c, await newSlot(c))).rejects.toMatchObject({ response: { code: 'REMEDY_REFUND_ALREADY_EXECUTED' } });
      await relay.drain();
      const [{ refunded }] = await dataSource.query(`SELECT refunded_total_toman::int AS refunded FROM commerce.orders WHERE id = $1`, [c.orderId]);
      expect(refunded).toBe(PRICE);
    });

    it('legacy/unknown manual_required (not tracked) is never superseded, but can be claimed', async () => {
      const c = await sellerCancelled();
      const [r] = await refunds(c.orderId);
      await dataSource.query(`UPDATE payment.refunds SET manual_tracked = false WHERE id = $1`, [r.id]);
      expect((await remedy.read(c.bookingId)).rescheduleStillAvailable).toBe(false);
      await expect(reschedule(c, await newSlot(c))).rejects.toMatchObject({ response: { code: 'REMEDY_REFUND_UNVERIFIABLE' } });
      await claim(r.id).expect(201);
    });

    it('the database itself refuses to supersede a claimed or untracked refund', async () => {
      const c = await sellerCancelled();
      const [r] = await refunds(c.orderId);
      await claim(r.id).expect(201);
      await expect(dataSource.query(`UPDATE payment.refunds SET status = 'superseded', superseded_at = now() WHERE id = $1`, [r.id])).rejects.toThrow(/cannot be superseded/);
    });
  });

  describe('review finding: manual execution recorded while the automatic execution has not recorded yet', () => {
    it('deterministic interleaving (paused before recordExecution): the recorded execution moves the decision atomically; the late recordExecution changes nothing', async () => {
      // The ORCHESTRATOR's own instance (the provider is instantiated per module; app.get may return another).
      const decisionsSvc = (orchestrator as unknown as { decisions: BookingOutcomeDecisionService }).decisions;
      const original = decisionsSvc.recordExecution.bind(decisionsSvc);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let paused = false;
      const spy = jest.spyOn(decisionsSvc, 'recordExecution').mockImplementationOnce(async (...args) => {
        paused = true;
        await gate;
        return original(...args);
      });
      try {
        const c = await sellerCancelled({ deliver: 'none' });
        const delivering = handler.handle({ payload: { bookingId: c.bookingId } } as never);
        for (let i = 0; i < 200 && !paused; i++) await new Promise((x) => setTimeout(x, 25));
        expect(paused).toBe(true); // deterministic: the execution is parked exactly before recordExecution
        const [r] = (await refunds(c.orderId)) as Array<{ id: string; status: string }>;
        // THE WINDOW: refund committed manual_required, decision still `executing`.
        expect(r!.status).toBe('manual_required');
        expect((await decisions(c.bookingId))[0].execution_status).toBe('executing');
        expect((await remedy.read(c.bookingId)).rescheduleStillAvailable).toBe(false);
        await expect(reschedule(c, await newSlot(c))).rejects.toMatchObject({ response: { code: 'REMEDY_REFUND_IN_EXECUTION' } });

        const exec = (await claim(r!.id).expect(201)).body.data.executionId;
        // No outbox drain during the resolve: a redelivered BookingCancelled would resume the parked execution
        // and heal the state by coincidence; the property under test is the resolve's OWN atomicity.
        const drain = jest.spyOn(relay, 'drain').mockResolvedValue(undefined as never);
        try {
          await resolveExec(exec, 'executed', 'SIM-RACE-1').expect(201);
        } finally {
          drain.mockRestore();
        }
        expect((await refunds(c.orderId))[0].status).toBe('succeeded');
        expect((await decisions(c.bookingId))[0].execution_status).toBe('executed'); // atomic with the refund
        expect(await refundCompletedEvents(r!.id)).toBe(1);

        release();
        await delivering;
        expect((await decisions(c.bookingId))[0].execution_status).toBe('executed'); // not rolled back to manual_required
        expect((await refunds(c.orderId))[0].status).toBe('succeeded');
        expect(await refundCompletedEvents(r!.id)).toBe(1);
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it('fail-closed: a refund whose decision is in any other state (inconsistent) cannot be recorded as executed; nothing changes', async () => {
      const c = await sellerCancelled();
      const [r] = await refunds(c.orderId);
      const [d] = await decisions(c.bookingId);
      // An inconsistent pairing forced for the test: decision already executed, refund still manual_required.
      await dataSource.query(`UPDATE commerce.booking_outcome_decisions SET execution_status = 'executed' WHERE id = $1`, [d.id]);
      const exec = (await claim(r.id).expect(201)).body.data.executionId;
      const res = await resolveExec(exec, 'executed', 'SIM-CONFLICT');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MANUAL_REFUND_TRANSITION_NOT_ALLOWED');
      expect((await refunds(c.orderId))[0].status).toBe('manual_required');
      expect(await refundCompletedEvents(r.id)).toBe(0);
      const [e] = await dataSource.query(`SELECT state FROM payment.manual_refund_executions WHERE id = $1`, [exec]);
      expect(e.state).toBe('claimed');
    });

    it('a manual refund with NO outcome decision (legacy/unrelated) can still be executed', async () => {
      const c = await sellerCancelled({ deliver: 'none' });
      // The booking stays cancelled but undecided; an unrelated manual refund on the same (manual-bank) payment.
      const refund = await payments.refund({ orderId: c.orderId, amountToman: 1000, reason: 'suite: unrelated manual refund', requestKey: 'suite-no-decision', actorType: 'admin', actorId: admin.id });
      expect(refund.status).toBe('manual_required');
      const exec = (await claim(refund.id).expect(201)).body.data.executionId;
      const done = await resolveExec(exec, 'executed', 'SIM-LEGACY').expect(201);
      expect(done.body.data.refundStatus).toBe('succeeded');
    });
  });

  describe('automatic execution claim (crash window)', () => {
    it('a decision left `executing` (crash after the claim) refuses the reschedule; redelivery resumes and executes', async () => {
      const c = await sellerCancelled({ manual: false, deliver: 'decide-only' });
      const [d] = await decisions(c.bookingId);
      expect(d.execution_status).toBe('pending');
      await dataSource.query(`UPDATE commerce.booking_outcome_decisions SET execution_status = 'executing' WHERE id = $1`, [d.id]);
      expect((await remedy.read(c.bookingId)).rescheduleStillAvailable).toBe(false);
      await expect(reschedule(c, await newSlot(c))).rejects.toMatchObject({ response: { code: 'REMEDY_REFUND_IN_EXECUTION' } });
      await handler.handle({ payload: { bookingId: c.bookingId } } as never);
      expect((await decisions(c.bookingId))[0].execution_status).toBe('executed');
      expect((await refunds(c.orderId))[0].status).toBe('succeeded');
    });

    it('pending (not yet claimed) → reschedule supersedes the decision; a late execution attempt then does nothing', async () => {
      const c = await sellerCancelled({ manual: false, deliver: 'decide-only' });
      await reschedule(c, await newSlot(c));
      expect((await decisions(c.bookingId))[0].execution_status).toBe('superseded');
      await handler.handle({ payload: { bookingId: c.bookingId } } as never); // redelivery of the first cancellation
      expect(await refunds(c.orderId)).toEqual([]);
    });
  });

  describe('F-11: a later cancellation after the reschedule is refunded normally', () => {
    it('manual path: new decision (after-key) supersedes the consumed one; full refund issued again (manual, tracked)', async () => {
      const c = await sellerCancelled();
      await reschedule(c, await newSlot(c));
      await bookings.cancel(c.bookingId, { type: 'professional', id: c.owner.id }, 'دوباره لغو شد');
      await handler.handle({ payload: { bookingId: c.bookingId } } as never);

      const ds = await decisions(c.bookingId);
      expect(ds).toHaveLength(2);
      expect(ds[0].superseded_by_id).toBe(ds[1].id);
      expect(ds[1].refund_request_key).toBe(`booking-cancelled:${c.bookingId}:after:${ds[0].id}`);
      const rs = await refunds(c.orderId);
      expect(rs.map((r: { status: string; amount: number }) => [r.status, r.amount])).toEqual([
        ['superseded', PRICE],
        ['manual_required', PRICE],
      ]);
      expect(rs[1].manual_tracked).toBe(true);
    });

    it('automatic path: the second cancellation refunds (succeeded) under the after-key, full amount', async () => {
      const c = await sellerCancelled({ manual: false, deliver: 'decide-only' });
      await reschedule(c, await newSlot(c));
      await bookings.cancel(c.bookingId, { type: 'professional', id: c.owner.id }, 'دوباره لغو شد');
      await handler.handle({ payload: { bookingId: c.bookingId } } as never);
      const rs = await refunds(c.orderId);
      expect(rs).toHaveLength(1);
      expect(rs[0]).toMatchObject({ status: 'succeeded', amount: PRICE });
      expect(rs[0].request_key).toMatch(new RegExp(`^booking-cancelled:${c.bookingId}:after:`));
    });

    it('a redelivery of the second cancellation issues nothing new', async () => {
      const c = await sellerCancelled({ manual: false, deliver: 'decide-only' });
      await reschedule(c, await newSlot(c));
      await bookings.cancel(c.bookingId, { type: 'professional', id: c.owner.id }, 'دوباره لغو شد');
      await handler.handle({ payload: { bookingId: c.bookingId } } as never);
      await handler.handle({ payload: { bookingId: c.bookingId } } as never);
      expect(await refunds(c.orderId)).toHaveLength(1);
      expect(await decisions(c.bookingId)).toHaveLength(2);
    });
  });

  describe('authorization (owner control = the administrator)', () => {
    it('customer and platform operator get 403 on list/claim/resolve; the refund is unchanged; the administrator succeeds', async () => {
      const c = await sellerCancelled();
      const [r] = await refunds(c.orderId);
      const operator = await seedUser(app, dataSource, phone(), ['platform_operator']);
      for (const u of [c.customer, operator]) {
        await request(server()).get('/api/v1/admin/refunds/manual').set(auth(u)).expect(403);
        await claim(r.id, u).expect(403);
      }
      expect(await dataSource.query(`SELECT 1 FROM payment.manual_refund_executions WHERE refund_id = $1`, [r.id])).toEqual([]);
      const list = await request(server()).get('/api/v1/admin/refunds/manual').set(auth(admin)).expect(200);
      expect((list.body.data as Array<{ refundId: string }>).some((x) => x.refundId === r.id)).toBe(true);
      await claim(r.id).expect(201);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int n FROM admin.admin_audit_log WHERE action = 'payment.manual_refund_claimed' AND target_id = $1`, [r.id]);
      expect(n).toBe(1);
    });

    it('another customer cannot use the remedy of this booking (HTTP 404); the owner can', async () => {
      const c = await sellerCancelled();
      const other = await seedUser(app, dataSource, phone(), ['customer']);
      const slot = await newSlot(c);
      const denied = await request(server()).post(`/api/v1/bookings/${c.bookingId}/remedy`).set(auth(other)).send({ choice: 'reschedule', newSlotId: slot });
      expect(denied.status).toBe(404);
      expect((await refunds(c.orderId))[0].status).toBe('manual_required');
      const ok = await request(server()).post(`/api/v1/bookings/${c.bookingId}/remedy`).set(auth(c.customer)).send({ choice: 'reschedule', newSlotId: slot });
      expect(ok.status).toBeLessThan(300);
    });
  });
});
