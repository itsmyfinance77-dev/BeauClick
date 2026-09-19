import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AuditLogger } from '@beauclick/events';
import { DomainException } from '@beauclick/http';
import { BookingOutcomeDecisionService, CustomerRemedyChoiceOption, CustomerRemedyChoiceService } from '@beauclick/commerce';
import { BookingService } from '@beauclick/booking';

/**
 * The customer never chose anything for this booking -- either it was never
 * cancelled by a non-customer cause, or (a foreign or nonexistent booking)
 * the caller has no legitimate claim on it at all. One generic refusal for
 * both, matching every other non-enumerating refusal on `v1/me/*`-adjacent
 * routes.
 */
export class RemedyNotOfferedException extends DomainException {
  constructor() {
    super('REMEDY_NOT_OFFERED', 'برای این رزرو گزینه‌ی جبران در دسترس نیست.', HttpStatus.NOT_FOUND);
  }
}

/**
 * The refund this remedy's default already produced has finished executing
 * -- money already left, so a switch to a free reschedule is no longer
 * offered (ADR-051 §8: "reschedule is available only while the refund
 * remains pending / manual_required").
 */
export class RemedyRefundAlreadyExecutedException extends DomainException {
  constructor() {
    super('REMEDY_REFUND_ALREADY_EXECUTED', 'بازگشت وجه این رزرو قبلاً انجام شده و دیگر امکان تغییر زمان رایگان وجود ندارد.', HttpStatus.CONFLICT);
  }
}

export class RemedyRescheduleRequiresSlotException extends DomainException {
  constructor() {
    super('REMEDY_RESCHEDULE_REQUIRES_SLOT', 'برای تغییر زمان رایگان، زمان جدید را انتخاب کنید.', HttpStatus.BAD_REQUEST);
  }
}

export interface CustomerRemedyResolutionResult {
  readonly chosen: CustomerRemedyChoiceOption | null;
  readonly resolvedBy: 'customer' | 'default';
}

/**
 * The remedy as the customer's own screen must render it — V3.3
 * `#42d-read` (#201), the read half of ADR-051 §8.
 *
 * `rescheduleStillAvailable` is the ONE derived field, and it is derived
 * from the same `ESCAPABLE_EXECUTION_STATUSES` set the write path consults,
 * in the same file, so the control the screen shows and the answer the POST
 * gives can never disagree. It is a boolean rather than a deadline on
 * purpose: the window is bounded by the refund's own state, not by a clock,
 * so there is nothing for a client to count down to and the design must not
 * be given a number that would invite one.
 */
export interface CustomerRemedyView {
  readonly chosen: CustomerRemedyChoiceOption | null;
  readonly resolvedBy: 'customer' | 'default';
  readonly rescheduleStillAvailable: boolean;
  readonly refundToman: string | null;
  readonly executionStatus: string | null;
}

/**
 * `POST /api/v1/bookings/:id/remedy` — V3.3 #161 (`#42d`), ADR-051 §8, the
 * composition root's own join of Commerce's remedy-choice record and
 * booking-service's reschedule, for the reason `BookingOutcomeOrchestrator`
 * joins Commerce, Payment and Booking for a cancellation decision: none of
 * `services/commerce`, `services/booking` may import the other (ADR-011).
 *
 * ## The lock order is the contract (ADR-051's own remedy-choice row)
 *
 * `commerce.customer_remedy_choices.order_id FOR UPDATE` first, then --
 * only for a reschedule that is actually eligible -- booking-service's own
 * reschedule transaction (booking `FOR UPDATE`, claim, move), all inside
 * ONE transaction this service owns. `refund` and every repeat request are
 * answered from the locked row alone; no second lock is ever taken for them.
 */
@Injectable()
export class CustomerRemedyResolutionService {
  private readonly auditLog = new AuditLogger('commerce');

  constructor(
    private readonly dataSource: DataSource,
    private readonly decisions: BookingOutcomeDecisionService,
    private readonly remedyChoices: CustomerRemedyChoiceService,
    private readonly bookings: BookingService,
  ) {}

