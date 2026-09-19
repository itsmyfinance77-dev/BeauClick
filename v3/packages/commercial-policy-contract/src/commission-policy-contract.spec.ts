import {
  COMMISSION_ARITHMETIC_VERSION,
  COMMISSION_BASES,
  COMMISSION_COMPONENTS,
  COMMISSION_RULE_KINDS,
  COMMISSION_TERM_STATES,
  CommissionBase,
  CommissionComponent,
  CommissionTermV1,
  MAX_COMMISSION_AMOUNT_TOMAN,
  MAX_COMMISSION_BASIS_POINTS,
  evaluateCommission,
  legacyCommissionReversalToman,
} from './commission-policy-contract';

/**
 * The commission engine — V3.3 Story #173 (`#43b-1`), ADR-052 §3,
 * `V33-DEC-040` R1 and R3, `V33-DEC-044`'s OC-2 decision.
 *
 * Every worked example ADR-052 states in prose appears below as a test, and
 * the property block exercises the arithmetic up to `MAX_COMMISSION_AMOUNT_TOMAN`
 * where `Number` would already have lost precision — the reason the engine is
 * `BigInt` throughout.
 */

const term = (
  component: CommissionComponent,
  overrides: Partial<CommissionTermV1> = {},
): CommissionTermV1 => ({
  component,
  state: 'rule',
  ruleKind: 'percentage',
  basisPoints: 1_000,
  fixedToman: null,
  base: 'platform_collected_amount',
  arithmeticVersion: COMMISSION_ARITHMETIC_VERSION,
  ...overrides,
});

const absent = (component: CommissionComponent): CommissionTermV1 => ({
  component,
  state: 'absent',
  ruleKind: null,
  basisPoints: null,
  fixedToman: null,
  base: null,
  arithmeticVersion: COMMISSION_ARITHMETIC_VERSION,
});

describe('the commission vocabulary', () => {
  it('is closed, and in the ratified evaluation order', () => {
    // The ORDER is binding, not the membership alone: the held ceiling is
    // allocated in this sequence, so a reordering changes the split.
    expect(COMMISSION_COMPONENTS).toEqual(['booking_commission', 'acquisition', 'processing_recovery']);
    expect(COMMISSION_RULE_KINDS).toEqual(['zero', 'percentage', 'fixed', 'hybrid']);
    expect(COMMISSION_BASES).toEqual(['platform_collected_amount', 'service_total']);
    expect(COMMISSION_TERM_STATES).toEqual(['absent', 'zero', 'rule']);
  });

  it('carries boundaries and no commercial value', () => {
    expect(MAX_COMMISSION_BASIS_POINTS).toBe(10_000);
    expect(MAX_COMMISSION_AMOUNT_TOMAN).toBe(10_000_000_000_000);
    expect(COMMISSION_ARITHMETIC_VERSION).toBe(1);
  });
});

describe('the four shapes, per component', () => {
  const evaluateOne = (overrides: Partial<CommissionTermV1>, collected = 1_000_000) =>
    evaluateCommission({
      basis: 'completion',
      terms: [term('booking_commission', overrides)],
      collectedTotalToman: collected,
      serviceTotalToman: collected,
      heldToman: collected,
      retainedToman: 0,
    });

  it('zero charges nothing, and so does an absent term — but they stay distinguishable', () => {
    const published = evaluateOne({ state: 'zero', ruleKind: 'zero', basisPoints: null, base: null });
    const none = evaluateCommission({
      basis: 'completion',
      terms: [absent('booking_commission')],
      collectedTotalToman: 1_000_000,
      serviceTotalToman: 1_000_000,
      heldToman: 1_000_000,
      retainedToman: 0,
    });

    expect(published.computedTotalToman).toBe(0);
    expect(none.computedTotalToman).toBe(0);
    // Same money, different fact: `#43c` must be able to say whether nobody
    // decided or somebody decided nothing.
    expect(published.components[0].state).toBe('zero');
    expect(none.components[0].state).toBe('absent');
  });

  it('percentage floors rather than rounding', () => {
    // 1 999 999 × 1 500 / 10 000 = 299 999.85 → 299 999, never 300 000.
    const result = evaluateOne({ basisPoints: 1_500 }, 1_999_999);
    expect(result.computedTotalToman).toBe(299_999);
  });

  it('fixed ignores the base entirely', () => {
    const result = evaluateOne({ ruleKind: 'fixed', fixedToman: 50_000, basisPoints: null, base: null }, 7);
    expect(result.computedTotalToman).toBe(50_000);
  });

  it('hybrid adds the flat part to the floored percentage, and the flat part may be zero', () => {
    const both = evaluateOne({ ruleKind: 'hybrid', basisPoints: 500, fixedToman: 20_000 }, 1_000_001);
    expect(both.computedTotalToman).toBe(20_000 + 50_000);

    const flatless = evaluateOne({ ruleKind: 'hybrid', basisPoints: 500, fixedToman: 0 }, 1_000_001);
    expect(flatless.computedTotalToman).toBe(50_000);
  });

  it('reads each component base from its OWN rule on completion', () => {
    const result = evaluateCommission({
      basis: 'completion',
      terms: [
        term('booking_commission', { basisPoints: 1_000, base: 'platform_collected_amount' }),
        term('acquisition', { basisPoints: 1_000, base: 'service_total' }),
      ],
      collectedTotalToman: 400_000,
      serviceTotalToman: 1_000_000,
      heldToman: 400_000,
      retainedToman: 0,
    });
    expect(result.components.map((c) => c.computedToman)).toEqual([40_000, 100_000, 0]);
  });
});

