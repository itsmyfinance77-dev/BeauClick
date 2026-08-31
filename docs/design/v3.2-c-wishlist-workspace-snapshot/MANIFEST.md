# BeauClick Design — V3.2-C Story #10 Wishlist Sync

Exported: 2026-08-31
Repository: `itsmyfinance77-dev/BeauClick` (this connection's resolved owner for the repo this project has tracked throughout as `marabi766/BeauClick` — same `v3/` tree, same commit lineage; see `github.md`), `v3/` scope. Audited against `master@462dd4d7f1a87ba01b46778c5490f2e72a05146b`, Story #8 `9aa59c0` and Story #9 `240c2dd` (`github_compare` between them: 36 files — Referral engineering Story #11 and its closure corrections, backend only — zero Wishlist changes).
No repository code changed; no commit made against the repository.

## This pass — V3.2-C Story #10 closure: exact-commit audit + remaining gaps

Closed three gaps left by the prior Wishlist pass: added the `saved` field/save-control to `01_SEARCH.md` and `02_PROVIDER_PROFILE.md` (previously undocumented despite being two of the four required entry points); added remove-in-progress, remove-failure, final-page (`nextCursor: null`), and an auth-required note to prototype §19 (previously 9 of 12 required states); added Handoff §29, which was referenced but did not exist. Referral **design** Story #14 remains NOT STARTED — the repository diff was Referral engineering Story #11 (backend), not Story #14 design.

## Previous pass — V3.2-C Story #10, wishlist design synchronisation

Synchronised the four required entry points (search-result card, professional profile, service list/card) and a new Wishlist screen against `@beauclick/wishlist-contract` and the `wishlist` service (ADR-033, ADR-034).

- **New spec:** `docs/design/screens/38_WISHLIST.md`, with the full requirement-to-screen/state matrix.
- **New prototype section:** `Prototype - Customer.dc.html` §19 (Wishlist screen — populated/loading/empty/error/pagination/cap-reached/neutral-unavailable, at 1280 and 390). Save/unsave controls added to existing §03 (search cards), §04 (mobile search cards), §05 (professional profile + each service row).
- **Contradiction found and reported, not used:** `app/src/mounts/wishlist-button.tsx` and `WishlistTab.tsx` are pre-V3 legacy code against a superseded `/marketplace/wishlist` contract (integer ids, plain boolean). Documented in `38_WISHLIST.md`.
- Preserved exactly: two target types only (`professional`, `service`); one list per customer; 500-item cap under an advisory lock; neutral two-value `available | unavailable` state with no cause anywhere; `saved: boolean | null` with `null` (never `false`) for anonymous callers; no save count of any kind, including the caller's own total; no popularity, ranking, notification, business target, or named/multiple list.
- Backend gaps reported: `WISHLIST-HYDRATION-BATCH` (no batch route to resolve saved-item display data at list-page scale) and `WISHLIST-SERVICE-PARENT-LOOKUP` (no reverse lookup from a saved service id to its professional).
- Pro/Admin prototype untouched — the audited contract has no admin- or professional-facing wishlist surface. Referral not started.

## Previous pass — V3.2-B Internal Chat Sync

Synchronised all customer, professional/business, and admin chat surfaces against the real `@beauclick/chat-contract` and `chat` service implementation (ADR-031, ADR-032).

- **New specs:** `docs/design/screens/36_INTERNAL_CHAT.md`, `docs/design/screens/37_ADMIN_CHAT_MODERATION.md`.
- **New prototype sections:** `Prototype - Customer.dc.html` §18 (inbox/thread, professional and business counterparties, all refusal/read-only states, report flow, block/unblock, erased placeholder, notification entry point); `Prototype - Pro and Admin.dc.html` §17 (professional/business inbox, owner+active-manager access, seller-side read-only states) and §18 (admin report queue and detail, report-id-only entry, 50-message window, uphold/reject with three actions, concurrent-decision conflict).
- Preserved exactly: immutable historical counterparty (no picker), booking eligibility rule, 90-day send window, directional/mutual blocking with no blocker disclosure, seven report reasons and rate limits, business-inbox owner+manager-only access, admin moderation's report-id-only boundary.
- Confirmed absent from both prototypes: attachments, typing/presence/delivery receipts, push/SMS/email, realtime transport, message editing/participant deletion, group chat, AI context integration.

## Top-level content inventory

- `Prototype - Customer.dc.html` — full customer prototype, §18 added this pass.
- `Prototype - Pro and Admin.dc.html` — full pro/admin prototype, §17–§18 added this pass.
- `Design Language.dc.html`, `Recreation - V3 Today.dc.html` — earlier baseline artifacts.
- `BeauClick-Mobile-Preview-Standalone.html` — standalone mobile export.
- `docs/design/screens/` — 38 screen specs, including new `38_WISHLIST.md` (this pass).
- `docs/design/V3.1.0_FINAL_DESIGN_HANDOFF.md` — handoff through §29 (this pass).
- `github.md` — sync record, baseline, screen map, sync history.
- `support.js`, `doc-page.js` — runtime files required by the `.dc.html` prototypes.
- `fonts/` — self-hosted Vazirmatn and display fonts.

## Correction pass (same day)

Two verified implementation mismatches fixed after re-audit against `d2e11ea0f0f7`:

1. **Business counterparty display.** `chat-contract.ts` returns only `counterpartyType`/`counterpartyId` — no name/avatar field. A professional resolves via the existing public provider route; a business does not (no `@Public` business-detail route, businesses absent from search). Replaced invented salon names («سالن بهار», «آتلیه سارا محمدی») in `Prototype - Customer.dc.html` §18 with the neutral label «کسب‌وکار BeauClick» + type badge, and marked named-business rendering `BACKEND CONTRACT REQUIRED` in `36_INTERNAL_CHAT.md` and the prototype.
2. **Moderation decision race — concurrent-decision CAS protection with a generic unavailable response.** `chat-moderation.service.ts`/`.controller.ts` return the same generic `NotFoundOrNotYoursException` to the compare-and-swap loser as to any missing/foreign/expired report id — there is no distinct "already decided" response. Replaced the definite "قبلاً توسط همکار دیگری تصمیم‌گیری شده" copy in `Prototype - Pro and Admin.dc.html` §18 and `37_ADMIN_CHAT_MODERATION.md` with a generic "no longer available, refresh the queue" state.

Files touched (this correction pass): `docs/design/screens/36_INTERNAL_CHAT.md`, `docs/design/screens/37_ADMIN_CHAT_MODERATION.md`, `Prototype - Customer.dc.html` §18, `Prototype - Pro and Admin.dc.html` §18, `docs/design/V3.1.0_FINAL_DESIGN_HANDOFF.md` §28, `github.md`, this file.

## Unresolved gates (this pass)

**Legal:** approved customer-facing chat disclosure/consent copy — no placeholder wording invented.
**Product:** V3.3-C staff role matrix, which owns any broader or practitioner-specific business-inbox access — explicitly deferred, not designed here.
**Backend:** none blocking the implemented neutral-label Chat surface. Optional real business-name rendering requires a public business-summary contract.
