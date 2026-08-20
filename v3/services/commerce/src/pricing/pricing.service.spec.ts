import { PricingService } from './pricing.service';
import { PricingAdjustment, PricingContext, PricingRule, PricingState } from './pricing.types';

function context(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    customerId: 'c1',
    sellerPartyType: 'professional',
    sellerPartyId: 'p1',
    lines: [{ referenceId: 's1', name: 'کوتاهی مو', quantity: 1, unitPriceToman: 200_000 }],
    at: new Date('2026-08-20T10:00:00Z'),
    bookingId: 'b1',
    ...overrides,
  };
}

/**
 * Percentage rule shaped exactly like the future membership/campaign rules
 * (V2's `MembershipDiscount` and `CampaignDiscount`), so these tests
 * exercise the real integration contract those phases will implement --
 * without inventing their economics here, which is later-phase scope.
 */
class PercentageDiscountRule implements PricingRule {
  constructor(
    readonly key: string,
    readonly priority: number,
    private readonly percent: number,
    private readonly label = 'تخفیف',
  ) {}

  async evaluate(_ctx: PricingContext, state: PricingState): Promise<PricingAdjustment[]> {
    const amount = Math.round((state.subtotalToman * this.percent) / 100);
    return [{ ruleKey: this.key, kind: 'discount', code: null, label: this.label, amountToman: -amount }];
  }
}

class FixedFeeRule implements PricingRule {
  constructor(
    readonly key: string,
    readonly priority: number,
    private readonly amount: number,
  ) {}
  async evaluate(): Promise<PricingAdjustment[]> {
    return [{ ruleKey: this.key, kind: 'fee', code: null, label: 'کارمزد', amountToman: this.amount }];
  }
}

class RecordingRule implements PricingRule {
  readonly seen: PricingState[] = [];
  constructor(
    readonly key: string,
    readonly priority: number,
  ) {}
  async evaluate(_ctx: PricingContext, state: PricingState): Promise<PricingAdjustment[]> {
    this.seen.push(state);
    return [];
  }
}

describe('PricingService: the single pricing path', () => {
  it('returns the bare subtotal when no rule is registered', async () => {
    const result = await new PricingService([]).quote(context());
    expect(result).toMatchObject({
      currency: 'IRT',
      subtotalToman: 200_000,
      adjustments: [],
      discountTotalToman: 0,
      feeTotalToman: 0,
      totalToman: 200_000,
    });
  });

  it('sums multi-line, multi-quantity subtotals as integer Toman', async () => {
    const result = await new PricingService([]).quote(
      context({
        lines: [
          { referenceId: 's1', name: 'A', quantity: 2, unitPriceToman: 150_000 },
          { referenceId: 's2', name: 'B', quantity: 1, unitPriceToman: 80_000 },
        ],
      }),
    );
    expect(result.subtotalToman).toBe(380_000);
    expect(result.totalToman).toBe(380_000);
  });

  it('applies one discount rule', async () => {
    const result = await new PricingService([new PercentageDiscountRule('membership', 10, 10)]).quote(context());
    expect(result.discountTotalToman).toBe(20_000);
    expect(result.totalToman).toBe(180_000);
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].ruleKey).toBe('membership');
  });
});

describe('PricingService: no compounding (V2s hard-won rule, now enforced by the engine)', () => {
  it('computes every percentage against the SAME immutable subtotal', async () => {
    const service = new PricingService([
      new PercentageDiscountRule('membership', 10, 10),
      new PercentageDiscountRule('campaign', 20, 15),
    ]);

    const result = await service.quote(context());

    // 10% of 200,000 = 20,000 and 15% of 200,000 = 30,000.
    // Compounding would give 15% of 180,000 = 27,000 and a total of 153,000.
    expect(result.adjustments.map((a) => a.amountToman)).toEqual([-20_000, -30_000]);
    expect(result.discountTotalToman).toBe(50_000);
    expect(result.totalToman).toBe(150_000);
  });

  it('shows every rule the same subtotal, and a decreasing remaining', async () => {
    const first = new RecordingRule('first', 10);
    const second = new RecordingRule('second', 30);
    const service = new PricingService([first, new PercentageDiscountRule('mid', 20, 25), second]);

    await service.quote(context());

    expect(first.seen[0].subtotalToman).toBe(200_000);
    expect(second.seen[0].subtotalToman).toBe(200_000); // unchanged
    expect(first.seen[0].remainingToman).toBe(200_000);
    expect(second.seen[0].remainingToman).toBe(150_000); // reflects the 25% already applied
  });

  it('tells a later rule which rules already applied', async () => {
    const last = new RecordingRule('last', 99);
    await new PricingService([new PercentageDiscountRule('early', 1, 5), last]).quote(context());
    expect(last.seen[0].appliedRuleKeys).toEqual(['early']);
  });
});