describe('the completion outcome (ADR-052 §3, R1)', () => {
  it('caps the deduction at what is still held and turns the remainder into a receivable', () => {
    const result = evaluateCommission({
      basis: 'completion',
      terms: [term('booking_commission', { ruleKind: 'fixed', fixedToman: 90_000, basisPoints: null, base: null })],
      collectedTotalToman: 100_000,
      serviceTotalToman: 100_000,
      heldToman: 30_000,
      retainedToman: 0,
    });

    expect(result.computedTotalToman).toBe(90_000);
    expect(result.deductibleTotalToman).toBe(30_000);
    expect(result.excessToman).toBe(60_000);
    expect(result.createsReceivable).toBe(true);
  });

  it('allocates the held ceiling in the fixed component order, and a later component gets only the remainder', () => {
    const result = evaluateCommission({
      basis: 'completion',
      terms: [
        term('booking_commission', { ruleKind: 'fixed', fixedToman: 70_000, basisPoints: null, base: null }),
        term('acquisition', { ruleKind: 'fixed', fixedToman: 50_000, basisPoints: null, base: null }),
        term('processing_recovery', { ruleKind: 'fixed', fixedToman: 10_000, basisPoints: null, base: null }),
      ],
      collectedTotalToman: 1_000_000,
      serviceTotalToman: 1_000_000,
      heldToman: 100_000,
      retainedToman: 0,
    });

    // 70 000 first, 30 000 of the 50 000 second, nothing for the third.
    expect(result.components.map((c) => c.deductibleToman)).toEqual([70_000, 30_000, 0]);
    expect(result.deductibleTotalToman).toBe(100_000);
    expect(result.excessToman).toBe(30_000);
  });

  it('creates no receivable when everything fits', () => {
    const result = evaluateCommission({
      basis: 'completion',
      terms: [term('booking_commission', { basisPoints: 1_000 })],
      collectedTotalToman: 500_000,
      serviceTotalToman: 500_000,
      heldToman: 500_000,
      retainedToman: 0,
    });
    expect(result.deductibleTotalToman).toBe(50_000);
    expect(result.excessToman).toBe(0);
    expect(result.createsReceivable).toBe(false);
  });
});

