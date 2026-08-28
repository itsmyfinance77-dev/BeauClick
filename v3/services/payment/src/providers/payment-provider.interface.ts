import type { CurrencyCode } from '@beauclick/money';

/**
 * The payment provider abstraction (ADR-006).
 *
 * Shaped after the provider-abstraction pattern V2 already proved three
 * times (SMS, AI, Professional-AI): an interface, a registry, and a
 * fail-safe default. The design target ADR-006 states is that adding a
 * second Iranian gateway is a new adapter and NOTHING else -- no change to
 * commerce, booking, financial, or any controller.
 *
 * Two rules every adapter must honour, both of them security properties:
 *
 *  1. **`verify()` must talk to the gateway.** It may never derive success
 *     from the callback parameters the browser carried back. Those are
 *     attacker-controlled: a user can simply type the success URL. The
 *     callback tells you *which* transaction to ask about; the gateway tells
 *     you whether it was paid.
 *  2. **`verify()` must report the amount the gateway actually captured**,
 *     so the caller can compare it against what was owed. An adapter that
 *     returns only success/failure makes amount-tampering undetectable.
 *  3. **`verify()` must state the CURRENCY/unit of that amount**, and it must
 *     be the platform unit. See `paidCurrency` -- a bare number cannot be
 *     compared safely, and the `...Toman` suffix is a naming convention, not
 *     an enforced one.
 */

export interface InitiatePaymentRequest {
  paymentIntentId: string;
  orderId: string;
  amountToman: number;
  /** Absolute URL the gateway should return the customer to. */
  callbackUrl: string;
  description: string;
}

export interface InitiatePaymentResult {
  /**
   * The gateway's own identifier for this transaction (ZarinPal calls it an
   * "authority"). Stored and treated as the idempotency key for every later
   * callback about this payment.
   */
  providerReference: string;
  /** Where to send the customer's browser. */
  redirectUrl: string;
  /** Whatever else the gateway returned, for diagnostics. Must contain no credentials. */
  raw?: Record<string, unknown>;
}

export interface VerifyPaymentRequest {
  providerReference: string;
  /** What the order says is owed. An adapter passes this to the gateway where the gateway requires it. */
  expectedAmountToman: number;
  /** The raw callback query/body. Available to adapters for diagnostics -- never as proof of payment. */
  callbackParams: Record<string, string>;
}

/**
 * What a verification established.
 *
 * `unknown` is the third state and it is load-bearing, not defensive
 * completeness. Before it existed an adapter whose gateway call timed out had
 * exactly two words available, and both were lies: `succeeded` would settle an
 * order nobody confirmed, and `failed` would mark a transaction failed that
 * may well have taken the customer's money. A network timeout does not tell
 * you the payment failed; it tells you nothing at all, and the honest answer
 * to "did this payment succeed?" is sometimes "I could not find out".
 *
 * The caller treats it accordingly: **nothing is written**, the attempt stays
 * `initiated` so a later callback or a reconciliation can still resolve it,
 * and no `PaymentSucceeded`/`PaymentFailed` event is emitted. Emitting
 * `PaymentFailed` on an unknown would fan out to five consumers, and the
 * financial ledger is append-only — an entry written on a guess cannot be
 * withdrawn.
 *
 * An adapter MUST return `unknown` for: a request timeout, a connection
 * failure, a gateway 5xx, and any response it cannot parse into a definite
 * outcome. It must return `failed` only when the gateway itself said the
 * transaction did not succeed.
 */
export type VerifyOutcome = 'succeeded' | 'failed' | 'unknown';

export interface VerifyPaymentResult {
  outcome: VerifyOutcome;
  /**
   * What the gateway says was actually captured. Compared against the order
   * total by the caller. Null on `failed` and ALWAYS null on `unknown` --
   * an ambiguous verification learned no amount by definition.
   */
  paidAmountToman: number | null;
  /**
   * The unit `paidAmountToman` is expressed in. Required on every successful
   * verification; the caller REFUSES a success that does not state it.
   *
   * This exists because the amount check was previously a bare
   * number-to-number equality, and the only thing asserting the unit was the
   * field's NAME. That is a live trap for the real Iranian gateway adapter
   * GAP-06b still requires: Iranian gateway APIs commonly denominate in
   * RIALS, and 1 toman = 10 rials. An adapter that passed the gateway's rial
   * figure straight through would make a 1,000,000-toman order settle for
   * 100,000 tomans of real money and still pass an equality check -- silently,
   * because both sides are just numbers.
   *
   * The sandbox cannot surface that class of bug on its own (it is IRT by
   * construction, which is precisely the limitation recorded against
   * GAP-06b), so the contract is made explicit now, while it is cheap, rather
   * than after an adapter has been written against the looser one.
   */
  paidCurrency?: CurrencyCode | null;
  /** The gateway's settlement/reference id, printed on the customer's receipt. */
  providerTransactionId: string | null;
  /**
   * The gateway's own code, stored for support and NEVER published.
   *
   * `payment-failure.ts` narrows it to the closed public vocabulary the
   * redirect contract and the frontend see. A gateway code routinely embeds a
   * reference or a bank message; a redirect URL is browser history.
   */
  failureCode: string | null;
  raw?: Record<string, unknown>;
}

export interface RefundPaymentRequest {
  providerReference: string;
  providerTransactionId: string | null;
  amountToman: number;
  reason: string;
  idempotencyKey: string;
}

export interface RefundPaymentResult {
  outcome: 'succeeded' | 'failed';
  providerRefundReference: string | null;
  failureCode: string | null;
  raw?: Record<string, unknown>;
}

export interface PaymentProvider {
  /** Stable key, persisted on every intent and attempt this provider handled. */
  readonly key: string;

  /** Human-readable, Persian, shown in a gateway picker. */
  readonly displayName: string;

  /**
   * Whether this gateway can refund programmatically. Iranian gateways vary:
   * several require a manual bank-side process. A `false` here is not a
   * failure -- it routes the refund to the manual settlement path instead of
   * silently reporting a refund that never happened.
   */
  readonly supportsAutomaticRefund: boolean;

  initiate(request: InitiatePaymentRequest): Promise<InitiatePaymentResult>;

  verify(request: VerifyPaymentRequest): Promise<VerifyPaymentResult>;

  refund(request: RefundPaymentRequest): Promise<RefundPaymentResult>;
}

/** Nest multi-provider token: every registered gateway adapter. */
export const PAYMENT_PROVIDERS = Symbol('BEAUCLICK_PAYMENT_PROVIDERS');
