# 52 — Moderator landing inside the shared admin shell (#45; implemented by #264 and #265)

**Baselines:** as screen 51 (`master` `2e3da4a`, design `4b5b120`).
**Prototype:** `Prototype - Workspace Shell and Dashboards.dc.html` §S8–S10.
**Decision:** the product owner's approved moderator-experience recommendation **A** (V3.3 continuation brief, 2026-09-25): one shared admin shell, a capability-driven moderator landing, and safe inspection of reported media. The recommendation is recorded as an internal product decision. It is not Legal or privacy-counsel approval, and nothing here claims to be.
**Amends:** spec 20 (overview), spec 25 (admin bar), spec 27 (media decision panel). Specs 21, 28 and 37 are unchanged.

## 1. The problem this solves

`app/admin/layout.tsx` wraps all of `/admin` in `AdminGuard` with its default `bc_manage_platform`. The `moderator` role holds `bc_moderate_verification`, `bc_moderate_reviews`, `bc_moderate_media` and `bc_moderate_chat`, and **not** `bc_manage_platform` (`identity/src/rbac/capabilities.ts`). So a pure moderator is refused by the shell before any queue renders, even though each queue page and each API would admit them (#264). Relaxing the guard alone would land them on the overview, whose every read is `bc_manage_platform` and would fail.

## 2. Who sees what at `/admin`

The decision is made from `GET /v1/me.capabilities`, read live.

| Caller holds | `/admin` renders | Bar mode label | Destinations in the bar |
|---|---|---|---|
| `bc_manage_platform` (operator or administrator) | the **overview**, unchanged (spec 20) | «بیوکلیک — مدیریت» | exactly today's list, filtered by capability as today |
| ≥ 1 `bc_moderate_*`, **no** `bc_manage_platform` | the **moderator landing** (§3) | «بیوکلیک — بررسی محتوا» | «صف‌های بررسی» (`/admin`) plus **only** the queues held, in the fixed order verification · media · reviews · chat |
| none of the above | the existing no-access state | — | — |

`bc_manage_commercial_plans` without `bc_manage_platform` does not occur in the role map (administrator holds both), and this design does not invent a landing for it. If it ever occurs, the caller gets the no-access state for `/admin` and their commercial routes stay reachable through their own guards.

**Never offered to a moderator,** and never rendered for one even through a typed URL, because each route keeps its own guard and API refusal: the overview statistics, users and roles, the audit log, settlements and finance, privacy requests, search, notifications, phone conflicts, loyalty, every `/admin/commercial/*` page, and the control plane. `bc_manage_platform` is **not** granted to moderators.

**Scopes chip:** the bar's existing capability chips show only the caller's own `bc_moderate_*` labels («بررسی احراز هویت» …). For a moderator, «مدیریت پلتفرم» never appears.

## 3. The landing

Heading `h1` «صف‌های بررسی». One card per moderation capability **held**, and no card for a capability not held. There is no disabled card and no "you do not have access to…" list.

| Card | Held capability | Count source | Link |
|---|---|---|---|
| احراز هویت | `bc_moderate_verification` | `GET /v1/admin/verification/queue?limit=1` → `meta.pagination.total` | `/admin/verification` |
| گزارش تصاویر | `bc_moderate_media` | `GET /v1/admin/media/reports?limit=1` → `meta.pagination.total` | `/admin/media` |
| بازبینی دیدگاه‌ها | `bc_moderate_reviews` | `GET /v1/admin/reviews/queue?limit=1` → `meta.pagination.total` | `/admin/reviews` |
| گزارش گفتگوها | `bc_moderate_chat` | `GET /v1/admin/chat/reports` (default `status=open`) → `items.length`. **This route returns no total** | `/admin/chat-reports` |

**Count wording.** For the three paginated queues the card says the count as returned: «‹total› مورد در صف». For chat, which returns at most `limit` items and no total, the card says «‹n› گزارش باز» when `n` is below the limit and «دست‌کم ‹n› گزارش باز» when `n` equals it. It never implies an exact total the server did not return. A `0` renders as «صف خالی است» with the success treatment of spec 20's zero-queue rule. It is still a link, because a moderator may want to confirm it.

**Card states (each card independent):** loading (skeleton, `aria-busy`), zero, count, error (`role="alert"`, «تلاش دوباره», this card only), revoked (see §4).

**One capability.** A moderator holding a single moderation capability sees the landing with **one** card and a bar with two entries. There is no automatic redirect to the queue. A redirect would make the meaning of `/admin` depend on a capability count that can change live, and the back button would bounce. A one-card landing is truthful and stable, and the card is one keystroke from the queue. (If the owner prefers a redirect, it is a `router.replace` to the single queue with the landing as fallback. This is recorded as the one open presentational choice for #264.)

**Nothing else is on the landing:** no platform statistics, no audit excerpt, no user search and no finance.

## 4. Revocation, live

- `/v1/me` is re-read on entry to `/admin` and after any `403` from an admin route.
- A revoked capability's card disappears at the next `/v1/me` read. If its count request returns `403` first, the card switches to «دسترسی شما به این صف تغییر کرده است.» with no retry and no stale count, and `/v1/me` is re-read.
- A moderator whose last moderation capability is revoked gets the no-access state, not an empty landing.
- A queue page open while its capability is revoked follows screen 51 §2.4: data is cleared and one sentence is shown, with no retry.

## 5. Media inspection in the decision panel (#265)

Spec 27 draws a thumbnail in the queue and the full image in the decision panel. Today `GET /v1/admin/media/reports` returns `mediaObjectId` and no way to show it, so «تأیید و حذف» is disabled (#238). This design fixes the **states**. It does **not** define the route's shape: #265 defines it in Phase 2, following the existing protected pattern `GET /v1/admin/verification/:id/evidence` → `downloadUrl` minted per moderator by `issueProtectedDownloadUrl`. No field is invented here.

| State | Queue row | Decision panel | «رد گزارش» | «تأیید و حذف» |
|---|---|---|---|---|
| inspection URL loading | thumbnail skeleton | image skeleton, `aria-busy` | enabled | **disabled**: «تا نمایش تصویر، حذف ممکن نیست.» |
| image shown | protected thumbnail | protected full image, `alt` = «تصویرِ گزارش‌شده» (never the uploader's text) | enabled | **enabled**, and it opens the reasoned confirmation |
| image not addressable (object gone, private or foreign → shared refusal) | «تصویر در دسترس نیست» | same sentence, no cause | enabled | **disabled**, same reason |
| URL expired while open | — | the image errors, then one silent re-request. If that fails, the sentence plus «دریافت دوباره» | enabled | **disabled** until the image loads again |
| capability revoked | row cleared | panel cleared, screen 51 §2.4 | — | — |

**Decision rules (unchanged by this design, restated so an implementation cannot drop them):** reject is reversible and needs a reason. Uphold deletes the bytes, is **irreversible**, needs a reason, and goes through `ConfirmDialog` with `aria-describedby` on the consequence sentence «حذف تصویر برگشت‌پذیر نیست.». The server audits it transactionally. No URL, storage key, bucket, path or token is ever shown, copied, logged, put in an error message or put in an audit detail. The image is rendered from the protected URL only and is never downloaded as a file.

**No new access:** verification, review and chat moderators without `bc_moderate_media` get no card, no bar entry and no inspection. The inspection URL is minted for the requesting moderator only.

## 6. Accessibility and responsive

- Cards are a list (`ul`). Each card's title is an `h2` with one link whose accessible name carries the count («گزارش تصاویر، ‹total› مورد در صف»).
- 390: the cards stack full-width. The dark bar scrolls horizontally with `scrollIntoView({ inline: 'nearest' })` as built. There is no bottom bar (spec 25).
- 768 and 1280: a grid of up to four cards (`repeat(auto-fit, minmax(240px, 1fr))`). The order is fixed and never sorted by count.
- The dark bar's text and bronze accent keep ≥ 7:1 and ≥ 3:1 (V3_ADMIN_UX §6). The card text uses the light-surface tokens.

## 7. What #264 and #265 must prove (carried into Phase 2, not done here)

Administrator and operator experience byte-identical. A pure moderator reaches only their queues. A partial moderator sees only theirs. A moderator refused on every `bc_manage_platform` and `bc_manage_commercial_plans` route and page. Revocation effective on the next request. Foreign, missing or private media gets the shared refusal. The inspection URL expires and is bound to the moderator. No token, key, path or URL in logs, metrics, errors or audit. Uphold is impossible without a successful inspection. Reject still works.