describe('the seller-retained outcome (OC-2, decided by `V33-DEC-044`)', () => {
  it("is ADR-052's own worked example: collected 100, refunded 60, retained 40, 10% ⇒ 4", () => {
    const result = evaluateCommission({
      basis: 'seller_retained',
      terms: [term('booking_commission', { basisPoints: 1_000, base: 'platform_collected_amount' })],
      collectedTotalToman: 100,
      serviceTotalToman: 100,
      heldToman: 40,
      retainedToman: 40,
    });
    expect(result.computedTotalToman).toBe(4);
    expect(result.deductibleTotalToman).toBe(4);
    expect(result.excessToman).toBe(0);
  });

  it('is the same example with a fixed 50 rule ⇒ 40 deducted and NO receivable', () => {
    const result = evaluateCommission({
      basis: 'seller_retained',
      terms: [term('booking_commission', { ruleKind: 'fixed', fixedToman: 50, basisPoints: null, base: null })],
      collectedTotalToman: 100,
      serviceTotalToman: 100,
      heldToman: 40,
      retainedToman: 40,
    });
    expect(result.computedTotalToman).toBe(50);
    expect(result.deductibleTotalToman).toBe(40);
    // The whole point of OC-2: the uncharged 10 is not owed by anyone.
    expect(result.excessToman).toBe(0);
    expect(result.createsReceivable).toBe(false);
  });

  it('computes EVERY component on the retained amount, whatever its own base says', () => {
    const onRetained = evaluateCommission({
      basis: 'seller_retained',
      terms: [
        term('booking_commission', { basisPoints: 1_000, base: 'service_total' }),
        term('acquisition', { basisPoints: 1_000, base: 'platform_collected_amount' }),
      ],
      collectedTotalToman: 1_000_000,
      serviceTotalToman: 5_000_000,
      heldToman: 200_000,
      retainedToman: 200_000,
    });
    // Both read 200 000, not 5 000 000 and not 1 000 000.
    expect(onRetained.components.map((c) => c.computedToman)).toEqual([20_000, 20_000, 0]);
  });

  it('never creates a receivable, however far the rule exceeds the retained amount', () => {
    const result = evaluateCommission({
      basis: 'seller_retained',
      terms: [term('booking_commission', { ruleKind: 'fixed', fixedToman: 9_000_000, basisPoints: null, base: null })],
      collectedTotalToman: 1_000_000,
      serviceTotalToman: 1_000_000,
      heldToman: 1_000,
      retainedToman: 1_000,
    });
    expect(result.deductibleTotalToman).toBe(1_000);
    expect(result.excessToman).toBe(0);
    expect(result.createsReceivable).toBe(false);
  });
});

describe('the legacy cumulative reversal (ADR-052 §3, §16)', () => {
  it('leaves no residue after a full refund, however many partial refunds preceded it', () => {
    const net = 1_000_003;
    const rate = 1_500;
    let reversed = 0;
    for (const refundedToDate of [250_000, 500_000, 750_000, net]) {
      reversed += legacyCommissionReversalToman({
        originalNetToman: net,
        refundedToDateToman: refundedToDate,
        originalRateBp: rate,
        alreadyReversedToman: reversed,
      });
    }
    // Everything the platform ever recognised on this order is reversed —
    // exactly, with no drift from the four floorings along the way.
    expect(reversed).toBe(Math.floor((net * rate) / 10_000));
  });

  it('is cumulative rather than incremental: the same total is reached in one step or four', () => {
    const inOne = legacyCommissionReversalToman({
      originalNetToman: 999_999,
      refundedToDateToman: 999_999,
      originalRateBp: 1_234,
      alreadyReversedToman: 0,
    });

    let stepwise = 0;
    for (const refundedToDate of [111_111, 444_444, 777_777, 999_999]) {
      stepwise += legacyCommissionReversalToman({
        originalNetToman: 999_999,
        refundedToDateToman: refundedToDate,
        originalRateBp: 1_234,
        alreadyReversedToman: stepwise,
      });
    }
    expect(stepwise).toBe(inOne);
  });

  it('never returns a negative amount: an over-reversal is a reconciliation exception, not a charge back to the seller', () => {
    expect(
      legacyCommissionReversalToman({
        originalNetToman: 100_000,
        refundedToDateToman: 10_000,
        originalRateBp: 1_000,
        alreadyReversedToman: 999_999,
      }),
    ).toBe(0);
  });

  it('refuses a refund larger than the original net rather than inventing a reversal', () => {
    expect(() =>
      legacyCommissionReversalToman({
        originalNetToman: 100,
        refundedToDateToman: 101,
        originalRateBp: 1_000,
        alreadyReversedToman: 0,
      }),
    ).toThrow(/cannot exceed/i);
  });
});