describe('PricingService: deterministic ordering', () => {
  it('orders by priority, not registration order', async () => {
    const service = new PricingService([
      new FixedFeeRule('third', 30, 1),
      new PercentageDiscountRule('first', 10, 5),
      new FixedFeeRule('second', 20, 2),
    ]);
    expect(service.ruleKeys()).toEqual(['first', 'second', 'third']);
  });

  it('breaks a priority tie by key, so the outcome never depends on module wiring order', async () => {
    const a = new PricingService([new FixedFeeRule('zebra', 10, 1), new FixedFeeRule('alpha', 10, 2)]);
    const b = new PricingService([new FixedFeeRule('alpha', 10, 2), new FixedFeeRule('zebra', 10, 1)]);
    expect(a.ruleKeys()).toEqual(b.ruleKeys());
    expect(a.ruleKeys()).toEqual(['alpha', 'zebra']);
  });

  it('produces an identical result on repeated evaluation of the same context', async () => {
    const service = new PricingService([
      new PercentageDiscountRule('membership', 10, 12),
      new FixedFeeRule('surcharge', 20, 5_000),
    ]);
    const ctx = context();
    expect(await service.quote(ctx)).toEqual(await service.quote(ctx));
  });
});

describe('PricingService: the total can never go below zero', () => {
  it('clamps a single over-large discount to the subtotal', async () => {
    const result = await new PricingService([new PercentageDiscountRule('absurd', 10, 150)]).quote(context());
    expect(result.discountTotalToman).toBe(200_000);
    expect(result.totalToman).toBe(0);
  });

  it('clamps the SECOND discount against what the first one left', async () => {
    const result = await new PricingService([
      new PercentageDiscountRule('big', 10, 80),
      new PercentageDiscountRule('alsoBig', 20, 80),
    ]).quote(context());

    // Each rule wants 160,000 (80% of the same base). The first takes it in
    // full; the second is clamped to the 40,000 that remains.
    expect(result.adjustments.map((a) => a.amountToman)).toEqual([-160_000, -40_000]);
    expect(result.totalToman).toBe(0);
  });

  it('drops an adjustment entirely once nothing remains, rather than recording a zero line', async () => {
    const result = await new PricingService([
      new PercentageDiscountRule('takesEverything', 10, 100),
      new PercentageDiscountRule('tooLate', 20, 50),
    ]).quote(context());

    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].ruleKey).toBe('takesEverything');
    expect(result.totalToman).toBe(0);
  });

  it('handles a zero-price line without dividing by anything', async () => {
    const result = await new PricingService([new PercentageDiscountRule('any', 10, 20)]).quote(
      context({ lines: [{ referenceId: 's1', name: 'رایگان', quantity: 1, unitPriceToman: 0 }] }),
    );
    expect(result.totalToman).toBe(0);
    expect(result.adjustments).toEqual([]);
  });
});

describe('PricingService: fees', () => {
  it('adds a fee on top of the discounted total', async () => {
    const result = await new PricingService([
      new PercentageDiscountRule('membership', 10, 10),
      new FixedFeeRule('service-fee', 20, 15_000),
    ]).quote(context());

    expect(result.discountTotalToman).toBe(20_000);
    expect(result.feeTotalToman).toBe(15_000);
    expect(result.totalToman).toBe(195_000);
  });
});

describe('PricingService: fails loudly rather than charging an unexplainable price', () => {
  class ExplodingRule implements PricingRule {
    readonly key = 'explodes';
    readonly priority = 10;
    async evaluate(): Promise<PricingAdjustment[]> {
      throw new Error('rule backend unavailable');
    }
  }

  class MisattributingRule implements PricingRule {
    readonly key = 'honest';
    readonly priority = 10;
    async evaluate(): Promise<PricingAdjustment[]> {
      return [{ ruleKey: 'someone-else', kind: 'discount', code: null, label: 'x', amountToman: -1000 }];
    }
  }

  class SignConfusedRule implements PricingRule {
    readonly key = 'confused';
    readonly priority = 10;
    async evaluate(): Promise<PricingAdjustment[]> {
      return [{ ruleKey: 'confused', kind: 'discount', code: null, label: 'x', amountToman: 5000 }];
    }
  }

  it('propagates a failing rule instead of silently pricing without it', async () => {
    await expect(new PricingService([new ExplodingRule()]).quote(context())).rejects.toThrow('rule backend unavailable');
  });

  it('rejects an adjustment attributed to a different rule (the stored history must stay true)', async () => {
    await expect(new PricingService([new MisattributingRule()]).quote(context())).rejects.toThrow(/attributed to/);
  });

  it('rejects a discount with a positive amount', async () => {
    await expect(new PricingService([new SignConfusedRule()]).quote(context())).rejects.toThrow(/positive amount/);
  });

  it('rejects an empty pricing context', async () => {
    await expect(new PricingService([]).quote(context({ lines: [] }))).rejects.toThrow(/at least one line/);
  });

  it('rejects a fractional catalogue price rather than rounding it silently', async () => {
    await expect(
      new PricingService([]).quote(
        context({ lines: [{ referenceId: 's1', name: 'x', quantity: 1, unitPriceToman: 199_999.5 }] }),
      ),
    ).rejects.toThrow(/integer Toman/);
  });

  it('rejects a zero or negative quantity', async () => {
    await expect(
      new PricingService([]).quote(
        context({ lines: [{ referenceId: 's1', name: 'x', quantity: 0, unitPriceToman: 1000 }] }),
      ),
    ).rejects.toThrow(/invalid quantity/);
  });
});
