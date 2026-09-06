/**
 * The collection-only half of a booking's commercial terms — V3.3 Story #83
 * (`#41d-1`), ADR-048 §2, `V33-DEC-029` Ruling 2.
 *
 * Zero dependencies, like every other file in this package. No NestJS, no
 * TypeORM, no entity, no user id, no seller id and no gateway.
 *
 * ## Why this exists beside `BookingCommercialTermsV1` rather than inside it
 *
 * `BookingCommercialTermsV1` requires six values this story does not own:
 * `cancellationCutoffMinutesBeforeStart`,
 * `lateCancellationRetainBasisPointsOfDeposit`,
 * `noShowRetainBasisPointsOfDeposit`, `rescheduleDepositAction` and
 * `disputeWindowMinutes` belong to #42, and `settlementDelayMinutes` to #43. It
 * also requires a non-empty `customerPolicyCopyVersion`, and no approved Persian
 * copy exists anywhere in the repository.
 *
 * An administrator publishing a *collection* policy cannot supply any of them,
 * and filling them with zeros, placeholders or an invented version identifier
 * would put commercial and legal values into code — a zero cutoff and a zero
 * retention are values, and a fabricated copy version is legal metadata.
 * `V33-DEC-028` Ruling 2 forbids both.
 *
 * So this is a **narrower** type, not a replacement. `BookingCommercialTermsV1`,
 * `BookingCommercialPolicySnapshotV1` and `collectionBreakdownV1` are unchanged
 * and still exported; #42 and #43 add their own contracts later, and how the
 * three compose is a decision neither this story nor ADR-048 pre-empts.
 *
 * ## The deposit rule is a discriminated union, so the base cannot be optional
 *
 * `percentageBase` is **structurally absent** from the fixed and no-deposit
 * arms rather than declared optional across all of them. A field that is
 * "optional and required in one case" is a field a caller can omit in the case
 * that needs it and the compiler will not object. The union makes the invalid
 * combination unrepresentable, and the database CHECK proves the same rule
 * against raw SQL (ADR-048 §3).
 *
 * ## `resolvedAt` is not acceptance, and must never be renamed into it
 *
 * It records the instant the SERVER selected a version. `policy_accepted_at` on
 * `commerce.order_payment_schedules` records that a CUSTOMER accepted approved
 * terms. They are different facts with different owners, and `V33-DEC-029`
 * Ruling 3 keeps acceptance null until #42 and Legal supply approved copy and a
 * real acceptance flow. Neither this story nor #104 writes it.
 *
 * ## No commercial value appears below
 *
 * No enabled-mode set, mode default, deposit amount, percentage, minimum,
 * maximum, rounding selection or percentage-base default. Every bound here is a
 * REPRESENTATIONAL guard of the kind `MAX_UNIT_PRICE_TOMAN` already is, and a
 * repository test enforces that against this file.
 */

import { BOOKING_COLLECTION_MODES, BookingCollectionMode } from './commercial-policy-contract';

/** The contract version these collection-only terms are expressed in. */
export const BOOKING_COLLECTION_POLICY_CONTRACT_VERSION = 1 as const;

/**
 * Which authoritative order amount a percentage deposit is computed from.
 *
 * Closed by `V33-DEC-029` Ruling 4 as exactly these two, because exactly these
 * two exist authoritatively at order creation (`priced.subtotalToman` and
 * `priced.totalToman`). The administrator chooses one per percentage policy
 * version; **neither is a default and neither is chosen here.**
 */
export const BOOKING_COLLECTION_PERCENTAGE_BASES = ['service_subtotal', 'service_total'] as const;
export type BookingCollectionPercentageBase = (typeof BOOKING_COLLECTION_PERCENTAGE_BASES)[number];

/** The closed deposit-rule vocabulary. A rule is not a mode (`V33-DEC-028` Ruling 6). */
export const BOOKING_COLLECTION_DEPOSIT_KINDS = ['none', 'fixed', 'percentage'] as const;
export type BookingCollectionDepositKind = (typeof BOOKING_COLLECTION_DEPOSIT_KINDS)[number];

export type NoCollectionDepositRule = Readonly<{ kind: 'none' }>;

export type FixedCollectionDepositRule = Readonly<{
  kind: 'fixed';
  amountToman: number;
}>;

export type PercentageCollectionDepositRule = Readonly<{
  kind: 'percentage';
  basisPoints: number;
  /** Required here and structurally absent from the other two arms. */
  percentageBase: BookingCollectionPercentageBase;
  minimumToman: number;
  maximumToman: number | null;
}>;