describe('boundaries and refusals', () => {
  const base = {
    basis: 'completion' as const,
    terms: [term('booking_commission')],
    collectedTotalToman: 1_000,
    serviceTotalToman: 1_000,
    heldToman: 1_000,
    retainedToman: 0,
  };

  it.each([
    ['a negative amount', { ...base, collectedTotalToman: -1 }],
    ['a fractional amount', { ...base, heldToman: 1.5 }],
    ['an amount above the ceiling', { ...base, serviceTotalToman: MAX_COMMISSION_AMOUNT_TOMAN + 1 }],
  ])('refuses %s rather than producing a number', (_label, input) => {
    expect(() => evaluateCommission(input)).toThrow(RangeError);
  });

  it('refuses basis points above 100%', () => {
    expect(() =>
      evaluateCommission({ ...base, terms: [term('booking_commission', { basisPoints: MAX_COMMISSION_BASIS_POINTS + 1 })] }),
    ).toThrow(RangeError);
  });

  it('treats a component with no term at all as absent rather than failing', () => {
    const result = evaluateCommission({ ...base, terms: [] });
    expect(result.components.map((c) => c.state)).toEqual(['absent', 'absent', 'absent']);
    expect(result.computedTotalToman).toBe(0);
  });
});

describe('properties, up to MAX_COMMISSION_AMOUNT_TOMAN', () => {
  /** A deterministic LCG: a property failure must be reproducible from the seed alone. */
  function* amounts(seed: number, count: number): Generator<number> {
    let state = seed;
    for (let i = 0; i < count; i += 1) {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      // Spread across the whole representable range, including the ceiling
      // itself, where `base × bp` reaches 10¹⁷ and `Number` is no longer exact.
      yield Math.floor((state / 2_147_483_648) * MAX_COMMISSION_AMOUNT_TOMAN);
    }
  }

  const bases: readonly CommissionBase[] = COMMISSION_BASES;

  it('never deducts more than the ceiling, and never reports a negative excess', () => {
    let checked = 0;
    for (const amount of amounts(7, 200)) {
      for (const bp of [0, 1, 1_500, 9_999, MAX_COMMISSION_BASIS_POINTS]) {
        const held = Math.floor(amount / 3);
        const result = evaluateCommission({
          basis: 'completion',
          terms: COMMISSION_COMPONENTS.map((component, index) =>
            term(component, { basisPoints: bp, base: bases[index % bases.length] }),
          ),
          collectedTotalToman: amount,
          serviceTotalToman: amount,
          heldToman: held,
          retainedToman: 0,
        });

        expect(result.deductibleTotalToman).toBeLessThanOrEqual(held);
        expect(result.excessToman).toBeGreaterThanOrEqual(0);
        expect(result.deductibleTotalToman + result.excessToman).toBe(result.computedTotalToman);
        // The per-component deductions always sum to the total, so no toman is
        // created or lost by the allocation.
        expect(result.components.reduce((sum, c) => sum + c.deductibleToman, 0)).toBe(result.deductibleTotalToman);
        checked += 1;
      }
    }
    expect(checked).toBe(1_000);
  });

  it('is monotone in the rate and never exceeds the base', () => {
    for (const amount of amounts(11, 60)) {
      let previous = -1;
      for (const bp of [0, 100, 2_500, 7_500, MAX_COMMISSION_BASIS_POINTS]) {
        const result = evaluateCommission({
          basis: 'completion',
          terms: [term('booking_commission', { basisPoints: bp })],
          collectedTotalToman: amount,
          serviceTotalToman: amount,
          heldToman: MAX_COMMISSION_AMOUNT_TOMAN,
          retainedToman: 0,
        });
        expect(result.computedTotalToman).toBeGreaterThanOrEqual(previous);
        // 100% of the base is the most a percentage rule can ever ask for.
        expect(result.computedTotalToman).toBeLessThanOrEqual(amount);
        previous = result.computedTotalToman;
      }
    }
  });

  it('never creates a receivable on a seller-retained outcome, for any inputs', () => {
    for (const amount of amounts(13, 120)) {
      const retained = Math.floor(amount / 7);
      const result = evaluateCommission({
        basis: 'seller_retained',
        terms: COMMISSION_COMPONENTS.map((component) =>
          term(component, { ruleKind: 'hybrid', basisPoints: 9_000, fixedToman: Math.min(amount, 1_000_000) }),
        ),
        collectedTotalToman: amount,
        serviceTotalToman: amount,
        heldToman: retained,
        retainedToman: retained,
      });
      expect(result.excessToman).toBe(0);
      expect(result.createsReceivable).toBe(false);
      expect(result.deductibleTotalToman).toBeLessThanOrEqual(retained);
    }
  });
});
