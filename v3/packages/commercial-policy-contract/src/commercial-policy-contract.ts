/**
 * The browser-safe half of ADR-039's commercial policy control plane.
 *
 * Zero dependencies. No NestJS, TypeORM, Zod, entity, user id, seller id,
 * gateway, subscription price, commission rate or production enablement flag.
 * The page and the server may share the terms a customer sees and accepts; they
 * may not use this package to move money or infer ownership.
 */

export const COMMERCIAL_POLICY_CONTRACT_VERSION = 1 as const;

/** The only ways v1 says a booking's service price may be collected. */
export const BOOKING_COLLECTION_MODES = [
  'pay_at_venue',
  'deposit_online_balance_at_venue',
  'full_payment_online',
] as const;
export type BookingCollectionMode = (typeof BOOKING_COLLECTION_MODES)[number];

/** A deposit is part of the service price, never a fee or discount. */
export type NoDepositTerms = Readonly<{ kind: 'none' }>;
export type FixedDepositTerms = Readonly<{ kind: 'fixed'; amountToman: number }>;
export type PercentageDepositTerms = Readonly<{
  kind: 'percentage';
  basisPoints: number;
  minimumToman: number;
  maximumToman: number | null;
}>;
export type DepositTerms = NoDepositTerms | FixedDepositTerms | PercentageDepositTerms;

export const RESCHEDULE_DEPOSIT_ACTIONS = ['transfer_deposit', 'refund_deposit'] as const;
export type RescheduleDepositAction = (typeof RESCHEDULE_DEPOSIT_ACTIONS)[number];

/**
 * Numeric policy values are deliberately not product defaults.
 *
 * They are values in an immutable policy version. #46 approves the allowed
 * ranges and defaults before a production policy may be registered.
 */
export interface BookingCommercialTermsV1 {
  readonly contractVersion: typeof COMMERCIAL_POLICY_CONTRACT_VERSION;
  readonly collectionMode: BookingCollectionMode;
  readonly deposit: DepositTerms;
  readonly cancellationCutoffMinutesBeforeStart: number;
  readonly lateCancellationRetainBasisPointsOfDeposit: number;
  readonly noShowRetainBasisPointsOfDeposit: number;
  readonly providerCancellationRefundBasisPointsOfDeposit: 10_000;
  readonly platformFaultRefundBasisPointsOfDeposit: 10_000;
  readonly rescheduleDepositAction: RescheduleDepositAction;
  readonly disputeWindowMinutes: number;
  readonly settlementDelayMinutes: number;
  readonly customerPolicyCopyVersion: string;
}

/**
 * The exact policy facts accepted for one booking.
 *
 * Contains no identity. The booking id, customer and authoritative seller party
 * belong to their owning domains and composition adapters, not to a browser-safe
 * terms object.
 */
export interface BookingCommercialPolicySnapshotV1 {
  readonly policyKey: string;
  readonly policyVersion: number;
  readonly acceptedAt: string;
  readonly terms: BookingCommercialTermsV1;
}

