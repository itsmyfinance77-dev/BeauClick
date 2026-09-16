import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuditLogger } from '@beauclick/events';
import {
  BookingOutcomeDecisionRecord,
  BookingOutcomeDecisionService,
  BookingOutcomeExecutionStatus,
  CustomerRemedyChoiceService,
  LockedBookingOrder,
  NewBookingOutcomeDecision,
  OrderDecisionTerms,
  OrderService,
  OrderStatus,
} from '@beauclick/commerce';
import { PaymentService, RefundStatus } from '@beauclick/payment';
import {
  BookingCancellationFacts,
  BookingNoShowGovernance,
  BookingRescheduleFacts,
  BookingRescheduleGovernance,
  BookingRescheduleOutcomeHook,
} from '@beauclick/booking';
import { evaluateBookingOutcome } from '@beauclick/commercial-policy';
import {
  BookingOutcomeEvaluationV1,
  bookingCancellationRefundKey,
  bookingNoShowRefundKey,
  bookingOutcomeCauseForActor,
} from '@beauclick/commercial-policy-contract';

/** ISO-8601 UTC with microseconds — mirrors `booking.service.ts`'s own constant, so `event_instant` survives a `timestamptz` round trip exactly. */
const ISO_MICROS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * The order statuses that mean BeauClick collected nothing — V3.3 #81
 * (`#41b`), ADR-044 §10. Moved here unchanged from the refund handler #160
 * replaced: such an order is cancelled, never refunded, and a paid one never is.
 */
export const NEVER_COLLECTED_STATUSES: readonly OrderStatus[] = ['pending', 'online_collection_not_required'];

/** The refund reason the cancellation path has always used. */
export const BOOKING_CANCELLATION_REFUND_REASON = 'رزرو مرتبط لغو شد — بازگشت خودکار وجه.';

/** V3.3 #161 (`#42d`). The refund reason a no-show window's un-retained remainder is issued under. */
export const BOOKING_NO_SHOW_REFUND_REASON = 'ارزیابی عدم حضور رزرو مرتبط انجام شد — بازگشت خودکار مبلغ باقی‌مانده.';

/** Reads the cancellation facts inside the deciding transaction, given the snapshot's cutoff. */
export type CancellationFactsReader = (manager: EntityManager, cutoffHours: number | null) => Promise<BookingCancellationFacts | null>;

/** What a governed reschedule carries back through booking-service, unopened. */
interface GovernedRescheduleContext {
  readonly governed: true;
  readonly cutoffHours: number;
  readonly rescheduleFreeCount: number;
  readonly orderId: string;
  readonly bookingId: string;
  readonly terms: OrderDecisionTerms;
  readonly collectedRemainingToman: bigint;
}

/**
 * The booking outcome decisions, composed — V3.3 Story #160 (`#42c`), ADR-051
 * §6 with its 2026-09-15 consistency note.
 *
 * The one place four domains meet for an outcome: Commerce's locked order,
 * terms and decision record; Payment's refund commitments and execution;
 * Booking's database-clock facts; and Commercial Policy's pure evaluator. None
 * of them may import another (ADR-011), so the composition root joins them —
 * and decides nothing itself: every number comes from `evaluateBookingOutcome`
 * and every guard is enforced again by the decision table's constraints.
 *
 * ## The cancellation, in two steps
 *
 * `decideCancellation` runs ONE transaction in ADR-050's lock order — order
 * `FOR UPDATE`, then the booking `FOR SHARE` — reads the snapshot, the Legal
 * cap's current state and the refunds already committed, evaluates, and
 * commits the decision (cancelling a never-collected order in the same
 * transaction, as the handler it replaces always did). Only THEN does
 * `executeCancellation` call the refund, under the one booking-derived key,
 * and record how it ended. A redelivery finds the live decision and never
 * evaluates twice.
 *
 * ## The reschedule, as booking-service's seam
 *
 * It implements `BookingRescheduleOutcomeHook`: it takes the order lock before
 * booking-service locks the booking, classifies nothing itself, and records the
 * accepted zero-money consequence inside booking-service's transaction.
 */
@Injectable()
export class BookingOutcomeOrchestrator implements BookingRescheduleOutcomeHook {
  private readonly logger = new Logger('BookingOutcomeOrchestrator');
  private readonly auditLog = new AuditLogger('commerce');

