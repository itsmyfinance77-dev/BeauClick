import {
  CATALOGUE_LIFECYCLE_STATES,
  COMMERCIAL_CATALOGUE_CONTRACT_VERSION,
  COMMERCIAL_CURRENCY,
  MAX_CATALOGUE_QUANTITY,
  MAX_UNIT_PRICE_TOMAN,
  PRICE_SCHEDULE_PURPOSES,
  PlanVersionTermsV1,
  PriceResolutionError,
  PriceScheduleTermsV1,
  isPermittedLifecycleTransition,
  resolvePriceV1,
  validatePlanVersionTermsV1,
  validatePriceScheduleTermsV1,
} from './commercial-catalogue-contract';

/**
 * The catalogue contract's own arithmetic and vocabulary.
 *
 * Every boundary here is tested AT the boundary and one step either side,
 * because a tier table is nothing but boundaries: the interesting failures are
 * at 99/100/101, not at 50.
 */

/** A three-tier schedule with deliberately awkward boundaries. */
function tieredSchedule(): PriceScheduleTermsV1 {
  return {
    currency: COMMERCIAL_CURRENCY,
    minPurchaseQuantity: 1,
    maxPurchaseQuantity: 500,
    uiPresetQuantities: [],
    tiers: [
      { minQuantity: 1, maxQuantity: 9, unitPriceToman: 12_000 },
      { minQuantity: 10, maxQuantity: 99, unitPriceToman: 10_500 },
      { minQuantity: 100, maxQuantity: null, unitPriceToman: 9_000 },
    ],
  };
}

function planTerms(overrides: Partial<PlanVersionTermsV1> = {}): PlanVersionTermsV1 {
  return {
    displayName: 'test plan',
    billingTermDays: 30,
    includedBookingCredits: 0,
    staffSeats: 0,
    includedLocations: 0,
    capabilityKeys: [],
    ...overrides,
  };
}

describe('commercial catalogue contract — vocabulary', () => {
  it('is version 1 and exposes only the three ratified lifecycle states', () => {
    expect(COMMERCIAL_CATALOGUE_CONTRACT_VERSION).toBe(1);
    expect([...CATALOGUE_LIFECYCLE_STATES]).toEqual(['draft', 'published', 'retired']);
  });

  it('permits only draft -> published and published -> retired', () => {
    expect(isPermittedLifecycleTransition('draft', 'published')).toBe(true);
    expect(isPermittedLifecycleTransition('published', 'retired')).toBe(true);
  });

  it.each([
    ['draft', 'retired'],
    ['published', 'draft'],
    ['retired', 'published'],
    ['retired', 'draft'],
    ['retired', 'retired'],
    ['draft', 'draft'],
    ['published', 'published'],
  ] as const)('refuses %s -> %s', (from, to) => {
    expect(isPermittedLifecycleTransition(from, to)).toBe(false);
  });

  it('offers exactly two schedule purposes', () => {
    expect([...PRICE_SCHEDULE_PURPOSES]).toEqual(['seller_plan', 'booking_credit']);
  });

  it('pins the currency to IRT', () => {
    expect(COMMERCIAL_CURRENCY).toBe('IRT');
  });
});