export interface CollectionBreakdownV1 {
  readonly serviceTotalToman: number;
  readonly platformCollectibleToman: number;
  readonly venueBalanceToman: number;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const COPY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBasisPoints(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000;
}

/** Returns every structural problem, rather than hiding the second behind the first. */
export function validateBookingCommercialTermsV1(terms: BookingCommercialTermsV1): readonly string[] {
  const errors: string[] = [];

  if (terms.contractVersion !== COMMERCIAL_POLICY_CONTRACT_VERSION) errors.push('contractVersion must be 1');
  if (!(BOOKING_COLLECTION_MODES as readonly string[]).includes(terms.collectionMode)) {
    errors.push('collectionMode is not a v1 mode');
  }

  if (terms.collectionMode === 'deposit_online_balance_at_venue' && terms.deposit.kind === 'none') {
    errors.push('deposit collection mode requires deposit terms');
  }
  if (terms.collectionMode !== 'deposit_online_balance_at_venue' && terms.deposit.kind !== 'none') {
    errors.push('a deposit is only valid in deposit_online_balance_at_venue mode');
  }

  switch (terms.deposit.kind) {
    case 'none':
      break;
    case 'fixed':
      if (!isSafeNonNegativeInteger(terms.deposit.amountToman) || terms.deposit.amountToman === 0) {
        errors.push('fixed deposit amountToman must be a positive safe integer');
      }
      break;
    case 'percentage':
      if (!isBasisPoints(terms.deposit.basisPoints) || terms.deposit.basisPoints === 0) {
        errors.push('percentage deposit basisPoints must be between 1 and 10000');
      }
      if (!isSafeNonNegativeInteger(terms.deposit.minimumToman)) {
        errors.push('percentage deposit minimumToman must be a non-negative safe integer');
      }
      if (terms.deposit.maximumToman !== null && !isSafeNonNegativeInteger(terms.deposit.maximumToman)) {
        errors.push('percentage deposit maximumToman must be null or a non-negative safe integer');
      }
      if (
        terms.deposit.maximumToman !== null &&
        isSafeNonNegativeInteger(terms.deposit.minimumToman) &&
        isSafeNonNegativeInteger(terms.deposit.maximumToman) &&
        terms.deposit.maximumToman < terms.deposit.minimumToman
      ) {
        errors.push('percentage deposit maximumToman must not be below minimumToman');
      }
      break;
    default: {
      const exhaustive: never = terms.deposit;
      return [...errors, `unsupported deposit kind: ${String(exhaustive)}`];
    }
  }

  for (const [name, value] of [
    ['cancellationCutoffMinutesBeforeStart', terms.cancellationCutoffMinutesBeforeStart],
    ['disputeWindowMinutes', terms.disputeWindowMinutes],
    ['settlementDelayMinutes', terms.settlementDelayMinutes],
  ] as const) {
    if (!isSafeNonNegativeInteger(value)) errors.push(`${name} must be a non-negative safe integer`);
  }

  for (const [name, value] of [
    ['lateCancellationRetainBasisPointsOfDeposit', terms.lateCancellationRetainBasisPointsOfDeposit],
    ['noShowRetainBasisPointsOfDeposit', terms.noShowRetainBasisPointsOfDeposit],
    ['providerCancellationRefundBasisPointsOfDeposit', terms.providerCancellationRefundBasisPointsOfDeposit],
    ['platformFaultRefundBasisPointsOfDeposit', terms.platformFaultRefundBasisPointsOfDeposit],
  ] as const) {
    if (!isBasisPoints(value)) errors.push(`${name} must be between 0 and 10000`);
  }

  if (terms.providerCancellationRefundBasisPointsOfDeposit !== 10_000) {
    errors.push('provider cancellation must refund 10000 basis points of the deposit');
  }
  if (terms.platformFaultRefundBasisPointsOfDeposit !== 10_000) {
    errors.push('platform fault must refund 10000 basis points of the deposit');
  }
  if (!(RESCHEDULE_DEPOSIT_ACTIONS as readonly string[]).includes(terms.rescheduleDepositAction)) {
    errors.push('rescheduleDepositAction is not a v1 action');
  }
  if (!COPY_VERSION_PATTERN.test(terms.customerPolicyCopyVersion)) {
    errors.push('customerPolicyCopyVersion must be 1-64 safe version characters');
  }

  return errors;
}

export function validateBookingCommercialPolicySnapshotV1(
  snapshot: BookingCommercialPolicySnapshotV1,
): readonly string[] {
  const errors = [...validateBookingCommercialTermsV1(snapshot.terms)];
  if (!KEY_PATTERN.test(snapshot.policyKey)) errors.push('policyKey must be a stable lowercase key');
  if (!Number.isSafeInteger(snapshot.policyVersion) || snapshot.policyVersion < 1) {
    errors.push('policyVersion must be a positive safe integer');
  }
  if (!Number.isFinite(Date.parse(snapshot.acceptedAt))) errors.push('acceptedAt must be an ISO-compatible instant');
  return errors;
}

/**
 * Computes what is collected where, without moving money.
 *
 * Integer arithmetic only. Percentage deposits use floor division so the
 * platform never collects more than the stated proportion because of rounding.
 */
export function collectionBreakdownV1(
  serviceTotalToman: number,
  terms: BookingCommercialTermsV1,
): CollectionBreakdownV1 {
  if (!isSafeNonNegativeInteger(serviceTotalToman)) throw new Error('serviceTotalToman must be a non-negative safe integer');
  const problems = validateBookingCommercialTermsV1(terms);
  if (problems.length > 0) throw new Error(`Invalid commercial terms: ${problems.join('; ')}`);

  let platformCollectibleToman = 0;
  if (terms.collectionMode === 'full_payment_online') platformCollectibleToman = serviceTotalToman;
  if (terms.collectionMode === 'deposit_online_balance_at_venue') {
    if (terms.deposit.kind === 'fixed') platformCollectibleToman = Math.min(serviceTotalToman, terms.deposit.amountToman);
    if (terms.deposit.kind === 'percentage') {
      // Both inputs are safe integers, but their product need not be. BigInt
      // preserves exact floor division even at the contract's maximum amount.
      const proportional = Number(
        (BigInt(serviceTotalToman) * BigInt(terms.deposit.basisPoints)) / 10_000n,
      );
      const boundedBelow = Math.max(proportional, terms.deposit.minimumToman);
      const bounded = terms.deposit.maximumToman === null ? boundedBelow : Math.min(boundedBelow, terms.deposit.maximumToman);
      platformCollectibleToman = Math.min(serviceTotalToman, bounded);
    }
  }

  return {
    serviceTotalToman,
    platformCollectibleToman,
    venueBalanceToman: serviceTotalToman - platformCollectibleToman,
  };
}

/**
 * The browser-safe projection of one order's collection schedule — V3.3 `#41a`,
 * ADR-043 §8.
 *
 * ## Why it lives in the contract and not in a controller
 *
 * The three amounts are the same three facts `CollectionBreakdownV1` already
 * names, so their shape belongs beside it: a projection type declared in a
 * controller would be a second place the vocabulary could drift, which
 * `V33-DEC-022` Ruling 2 forbids. This package stays zero-dependency, so the
 * API and the web client can both import it without either depending on the
 * other.
 *
 * ## `platformCollectibleNowToman`, not `platformCollectibleToman`
 *
 * The `Now` is load-bearing at the boundary and absent inside. Internally the
 * field is a property of the snapshot; to a customer reading a receipt it
 * answers "what am I paying right now, as opposed to at the venue", which is
 * the question the field exists to settle. #41's own acceptance criteria use
 * this name.
 *
 * ## What is deliberately absent
 *
 * No policy internals. `policyKey`, `policyVersion` and `policyAcceptedAt` are
 * administrative facts about which published terms were selected; a customer's
 * receipt shows the AMOUNTS those terms produced, not the terms' identity. The
 * same line `SellerCommercialPlansController` draws for the plan catalogue.
 *
 * ## The client never computes the split
 *
 * All three amounts are served. A client that can derive one from the others
 * can derive it wrongly — from a stale total, a rounded percentage, or a
 * currency assumption — and would then display a number the server never
 * agreed to.
 */
export interface OrderPaymentScheduleViewV1 {
  readonly collectionMode: BookingCollectionMode;
  readonly serviceTotalToman: number;
  readonly platformCollectibleNowToman: number;
  readonly venueBalanceToman: number;
}
