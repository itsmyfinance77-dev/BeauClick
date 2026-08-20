import { CURRENCY_IRT, CurrencyCode } from '@beauclick/money';

/**
 * THE V3 pricing contract.
 *
 * The problem this replaces: V2 had several independent systems that could
 * each modify a price -- membership discount, campaign discount, B2B tier
 * pricing -- implemented as separate WooCommerce hooks at hand-chosen
 * priorities (10 / 20 / 30) on two different extension points (an order
 * filter and a cart filter). Whether two of them could stack, and against
 * what base, was an emergent property of registration order that nobody
 * could read off a single file. `PRODUCT_GAP_REGISTER.md` records the real
 * consequences: a compounding bug, a float-rounding inconsistency between
 * two discounts, and a whole pricing path (B2B quote orders) that no
 * discount could reach at all because it fired no hook.
 *
 * V3 has exactly ONE pricing path. Every rule implements `PricingRule`,
 * every rule is evaluated by `PricingService`, and the outcome is an
 * explicit, ordered, itemized `PricingResult` that is stored alongside the
 * order. There is no second way for a price to change.
 */
export interface PricingLine {
  /** What is being sold -- a service offering id for a booking order. */
  referenceId: string;
  name: string;
  quantity: number;
  /** Catalogue price, resolved server-side. NEVER supplied by a client. */
  unitPriceToman: number;
}

export interface PricingContext {
  customerId: string;
  sellerPartyType: 'professional' | 'business';
  sellerPartyId: string;
  lines: PricingLine[];
  /** The moment being priced. Explicit so a quote is reproducible rather than dependent on wall-clock at replay. */
  at: Date;
  /** Set for booking-originated orders, so a rule can scope itself to bookings. */
  bookingId?: string | null;
}

/**
 * What every rule sees.
 *
 * `subtotalToman` is IMMUTABLE across the whole evaluation and is the base
 * every percentage rule must use. That is V2's hard-won "no compounding"
 * decision, promoted from a convention two classes independently
 * documented into an invariant the engine enforces by construction: a 10%
 * membership benefit and a 15% campaign are 10% and 15% of the same base,
 * never 15% of an already-discounted amount. It is also far easier to
 * explain to a customer.
 *
 * `remainingToman` is what is left after prior adjustments, and exists only
 * so a rule can size a FIXED-amount adjustment sensibly. The engine clamps
 * regardless, so a rule that ignores it cannot push an order below zero.
 */
export interface PricingState {
  readonly subtotalToman: number;
  readonly remainingToman: number;
  readonly appliedRuleKeys: readonly string[];
}

export type AdjustmentKind = 'discount' | 'fee';

export interface PricingAdjustment {
  /** Stable identifier of the rule that produced this. Stored on the order, so historical pricing stays explainable. */
  ruleKey: string;
  kind: AdjustmentKind;
  /** Business-facing code, e.g. a campaign code. Null when the rule has no external code. */
  code: string | null;
  /** Persian label shown to the customer on the receipt. */
  label: string;
  /** Negative for a discount, positive for a fee. Integer Toman. */
  amountToman: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface PricingRule {
  /** Stable across releases -- it is persisted on every order this rule ever touched. */
  readonly key: string;

  /**
   * Evaluation order. Lower runs first; ties broken by `key`, so the
   * outcome never depends on module registration order (the exact
   * fragility V2's hook priorities had).
   */
  readonly priority: number;

  evaluate(context: PricingContext, state: PricingState): Promise<PricingAdjustment[]>;
}

export interface PricingResult {
  currency: CurrencyCode;
  subtotalToman: number;
  adjustments: PricingAdjustment[];
  /** Sum of all negative adjustments, as a positive number. */
  discountTotalToman: number;
  /** Sum of all positive adjustments. */
  feeTotalToman: number;
  totalToman: number;
}

export const DEFAULT_CURRENCY: CurrencyCode = CURRENCY_IRT;

/** Nest multi-provider token. Later phases (membership, campaigns) contribute rules here and nowhere else. */
export const PRICING_RULES = Symbol('BEAUCLICK_PRICING_RULES');
