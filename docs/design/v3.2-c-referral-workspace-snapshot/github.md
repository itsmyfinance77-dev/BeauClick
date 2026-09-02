repo: itsmyfinance77-dev/BeauClick
branch: master
path: v3

## Repo owner note (this sync)

This connection now resolves `marabi766/BeauClick` (the owner recorded by every prior sync above) as inaccessible; `itsmyfinance77-dev/BeauClick` is what the current connection exposes, at the same `v3/` structure, same file layout, and the same commit lineage this project has been syncing against (`ADR-033`/`ADR-034`, `wishlist-contract`, etc. all present). Treated as the same repository under a changed remote/owner, not a different codebase. **Update:** the ownership transfer to `itsmyfinance77-dev/BeauClick` has since been confirmed by the user.

## Last sync

date: 2026-09-02T04:20:00Z
commit: repository `master@1e5f519177b4491662cb1a4c57eb2e9035934b69`. Correction: this commit/PR #54 was produced by Story #13 (the Referral adversarial test suite) — it is the repository baseline this Story #14 design sync is read against, not Story #14 itself.

### V3.2-C Story #14 — Referral design synchronisation (this pass, design workspace only — no repo write)

- Read the real contract before designing: `packages/referral-contract/src/referral-contract.ts`, `services/referral/src/{referral.controller.ts, referral.service.ts, referral.exceptions.ts, referral-reward.config.ts, referral-code.generator.ts, referral-qualification.service.ts, referral-reversal.service.ts, referral.module.ts, entities/referral.entities.ts}`, `libs/event-contracts/src/catalog/referral.events.ts`, `apps/api/src/events/{referral-qualification.handlers.ts, referral-reversal.handlers.ts}`, `services/notification/src/templates/template.registry.ts`, ADR-035, ADR-037, ADR-038, `V3.2_DECISION_REGISTER.md` (`V32-DEC-016`–`019`, `033`, `034`).
- **Central finding:** only two routes exist (`GET /v1/me/referral/code`, `POST /v1/me/referral/claim`). No route reads a *persistent* lifecycle status, reward grant, reversal, or cap counter — pending qualification, expired, and capped (3 of the 10 requested states) have no data source at all. Qualified and reversed are narrower: `template.registry.ts` defines four real, implemented notification templates (verbatim Persian subject/body, deep-linked to `/referral`) that do deliver both facts once, honestly, through the existing Notifications surface (§18) — what is missing is a persistent status screen, plus the narrower, optional `REFERRAL-NOTIFICATION-OUTCOME-VARS` gap (empty `vars` means the notification cannot yet distinguish `capped`/`disabled_zero`/`awarded`).
- Added `docs/design/screens/39_REFERRAL.md`; added `Prototype - Customer.dc.html` §20 (own code + invite link + three-channel share exactly as contracted — `copy_code`/`copy_link` unconditional, `native_share` capability-gated with silent-cancel; the honest always-visible zero-reward disclosure; an unconditionally-offered claim box per `V32-DEC-019`'s single-oracle design; the one-time claim-success reveal of `attributedAt`/`expiresAt`; the byte-identical 409 refusal across all six eligibility causes, kept distinct from a genuinely separate 400 for a malformed request body; the 429 throttle with the published `attemptsPerHour`; the four real notification templates shown as an illustrative callout; auth-required and generic-error states) plus one consolidated backend-gap notice for the three states with no data source at all.
- Preserved exactly: no reward figure other than the real configured zero; no referrer/referee identity beyond the caller's own two claim-result facts; no click/invite/conversion count anywhere; qualification copy names only "completed booking," never registration/OTP/`BookingConfirmed`/`OrderPaid`; reversal copy names only a full refund, never a partial refund or cancellation (structurally impossible post-qualification per `LEGAL_TRANSITIONS`).
- Pro/Admin prototype untouched — confirmed no admin- or professional-facing referral controller/route exists anywhere in the repository; the capability catalog itself records manual review/appeals/overrides as `unscheduled` and explicitly not built (`V32-DEC-019`).
- No production repository code changed; no commit made.

### Logo exploration — 10 concepts (previous pass, design workspace only, non-destructive)

- New brand exploration, not tied to any repository contract: `BeauClick Logo Explorations — 10 Concepts.dc.html` + 10 vector sources under `assets/brand/logo-explorations-2026/`.
- Both prior logo assets confirmed untouched: `uploads/icon-circle.svg` (current gradient-circle mark) and `Logo Explorations.dc.html` (earlier 14-sample page) — read only, not modified/renamed/deleted.
- 10 distinct concepts (Connection Point, Marketplace Module, Beauty Signature, Abstract BC Monogram, Booking Moment, Discover & Connect, Trust Badge, Dual-Script Bridge, Digital Beauty Mark, Network Facet), each with full lockup/mono/reversed/favicon/small-size deliverables and a Latin+Persian wordmark. Recommended top three (not final): 04, 07, 09. See handoff §30.
- No repository code touched; no commit made.

### V3.2-C Story #10 closure pass — exact-commit audit + remaining gaps closed (this pass, design workspace only — no repo write)

- `github_compare(240c2dd...462dd4d7)`: 36 files changed, all Referral **engineering** Story #11 backend scaffolding and its closure corrections (`packages/referral-contract`, `services/referral`, ADR-035) — zero files under `wishlist`/`provider`/`search`. Story #9's commit is still the current Wishlist baseline; nothing redesigned on stale information.
- Closed three real gaps left by the previous pass: `01_SEARCH.md` and `02_PROVIDER_PROFILE.md` had no mention of the `saved` field or save control despite being two of the four required entry points — added. Prototype §19 covered 9 of the 12 required states — added remove-in-progress, remove-failure-with-safe-restoration, final-page (`nextCursor: null`), and an auth-required note (reusing the existing safe-return login pattern). Handoff §29 was referenced by `MANIFEST.md`/this file but did not exist in the handoff document — added, with the exact audited commits above.
- Referral **design** Story #14 remains NOT STARTED — the diffed files are Referral engineering Story #11 (backend), not Story #14 design; read only to scope the compare, not acted on.

### V3.2-C Story #10 — Wishlist design synchronisation (previous pass, design workspace only — no repo write)

- Read the real contract before designing: `packages/wishlist-contract/src/wishlist-contract.ts`, `services/wishlist/src/{wishlist.controller.ts, wishlist.service.ts, wishlist.exceptions.ts, entities/wishlist.entities.ts, ports/wishlist.ports.ts}`, `libs/ownership/src/not-found-or-not-yours.exception.ts`, `services/search/src/search.controller.ts`, `services/provider/src/{provider.controller.ts, ports.ts}`, ADR-033, ADR-034, `V3.2_DECISION_REGISTER.md` §C, `V3.2_PLUS_CAPABILITY_CATALOG.md`, `V3.2_PRODUCT_ROADMAP.md` §5.
- Added `docs/design/screens/38_WISHLIST.md`; added save/unsave controls to `Prototype - Customer.dc.html` §03 (search cards), §04 (mobile search cards), §05 (professional profile + service rows), and a new §19 (the Wishlist screen: populated/loading/empty/error/pagination/cap-reached/neutral-unavailable).
- **Contradiction found:** `app/src/mounts/wishlist-button.tsx` and `app/src/features/dashboard/customer/WishlistTab.tsx` are pre-V3 legacy code against a different, superseded `/marketplace/wishlist` contract (integer ids, plain boolean). Reported in `38_WISHLIST.md`; not used as design input.
- Neutral unavailable state (one value, no cause) rendered identically at every entry point; no save count, popularity signal, ranking implication, notification, business target, or named/multiple list anywhere — verified against `V32-DEC-020`/`V32-DEC-021`.
- Two backend gaps reported, not designed around: `WISHLIST-HYDRATION-BATCH`, `WISHLIST-SERVICE-PARENT-LOOKUP` (both — no batch/reverse-lookup route exists for rendering real display data on the Wishlist screen at scale).
- Pro/Admin prototype untouched — no admin- or professional-facing wishlist surface exists in the audited contract. Referral not started, per instruction.
- No production repository code changed; no commit created.

### V3.2-B internal chat sync (previous pass) — same day

commit at that time: d2e11ea0f0f760c850997182f900748923e7418b (V3.2-B chat implementation milestone, CI run 33314468705, all green). Repository master separately at 63f9a8b9e76e5eb73faec8e3933c413a0f6fba56 (adds only the PR workflow — no chat code there).

### V3.2-B correction pass (same day) — two verified mismatches fixed

- **Business counterparty display:** `chat-contract.ts` has no business name/avatar field; a business has no public detail route/search entry (unlike a professional, which does). Customer §18 no longer shows invented salon names — shows «کسب‌وکار BeauClick» + type badge, with named-business rendering marked BACKEND CONTRACT REQUIRED in `36_INTERNAL_CHAT.md`.
- **Moderation race copy:** the compare-and-swap loser gets the same generic not-found refusal as any inaccessible report id, not a distinct "already decided" response. Pro/Admin §18 and `37_ADMIN_CHAT_MODERATION.md` now use generic "no longer available, refresh" copy.

### V3.2-B internal chat sync — customer, professional/business, admin moderation (this pass, design workspace only — no repo write)

- Read the real contract before designing: `packages/chat-contract/src/chat-contract.ts`, `services/chat/src/chat.controller.ts`, `chat.exceptions.ts`, `chat.service.ts`, `chat-access.service.ts`, `chat-moderation.controller.ts`, `chat-moderation.service.ts`, `chat-retention.service.ts`, `chat-subject-data.contract.ts`, `entities/chat.entities.ts`, `ports/chat.ports.ts`, the chat schema migration, ADR-031, ADR-032, RBAC grants for `bc_use_chat` (customer/professional/business) and `bc_moderate_chat` (moderator/administrator, privileged, not platform_operator).
- Added `docs/design/screens/36_INTERNAL_CHAT.md` and `docs/design/screens/37_ADMIN_CHAT_MODERATION.md`; added `Prototype - Customer.dc.html` §18 and `Prototype - Pro and Admin.dc.html` §17 (professional/business inbox) + §18 (admin report moderation).
- Full requirement coverage: immutable historical counterparty with no picker, professional and business conversation examples with business identity clarity, eligibility (`confirmed`/`completed`/`no_show` + proven-prior-`confirmed` `cancelled`), 90-day send window and reopening, business-inbox limited to owner + active managers (ordinary-staff exclusion shown explicitly), read watermark, blocking (directional record/mutual effect, no blocker disclosure), message-anchored reporting (seven reasons, 500-code-point note cap, duplicate-open and rate-limited states), all nine refusal reasons, erased-sender placeholder, loading/pagination/retry/offline, notification entry point; admin: report-id-only entry, metadata-only queue, 50-message bounded window with raw truncated sender ids, mandatory-reason uphold/reject with the three upheld actions, concurrent-decision conflict, missing/foreign/expired-access refusal.
- Contract boundary: the implemented Chat milestone is complete using the neutral «کسب‌وکار BeauClick» label; real business-name rendering is an OPTIONAL BACKEND CONTRACT REQUIRED item (no public business-summary route exists) that does not block the implemented surface. Moderation decisions use concurrent-decision CAS protection with a generic unavailable response (no distinct "already decided" code). Remaining gates: approved chat disclosure/consent copy (LEGAL REVIEW REQUIRED, no wording invented); V3.3-C staff role matrix for broader business-inbox access (PRODUCT DECISION REQUIRED, explicitly deferred).
- Confirmed absent from both prototypes: attachments, typing/presence/delivery-receipt, push/SMS/email, realtime transport, message edit/participant-deletion, group chat, AI summaries/context. No production repository code changed; no commit made against `marabi766/BeauClick`.

### V3.2-A AI assistant sync — customer sandbox only (this pass, design workspace only — no repo write)

- Read the real contract before designing: `packages/ai-contract/src/ai-assistant-contract.ts`, `services/ai/src/ai.controller.ts`, `ai.exceptions.ts`, `ai-consent.service.ts`, `ai-conversation.service.ts`, `ai-quota.service.ts`, `providers/ai-provider.interface.ts`, `providers/deterministic-assistant.provider.ts`, `safety/ai-input-safety.ts`, ADR-029, ADR-030, `V3.2_DECISION_REGISTER.md` §A (`V32-DEC-001`–`009`, all closed 2026-08-29).
- Scope is customer mode only (`V32-DEC-001`): added `Prototype - Customer.dc.html` §17 and `docs/design/screens/35_AI_ASSISTANT.md`. No professional assistant mode, operator content-management screen, human chat, or production-provider config designed — none exist upstream either.
- Full requirement-to-spec coverage: entry point, one-time consent gate, conversation list/pagination/empty state, new/active conversation, message composer with live counter and Tehran-day quota, deterministic response with the honesty disclosure, two-target recommendation cards with silent re-verification drop, all seven refusal reasons (server's own Persian copy), closed/deleted/expired/unavailable states (indistinguishable 404 for deleted/foreign/retention-expired), permanent-delete confirmation, and accessibility/keyboard behavior.
- Legal-gated disclosure copy kept explicitly separate from the engineering honesty sentence and marked `LEGAL REVIEW REQUIRED` — no legal approval claimed (`V32-DEC-006`). Real-provider enablement stays `EXTERNAL CONFIGURATION REQUIRED` pending the spend ceiling (`V32-DEC-008`) — no numeric ceiling invented.
- Pro/Admin prototype untouched — no shared component correction was needed. No production repository code changed; no commit made against `marabi766/BeauClick`.

### Sync check (previous pass): no upstream changes

`github_compare` against `master` under `v3/` returned no changes since the recorded commit at that time. No screens rebuilt; nothing else updated.

### Phase F closure sync — retry contract implemented (previous pass, design workspace only — no repo write)

- Read the implemented files: `checkout/result/page.tsx`, `auth/page.tsx`, `lib/safe-return.ts`, `lib/booking-api.ts`, `checkout/order-payment.controller.ts`, `checkout/checkout.service.ts`, `services/payment/src/payment.service.ts`, `packages/payment-contract/`, `payment-retry.pg-spec.ts`, `checkout-result.spec.tsx`, `V3.1_PHASE_F_IMPLEMENTATION.md`.
- **Retry backend gap closed:** `POST /v1/orders/:id/payment/retry` (order-scoped, empty body, no `intentId`, response `{ redirectUrl }` only) matches exactly what the design left open. Reclassified `cancelled_by_user`, `declined`, `not_completed`, `gateway_error` from BACKEND CONTRACT REQUIRED to IMPLEMENTED in `16_CHECKOUT_RESULT.md` and the prototype; prototype's disabled conceptual button replaced with the real visible/loading/double-click-safe/redirect-only interaction.
- **`expired` reclassified, not closed:** now tracked as product gap `EXPIRED-REBOOK` (was BACKEND CONTRACT REQUIRED) — no rebooking action invented, per explicit instruction and `V3.1_PHASE_F_IMPLEMENTATION.md` §12.
- Confirmed unchanged and matching: corrected `unresolved`/`gateway_error` copy, `refunded` warning tone, heading focus, missing-order/unauthenticated states, safe-return path, receipt-fetch retry. URL params remain presentation-only; receipt truth is the authenticated API.
- Updated `V3.1.0_FINAL_DESIGN_HANDOFF.md` §26. Admin/pro prototype untouched. No repository code changed.

### Phase F design sync — payment result only (previous pass, design workspace only — no repo write)

- Narrow scope by request: `docs/design/screens/16_CHECKOUT_RESULT.md` and `Prototype - Customer.dc.html` §16 only. Read the real implementation (`checkout/result/page.tsx`, `ui.tsx`, `checkout-result.spec.tsx`, `payment-failure.ts`, `checkout.controller.ts`) plus `V3.1_PHASE_F_IMPLEMENTATION.md`, not just the backend report.
- **Contradiction found and corrected:** live `unresolved` copy promises automatic resolution ("به‌صورت خودکار تعیین تکلیف می‌شود"); `V3.1_PHASE_F_IMPLEMENTATION.md` §8 confirms no reconciliation sweep exists. Rewrote the sentence to state only: outcome unknown, don't retry, check bookings, contact support if money moved without a confirmed booking. Milder same-class fix on `gateway_error`'s conditional refund promise.
- Designed the full six-outcome × eight-reason matrix. `refunded` tone changed error → warning (customer not at fault, reuses the existing warning/warning-soft token pair). All 8 failure reasons given an explicit retry decision; 4 are server-flagged retryable but the redirect contract carries no `intentId` — retry button designed and marked BACKEND CONTRACT REQUIRED, not wired.
- New edge-case designs not in the live page: missing-orderId state, unauthenticated state, wired onRetry on receipt-fetch error, h1 focus-on-mount after gateway redirect.
- Updated `V3.1.0_FINAL_DESIGN_HANDOFF.md` §25. Professional/admin prototype untouched — no shared component needed new documentation.
- No production frontend code and no commit against `marabi766/BeauClick` were created. `origin/master` unchanged. `GAP-11` untouched (unrelated to this surface).

### Phase E design sync (previous pass, design workspace only — no repo write)

- Read `PHASE_E_CLAUDE_DESIGN_HANDOFF.md`, `V3.1_PHASE_E_IMPLEMENTATION.md`, `V3.1_EXTERNAL_ENABLEMENT_STRATEGY.md`, `V3.1_PRODUCT_ROADMAP.md`, `ADR-027-subject-data-contract.md`, and the real `privacy.controller.ts` / `auth.controller.ts` / `otp.service.ts` source. Confirmed zero `apps/web` files changed — backend-only phase, same pattern as Phases C and D.
- Reclassified OTP resend cooldown in `15_AUTH.md` from BACKEND GAP to IMPLEMENTABLE NOW — `cooldownRemaining`/`expiresInSeconds` are now real fields; added prototype §11 (Customer) showing the countdown and both 429 refusal shapes (in-cooldown with `retryAfterSeconds`, hourly-limit without one).
- Added `29_PRIVACY_ACCOUNT.md` + prototype §09 (Customer): export request/status/download-with-expiry, deletion with typed `DELETE` confirmation, grace-window countdown, cancel.
- Added `30_DEVICE_SESSIONS.md` + prototype §10 (Customer): device list with real `current`, revoke one / revoke others, stale-session state.
- Added `31_ADMIN_PRIVACY_QUEUE.md` + prototype §16 (Pro and Admin): read-only status queue, explicitly no download/cancel control.
- Added `32_SEO_METADATA.md` (favicon/OG/robots/sitemap — structure IMPLEMENTABLE NOW, final OG copy/brand image BUSINESS DECISION REQUIRED), `33_FOOTER_LEGAL.md` (legal-route template, placeholder content, BUSINESS DECISION REQUIRED for actual policy/contact text), `34_TYPOGRAPHY_VAZIRMATN.md` (records both prototypes already self-host Vazirmatn; formal self-host-vs-CDN choice stays BUSINESS DECISION REQUIRED).
- Noted in `12_BUSINESS.md`: business-owner erasure outcome (close/unassigned/transfer) is PRODUCT DECISION REQUIRED; no screen implies an outcome.
- Homepage (`QA-16r`): already designed in this workspace's prototype §01–§02 with real imagery fields since the Phase C sync — confirmed sufficient, no rebuild needed.
- Updated `V3.1.0_FINAL_DESIGN_HANDOFF.md` §24 with this sync's findings.
- No production frontend code and no commit against `marabi766/BeauClick` were created. `origin/master` unchanged at `ec77e7c`.

### Phase D closure verification (previous pass, design workspace only — no repo write)

- Audited both prototype files against the Phase D spec checklist (review submission, ineligible/already-reviewed states, review list, professional reply, rating summary + zero-review state, search/profile rating display, minRating filter + rating sort, admin moderation queue with publish/hide + reason + loading/empty/error/conflict/success). Found the two `.dc.html` prototypes still carried pre-Phase-D "ساخته نشد" (not built) annotations for ratings — the Phase D work had only ever landed in the markdown specs (`01_SEARCH.md`, `02_PROVIDER_PROFILE.md`, `08_BOOKINGS_LIST.md`, `28_ADMIN_REVIEW_MODERATION.md`), never in the prototypes.
- Added screen `۰۸ — دیدگاه و امتیاز — فاز D` to `Prototype - Customer.dc.html`: rating summary + zero-review state + review list with professional reply on the provider-profile pattern, rating badge + minRating filter/sort on the search-card pattern, and leave-a-review CTA / already-reviewed badge / review composer (empty, disabled-until-rated, 409-ineligible) on the bookings pattern.
- Added screen `۱۵ — صف رسیدگی به دیدگاه‌ها — مدیریت` to `Prototype - Pro and Admin.dc.html`: queue table + detail panel modeled on the existing `۱۲ — صف احراز هویت` admin pattern, with equal-weight publish/hide buttons, required reason field, and empty/error/success/409-conflict states.
- Both additions use the neutral «کاربر BeauClick» label in place of reviewer identity — the public review API has no reviewer identity by design; revealing it stays PRODUCT DECISION REQUIRED + a backend contract change, not something this pass resolved.
- This design workspace is not the BeauClick repository — these prototype edits exist only as project files here, not as commits against `marabi766/BeauClick`. `origin/master` is unchanged at `432647ba753f`.

### Updated in this project (reviews/ratings sync — V3.1 Phase D)

- Diffed `7196041556fb...master` again: 21 new files beyond the prior Phase C sync, all Phase D — `provider.reviews` + `provider.review_eligibility` tables, review/reply/moderation routes, `rating: {average, count}` added to every professional shape. Zero `apps/web` files touched — backend ahead of frontend again, confirmed against the full app-route tree.
- Reclassified rating badge, `minRating` filter and `rating` sort from no-render to IMPLEMENTABLE NOW in `01_SEARCH.md`; review list, aggregate and professional reply in `02_PROVIDER_PROFILE.md`; "leave a review" from a completed booking in `08_BOOKINGS_LIST.md`.
- Reviewer display name stays PRODUCT DECISION REQUIRED — the public API has no reviewer identity by design; specs use relative date + booked service instead.
- Added `28_ADMIN_REVIEW_MODERATION.md` (new `bc_moderate_reviews` untriaged queue) — spec-only, no frontend route exists yet.
- Updated `V3.1.0_FINAL_DESIGN_HANDOFF.md` §23 with this sync's findings.

### Updated in this project (media/portfolio sync — V3.1 Phase C)

- Diffed `7196041556fb...master`: new `@beauclick/media` lib (presigned upload lifecycle, public/protected access classes, abuse-report moderation), provider portfolio/avatar/cover service, search imagery fields (`avatarUrl`, `portfolioCount`, mapping v2). No `apps/web` file touched — backend ahead of frontend.
- Reclassified image/portfolio items from BACKEND GAP to IMPLEMENTABLE NOW in `01_SEARCH.md`, `02_PROVIDER_PROFILE.md`, `14_PRO_PROFILE.md`; updated `21_ADMIN_VERIFICATION.md` and its prototype §12 evidence panel (real 5-minute protected download links, replacing "no evidence attached").
- Added `27_ADMIN_MEDIA_MODERATION.md` (new `bc_moderate_media` queue) — spec-only, no frontend route exists yet to prototype against.
- Updated `V3.1.0_FINAL_DESIGN_HANDOFF.md` §22 with this sync's findings.

### Updated in this project (design package completion pass)

- Re-read `docs/design/V3.1.0_CLAUDE_DESIGN_HANDOFF.md` (ground-truth engineering audit) in full; reconciled all existing design docs and prototypes against it — no repo changes since last sync, no boundary violations found.
- Added 16 P1/P2 screen specs + MoneyChart decision + mobile-nav decision + accessibility spec under `docs/design/screens/`.
- Added admin overview, business, auth, and checkout-result prototype sections (§13–§16) to the two prototype files.
- Rewrote `docs/design/V3.1.0_FINAL_DESIGN_HANDOFF.md` as the complete design package handoff.

### Updated in this project

- Design language and token proposal built from the real V3 token set and component kit.
- Thirteen current V3 screens recreated verbatim as the before/after baseline.
- Ten visual prototypes in the new language at 1280 and 390 across customer, pro and admin.
- Four design documents written against real repo files, with an implementation map.
- Re-checked shared chrome (`tokens.css`, `globals.css`, `ui.tsx`, `kit.tsx`): unchanged since last sync, all three token defects still present. No rebuild needed for previously mapped screens.
- Found 15 upstream routes with no project screen yet (see Notes) — out of scope for this sync, listed for prioritization.

## Sync history

- 2026-09-02T04:20:00Z — V3.2-C Story #14 Referral design synchronisation (own-code/share + claim box + one-time attributed reveal + collapsed refusal/throttle + distinct 400 + real notification templates; `39_REFERRAL.md`, Customer §20; central finding: no persistent status-read route exists for pending/expired/capped; qualified/reversed reach the customer once via real, implemented notification copy) @1e5f519177b4491662cb1a4c57eb2e9035934b69 (Story #13/PR #54 baseline).
- 2026-09-01T12:00:00Z — Logo exploration, 10 concepts (pure design-workspace brand exploration; new `BeauClick Logo Explorations — 10 Concepts.dc.html` + 10 SVG sources; both prior logo assets confirmed untouched). No repo read/write.
- 2026-08-31T16:30:00Z — V3.2-C Story #10 closure pass (exact-commit audit vs master@462dd4d7f1a87ba01b46778c5490f2e72a05146b, Story #8@9aa59c0, Story #9@240c2dd; closed the 01_SEARCH/02_PROVIDER_PROFILE/§19-states/handoff-§29 gaps).
- 2026-08-31T03:58:00Z — V3.2-C Story #10 wishlist design synchronisation (four entry-point save controls + new Wishlist screen; `38_WISHLIST.md`, Customer §19, save controls added to §03–§05) @240c2dd8c72a28fa4b3876605a8d77cd7bdfa7ab. Repo owner resolved as `itsmyfinance77-dev/BeauClick` this pass — see note above.
- 2026-08-30T14:05:00Z — V3.2-B internal chat sync (customer + professional/business inbox + admin moderation; 36_INTERNAL_CHAT.md, 37_ADMIN_CHAT_MODERATION.md, Customer §18, Pro/Admin §17–§18) @d2e11ea0f0f760c850997182f900748923e7418b.
- 2026-08-29T23:40:00Z — V3.2-A correction pass: removed invented conversation titles, separated `AiRecommendationView` card contract from provider prose, added missing disclosure on zero-recommendation reply. §17 + `35_AI_ASSISTANT.md` + handoff §27.1.
- 2026-08-29T18:06:30Z — V3.2-A AI assistant sync (customer-only deterministic sandbox; §17 + `35_AI_ASSISTANT.md`) @649dad5.
- 2026-08-29T23:05:00Z — Phase F closure sync (retry contract implemented and reclassified; `expired` moved to product gap `EXPIRED-REBOOK`) @226b14a441f1dfc1c4ee42b9831e51232d5ee14b.
- 2026-08-29T22:40:00Z — Phase F design sync (payment result: 6 outcomes × 8 reasons, unresolved contradiction fix, retry-affordance decision) @0bb226377ed1fe4ddb2e880632c79295ce4ca13e.
- 2026-08-28T20:41:00Z — Phase D closure verification (prototype gap found and closed: reviews/ratings existed only in specs, not in either prototype) @432647ba753f.
- 2026-08-28T14:50:00Z — media/portfolio sync (V3.1 Phase C: image gallery reclassified, `27_ADMIN_MEDIA_MODERATION.md` added) vs 7196041556fb, 62 files/10 commits.
- 2026-08-28T12:58:42Z — design package completion pass (16 P1/P2 screens, final handoff, MoneyChart/mobile-nav/a11y specs) @ 7196041556fb.
- 2026-08-28T10:05:00Z — initial build (design language, 13 recreations, 10 prototypes, 4 docs).

## Screen map

| Project screen | Repo files |
| --- | --- |
| Design Language.dc.html | v3/packages/design-tokens/src/tokens.css, v3/apps/web/app/globals.css, v3/apps/web/components/ui.tsx, v3/apps/web/components/kit.tsx |
| Recreation - V3 Today §01 صفحهٔ اصلی | v3/apps/web/app/page.tsx, v3/apps/web/components/app-shell.tsx, v3/apps/web/app/layout.tsx |
| Recreation §02 جست‌وجو | v3/apps/web/app/search/page.tsx |
| Recreation §03 پروفایل و رزرو | v3/apps/web/app/providers/[id]/page.tsx |
| Recreation §04 رزروهای من | v3/apps/web/app/bookings/page.tsx |
| Recreation §05 داشبورد مشتری | v3/apps/web/app/dashboard/page.tsx |
| Recreation §06 نمای کلی متخصص | v3/apps/web/app/pro/page.tsx, v3/apps/web/components/pro-shell.tsx |
| Recreation §07 رزروهای متخصص | v3/apps/web/app/pro/bookings/page.tsx |
| Recreation §08 زمان‌های آزاد | v3/apps/web/app/pro/availability/page.tsx |
| Recreation §09 مالی متخصص | v3/apps/web/app/pro/finance/page.tsx |
| Recreation §10 نمای کلی مدیریت | v3/apps/web/app/admin/page.tsx, v3/apps/web/components/admin-shell.tsx |
| Recreation §11 صف احراز هویت | v3/apps/web/app/admin/verification/page.tsx |
| Recreation §12 مسیر و باشگاه | v3/apps/web/app/journey/page.tsx, v3/apps/web/app/loyalty/page.tsx |
| Recreation §13 کسب‌وکار | v3/apps/web/app/business/page.tsx |
| Prototype - Customer §01–02 صفحهٔ اصلی | v3/apps/web/app/page.tsx, components/app-shell.tsx |
| Prototype - Customer §03–04 جست‌وجو | v3/apps/web/app/search/page.tsx |
| Prototype - Customer §05 پروفایل | v3/apps/web/app/providers/[id]/page.tsx |
| Prototype - Customer §06 جریان رزرو | v3/apps/web/app/providers/[id]/page.tsx |
| Prototype - Customer §07 داشبورد | v3/apps/web/app/dashboard/page.tsx, bookings, journey, loyalty |
| Prototype - Pro and Admin §08 امروز | v3/apps/web/app/pro/page.tsx, components/pro-shell.tsx |
| Prototype - Pro and Admin §09 رزروها | v3/apps/web/app/pro/bookings/page.tsx |
| Prototype - Pro and Admin §10 زمان‌های آزاد | v3/apps/web/app/pro/availability/page.tsx |
| Prototype - Pro and Admin §11 مالی | v3/apps/web/app/pro/finance/page.tsx |
| Prototype - Pro and Admin §12 احراز هویت | v3/apps/web/app/admin/verification/page.tsx, components/admin-shell.tsx |
| docs/design/V3_DESIGN_SYSTEM.md | packages/design-tokens/src/tokens.css, app/globals.css, components/ui.tsx, kit.tsx |
| docs/design/V3_INFORMATION_ARCHITECTURE.md | app/ route tree, app-shell.tsx, pro-shell.tsx, admin-shell.tsx |
| docs/design/V3_COMPONENT_INVENTORY.md | components/ui.tsx, kit.tsx, all three shells |
| docs/design/V3_UIUX_GAP_MATRIX.md | all screen files above |
| docs/design/screens/27_ADMIN_MEDIA_MODERATION.md | libs/media/src/media.controller.ts (AdminMediaController), services/identity/src/rbac/capabilities.ts |
| docs/design/screens/28_ADMIN_REVIEW_MODERATION.md | v3/services/provider/src/review.controller.ts (AdminReviewController), v3/services/provider/src/entities/review.entity.ts, v3/services/identity/src/rbac/capabilities.ts |
| Prototype - Customer §09 حریم خصوصی | v3/services/privacy/src/privacy.controller.ts, privacy.service.ts, ADR-027-subject-data-contract.md |
| Prototype - Customer §10 دستگاه‌ها و نشست‌ها | v3/services/identity/src/auth/auth.controller.ts (listSessions/revokeSession), token/token.service.ts |
| Prototype - Customer §11 OTP cooldown | v3/services/identity/src/otp/otp.service.ts, auth/auth.controller.ts (requestOtp) |
| Prototype - Pro and Admin §16 صف حریم خصوصی | v3/services/privacy/src/privacy.controller.ts (AdminPrivacyController) |
| docs/design/screens/16_CHECKOUT_RESULT.md (Phase F closure) | v3/apps/web/app/checkout/result/page.tsx, lib/booking-api.ts, lib/safe-return.ts, apps/api/src/checkout/order-payment.controller.ts, checkout.service.ts, services/payment/src/payment.service.ts, packages/payment-contract/ |
| Prototype - Customer §16 نتیجه پرداخت (Phase F closure) | same as above |
| docs/design/screens/29_PRIVACY_ACCOUNT.md | v3/services/privacy/src/privacy.controller.ts, privacy.service.ts |
| docs/design/screens/30_DEVICE_SESSIONS.md | v3/services/identity/src/auth/auth.controller.ts, token/token.service.ts |
| docs/design/screens/31_ADMIN_PRIVACY_QUEUE.md | v3/services/privacy/src/privacy.controller.ts (AdminPrivacyController) |
| docs/design/screens/32_SEO_METADATA.md | v3/apps/web/app/layout.tsx, app/page.tsx (imagery fields) |
| docs/design/screens/33_FOOTER_LEGAL.md | v3/apps/web/components/app-shell.tsx (footer) |
| docs/design/screens/34_TYPOGRAPHY_VAZIRMATN.md | v3/packages/design-tokens/src/tokens.css |
| docs/design/screens/36_INTERNAL_CHAT.md | v3/packages/chat-contract/src/chat-contract.ts, v3/services/chat/src/chat.controller.ts, chat.service.ts, chat-access.service.ts, entities/chat.entities.ts, ports/chat.ports.ts, ADR-031, ADR-032 |
| docs/design/screens/37_ADMIN_CHAT_MODERATION.md | v3/services/chat/src/chat-moderation.controller.ts, chat-moderation.service.ts, ADR-032 §4 |
| Prototype - Customer.dc.html §18 گفتگوی داخلی | same as 36_INTERNAL_CHAT.md |
| Prototype - Pro and Admin.dc.html §17 صندوق گفتگو | same as 36_INTERNAL_CHAT.md |
| Prototype - Pro and Admin.dc.html §18 رسیدگی به گزارش‌ها | same as 37_ADMIN_CHAT_MODERATION.md |
| docs/design/screens/38_WISHLIST.md | v3/packages/wishlist-contract/src/wishlist-contract.ts, v3/services/wishlist/src/wishlist.controller.ts, wishlist.service.ts, wishlist.exceptions.ts, ports/wishlist.ports.ts, v3/services/search/src/search.controller.ts, v3/services/provider/src/provider.controller.ts, ADR-033, ADR-034 |
| Prototype - Customer.dc.html §03–§05 (save/unsave controls added) | same as 38_WISHLIST.md |
| Prototype - Customer.dc.html §19 فهرست علاقه‌مندی‌ها | same as 38_WISHLIST.md |
| docs/design/screens/01_SEARCH.md (saved field/control added) | same as 38_WISHLIST.md |
| docs/design/screens/02_PROVIDER_PROFILE.md (saved field/control added) | same as 38_WISHLIST.md |
| docs/design/screens/39_REFERRAL.md | v3/packages/referral-contract/src/referral-contract.ts, v3/services/referral/src/referral.controller.ts, referral.service.ts, referral.exceptions.ts, referral-reward.config.ts, referral-code.generator.ts, referral-qualification.service.ts, referral-reversal.service.ts, entities/referral.entities.ts, v3/libs/event-contracts/src/catalog/referral.events.ts, v3/apps/api/src/events/referral-qualification.handlers.ts, referral-reversal.handlers.ts, ADR-035, ADR-037, ADR-038 |
| Prototype - Customer.dc.html §20 معرفی دوستان | same as 39_REFERRAL.md |

Shared chrome for every screen: v3/apps/web/components/app-shell.tsx, kit.tsx (NavLink, ContextBand, PageHeader, StatCard, StatGrid, Badge, EmptyState, SegmentedControl), ui.tsx (Button, Input, Card, Alert), app/globals.css, packages/design-tokens/src/tokens.css.

## Screen map (addition)

| Project screen | Repo files |
| --- | --- |
| docs/design/screens/35_AI_ASSISTANT.md | v3/services/ai/src/ai.controller.ts, ai.exceptions.ts, ai-consent.service.ts, ai-conversation.service.ts, ai-quota.service.ts, providers/*, safety/ai-input-safety.ts, v3/packages/ai-contract/src/ai-assistant-contract.ts, docs/roadmap/v3/adr/ADR-029, ADR-030 |
| Prototype - Customer.dc.html §17 دستیار هوشمند | same as above |

## Screen map (logo exploration, no repo files — pure design-workspace brand work)

| Project screen | Repo files |
| --- | --- |
| BeauClick Logo Explorations — 10 Concepts.dc.html | none — standalone brand exploration, not built from repository source |

## Notes

Three token defects found while recreating and recorded in V3_DESIGN_SYSTEM.md: `--bc-radius-input` and `--bc-color-surface-muted` are referenced but never defined; `Alert` has no `info` variant, so informational messages render with success or error colours. Confirmed still present as of this sync.

### Resolved this sync

Imagery/portfolio (avatar, cover, portfolio gallery, verification-evidence upload) moved from BACKEND GAP to IMPLEMENTABLE NOW across search results, provider profile, pro profile, and admin verification — see `27_ADMIN_MEDIA_MODERATION.md` for the one net-new spec and the handoff's §22 for the full list.

Reviews and ratings (rating badge, review list + aggregate, professional reply, leave-a-review) moved from no-render to IMPLEMENTABLE NOW across search, provider profile, and bookings — see `28_ADMIN_REVIEW_MODERATION.md` and the handoff's §23. Reviewer display name is not resolved (still PRODUCT DECISION REQUIRED, by API design).

### Upstream routes with no project screen yet

New since the app tree was last walked — none of these have a recreation, prototype, or doc entry:

- `app/auth/page.tsx` — login/registration
- `app/providers/page.tsx` — services/providers list
- `app/waitlist/page.tsx`
- `app/notifications/page.tsx` — customer notifications
- `app/checkout/result/page.tsx`
- `app/sandbox-gateway/page.tsx`
- `app/pro/profile/page.tsx`
- `app/pro/services/page.tsx`
- `app/pro/analytics/page.tsx`
- `app/admin/users/page.tsx`
- `app/admin/settlements/page.tsx`
- `app/admin/search/page.tsx`
- `app/admin/audit-log/page.tsx`
- `app/admin/loyalty/page.tsx`
- `app/admin/notifications/page.tsx`
- `app/admin/phone-conflicts/page.tsx`

These line up with the backlog's "missing prototypes" list — worth prioritizing next.