describe('commercial catalogue contract — plan terms', () => {
  it('accepts terms that grant nothing, because zero is the absence of an allowance', () => {
    expect(validatePlanVersionTermsV1(planTerms({ billingTermDays: null }))).toEqual([]);
  });

  it('rejects a fractional or negative allowance rather than rounding one', () => {
    expect(validatePlanVersionTermsV1(planTerms({ includedBookingCredits: 1.5 }))).toContain(
      `includedBookingCredits must be a non-negative integer of at most ${MAX_CATALOGUE_QUANTITY}`,
    );
    expect(validatePlanVersionTermsV1(planTerms({ includedBookingCredits: -1 }))).toHaveLength(1);
  });

  it('rejects a zero or negative billing term, and accepts null for "no recurring term"', () => {
    expect(validatePlanVersionTermsV1(planTerms({ billingTermDays: 0 }))).toHaveLength(1);
    expect(validatePlanVersionTermsV1(planTerms({ billingTermDays: -1 }))).toHaveLength(1);
    expect(validatePlanVersionTermsV1(planTerms({ billingTermDays: null }))).toEqual([]);
  });

  it('rejects a repeated or malformed capability key', () => {
    expect(validatePlanVersionTermsV1(planTerms({ capabilityKeys: ['bc_x', 'bc_x'] }))).toContain(
      'capabilityKeys must not repeat a key',
    );
    expect(validatePlanVersionTermsV1(planTerms({ capabilityKeys: ['BC_X'] }))).toContain(
      'every capabilityKey must be a stable lowercase key',
    );
  });

  it('reports every problem rather than hiding the second behind the first', () => {
    const problems = validatePlanVersionTermsV1(
      planTerms({ displayName: '  ', includedBookingCredits: -1, capabilityKeys: ['A'] }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe('commercial catalogue contract — schedule validation', () => {
  it('accepts a complete tiered schedule', () => {
    expect(validatePriceScheduleTermsV1(tieredSchedule())).toEqual([]);
  });

  it('accepts a ONE-TIER schedule, which is how a flat price is represented', () => {
    expect(
      validatePriceScheduleTermsV1({
        currency: COMMERCIAL_CURRENCY,
        minPurchaseQuantity: 1,
        maxPurchaseQuantity: 1,
        uiPresetQuantities: [],
        tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 0 }],
      }),
    ).toEqual([]);
  });

  it('refuses an EMPTY schedule: a flat price is one tier, not none', () => {
    const problems = validatePriceScheduleTermsV1({ ...tieredSchedule(), tiers: [] });
    expect(problems).toContain('a schedule needs at least one tier: a flat price is a one-tier schedule, not an empty one');
  });

  it('detects a gap between tiers', () => {
    const withGap: PriceScheduleTermsV1 = {
      ...tieredSchedule(),
      tiers: [
        { minQuantity: 1, maxQuantity: 9, unitPriceToman: 12_000 },
        { minQuantity: 20, maxQuantity: null, unitPriceToman: 9_000 },
      ],
    };
    expect(validatePriceScheduleTermsV1(withGap)).toContain('tiers leave a gap between quantity 10 and 19');
  });

  it('detects an overlap between tiers', () => {
    const overlapping: PriceScheduleTermsV1 = {
      ...tieredSchedule(),
      tiers: [
        { minQuantity: 1, maxQuantity: 20, unitPriceToman: 12_000 },
        { minQuantity: 10, maxQuantity: null, unitPriceToman: 9_000 },
      ],
    };
    expect(validatePriceScheduleTermsV1(overlapping)).toContain('tiers overlap between quantity 10 and 20');
  });

  it('refuses an unbounded tier that is not the highest', () => {
    const badlyUnbounded: PriceScheduleTermsV1 = {
      ...tieredSchedule(),
      tiers: [
        { minQuantity: 1, maxQuantity: null, unitPriceToman: 12_000 },
        { minQuantity: 10, maxQuantity: 500, unitPriceToman: 9_000 },
      ],
    };
    expect(validatePriceScheduleTermsV1(badlyUnbounded)).toContain('only the highest tier may be unbounded above');
  });

  it('refuses tiers that do not start at the schedule minimum', () => {
    const short: PriceScheduleTermsV1 = {
      ...tieredSchedule(),
      minPurchaseQuantity: 5,
      tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 100 }],
    };
    expect(validatePriceScheduleTermsV1(short)).toContain('tiers must start at minPurchaseQuantity (5), they start at 1');
  });

  it('refuses tiers that stop short of the schedule maximum', () => {
    const short: PriceScheduleTermsV1 = {
      currency: COMMERCIAL_CURRENCY,
      minPurchaseQuantity: 1,
      maxPurchaseQuantity: 500,
      uiPresetQuantities: [],
      tiers: [{ minQuantity: 1, maxQuantity: 100, unitPriceToman: 100 }],
    };
    expect(validatePriceScheduleTermsV1(short)).toContain(
      'tiers must cover maxPurchaseQuantity (500), the highest ends at 100',
    );
  });

  it('refuses a currency other than IRT', () => {
    const foreign = { ...tieredSchedule(), currency: 'USD' } as unknown as PriceScheduleTermsV1;
    expect(validatePriceScheduleTermsV1(foreign)).toContain('currency must be IRT');
  });

  it('refuses a negative unit price: a negative price is a corrupt row, not a discount', () => {
    const negative: PriceScheduleTermsV1 = {
      ...tieredSchedule(),
      tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: -1 }],
    };
    expect(validatePriceScheduleTermsV1(negative)).toContain(
      'every tier unitPriceToman must be a non-negative integer within the money bound',
    );
  });

  it('refuses a repeated preset quantity', () => {
    expect(validatePriceScheduleTermsV1({ ...tieredSchedule(), uiPresetQuantities: [50, 50] })).toContain(
      'uiPresetQuantities must not repeat a quantity',
    );
  });
});