export type CollectionDepositRule =
  | NoCollectionDepositRule
  | FixedCollectionDepositRule
  | PercentageCollectionDepositRule;

/**
 * What an administrator publishes: how a booking's service price is collected,
 * and nothing else.
 */
export interface BookingCollectionTermsV1 {
  readonly contractVersion: typeof BOOKING_COLLECTION_POLICY_CONTRACT_VERSION;
  readonly collectionMode: BookingCollectionMode;
  readonly deposit: CollectionDepositRule;
}

/**
 * The exact collection policy a server resolved for one commitment.
 *
 * Carries no identity — no order, seller, customer or administrator. `#41d-2`
 * writes `policyKey` and `policyVersion` onto the order schedule; **this story
 * writes nothing to `commerce` at all.**
 */
export interface BookingCollectionPolicySnapshotV1 {
  readonly policyKey: string;
  readonly policyVersion: number;
  /** When the SERVER selected this version. Never customer acceptance. */
  readonly resolvedAt: string;
  readonly terms: BookingCollectionTermsV1;
}

/** The three amounts a collection rule produces. Identical in shape to `CollectionBreakdownV1`. */
export interface BookingCollectionAmountsV1 {
  readonly serviceTotalToman: number;
  readonly platformCollectibleToman: number;
  readonly venueBalanceToman: number;
}

/**
 * The largest amount this contract will accept.
 *
 * A REPRESENTATIONAL guard, not a product bound, and deliberately the same
 * order of magnitude as `MAX_UNIT_PRICE_TOMAN`: BigInt keeps the percentage
 * arithmetic exact well past it, and the ceiling exists so a corrupt or hostile
 * amount cannot travel silently into an integer column.
 */
export const MAX_COLLECTION_AMOUNT_TOMAN = 10_000_000_000_000;

const POLICY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const BASIS_POINTS_MAX = 10_000;

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedAmount(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && (value as number) <= MAX_COLLECTION_AMOUNT_TOMAN;
}

/** Returns EVERY structural problem, rather than hiding the second behind the first. */
export function validateBookingCollectionTermsV1(terms: BookingCollectionTermsV1): readonly string[] {
  const errors: string[] = [];

  if (terms.contractVersion !== BOOKING_COLLECTION_POLICY_CONTRACT_VERSION) {
    errors.push('contractVersion must be 1');
  }
  if (!(BOOKING_COLLECTION_MODES as readonly string[]).includes(terms.collectionMode)) {
    errors.push('collectionMode is not a v1 mode');
  }

  const deposit = terms.deposit as CollectionDepositRule | undefined;
  if (!deposit || !(BOOKING_COLLECTION_DEPOSIT_KINDS as readonly string[]).includes(deposit.kind)) {
    errors.push('deposit.kind is not a v1 deposit rule');
    return errors;
  }

  // The mode/rule pairing, both ways. A deposit outside deposit mode is a
  // collectible nobody disclosed; deposit mode without one has no amount to
  // collect. `V33-DEC-028` Ruling 6: the rule produces the mode, and the two
  // must agree or the row means nothing.
  if (terms.collectionMode === 'deposit_online_balance_at_venue' && deposit.kind === 'none') {
    errors.push('deposit collection mode requires a deposit rule');
  }
  if (terms.collectionMode !== 'deposit_online_balance_at_venue' && deposit.kind !== 'none') {
    errors.push('a deposit rule is only valid in deposit_online_balance_at_venue mode');
  }

  switch (deposit.kind) {
    case 'none':
      break;
    case 'fixed':
      if (!isBoundedAmount(deposit.amountToman) || deposit.amountToman === 0) {
        errors.push(`fixed deposit amountToman must be a positive integer no greater than ${MAX_COLLECTION_AMOUNT_TOMAN}`);
      }
      break;
    case 'percentage': {
      if (
        !Number.isInteger(deposit.basisPoints) ||
        deposit.basisPoints < 1 ||
        deposit.basisPoints > BASIS_POINTS_MAX
      ) {
        errors.push('percentage deposit basisPoints must be an integer between 1 and 10000');
      }
      if (!(BOOKING_COLLECTION_PERCENTAGE_BASES as readonly string[]).includes(deposit.percentageBase)) {
        errors.push('percentage deposit percentageBase must be service_subtotal or service_total');
      }
      if (!isBoundedAmount(deposit.minimumToman)) {
        errors.push('percentage deposit minimumToman must be a non-negative integer within the amount bound');
      }
      if (deposit.maximumToman !== null && !isBoundedAmount(deposit.maximumToman)) {
        errors.push('percentage deposit maximumToman must be null or a non-negative integer within the amount bound');
      }
      if (
        deposit.maximumToman !== null &&
        isSafeNonNegativeInteger(deposit.minimumToman) &&
        isSafeNonNegativeInteger(deposit.maximumToman) &&
        deposit.maximumToman < deposit.minimumToman
      ) {
        errors.push('percentage deposit maximumToman must not be below minimumToman');
      }
      break;
    }
    default: {
      const exhaustive: never = deposit;
      errors.push(`unsupported deposit kind: ${String(exhaustive)}`);
    }
  }

  return errors;
}