  constructor(
    private readonly dataSource: DataSource,
    private readonly decisions: BookingOutcomeDecisionService,
    private readonly payments: PaymentService,
    private readonly orders: OrderService,
    // V3.3 #161 (`#42d`), ADR-051 §8.
    private readonly remedyChoices: CustomerRemedyChoiceService,
  ) {}

  // ---------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------

  /**
   * The cancellation decision, committed. `null` when the booking has no order,
   * or records no cancellation (a `BookingCancelled` fact with nothing behind it
   * moves no money).
   */
  async decideCancellation(bookingId: string, readFacts: CancellationFactsReader): Promise<BookingOutcomeDecisionRecord | null> {
    return this.dataSource.transaction(async (m) => {
      const order = await this.decisions.lockOrderForBooking(m, bookingId);
      if (!order) return null;

      const live = await this.decisions.liveDecision(m, bookingId, 'cancellation');
      if (live) return live;

      const terms = await this.decisions.termsFor(m, order.orderId);
      const facts = await readFacts(m, terms?.cutoffHours ?? null);
      if (!facts) {
        this.logger.warn(`BookingCancelled for booking ${bookingId} with no recorded cancellation; nothing decided.`);
        return null;
      }

      const requestKey = bookingCancellationRefundKey(bookingId);
      const commitments = await this.payments.orderRefundCommitments(m, order.orderId, requestKey);

      const decision = commitments.keyRefund
        ? this.adoptExistingRefund(bookingId, order, terms, facts, requestKey, commitments.keyRefund)
        : this.evaluateCancellation(bookingId, order, terms, facts, requestKey, commitments.otherCommittedToman);

      const recorded = await this.decisions.recordDecision(m, decision);

      if (NEVER_COLLECTED_STATUSES.includes(order.status)) {
        // Never collected: nothing to refund; cancel the order so it stops
        // appearing as awaiting payment -- inside THIS transaction, holding the
        // order row, so a capture cannot slip in between the decision and it.
        await this.orders.cancel(order.orderId, `booking_cancelled:${bookingId}`, m);
      }

      /*
       * V3.3 #161 (`#42d`), ADR-051 §8. A seller/platform/provider
       * cancellation additionally offers the customer's remedy choice,
       * already resolved to the ratified default (full refund) -- see
       * `commerce.customer_remedy_choices`'s own migration for why there is
       * no genuinely open state to model. Idempotent on `order_id`, so a
       * redelivery that reaches the `live` early-return above never
       * re-offers (the row already exists from the original decision).
       */
      if (decision.cause === 'seller' || decision.cause === 'platform' || decision.cause === 'provider') {
        await this.remedyChoices.offerDefault(m, order.orderId, bookingId);
      }

      this.auditLog.log({
        action: 'commerce.booking_outcome_decided',
        bookingId,
        orderId: order.orderId,
        decisionId: recorded.id,
        decisionKind: recorded.kind,
        cause: decision.cause,
        basis: recorded.basis,
        executionStatus: recorded.executionStatus,
      });
      return recorded;
    });
  }

  /**
   * Executes a committed cancellation decision: one refund call under its own
   * key, only when it refunds something and is still `pending`, then one
   * compare-and-swap recording how it ended.
   *
   * A redelivery re-calls with the same key, and `PaymentService.refund`
   * returns the refund that key already has — so a `failed` refund is reported
   * as failed and is not re-executed here (re-driving a real refund is #47).
   */
  async executeCancellation(decision: BookingOutcomeDecisionRecord): Promise<void> {
    /*
     * V3.3 #161 (`#42d`), ADR-051 §8. A customer who already chose
     * `reschedule` instead of the default refund must never also receive
     * one. Read unlocked, on the orchestrator's own connection -- this
     * method's refund call is itself outside any transaction, exactly like
     * the payment gateway call and the execution-status CAS it wraps -- and
     * checked immediately before issuing the refund. The remedy route's own
     * eligibility check (only while this decision's `execution_status` is
     * still `pending`/`manual_required`) is what bounds the race this leaves
     * open, not a re-check here: once `recordExecution` below moves this row
     * out of `pending`, the remedy route refuses a reschedule against it.
     * Only `cancellation` decisions are ever offered a remedy (`decideCancellation`),
     * so a no-show decision never reads this table at all.
     */
    if (decision.kind === 'cancellation') {
      const resolution = await this.remedyChoices.resolution(this.dataSource.manager, decision.orderId);
      if (resolution?.chosen === 'reschedule') {
        this.auditLog.log({
          action: 'commerce.booking_outcome_refund_skipped_for_remedy',
          bookingId: decision.bookingId,
          decisionId: decision.id,
        });
        return;
      }
    }

    await this.executeDecision(decision, BOOKING_CANCELLATION_REFUND_REASON);
  }

