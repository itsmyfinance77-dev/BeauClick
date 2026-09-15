import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { AuditLogger } from '@beauclick/events';
import {
  BookingOutcomeDecisionRecord,
  BookingOutcomeDecisionService,
  BookingOutcomeExecutionStatus,
  LockedBookingOrder,
  NewBookingOutcomeDecision,
  OrderDecisionTerms,
  OrderService,
  OrderStatus,
} from '@beauclick/commerce';
import { PaymentService, RefundStatus } from '@beauclick/payment';
import {
  BookingCancellationFacts,
  BookingRescheduleFacts,
  BookingRescheduleGovernance,
  BookingRescheduleOutcomeHook,
} from '@beauclick/booking';
import { evaluateBookingOutcome } from '@beauclick/commercial-policy';
import {
  BookingOutcomeEvaluationV1,
  bookingCancellationRefundKey,
  bookingOutcomeCauseForActor,
} from '@beauclick/commercial-policy-contract';

/**
 * The order statuses that mean BeauClick collected nothing — V3.3 #81
 * (`#41b`), ADR-044 §10. Moved here unchanged from the refund handler #160
 * replaced: such an order is cancelled, never refunded, and a paid one never is.
 */
export const NEVER_COLLECTED_STATUSES: readonly OrderStatus[] = ['pending', 'online_collection_not_required'];

/** The refund reason the cancellation path has always used. */
export const BOOKING_CANCELLATION_REFUND_REASON = 'رزرو مرتبط لغو شد — بازگشت خودکار وجه.';

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
    if (decision.executionStatus !== 'pending' || decision.refundToman <= 0n || decision.refundRequestKey === null) return;

    const refund = await this.payments.refund({
      orderId: decision.orderId,
      amountToman: Number(decision.refundToman),
      reason: BOOKING_CANCELLATION_REFUND_REASON,
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
