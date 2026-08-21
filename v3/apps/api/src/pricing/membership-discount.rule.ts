import { Injectable, Logger } from '@nestjs/common';
import { PricingAdjustment, PricingContext, PricingRule, PricingState } from '@beauclick/commerce';
import { BenefitService } from '@beauclick/loyalty';

/**
 * The first real pricing rule.
 *
 * Phase 2 built the pricing engine and deliberately registered ZERO rules,
 * because inventing membership economics then would have pulled future scope
 * into that phase. This is the rule it was built for, and its existence is
 * what turns "one pricing path" from a claim into something exercised in
 * production.
 *
 * It lives in `apps/api` rather than in loyalty-service, and that placement is
 * forced by the module boundary in the right direction: `PricingRule` is
 * commerce's interface and the benefit lookup is loyalty's data, so a class
 * implementing one against the other cannot live in either domain without
 * that domain depending on the other. The composition root is the one tier
 * permitted to know both, exactly as it is for the checkout transaction.
 *
 * Three properties inherited from the engine rather than reimplemented here:
 *
 *   * **No compounding.** The percentage is applied to `state.subtotalToman`,
 *     which the engine holds immutable across the whole evaluation. A future
 *     campaign rule discounting 15% and this rule discounting 10% both work
 *     from the same base -- they cannot multiply into 23.5%, which is the
 *     precise bug V2 shipped.
 *   * **Never below zero.** The engine clamps each adjustment against what
 *     actually remains.
 *   * **Deterministic order.** `priority` decides, never registration order.
 *
 * Basis points, not a float percentage. V2 stored discounts as floats and
 * produced a real rounding mismatch between two stacked discounts;
 * `Math.floor` on an integer-basis-point calculation is exactly reproducible
 * and always rounds in the customer's favour on the platform's side -- a
 * discount is never silently rounded down to less than the benefit promised.
 */
@Injectable()
export class MembershipDiscountRule implements PricingRule {
  readonly key = 'loyalty.membership_discount';

  /**
   * Runs early (10) so a later campaign rule can see it in
   * `state.appliedRuleKeys` and decide whether to stack. Note this changes
   * nothing about the BASE either rule computes against -- ordering here
   * affects only clamping and rule-to-rule awareness, never compounding.
   */
  readonly priority = 10;

  private readonly logger = new Logger('MembershipDiscountRule');

  constructor(private readonly benefits: BenefitService) {}

  async evaluate(context: PricingContext, state: PricingState): Promise<PricingAdjustment[]> {
    let percentBp: number;
    try {
      percentBp = await this.benefits.discountPercentBp(context.customerId);
    } catch (err) {
      // A failing rule is FATAL by the engine's design -- swallowing it would
      // charge a price no rule agreed to. Rethrown after logging, rather than
      // silently returning no discount, because "the customer was charged
      // full price because loyalty was briefly unreachable" is a money bug
      // and must fail the checkout loudly.
      this.logger.error(
        `Membership discount lookup failed for customer ${context.customerId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    if (percentBp <= 0) return [];

    // Integer arithmetic throughout. `floor` rather than `round` so the
    // discount can never exceed the exact percentage -- a rounded-up discount
    // on a large order would mean charging less than the rule states.
    const amount = Math.floor((state.subtotalToman * percentBp) / 10000);
    if (amount <= 0) return [];

    return [
      {
        ruleKey: this.key,
        kind: 'discount',
        code: null,
        label: 'تخفیف عضویت',
        // Negative: a discount reduces the total. The engine sums signed
        // amounts, so the sign is the rule's statement of intent.
        amountToman: -amount,
        metadata: { percentBp },
      },
    ];
  }
}
