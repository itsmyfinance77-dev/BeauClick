import { assertAmount } from './money';

/**
 * TypeORM `ValueTransformer` for every `BIGINT` money column.
 *
 * The reason this exists at all: node-postgres returns `int8`/`BIGINT` as a
 * **string**, not a number, because a 64-bit integer does not fit in a JS
 * double. Without a transformer, `entry.amount` would be `"250000"` and
 * `entry.amount + other.amount` would silently produce the string
 * `"250000250000"` -- a real, silent, catastrophic money bug that
 * type-checks cleanly (both sides are untyped at the driver boundary).
 *
 * Reading also re-asserts the safe-integer bound, so a value that somehow
 * grew beyond what JS can represent exactly fails loudly at the boundary
 * rather than being silently truncated deep inside a summation.
 */
export const moneyTransformer = {
  to(value: number | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return String(assertAmount(value, 'money column value'));
  },
  from(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return assertAmount(parsed, 'money column value read from database');
  },
};

/** Same contract for non-nullable columns -- keeps the entity property type `number`, not `number | null`. */
export const requiredMoneyTransformer = {
  to(value: number): string {
    return String(assertAmount(value, 'money column value'));
  },
  from(value: string | number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return assertAmount(parsed, 'money column value read from database');
  },
};
