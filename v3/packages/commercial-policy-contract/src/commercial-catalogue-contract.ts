/**
 * The browser-safe half of ADR-041's plan and price catalogue.
 *
 * Zero dependencies, exactly like `commercial-policy-contract.ts` beside it. No
 * NestJS, TypeORM, entity, user id, seller id, subscription, gateway or
 * production enablement flag. The page and the server share the vocabulary and
 * the arithmetic; neither may use this package to move money, infer ownership,
 * or discover who published anything.
 *
 * ## There is no default in this file, and that is the point
 *
 * `V33-DEC-009`: no allowance, INCLUDING 200, may exist as a code constant,
 * default, fallback or seed, and an unconfigured plan or price schedule must
 * refuse safely rather than fall back. So every term below is a REQUIRED input
 * validated on the way in, never a value with a fallback — the bounds that do
 * appear (`MAX_CATALOGUE_QUANTITY`, `MAX_UNIT_PRICE_TOMAN`) are
 * representational limits of the storage, in the same sense
 * `@beauclick/money`'s `MAX_AMOUNT_TOMAN` is, and neither is a price or an
 * allowance a deployment could inherit.
 *
 * The commercial VALUES — prices, included allowances, seats, locations,
 * capability bundles, billing terms, minimum and maximum custom quantities,
 * tier boundaries and presets — remain open under #46 and appear nowhere here.
 */

export const COMMERCIAL_CATALOGUE_CONTRACT_VERSION = 1 as const;

/**
 * `draft -> published -> retired`, one way, no return (`V33-DEC-009`).
 *
 * A retired version can neither be reactivated nor edited; restoring earlier
 * terms requires a new version. The database enforces the same allow-list in a
 * trigger, because a lifecycle upheld only by the service is upheld by the
 * service and by nothing else.
 */
export const CATALOGUE_LIFECYCLE_STATES = ['draft', 'published', 'retired'] as const;
export type CatalogueLifecycleState = (typeof CATALOGUE_LIFECYCLE_STATES)[number];

/**
 * Written as an allow-list rather than as a list of refusals, so a fourth state
 * added later is refused by default rather than silently permitted from and to
 * everywhere.
 */
const PERMITTED_TRANSITIONS: Readonly<Record<CatalogueLifecycleState, readonly CatalogueLifecycleState[]>> = {
  draft: ['published'],
  published: ['retired'],
  retired: [],
};

export function isPermittedLifecycleTransition(
  from: CatalogueLifecycleState,
  to: CatalogueLifecycleState,
): boolean {
  return (PERMITTED_TRANSITIONS[from] ?? []).includes(to);
}

/** What a price schedule prices. Part of a schedule key's identity, never of a version. */
export const PRICE_SCHEDULE_PURPOSES = ['seller_plan', 'booking_credit'] as const;
export type PriceSchedulePurpose = (typeof PRICE_SCHEDULE_PURPOSES)[number];

/**
 * Admits `D-7`, which `V33-DEC-009` fixes as the base workspace's key.
 *
 * Deliberately wider than the platform's other stable-key pattern
 * (`^[a-z][a-z0-9_]{0,63}$`, which rejects both the uppercase letter and the
 * hyphen): the ratified identifier is accommodated rather than silently
 * rewritten to suit a convention. The database CHECK carries the same pattern.
 */
export const CATALOGUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** A feature entitlement key. The platform's ordinary stable-key shape. */
export const CAPABILITY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * `V33-DEC-009`: currency is IRT only unless a later owner decision widens it.
 * Widening is a migration and a decision, never a string a caller supplies.
 */
export const COMMERCIAL_CURRENCY = 'IRT' as const;
export type CommercialCurrency = typeof COMMERCIAL_CURRENCY;