  /**
   * Executes any committed decision's refund: one call under its own key,
   * only when it refunds something and is still `pending`, then one
   * compare-and-swap recording how it ended — shared by `executeCancellation`
   * and #161's `decideNoShowWindow`, which differ only in the Persian reason
   * shown at the gateway and in whether a remedy choice can pre-empt it.
   *
   * A redelivery re-calls with the same key, and `PaymentService.refund`
   * returns the refund that key already has — so a `failed` refund is reported
   * as failed and is not re-executed here (re-driving a real refund is #47).
   */
  private async executeDecision(decision: BookingOutcomeDecisionRecord, reason: string): Promise<void> {
    if (decision.executionStatus !== 'pending' || decision.refundToman <= 0n || decision.refundRequestKey === null) return;

    const refund = await this.payments.refund({
      orderId: decision.orderId,
      amountToman: Number(decision.refundToman),
      reason,
      requestKey: decision.refundRequestKey,
      actorType: 'system',
      actorId: null,
    });

    const status = executionStatusOf(refund.status);
    if (status === 'pending') return;
    const moved = await this.decisions.recordExecution(decision.id, status);
    if (moved) {
      this.auditLog.log({
        action: 'commerce.booking_outcome_executed',
        bookingId: decision.bookingId,
        decisionId: decision.id,
        executionStatus: status,
      });
    }
  }

  private evaluateCancellation(
    bookingId: string,
    order: LockedBookingOrder,
    terms: OrderDecisionTerms | null,
    facts: BookingCancellationFacts,
    requestKey: string,
    otherCommittedToman: bigint,
  ): NewBookingOutcomeDecision {
    // Money already asked back -- projected or not -- is not collected remaining.
    const committed = order.refundedTotalToman > otherCommittedToman ? order.refundedTotalToman : otherCommittedToman;
    const collectedRemaining = order.collectedTotalToman > committed ? order.collectedTotalToman - committed : 0n;
    const cause = bookingOutcomeCauseForActor(facts.cancelledByActorType);

    const evaluation = evaluateBookingOutcome({
      cause,
      bookingWasConfirmed: facts.wasConfirmed,
      timely: terms === null ? null : facts.timely,
      collectedRemainingToman: collectedRemaining,
      terms,
      legalCapState: terms?.legalCapState ?? 'absent',
    });

    return this.cancellationRow(bookingId, order, terms, facts, requestKey, collectedRemaining, evaluation, {
      retainedToman: evaluation.retainedToman,
      refundToman: evaluation.refundToman,
      basis: evaluation.basis,
      executionStatus: evaluation.refundToman > 0n ? 'pending' : 'executed',
    });
  }

  /**
   * A refund under this booking's key already exists and no decision does —
   * a cancellation refunded before #160, or a capture that could not confirm a
   * booking the customer had just cancelled (the checkout compensation now uses
   * the cancellation's own key). The decision records that refund as the
   * outcome instead of issuing another, and never retains.
   */
  private adoptExistingRefund(
    bookingId: string,
    order: LockedBookingOrder,
    terms: OrderDecisionTerms | null,
    facts: BookingCancellationFacts,
    requestKey: string,
    keyRefund: { amountToman: bigint; status: RefundStatus },
  ): NewBookingOutcomeDecision {
    const evaluation = evaluateBookingOutcome({
      cause: bookingOutcomeCauseForActor(facts.cancelledByActorType),
      bookingWasConfirmed: facts.wasConfirmed,
      timely: terms === null ? null : facts.timely,
      collectedRemainingToman: keyRefund.amountToman,
      terms,
      legalCapState: terms?.legalCapState ?? 'absent',
    });
    const status = executionStatusOf(keyRefund.status);
    return this.cancellationRow(bookingId, order, terms, facts, requestKey, keyRefund.amountToman, evaluation, {
      retainedToman: 0n,
      refundToman: keyRefund.amountToman,
      basis: 'pre_existing_refund',
      executionStatus: keyRefund.amountToman > 0n ? status : 'executed',
    });
  }

