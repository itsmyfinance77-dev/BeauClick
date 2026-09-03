# 38 — Wishlist — V3.2-C Story #10

Prototype: `Prototype - Customer.dc.html` §03–§05 (entry-point save controls) and §19 (the Wishlist screen itself). Route: `/wishlist`. Backend routes: `POST /v1/me/wishlist/items`, `GET /v1/me/wishlist/items`, `DELETE /v1/me/wishlist/items/:targetType/:targetId`. No new capability — authenticated-only, same as `journey` and the customer half of `loyalty`.

## Source read

Authoritative backend baseline: `itsmyfinance77-dev/BeauClick` `master@240c2dd8c72a28fa4b3876605a8d77cd7bdfa7ab`. Read in full: `packages/wishlist-contract/src/wishlist-contract.ts`, `services/wishlist/src/wishlist.controller.ts`, `wishlist.service.ts`, `wishlist.exceptions.ts`, `entities/wishlist.entities.ts`, `ports/wishlist.ports.ts`, `libs/ownership/src/not-found-or-not-yours.exception.ts`, `services/search/src/search.controller.ts` (saved-state hydration), `services/provider/src/provider.controller.ts` + `ports.ts` (saved-state hydration), ADR-033, ADR-034, `V3.2_DECISION_REGISTER.md` §C (`V32-DEC-020`, `V32-DEC-021`), `V3.2_PLUS_CAPABILITY_CATALOG.md`, `V3.2_PRODUCT_ROADMAP.md` §5. Also read the pre-V3 legacy frontend (`app/src/features/dashboard/customer/WishlistTab.tsx`, `app/src/mounts/wishlist-button.tsx`) to confirm it is a different, superseded contract — see "Contradiction found" below.

## What the contract actually is

Two target types only: `professional` and `service` (`V32-DEC-020`). Not `business` (no public business route or search document exists) and not `portfolio` (its id is not stable across routine media maintenance). One list per customer, capped at 500 items (`WISHLIST_MAX_SAVED_ITEMS`), enforced under a transaction-scoped advisory lock, not a preceding count. A saved item is `{ targetType, targetId, savedAt, state }` — no name, price, image, or any other display field is stored; `provider` and `search` stay authoritative for that. `state` is `available | unavailable`, computed fresh on every read and never cached — soft-deleted, professional soft-deleted, professional `suspended`, and professional `revoked` all collapse into the single `unavailable` value with no cause anywhere in the system that could carry one. A professional who is merely `unverified`, `pending`, or `rejected` is `available` (ordinary search still returns them). `saved` on a search result or a profile is `boolean | null` — `null`, never `false`, for an anonymous caller, because `false` would be a claim about somebody the server cannot identify.

## Contradiction found — legacy frontend is a different contract

`app/src/mounts/wishlist-button.tsx` and `app/src/features/dashboard/customer/WishlistTab.tsx` are pre-V3 (`V2.4 Step 23`) code hitting `/marketplace/wishlist` with integer provider ids and a plain `available: boolean`. They predate `@beauclick/wishlist-contract` entirely and do not reflect V32-DEC-020/021, the UUID target keying, the tri-state `saved`, the 500-item cap, or the neutral-tombstone rule. This design is built against the real V3.2-C contract only; the legacy files are noted here so nobody mistakes them for the current backend. No production frontend implementing the V3.2-C contract exists yet — confirmed by reading the full route tree; this is design-workspace work only, per Story #10's own scope.

## Four entry points, one saved-state control

The same save/unsave control (a pill toggle — unsaved outline, saved filled, exact copy "ذخیره" / "ذخیره‌شده") appears at all four required points and reads/writes the identical `WishlistItemView`:

- **Search-result card** (§03 desktop, §04 mobile) — `targetType: 'professional'`.
- **Professional profile** (§05) — `targetType: 'professional'`, next to the identity/verification badge.
- **Service list/card** (§05, the services-and-prices list on the profile) — `targetType: 'service'`, one control per row, independent of the professional-level control.
- **Wishlist screen** (§19) — the same control, in its saved (filled) state; pressing it again removes the row.

## Anonymous behaviour (`saved: null`)

An anonymous visitor's search card (§03, third example card) never renders a claimed "not saved" state. The control shows a dashed, muted "ذخیره" affordance; a click routes to sign-in rather than toggling anything, because the field behind it is `null`, not `false`. This is a product-level default for *what happens on click* — the contract only guarantees the field is `null` and that no saved-state query runs for an anonymous caller; it does not prescribe UI click behaviour. Documented as such, not as BACKEND CONTRACT REQUIRED.