  async resolve(
    bookingId: string,
    customerId: string,
    choice: CustomerRemedyChoiceOption,
    newSlotId: string | null,
  ): Promise<CustomerRemedyResolutionResult> {
    return this.dataSource.transaction(async (m) => {
      const orderId = await this.decisions.orderIdForBooking(m, bookingId);
      if (!orderId) throw new RemedyNotOfferedException();

      const current = await this.remedyChoices.lockResolution(m, orderId);
      if (!current) throw new RemedyNotOfferedException();

      // Already resolved by the customer, or a `refund`/invalid request: the
      // default already IS a refund, so there is nothing new to do -- the
      // existing resolution stands, and nothing is written. This is the
      // whole of "no double refund and no duplicate credit return" for this
      // route: it writes exactly once, ever, and only for `reschedule`.
      if (current.resolvedBy === 'customer' || choice !== 'reschedule') {
        return { chosen: current.chosen, resolvedBy: current.resolvedBy };
      }

      if (!newSlotId) throw new RemedyRescheduleRequiresSlotException();

      const decision = await this.decisions.liveDecision(m, bookingId, 'cancellation');
      if (!decision || !ESCAPABLE_EXECUTION_STATUSES.has(decision.executionStatus)) {
        throw new RemedyRefundAlreadyExecutedException();
      }

      // Bypasses the cutoff and free-count rules (cause is not the
      // customer's); price and terms are otherwise untouched, exactly as
      // every reschedule already is (same professional, same service).
      await this.bookings.reschedule(bookingId, newSlotId, { type: 'customer', id: customerId }, null, m, {
        remedyBypass: true,
      });

      const applied = await this.remedyChoices.resolveReschedule(m, orderId);
      if (!applied) {
        // Lost a race with another concurrent resolution of the SAME choice
        // row -- the booking `FOR UPDATE` above already serialised this
        // against another reschedule attempt, so this is unreachable in
        // practice; fail closed to whatever the winner recorded rather than
        // assume.
        const resolved = await this.remedyChoices.resolution(m, orderId);
        return resolved ? { chosen: resolved.chosen, resolvedBy: resolved.resolvedBy } : { chosen: null, resolvedBy: 'default' };
      }

      // Never the customer's slot choice reasoning or anything about the
      // cancellation's own cause -- just that a remedy resolved, and to what.
      this.auditLog.log({ action: 'commerce.customer_remedy_resolved', bookingId, orderId, chosen: 'reschedule' });
      return { chosen: 'reschedule', resolvedBy: 'customer' };
    });
  }

  /**
   * The same resolution `resolve` would answer from, read without writing —
   * V3.3 `#42d-read` (#201).
   *
   * ## Why it refuses identically rather than returning an "absent" shape
   *
   * Both causes `resolve` refuses for -- no remedy was ever offered for this
   * booking, and the booking is foreign or nonexistent -- collapse into the
   * same `RemedyNotOfferedException` here, for the reason they collapse
   * there: a distinct shape for "offered but not to you" would let a caller
   * who guessed a booking id learn that it exists. A GET that enumerated
   * what the POST refuses to enumerate would undo the POST's discipline.
   *
   * ## No lock, and no transaction of its own
   *
   * `lockResolution` exists so the write path can serialise against a
   * concurrent reschedule. A read has nothing to serialise: the row it reads
   * moves at most once in its whole life, and a caller who observes the
   * pre-move value simply re-reads. Taking `FOR UPDATE` here would make a
   * screen refresh block a checkout's neighbour for no gain.
   */
  async read(bookingId: string): Promise<CustomerRemedyView> {
    const m = this.dataSource.manager;

    const orderId = await this.decisions.orderIdForBooking(m, bookingId);
    if (!orderId) throw new RemedyNotOfferedException();

    const current = await this.remedyChoices.resolution(m, orderId);
    if (!current) throw new RemedyNotOfferedException();

    // A remedy is always born against a live cancellation decision, but the
    // read must not assume one is still there: `null` reads as "no refund
    // figure yet", never as a zero the platform never decided.
    const decision = await this.decisions.liveDecision(m, bookingId, 'cancellation');

    return {
      chosen: current.chosen,
      resolvedBy: current.resolvedBy,
      rescheduleStillAvailable:
        current.resolvedBy === 'default' && !!decision && ESCAPABLE_EXECUTION_STATUSES.has(decision.executionStatus),
      refundToman: decision ? decision.refundToman.toString() : null,
      executionStatus: decision ? decision.executionStatus : null,
    };
  }
}

const ESCAPABLE_EXECUTION_STATUSES = new Set(['pending', 'manual_required']);