  private cancellationRow(
    bookingId: string,
    order: LockedBookingOrder,
    terms: OrderDecisionTerms | null,
    facts: BookingCancellationFacts,
    requestKey: string,
    collectedRemaining: bigint,
    evaluation: BookingOutcomeEvaluationV1,
    outcome: Pick<NewBookingOutcomeDecision, 'retainedToman' | 'refundToman' | 'basis' | 'executionStatus'>,
  ): NewBookingOutcomeDecision {
    return {
      bookingId,
      orderId: order.orderId,
      kind: 'cancellation',
      cause: bookingOutcomeCauseForActor(facts.cancelledByActorType),
      eventInstant: facts.eventInstant,
      bookingWasConfirmed: facts.wasConfirmed,
      policyKey: terms?.policyKey ?? null,
      policyVersion: terms?.policyVersion ?? null,
      cutoffInstant: terms === null ? null : facts.cutoffInstant,
      timely: terms === null ? null : facts.timely,
      collectedRemainingToman: collectedRemaining,
      policyAmountToman: evaluation.policyAmountToman,
      legalCapToman: evaluation.legalCapToman,
      legalCapState: evaluation.legalCapState,
      ...outcome,
      refundRequestKey: requestKey,
    };
  }

  // ---------------------------------------------------------------------
  // Reschedule -- booking-service's BookingRescheduleOutcomeHook
  // ---------------------------------------------------------------------

  async governReschedule(manager: EntityManager, bookingId: string): Promise<BookingRescheduleGovernance> {
    // Terms are immutable and never acquired later, so the unlocked read is
    // final -- and a booking without them takes no new lock at all.
    if (!(await this.decisions.bookingHasOutcomeTerms(manager, bookingId))) return { governed: false };

    const order = await this.decisions.lockOrderForBooking(manager, bookingId);
    const terms = order ? await this.decisions.termsFor(manager, order.orderId) : null;
    if (!order || !terms) return { governed: false };

    const commitments = await this.payments.orderRefundCommitments(manager, order.orderId, bookingCancellationRefundKey(bookingId));
    const keyCommitted = commitments.keyRefund && commitments.keyRefund.status !== 'failed' ? commitments.keyRefund.amountToman : 0n;
    const asked = commitments.otherCommittedToman + keyCommitted;
    const committed = order.refundedTotalToman > asked ? order.refundedTotalToman : asked;

    const context: GovernedRescheduleContext = {
      governed: true,
      cutoffHours: terms.cutoffHours,
      rescheduleFreeCount: terms.rescheduleFreeCount,
      orderId: order.orderId,
      bookingId,
      terms,
      collectedRemainingToman: order.collectedTotalToman > committed ? order.collectedTotalToman - committed : 0n,
    };
    return context;
  }

  consequenceRetainedToman(governance: BookingRescheduleGovernance, facts: BookingRescheduleFacts): bigint {
    return this.evaluateReschedule(contextOf(governance, facts), facts).retainedToman;
  }

  async recordConsequence(manager: EntityManager, governance: BookingRescheduleGovernance, facts: BookingRescheduleFacts): Promise<void> {
    const context = contextOf(governance, facts);
    const evaluation = this.evaluateReschedule(context, facts);
    if (evaluation.retainedToman > 0n) {
      // Unreachable through booking-service, which refuses first; and the
      // table's dormancy CHECK would refuse it again.
      throw new Error('a reschedule consequence carrying money is not ratified');
    }

    const recorded = await this.decisions.recordSupersedingDecision(manager, {
      bookingId: facts.bookingId,
      orderId: context.orderId,
      kind: 'reschedule_consequence',
      cause: 'customer',
      eventInstant: facts.eventInstant,
      bookingWasConfirmed: facts.wasConfirmed,
      policyKey: context.terms.policyKey,
      policyVersion: context.terms.policyVersion,
      cutoffInstant: facts.cutoffInstant,
      timely: facts.timely,
      collectedRemainingToman: context.collectedRemainingToman,
      policyAmountToman: evaluation.policyAmountToman,
      legalCapToman: evaluation.legalCapToman,
      legalCapState: evaluation.legalCapState,
      retainedToman: 0n,
      refundToman: 0n,
      basis: evaluation.basis,
      executionStatus: 'executed',
      refundRequestKey: null,
    });

    this.auditLog.log({
      action: 'booking.reschedule_consequence_accepted',
      bookingId: facts.bookingId,
      orderId: context.orderId,
      decisionId: recorded.id,
      basis: recorded.basis,
    });
  }

