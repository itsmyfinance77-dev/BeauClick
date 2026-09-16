/**
 * The booking outcome decision contract — V3.3 Story #160 (`#42c`), ADR-051 §6
 * (with its 2026-09-15 consistency note), `V33-DEC-039` R1, R2, R4, R5, R8.
 *
 * Browser-safe and implementation-free, like the snapshot contract beside it:
 * `commerce` records decisions and `apps/api` composes them, and neither may
 * import the Commercial Policy implementation that evaluates them. This file is
 * the vocabulary the three share — and the SQL CHECKs on
 * `commerce.booking_outcome_decisions` repeat it, so a member added here and not
 * there is refused by the database rather than silently written.
 *
 * It carries no value: no cutoff, retention, cap or window appears below.
 */

import { BookingOutcomeRetentionRule } from './booking-outcome-policy-contract';

/** ADR-051 §6's binding vocabulary. #160 writes `cancellation` and `reschedule_consequence` only. */
export const BOOKING_OUTCOME_DECISION_KINDS = ['cancellation', 'no_show', 'reschedule_consequence', 'dispute_outcome'] as const;
export type BookingOutcomeDecisionKind = (typeof BOOKING_OUTCOME_DECISION_KINDS)[number];

/**
 * Who caused the event, derived server-side from the booking's recorded actor
 * (`V33-DEC-039` R3). `force_majeure` and `provider` exist in the vocabulary and
 * have no producer in #160; both retain zero.
 */
export const BOOKING_OUTCOME_CAUSES = ['customer', 'seller', 'platform', 'provider', 'force_majeure', 'no_show'] as const;
export type BookingOutcomeCause = (typeof BOOKING_OUTCOME_CAUSES)[number];

/**
 * The Legal cap's state at the decision instant (ADR-051 §5): `applied` only
 * when the snapshot carries a cap AND its evidence record currently exists, is
 * `recorded`, and has subject `retention_cap`. Anything else is `absent`,
 * except a record that was retired, which is `retired`. Both retain zero.
 */
export const LEGAL_CAP_STATES = ['applied', 'absent', 'retired'] as const;
export type LegalCapState = (typeof LEGAL_CAP_STATES)[number];

/** Why the amounts are what they are. Closed; recorded on every decision. */
export const BOOKING_OUTCOME_BASES = [
  'legacy_unenrolled',
  'invalid_terms',
  'non_customer_cause',
  'not_confirmed',
  'timely',
  'cap_absent',
  'cap_retired',
  'cap_applied',
  'pre_existing_refund',
] as const;
export type BookingOutcomeBasis = (typeof BOOKING_OUTCOME_BASES)[number];

/**
 * The booking actor → cause mapping. Closed: an actor not named here is a
 * programming error, not a default. `admin` and `system` are `platform`, and
 * neither has a production cancellation route today.
 */
export function bookingOutcomeCauseForActor(actorType: string): BookingOutcomeCause {
  switch (actorType) {
    case 'customer':
      return 'customer';
    case 'professional':
      return 'seller';
    case 'admin':
    case 'system':
      return 'platform';
    default:
      throw new Error(`No booking outcome cause is defined for actor type '${actorType}'`);
  }
}

/** The request key a cancellation's refund is issued under. Unchanged from the handler #160 replaced. */
export function bookingCancellationRefundKey(bookingId: string): string {
  return `booking-cancelled:${bookingId}`;
}

/**
 * The request key a no-show's refund (the collected amount not retained) is
 * issued under — V3.3 #161 (`#42d`), ADR-051 §7. Distinct from the
 * cancellation key by construction: a booking can be in at most one of
 * `cancelled`/`no_show`, so the two keys are never both live for one
 * booking, but keeping them textually distinct means a log or a payment
 * gateway record never has to disambiguate which outcome a refund belongs to.
 */
export function bookingNoShowRefundKey(bookingId: string): string {
  return `booking-no-show:${bookingId}`;
}

/**
 * The terms the evaluator reads; everything else on the snapshot is another
 * story's. `noShowRetention` was added by #161 — the seller's separate
 * selection for a no-show, read only when `cause === 'no_show'`.
 */
export interface BookingOutcomeEvaluationTermsV1 {
  readonly lateCancellationRetention: BookingOutcomeRetentionRule;
  readonly noShowRetention: BookingOutcomeRetentionRule;
  readonly legalCap: BookingOutcomeRetentionRule | null;
}

/**
 * Everything `evaluateBookingOutcome` decides from. Every member is a FACT the
 * caller read inside the deciding transaction; none is a clock.
 *
 * `timely` was computed in SQL (`event_instant <= slot_start − cutoff_hours`),
 * so no JavaScript `Date` participates; it is `null` exactly when `terms` is.
 */
export interface BookingOutcomeEvaluationInputV1 {
  readonly cause: BookingOutcomeCause;
  readonly bookingWasConfirmed: boolean;
  readonly timely: boolean | null;
  /** Collected money not yet refunded or committed to a refund; integer toman. */
  readonly collectedRemainingToman: bigint;
  /** `null` ⇒ the order carries no outcome terms (`legacy_unenrolled`). */
  readonly terms: BookingOutcomeEvaluationTermsV1 | null;
  readonly legalCapState: LegalCapState;
}

/** The evaluator's answer. `retainedToman + refundToman === collectedRemainingToman`, always. */
export interface BookingOutcomeEvaluationV1 {
  readonly basis: Exclude<BookingOutcomeBasis, 'pre_existing_refund'>;
  readonly policyAmountToman: bigint;
  /** Present exactly when `legalCapState === 'applied'`. */
  readonly legalCapToman: bigint | null;
  readonly legalCapState: LegalCapState;
  readonly retainedToman: bigint;
  readonly refundToman: bigint;
}