## The Wishlist screen's own states

| State | Design |
|---|---|
| Populated (mixed available/unavailable) | Full list, newest-first, desktop (1280) and mobile (390) mockups |
| Loading (first page) | Skeleton rows, no content flash |
| Empty | Icon-free circle + "فهرست علاقه‌مندی‌های شما خالی است" + CTA to search |
| Error (list fetch failed) | Retry panel, existing red-tone pattern |
| Unavailable item (neutral tombstone) | No name, no thumbnail, no cause — "این مورد دیگر در دسترس نیست." + a remove-only action. Identical for all four internal causes |
| Cap reached (500/500) | Amber informational banner using the server's own message verbatim; no numeric tally of the customer's own items is ever rendered anywhere in this screen — `V32-DEC-021` refuses even the caller's own count |
| Pagination / loading more | "بیشتر" button reading `nextCursor`; a failed page-2 fetch leaves page 1 intact and only the button shows a retry state |
| Add-time refusal at the cap (triggered from any of the four entry points) | `409 WISHLIST_LIMIT_REACHED`, verbatim server copy, shown in the existing refusal-panel pattern |

No state renders a per-target save count, a "N people saved this," a popularity badge, a ranking implication, a notification, a business target, or a named/multiple list — none of these exist in the contract and none are designed here.

## Requirement → screen/state matrix

| Requirement | Screen / prototype section | State(s) |
|---|---|---|
| Search-result card saved/unsaved | Customer §03 (desktop), §04 (mobile) | saved, unsaved |
| Professional profile saved/unsaved | Customer §05 | saved, unsaved |
| Service list/card saved/unsaved | Customer §05 (services list) | saved, unsaved |
| New customer Wishlist screen | Customer §19 | saved (populated list) |
| Wishlist: loading | Customer §19 | loading skeleton |
| Wishlist: empty | Customer §19 | empty |
| Wishlist: error | Customer §19 | fetch error + retry |
| Wishlist: unavailable | Customer §19 (in-list rows) + §03/§05 (add-time refusal) | neutral tombstone; `target_unavailable` refusal |
| Wishlist: cap reached | Customer §19 | full-list banner; `409 WISHLIST_LIMIT_REACHED` toast |
| Wishlist: pagination/loading-more | Customer §19 | "بیشتر" + `nextCursor`; page-2 failure |
| Anonymous `saved: null` | Customer §03 (third card) | anonymous, sign-in-gated |
| Privacy boundaries (no counts, no popularity, no ranking, no notification, no business target, no named/multiple lists) | All of the above | verified absent everywhere; called out explicitly in §19's data-backing panel |

## Backend gaps found (reported, not designed around)

- **`WISHLIST-HYDRATION-BATCH`**: rendering a page of saved items with real names/prices needs a batch "resolve these N ids" route. None exists — `GET /v1/providers/:id` and `GET /v1/providers/:id/services` are both single-target. The Wishlist screen's available rows are illustrative, not wired to an implementable call today.
- **`WISHLIST-SERVICE-PARENT-LOOKUP`**: resolving which professional offers a bare saved `service` id has no reverse-lookup route in `provider.controller.ts`.

Neither gap blocks Story #10 as a design-workspace pass; both are noted so Claude Code does not assume a route that is not there.

## Status classification

| Item | Status |
|---|---|
| Four save/unsave entry points, full Wishlist screen (populated/loading/empty/error/pagination), neutral unavailable tombstone, cap-reached banner and refusal, anonymous `saved: null` handling | `IMPLEMENTED` (design), backend contract fully shipped (ADR-033, ADR-034) |
| Wishlist row display-data hydration at list-page scale | `BACKEND GAP` — `WISHLIST-HYDRATION-BATCH`, `WISHLIST-SERVICE-PARENT-LOOKUP` |
| Anonymous click-to-sign-in behaviour on the save control | `PRODUCT DECISION` (reasonable default; not contract-mandated) |

## Not built

Named or multiple lists, folders, sharing, notes, sorting/collections, business wishlist targets, portfolio-item targets, any save-count/popularity/ranking signal, any notification on target-availability change, Referral (explicitly out of scope for this story).