describe('commercial catalogue contract — exact resolution at the boundaries', () => {
  it.each([
    [1, 12_000, 12_000],
    [9, 12_000, 108_000],
    [10, 10_500, 105_000],
    [99, 10_500, 1_039_500],
    [100, 9_000, 900_000],
    [500, 9_000, 4_500_000],
  ])('quantity %i resolves to unit %i and total %i', (quantity, unit, total) => {
    const quote = resolvePriceV1(tieredSchedule(), quantity);
    expect(quote.unitPriceToman).toBe(unit);
    expect(quote.totalToman).toBe(total);
    expect(quote.currency).toBe('IRT');
    expect(quote.quantity).toBe(quantity);
  });

  it('crosses each boundary exactly once: 9 and 10 differ, 99 and 100 differ', () => {
    const schedule = tieredSchedule();
    expect(resolvePriceV1(schedule, 9).unitPriceToman).not.toBe(resolvePriceV1(schedule, 10).unitPriceToman);
    expect(resolvePriceV1(schedule, 99).unitPriceToman).not.toBe(resolvePriceV1(schedule, 100).unitPriceToman);
  });

  it('resolves a one-tier flat price for every quantity in range', () => {
    const flat: PriceScheduleTermsV1 = {
      currency: COMMERCIAL_CURRENCY,
      minPurchaseQuantity: 1,
      maxPurchaseQuantity: 1_000,
      uiPresetQuantities: [],
      tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 7 }],
    };
    expect(resolvePriceV1(flat, 1).totalToman).toBe(7);
    expect(resolvePriceV1(flat, 1_000).totalToman).toBe(7_000);
  });

  it('resolves a ZERO price exactly, without confusing it for "no price"', () => {
    const free: PriceScheduleTermsV1 = {
      currency: COMMERCIAL_CURRENCY,
      minPurchaseQuantity: 1,
      maxPurchaseQuantity: 1,
      uiPresetQuantities: [],
      tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 0 }],
    };
    const quote = resolvePriceV1(free, 1);
    expect(quote.unitPriceToman).toBe(0);
    expect(quote.totalToman).toBe(0);
  });

  it('refuses a quantity below the schedule minimum', () => {
    const schedule: PriceScheduleTermsV1 = {
      ...tieredSchedule(),
      minPurchaseQuantity: 10,
      tiers: [{ minQuantity: 10, maxQuantity: null, unitPriceToman: 100 }],
    };
    expect(() => resolvePriceV1(schedule, 9)).toThrow(PriceResolutionError);
    try {
      resolvePriceV1(schedule, 9);
    } catch (error) {
      expect((error as PriceResolutionError).refusal).toBe('quantity_out_of_bounds');
    }
  });

  it('refuses a quantity above the schedule maximum rather than clamping it', () => {
    try {
      resolvePriceV1(tieredSchedule(), 501);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PriceResolutionError);
      expect((error as PriceResolutionError).refusal).toBe('quantity_out_of_bounds');
    }
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses the non-quantity %p', (quantity) => {
    expect(() => resolvePriceV1(tieredSchedule(), quantity as number)).toThrow(PriceResolutionError);
  });

  it('refuses an incomplete schedule instead of returning a fallback price', () => {
    const holed: PriceScheduleTermsV1 = {
      ...tieredSchedule(),
      tiers: [
        { minQuantity: 1, maxQuantity: 9, unitPriceToman: 12_000 },
        { minQuantity: 20, maxQuantity: null, unitPriceToman: 9_000 },
      ],
    };
    try {
      resolvePriceV1(holed, 15);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PriceResolutionError);
      expect((error as PriceResolutionError).refusal).toBe('schedule_incomplete');
    }
  });

  /**
   * The reason the total is computed with BigInt.
   *
   * `MAX_CATALOGUE_QUANTITY × MAX_UNIT_PRICE_TOMAN` is far past 2^53, so a
   * naive `quantity * unitPrice` would silently produce a rounded float. This
   * proves the overflow is REFUSED rather than rounded — and the case just
   * below it proves a product that is still exact is accepted, so the refusal
   * is a boundary rather than a blanket.
   */
  it('refuses a total that exceeds the representable money bound', () => {
    const huge: PriceScheduleTermsV1 = {
      currency: COMMERCIAL_CURRENCY,
      minPurchaseQuantity: 1,
      maxPurchaseQuantity: MAX_CATALOGUE_QUANTITY,
      uiPresetQuantities: [],
      tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: MAX_UNIT_PRICE_TOMAN }],
    };
    expect(() => resolvePriceV1(huge, MAX_CATALOGUE_QUANTITY)).toThrow(PriceResolutionError);
  });

  it('computes a large but representable total exactly', () => {
    const large: PriceScheduleTermsV1 = {
      currency: COMMERCIAL_CURRENCY,
      minPurchaseQuantity: 1,
      maxPurchaseQuantity: 1_000_000,
      uiPresetQuantities: [],
      tiers: [{ minQuantity: 1, maxQuantity: null, unitPriceToman: 9_999_999 }],
    };
    expect(resolvePriceV1(large, 999_999).totalToman).toBe(9_999_989_000_001);
  });

  it('returns a frozen quote, so a caller cannot mutate a resolved price in place', () => {
    const quote = resolvePriceV1(tieredSchedule(), 10);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.tier)).toBe(true);
  });
});