/**
 * Representational bounds, not commercial ones.
 *
 * `MAX_CATALOGUE_QUANTITY` is what the stored `int4range` can express without
 * `max_quantity + 1` overflowing int4. `MAX_UNIT_PRICE_TOMAN` is
 * `@beauclick/money`'s own absolute bound, restated here because this package
 * may not import it (zero dependencies) and a price a sum could not represent
 * is a corrupt row rather than an expensive plan.
 */
export const MAX_CATALOGUE_QUANTITY = 1_000_000_000;
export const MAX_UNIT_PRICE_TOMAN = 10_000_000_000_000;

/** One quantity range and its integer unit price. `maxQuantity: null` is unbounded above. */
export interface PriceTierV1 {
  readonly minQuantity: number;
  readonly maxQuantity: number | null;
  readonly unitPriceToman: number;
}

/**
 * A price schedule version's terms.
 *
 * A FLAT PRICE IS A ONE-TIER SCHEDULE (`V33-DEC-009`). There is no scalar price
 * anywhere in this contract, so there is no second, simpler pricing mechanism
 * that later has to grow tiers.
 */
export interface PriceScheduleTermsV1 {
  readonly currency: CommercialCurrency;
  readonly minPurchaseQuantity: number;
  readonly maxPurchaseQuantity: number;
  /** Presentation only, never a contract limit. Values are open under #46. */
  readonly uiPresetQuantities: readonly number[];
  readonly tiers: readonly PriceTierV1[];
}

/** A plan version's terms. Every field is required; none has a default. */
export interface PlanVersionTermsV1 {
  readonly displayName: string;
  /** `null` means no recurring term — not zero, which reads as "renews immediately". */
  readonly billingTermDays: number | null;
  readonly includedBookingCredits: number;
  readonly staffSeats: number;
  readonly includedLocations: number;
  readonly capabilityKeys: readonly string[];
}

/** The exact price facts a later purchase would snapshot. Contains no identity. */
export interface PriceQuoteV1 {
  readonly quantity: number;
  readonly unitPriceToman: number;
  readonly totalToman: number;
  readonly currency: CommercialCurrency;
  readonly tier: PriceTierV1;
}

/**
 * Why a price could not be resolved.
 *
 * A closed vocabulary, so a caller branches on a member rather than on a
 * message, and so a refusal never carries catalogue internals.
 */
export const PRICE_RESOLUTION_REFUSALS = [
  /** No schedule version is published and active for the requested instant. */
  'schedule_not_configured',
  /** The schedule exists but its tiers do not cover its own bounds. */
  'schedule_incomplete',
  /** The quantity is outside the schedule's own purchasable bounds. */
  'quantity_out_of_bounds',
] as const;
export type PriceResolutionRefusal = (typeof PRICE_RESOLUTION_REFUSALS)[number];

export class PriceResolutionError extends Error {
  readonly refusal: PriceResolutionRefusal;

