import { z } from 'zod';

/**
 * Shared payload primitives.
 *
 * `uuid()` deliberately accepts any UUID version rather than pinning v7:
 * ids are opaque to consumers, and a contract that rejected a v4 id would
 * fail a legitimate producer for a reason no consumer cares about.
 */
export const uuid = () => z.string().uuid();

/** An ISO-8601 instant, always UTC-serialized by producers. */
export const instant = () => z.string().datetime();

/** Integer Toman. Never a float -- @beauclick/money throws on fractional values, and a payload must not be the one place that relaxes it. */
export const toman = () => z.number().int();

/** Non-negative integer Toman, for amounts a negative value would make meaningless. */
export const positiveToman = () => z.number().int().nonnegative();

export const currency = () => z.literal('IRT');

export const partyType = () => z.enum(['professional', 'business']);

export const orderSourceType = () => z.enum(['booking', 'b2b_quote', 'shop']);
