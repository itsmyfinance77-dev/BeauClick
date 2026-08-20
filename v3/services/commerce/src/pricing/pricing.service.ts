import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { assertNonNegativeAmount, clampDiscount, sumAmounts } from '@beauclick/money';

import {
  DEFAULT_CURRENCY,
  PRICING_RULES,
  PricingAdjustment,
  PricingContext,
  PricingResult,
  PricingRule,
  PricingState,
} from './pricing.types';

/**
 * The one and only place an order total is computed.
 *
 * Guarantees, all enforced here rather than trusted to rule authors:
 *
 *  - **Deterministic order.** Rules are sorted by `(priority, key)`, never
 *    by registration order.
 *  - **No compounding.** Every rule is handed the same immutable
 *    `subtotalToman`. A rule literally cannot see a previously-discounted
 *    base to compute a percentage against.
 *  - **Never below zero.** Each discount is clamped to what actually
 *    remains, in application order, so any combination of rules -- however
 *    misconfigured -- lands at a total of at least 0.
 *  - **Integer Toman throughout.** All arithmetic goes through
 *    `@beauclick/money`, which throws on a fractional or out-of-range
 *    value rather than rounding it away.
 *  - **Reproducible.** Given the same context and rule set, the result is
 *    identical; every applied adjustment is itemized and persisted, so a
 *    historical total can always be re-explained even after rules change.
 *
 * A rule that throws is FATAL, deliberately. Swallowing a pricing error
 * would charge the customer a price no rule agreed to -- the failure mode
 * must be "checkout fails loudly", never "checkout succeeds at a price
 * nobody can explain".
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger('PricingService');
  private readonly rules: PricingRule[];

  constructor(@Optional() @Inject(PRICING_RULES) rules: PricingRule[] = []) {
    this.rules = [...(rules ?? [])].sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
  }

  /** The registered rule keys, in evaluation order. Exposed for diagnostics and for the pricing-path test. */
  ruleKeys(): string[] {
    return this.rules.map((r) => r.key);
  }

  async quote(context: PricingContext): Promise<PricingResult> {
    const subtotalToman = this.computeSubtotal(context);

    const applied: PricingAdjustment[] = [];
    let remaining = subtotalToman;

    for (const rule of this.rules) {
      const state: PricingState = {
        subtotalToman,
        remainingToman: remaining,
        appliedRuleKeys: applied.map((a) => a.ruleKey),
      };

      const produced = await rule.evaluate(context, state);

      for (const adjustment of produced ?? []) {
        const normalized = this.normalize(rule, adjustment, remaining);
        if (normalized === null) continue;
        applied.push(normalized);
        remaining += normalized.amountToman;
      }
    }

    // Math.abs, not unary minus: negating an empty sum yields -0, which
    // JSON-serializes as `-0` and compares unequal to 0 under Object.is --
    // a genuinely confusing value to persist on an order that simply had no
    // discount at all.
    const discountTotalToman = Math.abs(sumAmounts(applied.filter((a) => a.amountToman < 0).map((a) => a.amountToman)));
    const feeTotalToman = sumAmounts(applied.filter((a) => a.amountToman > 0).map((a) => a.amountToman));
    const totalToman = assertNonNegativeAmount(subtotalToman - discountTotalToman + feeTotalToman, 'order total');

    return {
      currency: DEFAULT_CURRENCY,
      subtotalToman,
      adjustments: applied,
      discountTotalToman,
      feeTotalToman,
      totalToman,
    };
  }

  private computeSubtotal(context: PricingContext): number {
    if (context.lines.length === 0) {
      throw new Error('A pricing context must contain at least one line');
    }
    const lineTotals = context.lines.map((line) => {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) {
        throw new Error(`Line ${line.referenceId} has an invalid quantity: ${line.quantity}`);
      }
      assertNonNegativeAmount(line.unitPriceToman, `unit price for ${line.referenceId}`);
      return line.unitPriceToman * line.quantity;
    });
    return assertNonNegativeAmount(sumAmounts(lineTotals), 'order subtotal');
  }

  /**
   * Clamps one rule's proposed adjustment into something that cannot break
   * the order, and drops it entirely if nothing survives the clamp.
   *
   * The clamp is against `remaining` (not the subtotal) BY DESIGN: only the
   * engine knows what earlier rules already took off, so only the engine can
   * stop the Nth discount from overshooting. V2 reached the same conclusion
   * the hard way -- `CampaignDiscount` had to reach into the order's current
   * total to clamp against whatever `MembershipDiscount` had already
   * applied, which meant each new rule had to know about every previous one.
   */
  private normalize(rule: PricingRule, adjustment: PricingAdjustment, remaining: number): PricingAdjustment | null {
    if (adjustment.ruleKey !== rule.key) {
      // A rule attributing its adjustment to a different rule would make the
      // stored pricing history a lie. Refuse rather than silently rewrite.
      throw new Error(`Rule "${rule.key}" produced an adjustment attributed to "${adjustment.ruleKey}"`);
    }

    if (adjustment.kind === 'discount') {
      if (adjustment.amountToman > 0) {
        throw new Error(`Rule "${rule.key}" produced a positive amount for a discount`);
      }
      const clamped = clampDiscount(-adjustment.amountToman, remaining);
      if (clamped <= 0) {
        this.logger.debug(`Pricing rule ${rule.key} produced no applicable discount (nothing left to discount)`);
        return null;
      }
      return { ...adjustment, amountToman: -clamped };
    }

    if (adjustment.amountToman < 0) {
      throw new Error(`Rule "${rule.key}" produced a negative amount for a fee`);
    }
    if (adjustment.amountToman === 0) return null;
    return adjustment;
  }
}
