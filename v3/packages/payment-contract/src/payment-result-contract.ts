/**
 * The payment result contract, in the half that both sides can hold.
 *
 * ## Why this is its own package
 *
 * `services/payment` owns the payment domain, and it is a NestJS module full
 * of TypeORM entities. The checkout result page is a Next.js client bundle.
 * The page needs exactly three things from the domain — which statuses exist,
 * which public failure reasons exist, and which of those permit a retry — and
 * importing the domain to get them would drag `@nestjs/common`, `typeorm`, and
 * every entity into a browser bundle.
 *
 * The alternative, which is what the page did before, is to keep its own copy
 * of the vocabulary as string literals. That works right up until the two
 * disagree, and the failure mode is silent: a reason the server considers
 * retryable that the page hides, or worse, a reason the page offers a retry
 * for that the server refuses. **Two policies that must agree, maintained
 * separately, are one policy plus a bug waiting for a release.**
 *
 * So the browser-safe half lives here: pure TypeScript, zero dependencies, no
 * framework. `services/payment` re-exports it and adds the parts that need the
 * domain (the provider-code alias table, and the `VerifyPaymentResult` shape).
 *
 * ## What this does NOT do
 *
 * **It does not authorize anything.** `isRetryableFailureReason` is consulted
 * by the page to decide whether to render a button, and independently by the
 * server to decide whether to act — and the server derives its input from its
 * OWN stored failure code, never from what the browser sends. A client that
 * lies about the reason gets a refusal from a server that never asked it.
 * Sharing the rule removes drift; it does not move the decision.
 */

/**
 * Every status the payment result redirect can carry.
 *
 * Produced by `PaymentCallbackController.handle`. `duplicate_refunded` and
 * `refunded` are corrections applied AFTER a successful gateway verification,
 * which is why neither is a failure.
 */
export const PAYMENT_RESULT_STATUSES = [
  'succeeded',
  'replayed',
  'failed',
  'refunded',
  'duplicate_refunded',
  'unresolved',
] as const;

export type PaymentResultStatus = (typeof PAYMENT_RESULT_STATUSES)[number];

export function isPaymentResultStatus(value: unknown): value is PaymentResultStatus {
  return typeof value === 'string' && (PAYMENT_RESULT_STATUSES as readonly string[]).includes(value);
}

/**
 * The PUBLIC failure vocabulary — the only payment failure information that
 * ever leaves the server (`QA-21`).
 *
 * A gateway's own code is stored for support and never published: it is
 * provider-shaped, unbounded, and frequently a numeric code or a free-text
 * bank message that may embed a reference or a merchant identifier. A redirect
 * URL is browser history, a referrer header, and whatever analytics the result
 * page loads.
 *
 * The set is closed on purpose. An adapter cannot widen it by returning a new
 * string — `toPublicFailureReason` (server-side) maps what it recognises and
 * answers `gateway_error` for everything else — so a new gateway cannot leak a
 * new code by accident, and adding a genuinely new user-visible distinction is
 * a deliberate edit here plus the Persian copy that goes with it.
 */
export const PAYMENT_FAILURE_REASONS = [
  /** The customer chose to abandon the payment at the bank's own page. */
  'cancelled_by_user',
  /** The bank refused the transaction — insufficient funds, a blocked card, a wrong PIN. */
  'declined',
  /** The intent's payment window closed before the gateway confirmed anything. */
  'expired',
  /** The customer returned from the gateway without completing anything there. */
  'not_completed',
  /**
   * The gateway does not recognise the transaction at all.
   *
   * Also what a FORGED callback produces, and the two are deliberately
   * indistinguishable from outside: an attacker probing references must not be
   * able to tell a real-but-unpaid one from an invented one.
   */
  'unknown_reference',
  /**
   * The gateway reported a success whose amount or currency disagreed with the
   * order. A security event, not an ordinary decline.
   */
  'amount_mismatch',
  /**
   * The gateway could not be reached, or answered in a way that did not
   * establish an outcome. **Not a failure of the payment** — the money may
   * have moved, and nothing was written.
   */
  'unresolved',
  /** Anything else a gateway reported. The safe fallback, never a leak. */
  'gateway_error',
] as const;