export function validateBookingCollectionPolicySnapshotV1(
  snapshot: BookingCollectionPolicySnapshotV1,
): readonly string[] {
  const errors = [...validateBookingCollectionTermsV1(snapshot.terms)];
  if (typeof snapshot.policyKey !== 'string' || !POLICY_KEY_PATTERN.test(snapshot.policyKey)) {
    errors.push('policyKey must be 1-64 characters of [A-Za-z0-9_-] starting with a letter');
  }
  if (!Number.isSafeInteger(snapshot.policyVersion) || snapshot.policyVersion < 1) {
    errors.push('policyVersion must be a positive safe integer');
  }
  if (typeof snapshot.resolvedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.resolvedAt))) {
    errors.push('resolvedAt must be an ISO-compatible instant');
  }
  return errors;
}

/**
 * Computes what is collected where, from the two authoritative order amounts.
 *
 * Takes BOTH amounts rather than one, because the administrator — not this
 * function and not its caller — chose which is the base. Passing only the
 * chosen amount would move the choice to the call site, which is exactly the
 * gap `V33-DEC-029` Ruling 4 exists to close.
 *
 * The order of operations is binding (ADR-048 §2) and is the same one
 * `collectionBreakdownV1` already uses:
 *
 *   1. select the administrator-published base;
 *   2. BigInt floor division, so rounding can never collect MORE than the
 *      stated proportion;
 *   3. clamp up to the minimum;
 *   4. clamp down to the maximum, when one is published;
 *   5. clamp down to the service TOTAL, always and last, so the platform can
 *      never record collecting more than the disclosed price — the invariant
 *      `ck_ops_sum` also enforces in the database.
 *
 * Step 5 is last on purpose: a minimum above the service total must lose to the
 * total, not win over it.
 */
export function bookingCollectionAmountsV1(
  serviceSubtotalToman: number,
  serviceTotalToman: number,
  terms: BookingCollectionTermsV1,
): BookingCollectionAmountsV1 {
  if (!isBoundedAmount(serviceSubtotalToman)) {
    throw new Error(`serviceSubtotalToman must be a non-negative integer no greater than ${MAX_COLLECTION_AMOUNT_TOMAN}`);
  }
  if (!isBoundedAmount(serviceTotalToman)) {
    throw new Error(`serviceTotalToman must be a non-negative integer no greater than ${MAX_COLLECTION_AMOUNT_TOMAN}`);
  }
  const problems = validateBookingCollectionTermsV1(terms);
  if (problems.length > 0) throw new Error(`Invalid collection terms: ${problems.join('; ')}`);

  let platformCollectibleToman = 0;

  if (terms.collectionMode === 'full_payment_online') {
    platformCollectibleToman = serviceTotalToman;
  }

  if (terms.collectionMode === 'deposit_online_balance_at_venue') {
    const deposit = terms.deposit;
    if (deposit.kind === 'fixed') {
      platformCollectibleToman = deposit.amountToman;
    }
    if (deposit.kind === 'percentage') {
      const base =
        deposit.percentageBase === 'service_subtotal' ? serviceSubtotalToman : serviceTotalToman;
      // Both operands are safe integers, but their product need not be. BigInt
      // keeps the floor division exact at the contract's maximum amount.
      const proportional = Number((BigInt(base) * BigInt(deposit.basisPoints)) / 10_000n);
      const atLeastMinimum = Math.max(proportional, deposit.minimumToman);
      platformCollectibleToman =
        deposit.maximumToman === null ? atLeastMinimum : Math.min(atLeastMinimum, deposit.maximumToman);
    }
    platformCollectibleToman = Math.min(platformCollectibleToman, serviceTotalToman);
  }

  return {
    serviceTotalToman,
    platformCollectibleToman,
    venueBalanceToman: serviceTotalToman - platformCollectibleToman,
  };
}