  private evaluateReschedule(context: GovernedRescheduleContext, facts: BookingRescheduleFacts): BookingOutcomeEvaluationV1 {
    return evaluateBookingOutcome({
      cause: 'customer',
      bookingWasConfirmed: facts.wasConfirmed,
      timely: facts.timely,
      collectedRemainingToman: context.collectedRemainingToman,
      terms: context.terms,
      legalCapState: context.terms.legalCapState,
    });
  }

  // ---------------------------------------------------------------------
  // No-show -- booking-service's BookingRescheduleOutcomeHook, extended by
  // V3.3 #161 (`#42d`), ADR-051 §7
  // ---------------------------------------------------------------------

  /**
   * Whether, and under what snapshotted values, a booking's no-show guard is
   * governed. No lock at all: a declaration moves no money, and the terms it
   * reads are immutable (ADR-051's lock order for the declaration itself
   * never touches the order row).
   */
  async governNoShow(manager: EntityManager, bookingId: string): Promise<BookingNoShowGovernance> {
    const orderId = await this.decisions.orderIdForBooking(manager, bookingId);
    if (!orderId) return { governed: false };
    const terms = await this.decisions.termsFor(manager, orderId);
    if (!terms) return { governed: false };
    return { governed: true, graceMinutes: terms.noShowGraceMinutes, disputeWindowHours: terms.disputeWindowHours };
  }

  /**
   * Evaluates ONE booking's no-show window if it is due, and executes its
   * refund (if any) immediately afterward — there is no separate consumer
   * step the way `BookingCancelled` gives cancellation, so the decision and
   * its execution happen back to back here, exactly as #160's own handler
   * calls `decideCancellation` then `executeCancellation` in sequence.
   *
   * Both the periodic sweep (`expireNoShowWindows`) and any future lazy
   * caller call this SAME method -- there is no separate "lazy" code path to
   * drift from the sweep's, only a different reason to have called it.
   */
  async decideNoShowWindow(bookingId: string): Promise<BookingOutcomeDecisionRecord | null> {
    const decision = await this.decideNoShowWindowOnly(bookingId);
    if (decision) await this.executeDecision(decision, BOOKING_NO_SHOW_REFUND_REASON);
    return decision;
  }