  constructor(refusal: PriceResolutionRefusal, detail: string) {
    super(detail);
    this.name = 'PriceResolutionError';
    this.refusal = refusal;
  }
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Returns every structural problem, rather than hiding the second behind the first. */
export function validatePlanVersionTermsV1(terms: PlanVersionTermsV1): readonly string[] {
  const errors: string[] = [];

  if (typeof terms.displayName !== 'string' || terms.displayName.trim().length === 0) {
    errors.push('displayName must be a non-empty string');
  } else if (terms.displayName.length > 120) {
    errors.push('displayName must be at most 120 characters');
  }

  if (terms.billingTermDays !== null && !(isSafePositiveInteger(terms.billingTermDays) && terms.billingTermDays <= 3660)) {
    errors.push('billingTermDays must be null or a positive integer of at most 3660 days');
  }

  for (const [name, value, max] of [
    ['includedBookingCredits', terms.includedBookingCredits, MAX_CATALOGUE_QUANTITY],
    ['staffSeats', terms.staffSeats, 1_000_000],
    ['includedLocations', terms.includedLocations, 1_000_000],
  ] as const) {
    if (!isSafeNonNegativeInteger(value) || value > max) {
      errors.push(`${name} must be a non-negative integer of at most ${max}`);
    }
  }

  if (!Array.isArray(terms.capabilityKeys)) {
    errors.push('capabilityKeys must be an array');
  } else {
    if (terms.capabilityKeys.some((key) => typeof key !== 'string' || !CAPABILITY_KEY_PATTERN.test(key))) {
      errors.push('every capabilityKey must be a stable lowercase key');
    }
    if (new Set(terms.capabilityKeys).size !== terms.capabilityKeys.length) {
      errors.push('capabilityKeys must not repeat a key');
    }
  }

  return errors;
}

/**
 * Proves a schedule is complete, non-overlapping and internally consistent.
 *
 * All four properties, because a schedule that satisfies three of them is one a
 * resolution can still fall through:
 *
 *  1. at least one tier — a flat price is a one-tier schedule, not an empty one;
 *  2. no overlap — two tiers claiming one quantity have no defined price;
 *  3. no gap — every tier begins exactly where the previous one ended;
 *  4. full coverage — the tiers span the schedule's own purchasable bounds.
 *
 * The database enforces (2) with an exclusion constraint and (1), (3) and (4)
 * in the publication trigger. This function is what lets the service refuse
 * with a readable message first; it is not what makes the guarantee true.
 */
export function validatePriceScheduleTermsV1(terms: PriceScheduleTermsV1): readonly string[] {
  const errors: string[] = [];

  if (terms.currency !== COMMERCIAL_CURRENCY) {
    errors.push(`currency must be ${COMMERCIAL_CURRENCY}`);
  }

  const boundsUsable =
    isSafePositiveInteger(terms.minPurchaseQuantity) &&
    isSafePositiveInteger(terms.maxPurchaseQuantity) &&
    terms.maxPurchaseQuantity <= MAX_CATALOGUE_QUANTITY &&
    terms.maxPurchaseQuantity >= terms.minPurchaseQuantity;

  if (!boundsUsable) {
    errors.push(
      `minPurchaseQuantity and maxPurchaseQuantity must be positive integers with max >= min and max <= ${MAX_CATALOGUE_QUANTITY}`,
    );
  }

  if (!Array.isArray(terms.uiPresetQuantities)) {
    errors.push('uiPresetQuantities must be an array');
  } else {
    if (terms.uiPresetQuantities.some((q) => !isSafePositiveInteger(q) || q > MAX_CATALOGUE_QUANTITY)) {
      errors.push('every uiPresetQuantity must be a positive integer within the catalogue bound');
    }
    if (new Set(terms.uiPresetQuantities).size !== terms.uiPresetQuantities.length) {
      errors.push('uiPresetQuantities must not repeat a quantity');
    }
  }

  if (!Array.isArray(terms.tiers) || terms.tiers.length === 0) {
    errors.push('a schedule needs at least one tier: a flat price is a one-tier schedule, not an empty one');
    return errors;
  }

  for (const tier of terms.tiers) {
    if (!isSafePositiveInteger(tier.minQuantity) || tier.minQuantity > MAX_CATALOGUE_QUANTITY) {
      errors.push('every tier minQuantity must be a positive integer within the catalogue bound');
    }
    if (
      tier.maxQuantity !== null &&
      (!isSafePositiveInteger(tier.maxQuantity) || tier.maxQuantity > MAX_CATALOGUE_QUANTITY)
    ) {
      errors.push('every tier maxQuantity must be null or a positive integer within the catalogue bound');
    }
    if (
      tier.maxQuantity !== null &&
      isSafePositiveInteger(tier.minQuantity) &&
      isSafePositiveInteger(tier.maxQuantity) &&
      tier.maxQuantity < tier.minQuantity
    ) {
      errors.push('a tier maxQuantity must not be below its minQuantity');
    }
    if (!isSafeNonNegativeInteger(tier.unitPriceToman) || tier.unitPriceToman > MAX_UNIT_PRICE_TOMAN) {
      errors.push('every tier unitPriceToman must be a non-negative integer within the money bound');
    }
  }

  if (errors.length > 0) return errors;

  const ordered = [...terms.tiers].sort((a, b) => a.minQuantity - b.minQuantity);

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.maxQuantity === null) {
      errors.push('only the highest tier may be unbounded above');
      continue;
    }
    if (current.minQuantity <= previous.maxQuantity) {
      errors.push(`tiers overlap between quantity ${current.minQuantity} and ${previous.maxQuantity}`);
    } else if (current.minQuantity !== previous.maxQuantity + 1) {
      errors.push(`tiers leave a gap between quantity ${previous.maxQuantity + 1} and ${current.minQuantity - 1}`);
    }
  }

  if (boundsUsable) {
    const lowest = ordered[0];
    const highest = ordered[ordered.length - 1];
    if (lowest.minQuantity !== terms.minPurchaseQuantity) {
      errors.push(`tiers must start at minPurchaseQuantity (${terms.minPurchaseQuantity}), they start at ${lowest.minQuantity}`);
    }
    if (highest.maxQuantity !== null && highest.maxQuantity < terms.maxPurchaseQuantity) {
      errors.push(
        `tiers must cover maxPurchaseQuantity (${terms.maxPurchaseQuantity}), the highest ends at ${highest.maxQuantity}`,
      );
    }
  }

  return errors;
}

