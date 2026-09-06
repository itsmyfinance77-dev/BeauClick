import { COMMERCIAL_CURRENCY, CommercialCurrency, MAX_CATALOGUE_QUANTITY, PriceQuoteV1 } from './commercial-catalogue-contract';

/**
 * The custom booking-credit purchase contract — V3.3 #57 (`#40c-1`),
 * ADR-047, `V33-DEC-026` and `V33-DEC-027`.
 *
 * ## Zero dependencies, like everything else in this package
 *
 * No framework, no ORM, no `Date` in a payload. Instants cross this boundary as
 * ISO-8601 strings so the same shapes compile in a browser bundle, which is the
 * property that lets a client render a quote without importing the server.
 *
 * ## What this file does NOT contain
 *
 * No price, tier, quantity bound, preset, allowance, expiry or schedule key.
 * `V33-DEC-009` forbids a commercial value existing as a code constant, default,
 * fallback or seed, and `V33-DEC-027` R9 restates it for this story: every
 * number here is representational, and every commercial number comes from the
 * administrator's published schedule at run time.
 */

/* ==========================================================================
 * The identity-bound quote
 * ========================================================================== */

/**
 * Which catalogue rows a quote was computed from.
 *
 * `resolvePriceV1` is a pure function of VALUES — tier bounds and a unit price —
 * and cannot know which rows those came from. Rather than making it return
 * optional ids it can never fill, identity is a separate fact the service
 * attaches from the rows it actually read.
 *
 * The distinction is load-bearing for the snapshot: a purchase records the exact
 * version and tier it was priced by, so a later repricing of the same schedule
 * key is provably invisible to it (`V33-DEC-027` R4).
 */
export interface PriceSourceIdentityV1 {
  /** The stable key the subscription is bound to. */
  readonly scheduleKey: string;
  /** The version of that key that was published and active at `resolvedAt`. */
  readonly scheduleVersionId: string;
  /** The tier within that version that covers the quantity. */
  readonly tierId: string;
  /** The single captured instant the resolution was performed at, ISO-8601 UTC. */
  readonly resolvedAt: string;
}

/**
 * A price, and the exact rows it came from.
 *
 * Every identity field is required. An optional id here would be an invitation
 * to write a purchase snapshot that cannot say what it was priced by, which is
 * the one thing the snapshot exists to say.
 */
export interface ResolvedPriceQuoteV1 extends PriceQuoteV1, PriceSourceIdentityV1 {}

/**
 * Compose a pure quote with the identity of the rows it was computed from.
 *
 * Pure, total and frozen. It fabricates nothing: every field comes from one of
 * its two arguments, so a caller that does not know a real `tierId` cannot
 * produce a `ResolvedPriceQuoteV1` at all.
 */
export function attachPriceIdentityV1(
  quote: PriceQuoteV1,
  identity: PriceSourceIdentityV1,
): ResolvedPriceQuoteV1 {
  return Object.freeze({
    quantity: quote.quantity,
    unitPriceToman: quote.unitPriceToman,
    totalToman: quote.totalToman,
    currency: quote.currency,
    tier: quote.tier,
    scheduleKey: identity.scheduleKey,
    scheduleVersionId: identity.scheduleVersionId,
    tierId: identity.tierId,
    resolvedAt: identity.resolvedAt,
  });
}

/* ==========================================================================
 * Lifecycle
 * ========================================================================== */

/**
 * The purchase lifecycle, exactly as `V33-DEC-026` R2 ratified it.
 *
 * **Neither state confers entitlement**, and Story #57 contains no code path
 * that writes a booking-credit grant. `paid` is #99's to add, together with the
 * verified payment fact that would justify it — a third member here today would
 * be a state nothing can reach and nothing may honour.
 */
export const CREDIT_PURCHASE_STATES = ['awaiting_payment', 'abandoned'] as const;
export type CreditPurchaseState = (typeof CREDIT_PURCHASE_STATES)[number];

/* ==========================================================================
 * The public refusal
 * ========================================================================== */

/**
 * The single public refusal for every pricing cause.
 *
 * A null binding, a missing schedule, a wrong-purpose schedule, no active
 * published version, incomplete tiers, an out-of-bounds quantity and a
 * concurrent catalogue change are all THIS, and are indistinguishable to a
 * caller — so the catalogue cannot be enumerated through refusals
 * (`V33-DEC-026` R8, `V33-DEC-027` R6).
 *
 * ## Why it is lower-case when every other code in this repository is not
 *
 * Because `V33-DEC-026` Ruling 8 spelled it that way, and on a ratified
 * contract the register is the authority. Recorded here and in ADR-047 §8 so it
 * reads as a decision rather than as an oversight somebody should tidy.
 */
export const PURCHASE_UNAVAILABLE = 'purchase_unavailable' as const;
export type PurchaseUnavailableCode = typeof PURCHASE_UNAVAILABLE;

/* ==========================================================================
 * Seller-facing response shapes
 * ========================================================================== */

/**
 * What a quote returns.
 *
 * The schedule key, version id and tier id are **absent** on purpose. They are
 * catalogue internals; a seller is told what a quantity costs, not which
 * administrative rows decided it. The snapshot on the server records all three.
 */
export interface CreditPurchaseQuoteViewV1 {
  readonly quantity: number;
  readonly unitPriceToman: number;
  readonly totalToman: number;
  readonly currency: CommercialCurrency;
}

/**
 * What a created or listed purchase returns.
 *
 * `requestKey` and `requestedByUserId` are absent: the first is the caller's own
 * protocol token and echoing it adds nothing, the second is an actor identity
 * that belongs in the audit trail rather than in a listing.
 */
export interface CreditPurchaseViewV1 {
  readonly purchaseId: string;
  readonly quantity: number;
  readonly unitPriceToman: number;
  readonly totalToman: number;
  readonly currency: CommercialCurrency;
  readonly state: CreditPurchaseState;
  /** ISO-8601 UTC. The instant the price was resolved at. */
  readonly effectiveAt: string;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
}

/* ==========================================================================
 * Representational limits — technical, never commercial
 * ========================================================================== */

/**
 * The largest quantity that can be REPRESENTED, not the largest that may be
 * bought.
 *
 * The same value the catalogue's own bounds use, and for the same reason:
 * `price_tiers.quantity_range` is an `int4range` over `max_quantity + 1`, and
 * that addition must not overflow. The commercial minimum and maximum are the
 * administrator's `min_purchase_quantity` / `max_purchase_quantity`, and a
 * quantity outside them is refused by the pricing engine — never by this
 * constant.
 */
export const MAX_PURCHASABLE_QUANTITY = MAX_CATALOGUE_QUANTITY;

/**
 * The accepted width of an `Idempotency-Key` header.
 *
 * A PROTOCOL limit, matching `credit_purchases.request_key`'s own CHECK: long
 * enough for a UUID or a ULID, short enough that an unbounded header cannot be
 * used to write arbitrary volume into an append-only table. It expresses no
 * product policy and no commercial value.
 */
export const REQUEST_KEY_MIN_LENGTH = 8;
export const REQUEST_KEY_MAX_LENGTH = 128;

/** Re-exported so a caller needs one import to describe a purchase's money. */
export { COMMERCIAL_CURRENCY };
