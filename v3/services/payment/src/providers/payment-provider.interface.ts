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

export type VerifyOutcome = 'succeeded' | 'failed';

export interface VerifyPaymentResult {
  outcome: VerifyOutcome;
  /** What the gateway says was actually captured. Compared against the order total by the caller. */
  paidAmountToman: number | null;
  /** The gateway's settlement/reference id, printed on the customer's receipt. */
  providerTransactionId: string | null;
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
