/**
 * The wishlist contract, in the half both sides can hold.
 *
 * The fourth package of this shape, after `@beauclick/payment-contract`,
 * `@beauclick/ai-contract`, and `@beauclick/chat-contract`, and for the reason
 * each of those records: the page needs a handful of vocabularies and limits
 * from the domain, and importing the domain to get them would drag
 * `@nestjs/common`, `typeorm`, and every entity into a browser bundle. The
 * alternative — the page keeping its own string literals — works until the two
 * disagree, and the failure is silent.
 *
 * Zero dependencies. No framework, no TypeORM, no decorators, no `zod`.
 *
 * ## What is deliberately NOT here
 *
 * **No target state, and no `available` / `unavailable` vocabulary.** Story #8
 * builds persistence and the contract; the target-state projection is Story #9
 * (`V32-DEC-021`, ADR-033 §4). Declaring the vocabulary now would be a promise a
 * client codes against before anything can produce it, and an always-`available`
 * field would be worse than an absent one — it would be wrong rather than
 * missing.
 *
 * **No display fields.** No `displayName`, price, image, city, or rating.
 * `provider` and `search` stay authoritative for public target data (ADR-033
 * §7). Putting them here would make this package a second place the catalogue's
 * public shape is defined, and the saved row does not store them anyway.
 *
 * **No collection, folder, or list identifier.** One list per customer
 * (`V32-DEC-021`). A `listId` that is always the same value is a field a client
 * would build a picker around.
 *
 * **No count of any kind.** Not a per-target save count, not a "N people saved
 * this", not even the caller's own total. A popularity count is refused outright
 * by `V32-DEC-021`, and the absence is structural: there is no field here that
 * could carry one.
 */

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * What a customer may save.
 *
 * Closed by `V32-DEC-020`. Two members, and the two that are absent are absent
 * for different reasons:
 *
 * - **`portfolio`** is refused on evidence. A portfolio item id does not survive
 *   an ordinary remove-and-re-add, because `uq_portfolio_media_live` is partial
 *   on `deleted_at IS NULL` — so saved portfolio items would go unavailable
 *   during routine gallery maintenance.
 * - **`business`** is refused because it is not implementable. `services/business`
 *   exposes no public route anywhere and businesses have no search document, so
 *   a business cannot be resolved publicly at all. That is a missing capability,
 *   not a product ranking.
 *
 * A third member is a deliberate edit here, plus a migration widening
 * `ck_wishlist_saved_items_target_type`, plus a port that can resolve it.
 */
export const WISHLIST_TARGET_TYPES = ['professional', 'service'] as const;
export type WishlistTargetType = (typeof WISHLIST_TARGET_TYPES)[number];

export function isWishlistTargetType(value: unknown): value is WishlistTargetType {
  return typeof value === 'string' && (WISHLIST_TARGET_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The most items one customer may hold at once (`V32-DEC-021`).
 *
 * Exported so the page can disable its own save control at the boundary rather
 * than discovering the limit from a refusal. The server enforces it regardless
 * of what the page believed — under a per-customer advisory lock, so two
 * concurrent adds at 499 cannot both succeed (ADR-033 §8).
 */
export const WISHLIST_MAX_SAVED_ITEMS = 500;

/** Default page size for the saved list (`V32-DEC-021`). */
export const WISHLIST_DEFAULT_PAGE_SIZE = 20;

/**
 * Largest page a caller may ask for (`V32-DEC-021`).
 *
 * A larger request is CLAMPED to this rather than refused. A client that asks
 * for 200 gets 50 and a cursor, which is the answer it can act on; a 400 is a
 * dead end for a caller whose only mistake was optimism.
 */
export const WISHLIST_MAX_PAGE_SIZE = 50;

/** Longest opaque cursor the server will parse. Bounds a hostile query string. */
export const WISHLIST_MAX_CURSOR_LENGTH = 200;

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every reason the server declines to save, as a closed set.
 *
 * Closed for the reason the payment, AI, and chat vocabularies are closed: the
 * alternative is an internal state name or an exception message reaching a
 * browser.
 *
 * Note what is **absent**, and that the absence is the security property:
 *
 * There is no `target_deleted`, no `target_suspended`, no `target_revoked`, and
 * no `target_not_found`. All four collapse into `target_unavailable`, which the
 * server returns as the platform's single `NotFoundOrNotYoursException` — one
 * code, one Persian message. Distinguishing them would tell a caller whether a
 * professional exists and what the platform has decided about them, which is a
 * moderation-and-verification feed dressed as an error code.
 */
export const WISHLIST_REFUSAL_REASONS = [
  /**
   * The target does not exist, is soft-deleted, is owned by a soft-deleted
   * professional, or is owned by a professional the platform has suspended or
   * revoked.
   *
   * One reason for all of them, deliberately.
   */
  'target_unavailable',
  /** The caller already holds `WISHLIST_MAX_SAVED_ITEMS` items. */
  'limit_reached',
] as const;
export type WishlistRefusalReason = (typeof WISHLIST_REFUSAL_REASONS)[number];

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * One saved item, as the API returns it.
 *
 * Three fields, and that is the whole shape. Two of them are values the caller
 * supplied themselves; the third is when the server recorded it.
 *
 * There is no `id`. The saved row's primary key is an internal identifier the
 * caller never needs: every operation addresses an item by
 * `(targetType, targetId)`, which the caller already knows, and exposing a
 * second identifier would invite a `DELETE /items/:id` route that would then
 * have to re-prove ownership. Addressing by the natural key makes
 * not-yours and not-found the same query rather than the same catch block.
 */
export interface WishlistItemView {
  readonly targetType: WishlistTargetType;
  readonly targetId: string;
  /** ISO-8601 instant. */
  readonly savedAt: string;
}

/**
 * One page of the caller's own saved items, newest first.
 *
 * `nextCursor` is opaque and `null` on the last page. It is opaque on purpose:
 * a readable cursor invites a client to construct one, and a constructed cursor
 * pins the client to this ordering — which then cannot change without breaking
 * them.
 */
export interface WishlistPageView {
  readonly items: readonly WishlistItemView[];
  readonly nextCursor: string | null;
}