/**
 * The exact price of a quantity, or a typed refusal.
 *
 * NO FALLBACK. There is no default tier, no nearest match, and no zero returned
 * where a price is missing — an incomplete schedule refuses, which is
 * `V33-DEC-009`'s "an unconfigured plan or price schedule refuses safely rather
 * than falling back" made executable.
 *
 * Integer arithmetic only. The total is computed with BigInt because
 * `quantity × unitPrice` need not be a safe integer even when both operands
 * are: at the contract's own bounds the product exceeds 2^53, and a silently
 * rounded money value is precisely the bug class `@beauclick/money` exists to
 * prevent.
 */
export function resolvePriceV1(terms: PriceScheduleTermsV1, quantity: number): PriceQuoteV1 {
  const problems = validatePriceScheduleTermsV1(terms);
  if (problems.length > 0) {
    throw new PriceResolutionError('schedule_incomplete', `Price schedule is not resolvable: ${problems.join('; ')}`);
  }

  if (!isSafePositiveInteger(quantity)) {
    throw new PriceResolutionError('quantity_out_of_bounds', 'quantity must be a positive integer');
  }
  if (quantity < terms.minPurchaseQuantity || quantity > terms.maxPurchaseQuantity) {
    throw new PriceResolutionError(
      'quantity_out_of_bounds',
      `quantity ${quantity} is outside the schedule's bounds [${terms.minPurchaseQuantity}, ${terms.maxPurchaseQuantity}]`,
    );
  }

  const tier = terms.tiers.find(
    (candidate) => quantity >= candidate.minQuantity && (candidate.maxQuantity === null || quantity <= candidate.maxQuantity),
  );

  // Unreachable while the schedule validates: coverage and contiguity above
  // guarantee a tier for every quantity inside the bounds. Kept because
  // "unreachable" is a claim about the code above, and a refusal is a better
  // failure than an undefined dereference if that claim ever stops holding.
  if (!tier) {
    throw new PriceResolutionError('schedule_incomplete', `no tier covers quantity ${quantity}`);
  }

  const total = BigInt(quantity) * BigInt(tier.unitPriceToman);
  if (total > BigInt(MAX_UNIT_PRICE_TOMAN)) {
    throw new PriceResolutionError(
      'quantity_out_of_bounds',
      'the resolved total exceeds the representable money bound',
    );
  }

  return Object.freeze({
    quantity,
    unitPriceToman: tier.unitPriceToman,
    totalToman: Number(total),
    currency: COMMERCIAL_CURRENCY,
    tier: Object.freeze({ ...tier }),
  });
}
