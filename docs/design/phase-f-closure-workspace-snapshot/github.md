repo: marabi766/BeauClick
branch: master
path: v3

## Last sync

date: 2026-08-29T23:05:00Z
commit: 226b14a441f1dfc1c4ee42b9831e51232d5ee14b (CI run 33238002176, green)

### Phase F closure sync — retry contract implemented (this pass, design workspace only — no repo write)

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

Shared chrome for every screen: v3/apps/web/components/app-shell.tsx, kit.tsx (NavLink, ContextBand, PageHeader, StatCard, StatGrid, Badge, EmptyState, SegmentedControl), ui.tsx (Button, Input, Card, Alert), app/globals.css, packages/design-tokens/src/tokens.css.

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
