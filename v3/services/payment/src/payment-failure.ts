import { PaymentFailureReason, isRetryableFailureReason } from '@beauclick/payment-contract';

import { VerifyPaymentResult } from './providers/payment-provider.interface';

/**
 * The payment domain's half of the failure contract.
 *
 * The VOCABULARY itself -- the eight public reasons, the six result statuses,
 * and the rule for which reasons permit a retry -- now lives in
 * `@beauclick/payment-contract`, a dependency-free package the Next.js bundle
 * can import. This module keeps the half that needs the domain: the table that
 * maps a PROVIDER's own code onto a public reason, and the shape an ambiguous
 * verification takes.
 *
 * That split exists because the checkout result page has to render the same
 * eight reasons and make the same retry decision, and the only alternatives
 * were dragging `@nestjs/common` and TypeORM into a browser bundle, or keeping
 * a second copy of the vocabulary in the page. The second copy is what the page
 * had, and two policies that must agree while being maintained separately are
 * one policy plus a bug waiting for a release.
 *
 * Re-exported below, so every existing `@beauclick/payment` import keeps
 * working and there is still exactly one place a server-side caller looks.
 *
 * ## Why the two codes stay different things
 *
 * `payment_attempts.failure_code` and `payment_intents.failure_code` store
 * whatever the ADAPTER reported, because that is what a support engineer needs
 * when a customer calls: a gateway's own code is the only thing the gateway's
 * own support desk will accept. But that value is provider-shaped, unbounded,
 * and -- for a real Iranian gateway -- frequently a numeric code or a free-text
 * sentence that may embed a reference, a merchant identifier, or a bank
 * message. Putting it in a redirect URL would publish it to the customer's
 * browser history, their referrer headers, and any analytics script the result
 * page ever loads.
 *
 * So there are two codes and they are deliberately different things:
 *
 *  - the PROVIDER code -- stored, internal, unbounded, never rendered;
 *  - the PUBLIC reason -- the closed set, safe to publish, and the ONLY thing
 *    the redirect contract and the frontend ever see.
 */

export * from '@beauclick/payment-contract';

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

/**
 * Whether the failure a PROVIDER reported permits a retry.
 *
 * The narrowing and the rule are two separate steps on purpose. This takes a
 * raw, stored, provider-shaped code and answers the domain question, so a
 * caller in the payment domain never has to remember to narrow first — which
 * is exactly the mistake that would let an unrecognised gateway code fall
 * through to a permissive default.
 *
 * The RULE itself lives in `@beauclick/payment-contract` and is shared with
 * the browser. This is the domain-side adapter onto it.
 */
export function isRetryableProviderFailureCode(providerFailureCode: string | null | undefined): boolean {
  return isRetryableFailureReason(toPublicFailureReason(providerFailureCode));
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