export type PaymentFailureReason = (typeof PAYMENT_FAILURE_REASONS)[number];

export function isPaymentFailureReason(value: unknown): value is PaymentFailureReason {
  return typeof value === 'string' && (PAYMENT_FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * Whether a customer can sensibly be offered "try again" for this reason.
 *
 * The four `true` cases share one property: **the gateway told us definitively
 * that no money moved.** The four `false` cases each break that in a different
 * way, and each would be a different kind of harm:
 *
 * - `unresolved` — nobody knows whether money moved. Retrying is how a
 *   customer gets charged twice.
 * - `amount_mismatch` — a gateway-reported success whose figure disagreed with
 *   the order. That is an open security question, and re-running it is not the
 *   customer's job.
 * - `unknown_reference` — the gateway does not recognise the transaction, so a
 *   retry cannot be reasoned about at all. If money moved, support must look.
 * - `expired` — the payment window closed, and the SLOT that was being paid
 *   for may already belong to somebody else. A retry here is not a payment
 *   question, it is a re-booking question, and this platform has no safe
 *   re-booking path for it (see the runbook and §3 of the design).
 *
 * Kept in the shared package rather than the domain so the page and the server
 * cannot disagree about it — and enforced by the server from its own stored
 * failure code regardless of what the page believes.
 */
export function isRetryableFailureReason(reason: PaymentFailureReason | null | undefined): boolean {
  if (reason === null || reason === undefined) return false;
  return (
    reason === 'cancelled_by_user' || reason === 'declined' || reason === 'not_completed' || reason === 'gateway_error'
  );
}

/**
 * The statuses on which a `reason` is meaningful at all.
 *
 * `PaymentCallbackController` attaches one only to `failed` and `unresolved`;
 * a `refunded` or `duplicate_refunded` outcome SUCCEEDED at the gateway and was
 * corrected afterwards, so labelling either with a failure reason would
 * describe the wrong event.
 *
 * Exported so the page can enforce the same rule on the way in. A URL is
 * user-editable, and `?status=succeeded&reason=declined` must not produce a
 * page that says both.
 */
export const STATUSES_CARRYING_A_REASON: readonly PaymentResultStatus[] = ['failed', 'unresolved'];

export function statusCarriesAReason(status: string): boolean {
  return (STATUSES_CARRYING_A_REASON as readonly string[]).includes(status);
}

/**
 * Why a retry was refused, as a closed set.
 *
 * Returned in the error envelope of the order-scoped retry command. Closed for
 * the same reason the failure vocabulary is: the alternative is an internal
 * state name or a provider code reaching a browser.
 *
 * Deliberately coarse. `no_payment_started` and `verification_pending` are
 * distinguishable because the customer's next action genuinely differs; the
 * rest collapse into "this order cannot be paid again".
 */
export const PAYMENT_RETRY_REFUSALS = [
  /** The order is already paid, refunded, or cancelled. */
  'order_not_payable',
  /** The intent succeeded. The customer has already paid. */
  'already_paid',
  /** The payment window closed. */
  'expired',
  /**
   * A gateway transaction is open and has not been resolved — which is also
   * exactly the `unresolved` state. Retrying could charge the customer twice.
   */
  'verification_pending',
  /** No payment was ever started for this order. */
  'no_payment_started',
  /** The recorded failure is not one a retry can fix. */
  'not_retryable',
] as const;

export type PaymentRetryRefusal = (typeof PAYMENT_RETRY_REFUSALS)[number];

export function isPaymentRetryRefusal(value: unknown): value is PaymentRetryRefusal {
  return typeof value === 'string' && (PAYMENT_RETRY_REFUSALS as readonly string[]).includes(value);
}
