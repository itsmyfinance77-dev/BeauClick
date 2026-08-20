import {
  MAX_AMOUNT_TOMAN,
  MoneyError,
  addAmounts,
  assertAmount,
  assertNonNegativeAmount,
  assertRateBasisPoints,
  clampDiscount,
  formatBasisPoints,
  percentOf,
  roundHalf,
  splitExact,
  sumAmounts,
} from './money';
import { moneyTransformer, requiredMoneyTransformer } from './money.transformer';

describe('money: representation invariants', () => {
  it('accepts zero', () => {
    expect(assertAmount(0)).toBe(0);
  });

  it('accepts one Toman', () => {
    expect(assertAmount(1)).toBe(1);
  });

  it('accepts a large but in-range value', () => {
    expect(assertAmount(MAX_AMOUNT_TOMAN)).toBe(MAX_AMOUNT_TOMAN);
  });

  it('rejects a value above the permitted maximum rather than silently overflowing', () => {
    expect(() => assertAmount(MAX_AMOUNT_TOMAN + 1)).toThrow(MoneyError);
  });

  it('rejects a fractional amount -- there is no fractional Toman', () => {
    expect(() => assertAmount(1000.5)).toThrow(/integer Toman/);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => assertAmount(Number.NaN)).toThrow(MoneyError);
    expect(() => assertAmount(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it('permits negative amounts (refund reversals are real ledger facts)', () => {
    expect(assertAmount(-250_000)).toBe(-250_000);
  });

  it('rejects a negative amount where the domain forbids one', () => {
    expect(() => assertNonNegativeAmount(-1, 'price')).toThrow(/must not be negative/);
  });
});

describe('money: rounding is symmetric across zero', () => {
  it('rounds a positive half away from zero', () => {
    expect(roundHalf(0.5)).toBe(1);
    expect(roundHalf(2.5)).toBe(3);
  });

  it('rounds a negative half away from zero (Math.round does NOT)', () => {
    expect(roundHalf(-0.5)).toBe(-1);
    expect(roundHalf(-2.5)).toBe(-3);
    expect(Math.round(-0.5)).toBe(-0); // the exact asymmetry this helper exists to avoid
  });

  it('guarantees roundHalf(-x) === -roundHalf(x) for exact halves', () => {
    for (const x of [0.5, 1.5, 2.5, 12345.5]) {
      expect(roundHalf(-x)).toBe(-roundHalf(x));
    }
  });
});

describe('money: percentage and rate validation', () => {
  it('computes an integer-percent rate exactly', () => {
    expect(percentOf(200_000, 1500)).toBe(30_000);
  });

  it('supports a fractional percentage via basis points', () => {
    expect(percentOf(200_000, 1250)).toBe(25_000);
  });

  it('rounds a mid-point percentage half away from zero, symmetrically', () => {
    expect(percentOf(1, 5000)).toBe(1);
    expect(percentOf(-1, 5000)).toBe(-1);
  });

  it('rejects a rate above 100%', () => {
    expect(() => assertRateBasisPoints(10_001)).toThrow(MoneyError);
  });

  it('rejects a non-integer rate', () => {
    expect(() => assertRateBasisPoints(1500.5)).toThrow(MoneyError);
  });

  it('formats basis points for humans', () => {
    expect(formatBasisPoints(1500)).toBe('15%');
    expect(formatBasisPoints(1250)).toBe('12.5%');
  });
});

describe('money: splitExact never loses or invents a Toman', () => {
  const RATE = 1500;

  it('splits a clean amount exactly', () => {
    const { part, remainder } = splitExact(200_000, RATE);
    expect(part).toBe(30_000);
    expect(remainder).toBe(170_000);
    expect(part + remainder).toBe(200_000);
  });

  it('holds the sum invariant for every amount in an exhaustive small range', () => {
    for (let total = 0; total <= 2000; total++) {
      const { part, remainder } = splitExact(total, RATE);
      expect(part + remainder).toBe(total);
    }
  });

  it('holds the sum invariant for negative totals (refund reversal)', () => {
    for (let total = 0; total >= -2000; total--) {
      const { part, remainder } = splitExact(total, RATE);
      expect(part + remainder).toBe(total);
    }
  });

  it('produces the exact negative of the forward split for a full reversal', () => {
    const forward = splitExact(199_999, RATE);
    const reverse = splitExact(-199_999, RATE);
    expect(reverse.part).toBe(-forward.part);
    expect(reverse.remainder).toBe(-forward.remainder);
  });

  it('handles a 0% rate (platform takes nothing)', () => {
    expect(splitExact(150_000, 0)).toEqual({ part: 0, remainder: 150_000 });
  });

  it('handles a 100% rate (platform takes everything)', () => {
    expect(splitExact(150_000, 10_000)).toEqual({ part: 150_000, remainder: 0 });
  });

  it('handles a zero total', () => {
    expect(splitExact(0, RATE)).toEqual({ part: 0, remainder: 0 });
  });

  it('handles a one-Toman total without losing the Toman', () => {
    const { part, remainder } = splitExact(1, RATE);
    expect(part + remainder).toBe(1);
  });
});

describe('money: summation', () => {
  it('sums a list of amounts', () => {
    expect(sumAmounts([100, -40, 5])).toBe(65);
  });

  it('refuses to sum a corrupted value rather than propagating it', () => {
    expect(() => addAmounts(100, 1.5)).toThrow(MoneyError);
  });
});

describe('money: discount clamping', () => {
  it('caps a discount at what is left to discount', () => {
    expect(clampDiscount(500_000, 200_000)).toBe(200_000);
  });

  it('never returns a negative discount', () => {
    expect(clampDiscount(-100, 200_000)).toBe(0);
  });

  it('returns zero once nothing remains', () => {
    expect(clampDiscount(50_000, 0)).toBe(0);
    expect(clampDiscount(50_000, -10)).toBe(0);
  });
});

describe('money: BIGINT transformer (the string-concatenation bug guard)', () => {
  it('reads a driver-supplied string back as a real number', () => {
    const read = requiredMoneyTransformer.from('250000');
    expect(read).toBe(250_000);
    expect(read + read).toBe(500_000);
  });

  it('writes a number out as a string the driver can bind to BIGINT', () => {
    expect(requiredMoneyTransformer.to(250_000)).toBe('250000');
  });

  it('round-trips a negative reversal amount', () => {
    expect(requiredMoneyTransformer.from(requiredMoneyTransformer.to(-30_000))).toBe(-30_000);
  });

  it('passes null through for nullable columns', () => {
    expect(moneyTransformer.to(null)).toBeNull();
    expect(moneyTransformer.from(null)).toBeNull();
  });

  it('throws rather than silently truncating a value beyond the safe range', () => {
    expect(() => requiredMoneyTransformer.from('99999999999999999')).toThrow(MoneyError);
  });
});
