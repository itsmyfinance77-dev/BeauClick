/**
 * The ONE money representation in V3.
 *
 * Decision (Phase 2, ADR-017): amounts are **integer Toman**, stored in
 * `BIGINT` columns, never a float and never a decimal string.
 *
 * Why Toman and not Rial minor units: Iran has no ISO-4217 code for Toman
 * (it is a colloquial Rial/10), and *every* price the product has ever
 * stored, displayed, or reasoned about -- V2's `wp_bc_ledger_entries.amount`,
 * `bc_service` price meta, `formatToman()` in `@beauclick/persian-utils`,
 * every Persian price string a user has ever seen -- is an integer Toman
 * with no subunit. Re-basing to Rial would multiply every historical and
 * conceptual figure by 10 and invite exactly one class of catastrophic
 * off-by-10x bug for zero modelling benefit: Toman has no fractional part
 * in real commerce here, so integer Toman IS the minor unit for this
 * currency in this product.
 *
 * Why BIGINT and not INT: V2 used `INT`, which caps at 2,147,483,647 Toman
 * (~21.5bn Rial). A single large B2B/wholesale order, or a party's lifetime
 * ledger sum, can realistically exceed that. A silent overflow in a ledger
 * is unacceptable, so the column type is widened and the application-level
 * bound below is checked explicitly on every construction.
 */

export const CURRENCY_IRT = 'IRT' as const;
export type CurrencyCode = typeof CURRENCY_IRT;

/**
 * Hard bound on any single amount. Deliberately far below
 * `Number.MAX_SAFE_INTEGER` (2^53-1) so that a *sum* of many amounts still
 * cannot leave the exactly-representable integer range: 1e13 Toman is a
 * hundred trillion Toman, ~7 orders of magnitude above any plausible real
 * transaction, and a billion such rows still sum safely.
 */
export const MAX_AMOUNT_TOMAN = 1_000_000_000_000_0; // 1e13
export const MIN_AMOUNT_TOMAN = -MAX_AMOUNT_TOMAN;

/** Basis points: 1 bp = 0.01%. 10_000 bp = 100%. Rates are stored in bp, never as floats. */
export const BASIS_POINTS_DENOMINATOR = 10_000;

export class MoneyError extends Error {}

/**
 * Every amount entering the domain goes through this. A non-integer, NaN,
 * Infinity, or out-of-bounds value is a programming error, not a business
 * outcome -- it throws rather than silently rounding, because a silently
 * rounded money value is precisely the bug class this module exists to
 * prevent.
 */
export function assertAmount(value: number, label = 'amount'): number {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`${label} must be a finite number, received ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer Toman (no fractional Toman exists), received ${value}`);
  }
  if (value > MAX_AMOUNT_TOMAN || value < MIN_AMOUNT_TOMAN) {
    throw new MoneyError(`${label} ${value} is outside the permitted range [${MIN_AMOUNT_TOMAN}, ${MAX_AMOUNT_TOMAN}]`);
  }
  return value;
}

export function assertNonNegativeAmount(value: number, label = 'amount'): number {
  assertAmount(value, label);
  if (value < 0) {
    throw new MoneyError(`${label} must not be negative, received ${value}`);
  }
  return value;
}

/**
 * Round-half-AWAY-FROM-ZERO, not JavaScript's `Math.round` (which is
 * round-half-UP and therefore asymmetric across zero: Math.round(-0.5) is
 * -0, Math.round(0.5) is 1).
 *
 * Symmetry matters concretely here: a refund reversal must be the exact
 * negative of the split it reverses. With Math.round, a commission of
 * +round(x) would reverse as -round(-x) != -round(x) for exact-half cases,
 * leaving a 1-Toman residue in the ledger. This function makes
 * `roundHalf(-x) === -roundHalf(x)` for every x.
 */
export function roundHalf(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function addAmounts(...values: number[]): number {
  let total = 0;
  for (const v of values) {
    total += assertAmount(v);
  }
  return assertAmount(total, 'sum');
}

export function sumAmounts(values: readonly number[]): number {
  return addAmounts(...values);
}

/** Percentage-of-base, expressed in basis points, rounded half-away-from-zero. */
export function percentOf(base: number, rateBasisPoints: number): number {
  assertAmount(base, 'base');
  assertRateBasisPoints(rateBasisPoints);
  return assertAmount(roundHalf((base * rateBasisPoints) / BASIS_POINTS_DENOMINATOR), 'percentOf result');
}

export function assertRateBasisPoints(rate: number, label = 'rate'): number {
  if (!Number.isInteger(rate)) {
    throw new MoneyError(`${label} must be an integer basis-point value, received ${rate}`);
  }
  if (rate < 0 || rate > BASIS_POINTS_DENOMINATOR) {
    throw new MoneyError(`${label} must be within [0, ${BASIS_POINTS_DENOMINATOR}] basis points, received ${rate}`);
  }
  return rate;
}

export interface ExactSplit {
  /** The proportional part, e.g. the platform's commission. */
  part: number;
  /** Whatever is left, e.g. the professional's receivable. */
  remainder: number;
}

/**
 * Splits `total` into `part` (a basis-point proportion) and `remainder`,
 * with the invariant `part + remainder === total` holding EXACTLY for every
 * input, including negatives.
 *
 * This is V2's proven "exact-sum split discipline" (`LedgerService::
 * record_payment`/`record_refund`) expressed once, in one place, instead of
 * being re-derived at each call site: the remainder is always computed by
 * SUBTRACTION, never by a second independent rounding -- two independent
 * roundings are exactly how a ledger ends up 1 Toman short of the money
 * that actually moved.
 */
export function splitExact(total: number, rateBasisPoints: number): ExactSplit {
  assertAmount(total, 'total');
  assertRateBasisPoints(rateBasisPoints);
  const part = percentOf(total, rateBasisPoints);
  return { part, remainder: assertAmount(total - part, 'remainder') };
}

/** Clamps a discount so it can never exceed what is left to discount, and never goes negative. */
export function clampDiscount(requested: number, remaining: number): number {
  assertAmount(requested, 'requested discount');
  assertAmount(remaining, 'remaining');
  if (requested <= 0) return 0;
  if (remaining <= 0) return 0;
  return Math.min(requested, remaining);
}

/** Basis points rendered for humans/logs: 1500 -> "15%", 1250 -> "12.5%". */
export function formatBasisPoints(rate: number): string {
  const percent = rate / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0$/, '')}%`;
}