  /**
   * The decision half of `decideNoShowWindow`, in its own transaction: the
   * declaration row `FOR UPDATE`, re-validated after the lock (not
   * `window_open`, or not yet due -- both ordinary outcomes for an
   * opportunistic caller, never an error), the order `FOR UPDATE`, the
   * decision inserted through the SAME `uq_bod_one_live_per_kind` index
   * every other decision kind converges on, and finally the declaration
   * moved to `evaluated`. Two concurrent calls for the same booking converge
   * on one decision: the second transaction's `FOR UPDATE` blocks until the
   * first commits, then observes `evaluation_state = 'evaluated'` and
   * returns the now-live decision without writing a second one.
   */
  private async decideNoShowWindowOnly(bookingId: string): Promise<BookingOutcomeDecisionRecord | null> {
    return this.dataSource.transaction(async (m) => {
      const declarations: Array<{ declared_at: string; evaluation_state: string; due: boolean }> = await m.query(
        `SELECT to_char(declared_at AT TIME ZONE 'UTC', ${ISO_MICROS}) AS declared_at,
                evaluation_state,
                (objection_window_ends_at IS NOT NULL AND objection_window_ends_at <= now()) AS due
           FROM booking.no_show_declarations
          WHERE booking_id = $1
            FOR UPDATE`,
        [bookingId],
      );
      const declaration = declarations[0];
      if (!declaration) return null;
      if (declaration.evaluation_state === 'evaluated') {
        // Converge: a concurrent sweep tick or lazy call already decided this
        // window (whichever of the two transactions locked the declaration
        // row second observes this, after the first committed) -- the SAME
        // live decision, not nothing.
        return this.decisions.liveDecision(m, bookingId, 'no_show');
      }
      if (declaration.evaluation_state !== 'window_open' || !declaration.due) return null;

      const order = await this.decisions.lockOrderForBooking(m, bookingId);
      if (!order) {
        // Structurally unreachable (a governed declaration always has an
        // order), fail closed rather than crash a sweep tick over it.
        this.logger.warn(`No-show window due for booking ${bookingId} with no order; nothing decided.`);
        return null;
      }

      const terms = await this.decisions.termsFor(m, order.orderId);
      const requestKey = bookingNoShowRefundKey(bookingId);
      const commitments = await this.payments.orderRefundCommitments(m, order.orderId, requestKey);
      const committed = order.refundedTotalToman > commitments.otherCommittedToman ? order.refundedTotalToman : commitments.otherCommittedToman;
      const collectedRemaining = order.collectedTotalToman > committed ? order.collectedTotalToman - committed : 0n;

      const evaluation = evaluateBookingOutcome({
        cause: 'no_show',
        bookingWasConfirmed: true,
        timely: null,
        collectedRemainingToman: collectedRemaining,
        terms,
        legalCapState: terms?.legalCapState ?? 'absent',
      });

      const decision: NewBookingOutcomeDecision = {
        bookingId,
        orderId: order.orderId,
        kind: 'no_show',
        cause: 'no_show',
        eventInstant: declaration.declared_at,
        bookingWasConfirmed: true,
        policyKey: terms?.policyKey ?? null,
        policyVersion: terms?.policyVersion ?? null,
        cutoffInstant: null,
        timely: null,
        collectedRemainingToman: collectedRemaining,
        policyAmountToman: evaluation.policyAmountToman,
        legalCapToman: evaluation.legalCapToman,
        legalCapState: evaluation.legalCapState,
        retainedToman: evaluation.retainedToman,
        refundToman: evaluation.refundToman,
        basis: evaluation.basis,
        executionStatus: evaluation.refundToman > 0n ? 'pending' : 'executed',
        refundRequestKey: requestKey,
      };

      const recorded = await this.decisions.recordDecision(m, decision);
      await this.markNoShowEvaluated(m, bookingId);

      this.auditLog.log({
        action: 'commerce.booking_outcome_decided',
        bookingId,
        orderId: order.orderId,
        decisionId: recorded.id,
        decisionKind: recorded.kind,
        cause: decision.cause,
        basis: recorded.basis,
        executionStatus: recorded.executionStatus,
      });
      return recorded;
    });
  }

  private async markNoShowEvaluated(manager: EntityManager, bookingId: string): Promise<void> {
    await manager.query(
      `UPDATE booking.no_show_declarations SET evaluation_state = 'evaluated'
        WHERE booking_id = $1 AND evaluation_state = 'window_open'`,
      [bookingId],
    );
  }

  /**
   * The periodic backstop: due, still-open windows, oldest first, each
   * decided in its own transaction so one failure cannot strand the rest of
   * the batch -- the same shape `BookingService.expireStaleHolds` uses. A
   * plain, unlocked scan; `decideNoShowWindow`'s own `FOR UPDATE` and its
   * re-validation after the lock are what make a concurrent lazy evaluation
   * of the same booking safe, not this scan's locking (there is none).
   */
  async expireNoShowWindows(limit = 100): Promise<number> {
    const due: Array<{ booking_id: string }> = await this.dataSource.query(
      `SELECT booking_id FROM booking.no_show_declarations
        WHERE evaluation_state = 'window_open' AND objection_window_ends_at <= now()
        ORDER BY objection_window_ends_at ASC
        LIMIT $1`,
      [limit],
    );
    let decided = 0;
    for (const row of due) {
      const outcome = await this.decideNoShowWindow(row.booking_id);
      if (outcome) decided += 1;
    }
    return decided;
  }
}

function contextOf(governance: BookingRescheduleGovernance, facts: BookingRescheduleFacts): GovernedRescheduleContext {
  const context = governance as Partial<GovernedRescheduleContext>;
  if (!governance.governed || context.terms === undefined || context.orderId === undefined || context.bookingId !== facts.bookingId) {
    throw new Error('reschedule consequence requested for a governance this seam did not issue');
  }
  return context as GovernedRescheduleContext;
}

function executionStatusOf(status: RefundStatus): BookingOutcomeExecutionStatus {
  switch (status) {
    case 'succeeded':
      return 'executed';
    case 'manual_required':
      return 'manual_required';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}
