import { VerifyPaymentResult } from './providers/payment-provider.interface';

/**
 * The PUBLIC failure vocabulary — the only payment failure information that
 * ever leaves the server (`QA-21`).
 *
 * Why a second vocabulary exists at all. `payment_attempts.failure_code` and
 * `payment_intents.failure_code` store whatever the ADAPTER reported, because
 * that is what a support engineer needs when a customer calls: a gateway's
 * own code is the only thing the gateway's own support desk will accept. But
 * that value is provider-shaped, unbounded, and — for a real Iranian gateway —
 * frequently a numeric code or a free-text sentence that may embed a
 * reference, a merchant identifier, or a bank message. Putting it in a
 * redirect URL would publish it to the customer's browser history, their
 * referrer headers, and any analytics script the result page ever loads.
 *
 * So there are two codes and they are deliberately different things:
 *
 *  - the PROVIDER code — stored, internal, unbounded, never rendered;
 *  - the PUBLIC reason — this closed set, safe to publish, and the ONLY thing
 *    the redirect contract and the frontend ever see.
 *
 * The set is closed on purpose. An adapter cannot widen it by returning a new
 * string: `toPublicFailureReason` maps what it recognises and answers
 * `gateway_error` for everything else. A new gateway therefore cannot leak a
 * new code by accident, and adding a genuinely new user-visible distinction is
 * a deliberate edit here plus the Persian copy that goes with it — which is
 * the point, because each of these needs a DIFFERENT sentence to the customer.
 *
 * `QA-21`'s actual complaint: `cancelled_by_user` and `declined` were both
 * rendered as "پرداخت انجام نشد". One means the customer changed their mind
 * and should simply be offered the button again; the other means their bank
 * refused and they need to try a different card. Collapsing them makes the
 * page useless in exactly the moment a customer is deciding whether to give
 * up.
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
   * order. A security event, not an ordinary decline — see
   * `PaymentService.applyVerification`.
   */
  'amount_mismatch',
  /**
   * The gateway could not be reached, or answered in a way that did not
   * establish an outcome. **Not a failure of the payment** — the money may
   * have moved. Carried through so the customer is told the truth rather than
   * "no money was taken", which is the one thing nobody can promise here.
   */
  'unresolved',
  /** Anything else a gateway reported. The safe fallback, never a leak. */
  'gateway_error',
] as const;

export type PaymentFailureReason = (typeof PAYMENT_FAILURE_REASONS)[number];

/**
 * Provider and internal codes that map onto a public reason.
 *
 * Keys are compared case-insensitively after trimming. Anything absent
 * becomes `gateway_error` — deliberately a silent, safe fallback rather than a
 * throw: a gateway inventing a new code must never turn a completed payment's
 * result page into a 500.
 *
 * Vendor-specific numeric codes belong in the ADAPTER, which should translate
 * them to one of these strings before returning, for the same reason the
 * money unit is mapped in the adapter and not here: this module must not learn
 * a single gateway's dialect.
 *
 * A `Map`, not an object literal, and that is a correctness fix rather than a
 * style choice. Written as `REASON_ALIASES[code]` over an object, a gateway
 * returning `constructor`, `toString`, or `hasOwnProperty` resolves a FUNCTION
 * off `Object.prototype` instead of missing, and that function is then
 * returned as though it were a reason -- straight into `URLSearchParams`,
 * which stringifies it, publishing a chunk of the runtime's source into the
 * customer's address bar. Exactly the leak this closed set exists to prevent,
 * arriving through the lookup rather than the table. A `Map` has no prototype
 * chain to fall through. Found by `payment-failure.spec.ts`.
 */
const REASON_ALIASES = new Map<string, PaymentFailureReason>(Object.entries({
  cancelled_by_user: 'cancelled_by_user',
  canceled_by_user: 'cancelled_by_user',
  cancelled: 'cancelled_by_user',
  canceled: 'cancelled_by_user',
  user_cancelled: 'cancelled_by_user',

  declined: 'declined',
  rejected: 'declined',
  insufficient_funds: 'declined',
  card_declined: 'declined',

  intent_expired: 'expired',
  expired: 'expired',
  timeout_expired: 'expired',

  not_completed: 'not_completed',
  incomplete: 'not_completed',
  pending: 'not_completed',

  unknown_reference: 'unknown_reference',
  not_found: 'unknown_reference',
  invalid_reference: 'unknown_reference',

  amount_mismatch: 'amount_mismatch',
  currency_mismatch: 'amount_mismatch',

  verification_timeout: 'unresolved',
  verification_unavailable: 'unresolved',
  verification_transport_error: 'unresolved',
  unresolved: 'unresolved',

  gateway_error: 'gateway_error',
} as const));

/**
 * Narrows a stored/provider failure code to the public set.
 *
 * `null` in means `null` out: a successful payment has no failure reason, and
 * inventing `gateway_error` for it would put a failure code on a receipt.
 */
export function toPublicFailureReason(providerFailureCode: string | null | undefined): PaymentFailureReason | null {
  if (providerFailureCode === null || providerFailureCode === undefined) return null;
  const normalized = providerFailureCode.trim().toLowerCase();
  if (normalized === '') return null;
  return REASON_ALIASES.get(normalized) ?? 'gateway_error';
}

/** Whether a string is one of the public reasons — for the frontend contract's own boundary checks. */
export function isPaymentFailureReason(value: unknown): value is PaymentFailureReason {
  return typeof value === 'string' && (PAYMENT_FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * Whether a customer can sensibly be offered "try again" for this reason.
 *
 * Server-side rather than a frontend `switch`, because the answer is a
 * property of the payment domain: `amount_mismatch` is an open security
 * investigation and must NOT invite a retry, and `unresolved` must not either
 * — retrying a payment that may already have succeeded is how a customer gets
 * charged twice.
 */
export function isRetryableFailureReason(reason: PaymentFailureReason | null): boolean {
  if (reason === null) return false;
  return reason === 'cancelled_by_user' || reason === 'declined' || reason === 'not_completed' || reason === 'gateway_error';
}

/**
 * The ambiguous-verification result an adapter's transport failure becomes.
 *
 * Constructed here rather than inline so every ambiguous path — timeout,
 * transport error, a thrown adapter — produces the SAME shape, and so it is
 * impossible to write one that accidentally reports `outcome: 'failed'`.
 */
export function unresolvedVerification(failureCode: string): VerifyPaymentResult {
  return {
    outcome: 'unknown',
    paidAmountToman: null,
    paidCurrency: null,
    providerTransactionId: null,
    failureCode,
  };
}
