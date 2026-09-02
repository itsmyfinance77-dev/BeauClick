# 39 — Referral — V3.2-C Story #14

Prototype: `Prototype - Customer.dc.html` §20. Route: `/referral`. Backend routes: `GET /v1/me/referral/code`, `POST /v1/me/referral/claim`. Both authenticated-only, no capability — same reasoning as `journey` and the customer half of `loyalty`/`wishlist`.

## Source read

Authoritative backend baseline: `itsmyfinance77-dev/BeauClick` `master@1e5f519177b4491662cb1a4c57eb2e9035934b69`. **Correction:** this commit/PR #54 was produced by Story #13 (the Referral adversarial test suite) — it is only the repository baseline this Story #14 *design* sync is read against, not the design story itself. Read in full: `packages/referral-contract/src/referral-contract.ts`, `services/referral/src/{referral.controller.ts, referral.service.ts, referral.exceptions.ts, referral-reward.config.ts, referral-code.generator.ts, referral-qualification.service.ts, referral-reversal.service.ts, referral.module.ts, entities/referral.entities.ts}`, `libs/event-contracts/src/catalog/referral.events.ts`, `apps/api/src/events/{referral-qualification.handlers.ts, referral-reversal.handlers.ts}`, ADR-035, ADR-037, ADR-038, `V3.2_DECISION_REGISTER.md` (`V32-DEC-016`–`019`, `033`, `034`). Confirmed via `github_get_tree`/search: no Pro/Admin referral controller, route, or manual-review surface exists anywhere in the repository — the capability catalog itself records manual review/appeals as `unscheduled` and explicitly not built (`V32-DEC-019`). No pre-V3 legacy referral frontend was found (unlike Wishlist/Chat, this is a net-new domain with no superseded contract to contradict).

## The central finding: only two routes exist, and neither reads status

This is the fact that shapes the whole design, and it is stronger than an ordinary gap list — the customer surface for Referral is not "each state is designed except one field"; **most of the ten requested states have no route at all**, not a route missing one field.

`ReferralController` mounts exactly two handlers:

- `GET /v1/me/referral/code` — mint-on-first-read, returns `{ code, inviteUrl, shareText, shareChannels }`. Idempotent; the code never changes; nothing here is a status.
- `POST /v1/me/referral/claim` — one-shot. Returns `{ attributedAt, expiresAt }` on success (**200**, not 201), a byte-identical refusal on **409** for all six eligibility causes, a **429** on the claimant's own spent hourly throttle, **400** on a malformed body, **401** unauthenticated.

There is no route that reads a referral's lifecycle status, a reward grant, a reversal, or a cap counter. `referral.referrals.status` (`pending | qualified | reversed`), `reward_grants`, `reward_reversals`, and `referrer_counters` are written by two internal event handlers (`BookingCompleted → qualify`, `OrderRefunded → reverse`) and read only by the privacy-export path (`ReferralSubjectDataContract`, a different surface, out of this story's scope) — never by an authenticated customer-facing read route. Confirmed by reading `ReferralModule`'s full provider/controller list and the two services end to end.

**The one exception, and it is real and implemented:** `ReferralQualified` v1 and `ReferralReversed` v1 each drive an in-app, opt-outable `referral` notification to both parties (`V32-DEC-033`, `ReferralQualifiedNotificationHandler`, `ReferralReversedNotificationHandler`). The four templates are genuinely implemented — `v3/services/notification/src/templates/template.registry.ts` defines all four, verbatim:

| Template key | Subject | Body/short | Deep link |
|---|---|---|---|
| `referral_qualified_referrer` | «دعوت شما به نتیجه رسید» | «یکی از دعوت‌های شما تکمیل شد.» | `/referral` |
| `referral_qualified_referee` | «دعوت شما ثبت شد» | «دعوتی که با آن ثبت‌نام کردید تکمیل شد.» | `/referral` |
| `referral_reversed_referrer` | «یکی از دعوت‌های شما لغو شد» | «به دلیل بازگشت کامل وجه سفارش مربوط، یکی از دعوت‌های تکمیل‌شده شما لغو شد.» | `/referral` |
| `referral_reversed_referee` | «دعوت شما لغو شد» | «به دلیل بازگشت کامل وجه سفارش مربوط، دعوتی که با آن ثبت‌نام کردید لغو شد.» | `/referral` |

This is a real, honest, already-implemented notification path — the existing generic Notifications surface (§18) genuinely delivers both facts to both parties today, deep-linked to `/referral`. What it does **not** do is create a persistent, re-visitable Referral status screen: a notification is read once and archived, not a status a customer can look up later. And one real, narrower limitation remains, confirmed by reading the event schema against the template's `requiredVars: []`:

**The notification body carries no variables**, deliberately — `requiredVars: []` on all four is documented in the registry itself as the mechanism keeping referral codes, phone numbers, display names, and points figures out of every payload. One real consequence follows: the qualification event's `referrerOutcome` (`awarded | disabled_zero | capped`) and the reversal event's outcome are real fields on the *event*, but neither reaches the *notification text* — so today's generic "یکی از دعوت‌های شما تکمیل شد" reads identically whether the referrer was awarded, saw the configured zero, or was capped that month. This is not a defect in the shipped generic flow; it is recorded below as `REFERRAL-NOTIFICATION-OUTCOME-VARS`, an **optional future enhancement**, not a blocker.

## What is designed as real (backend-observable today)

- **The share screen** — the customer's own code, invite link, and the three-channel share model exactly as the contract shapes it: `copy_code` and `copy_link` always present and unconditional; `native_share` shown only after a runtime `navigator.share` capability check, never a fallback. A cancelled/aborted native share is rendered as a user choice — no error banner, no failure toast, no "sent" claim of any kind, matching `V32-DEC-033` in terms.
- **The honest zero-reward disclosure**, shown permanently on the share screen rather than hidden or replaced with a sample figure. `REFERRAL_REWARD_DEFAULTS` (`referrerPoints: 0, refereePoints: 0`) is a static, decided configuration fact readable from the repository today — not a per-customer status behind a missing route — so it is stated plainly and is the one item from the ten-state list that belongs on the *always-visible* normal state rather than a conditional one.
- **The claim box** — offered unconditionally to every authenticated customer, with no attempt to pre-filter eligibility client-side. This is not a shortcut: `V32-DEC-019` deliberately makes the claim route the *only* oracle for all six eligibility facts (unknown code, revoked code, own code, already attributed, account too old, already booked), and a client that tried to hide the box for an "ineligible" customer would need exactly the read route that does not exist — and would leak eligibility information the server itself refuses to reveal. Client-side shape validation (`isReferralCodeShape`) still disables obviously-malformed submissions before they cost a throttle attempt, per the contract's own exported helper.
- **The claim result — success.** Renders the caller's own `attributedAt`/`expiresAt` from the 200 response as two labelled rows — «زمان ثبت» and «مهلت تکمیل نخستین رزرو» — both driven by the real response values, with the "90 days" language kept only as secondary explanatory text alongside them, never substituted for the exact `expiresAt` value. This is genuinely the *only* moment this information is ever visible; there is no later screen that can re-fetch it. Documented as a one-time reveal, not a persistent status, so the design does not imply a "my pending referral" page that could be revisited. `role="status"` on the panel.
- **The claim result — refused (409).** One fixed sentence, server-verbatim, identical regardless of which of the six causes triggered it: «این کد دعوت برای حساب شما قابل استفاده نیست.» No hint, no differentiated copy, no "did you mean" — a differentiated message would recreate the oracle the collapsed exception exists to prevent.
- **Throttled (429).** Server-verbatim: «تعداد تلاش‌های شما برای ثبت کد دعوت بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.» Shows the published `attemptsPerHour` (10). Deliberately shows **no countdown and no remaining-attempts count** — the backend returns neither, and a client-invented countdown would count down to a moment that can still fail (the docblock's own reasoning for a per-hour bucket).
- **Malformed code shape (folds into 409, by the server's own design).** Client-side catch via `isReferralCodeShape` before submission (uppercase, 10 chars, the exact 31-character alphabet) disables the submit button rather than spending a throttle attempt on an obvious typo; a wrongly-shaped code that reaches the server anyway is deliberately folded into the same collapsed 409 by the controller (its own docblock records why: a dedicated `@Matches` check at the DTO layer once echoed the submitted code into a 400 response body, leaking a bearer credential — so shape-checking was moved into the service specifically to avoid that).
- **Malformed request body — a genuinely distinct 400.** A non-string `code`, a missing `code` field, or a forged extra field (e.g. `refereeUserId`, `rewardAmount`) is refused by the global `ValidationPipe` (`whitelist`/`forbidNonWhitelisted`) before the service is ever reached. This is a structural violation, not an eligibility question, and is never folded into the 409 panel — shown as its own generic "درخواست نامعتبر است" state, reachable only by bypassing the client's own form (this prototype's UI cannot produce it through normal use).
- **Auth-required.** Both routes are authenticated-only; an unauthenticated visitor sees the existing safe-return login pattern already used by Wishlist/Journey, not a bespoke one.
- **Generic/network error.** The standard retry panel already used across this prototype.

## What is explicitly NOT designed, and marked BACKEND CONTRACT REQUIRED

Five of the ten requested states have no persistent, re-visitable data source and are not simulated with placeholder content. A single consolidated notice panel on the Referral screen names them instead of five fabricated mockups:

| Requested state | Why it cannot be designed as a persistent screen today |
|---|---|
| Pending qualification (persistent) | No read route. The only glimpse is the one-time claim response above; nothing re-fetches it later. |
| Qualified (persistent status) | No read route for a re-visitable status. The fact does reach the customer once, honestly, via the real `referral_qualified_referrer`/`referee` notification (see above) — that is real and designed; what does not exist is a Referral-screen status the customer can look up afterward. |
| Expired | Not even a stored state server-side — `expires_at <= now()` is a predicate the qualification compare-and-swap reads once, never a status any route returns. No notification path either. |
| Reversed (persistent status) | Same shape as Qualified: the real `referral_reversed_referrer`/`referee` notification delivers the fact once; no route makes it a re-visitable status. |
| Capped | No read route, **and** — even once one exists — today's notification carries no variable that could distinguish it from `awarded` or `disabled_zero` (`REFERRAL-NOTIFICATION-OUTCOME-VARS`, an optional future enhancement, not a defect in what ships today). |

None of the five is rendered as a fake screen with invented copy or a placeholder number. The notice panel states the one genuine route gap (`REFERRAL-STATUS-READ`) once, and separately notes the optional future notification enhancement — both as engineering annotations outside the simulated customer-facing UI, never as text an end user would see.

## Qualification and reversal copy discipline

Nowhere in the design does copy state or imply that registration, OTP verification, `BookingConfirmed`, or `OrderPaid` qualifies a referral — `V32-DEC-018` binds qualification to the referee's first `BookingCompleted` alone, and every string in this design that mentions qualifying says "completed booking," never "booking," "payment," or "registration." Reversal copy (confined to the BACKEND CONTRACT REQUIRED notice, since no reversal is otherwise customer-visible here) states only that a full refund can reverse a qualified referral — never a partial refund, never a cancellation (a booking that qualified a referral is `completed` and `LEGAL_TRANSITIONS` maps `completed` to no further transition, so cancellation-after-qualification is not merely undesigned, it is impossible). No customer-facing Referral terms/disclosure/legal copy is invented; the share sheet uses only the two contract-fixed strings (`REFERRAL_SHARE_TITLE`, `buildReferralShareText`), both already recorded in their own docblocks as engineering-authored placeholders pending the dependency ledger's legal-copy gate (blocker 16) — restated here, not re-approved.

## Cap and privacy rules, as designed

The capped outcome is never shown to the referee (the referee's own reward is independently evaluated and never depends on the referrer's cap, per `V32-DEC-019`'s owner correction) and never shown to the referrer with any detail beyond "capped" even if the read route existed — no remaining-slot count, no referee identity, no referee activity. Since no such surface exists today, this section is prescriptive for the day `REFERRAL-STATUS-READ` closes, not a live design. No save count, invite count, click count, or conversion count appears anywhere in what is built, per the same closed vocabulary the contract itself enforces (`V32-DEC-033` forbids share-tracking outright).

## Accessibility

- The two copy actions ("کپیِ کد" and "کپیِ پیوند") have distinct accessible names — never two buttons both labeled "کپی."
- A polite live region announces "کد کپی شد" / "پیوند کپی شد" after each copy; the native-share capability check itself never moves focus or announces anything, since its presence is silent capability detection, not an action.
- The claim submit button is genuinely `disabled` (not merely dimmed) while shape-invalid or while a request is in flight, and while throttled.
- Focus returns to the triggering control after a copy action or a dismissed refusal panel; the BACKEND CONTRACT REQUIRED notice is reachable in normal tab order but never auto-focused.
- The claim-code input carries a visible `<label for="referral-claim-code-input">` («کد دعوت دوست») plus `aria-describedby` pointing at its helper text — never a placeholder standing in as the accessible name.
- Success uses `role="status"`; the 400/409/429/generic-error panels use `role="alert"`; the loading skeleton carries `aria-busy="true"`.
- Every error/throttled/refused state pairs a heading and body text with a non-color visual treatment (its own panel background and border, not a bare color swatch) — no decorative icons are used in this pass, so none are claimed; status meaning is never carried by color alone.
- RTL: the invite link and the code itself render `dir="ltr"` inline within the RTL page (both are ASCII bearer strings — `unicode-bidi: isolate`, matching the existing `<code>` treatment used across this prototype for ids/routes), so neither reverses character order.
- Mobile (390): share actions stack into a single-column action list; the claim box moves below the share panel rather than beside it.
- The four real notification templates are shown as an illustrative-only callout in the design/state gallery *below* the live `/referral` screen, not as permanent content of the live page itself — the live page's own content ends at the claim box.

## Requirement → screen/state matrix

| Requirement | Screen / prototype section | State(s) |
|---|---|---|
| Invite/code/share (own code, both fallback channels always, native share capability-gated) | Customer §20 | normal, loading, error+retry, auth-required |
| Disabled-at-zero-reward disclosure | Customer §20 (part of the normal share panel) | always-visible, not conditional |
| Claim box (redeem a friend's code) | Customer §20 | normal (unconditionally offered) |
| Attributed (one-time claim success) | Customer §20 | success panel, immediately after `POST /claim` |
| Claim refused, all six causes collapsed | Customer §20 | one fixed 409 panel |
| Throttled | Customer §20 | 429 panel with published `attemptsPerHour`, no countdown |
| Malformed request body (non-string/missing `code`, forged extra field) | Customer §20 | distinct generic 400 state, never folded into the 409 panel |
| Pending qualification / Expired / Capped (persistent status) | Customer §20 (consolidated notice) | `BACKEND CONTRACT REQUIRED` — not simulated |
| Qualified/Reversed reaching the customer once | Customer §20 (notification-example callout) + existing Notifications §18 (unchanged) | real, implemented template copy, deep-linked to `/referral` |
| Qualified/Reversed as a persistent, re-visitable status | Customer §20 (consolidated notice) | `BACKEND CONTRACT REQUIRED` — not simulated |
| Keyboard/focus/RTL/mobile/live-region behaviour | Customer §20 | see Accessibility above |

## Backend gaps found (reported, not designed around)

- **`REFERRAL-STATUS-READ`**: no authenticated route reads a referral's lifecycle status, reward outcome, or the referrer's cap position. Five of the ten requested states (pending, qualified, expired, reversed, capped) have no *persistent, re-visitable* data source because of this single gap — even though qualified/reversed already reach the customer once via the real, implemented notification templates.
- **`REFERRAL-NOTIFICATION-OUTCOME-VARS`** *(optional future enhancement, not a blocker or defect)*: the four notification templates are real and implemented, but both notification calls carry `vars: {}` by design — so the outcome enum (`awarded | disabled_zero | capped` / `reversed | nothing_to_reverse`) cannot be spoken in the notification text without a producer-side change adding a variable. Recorded for a future decision, not required for this pass.

Neither blocks the real states (share, claim, refusal, throttle, and the two real notification paths) that this pass ships.

## Status classification

| Item | Status |
|---|---|
| Own code + invite link + share (copy_code/copy_link unconditional, native_share capability-gated), zero-reward disclosure, unconditional claim box, claim success/refusal/throttle/malformed(400)/auth-required | `IMPLEMENTED` (design), backend contract fully shipped (ADR-035, ADR-036 — the claim route ships under this baseline; PR #54/commit `1e5f519` is Story #13's adversarial suite over that same shipped contract) |
| Qualified/reversed notification, real copy, deep-linked to `/referral` | `IMPLEMENTED` — `template.registry.ts` defines all four templates verbatim |
| Pending/qualified/expired/reversed/capped as a persistent, re-visitable status | `BACKEND GAP` — `REFERRAL-STATUS-READ` |
| Notification's ability to express *why* (capped vs. disabled-zero vs. awarded) | `OPTIONAL FUTURE ENHANCEMENT` — `REFERRAL-NOTIFICATION-OUTCOME-VARS`, not a blocker or defect |
| `/invite/:code` anonymous landing page for a not-yet-registered friend | `PRODUCT DECISION REQUIRED` — the link format is fixed by contract, but no frontend route, capture-then-redirect-to-signup flow, or design exists for it; explicitly out of this pass's scope, not backend-blocked |
| Manual review, appeal, fraud score, or override of any referral outcome | Not built, `unscheduled` (`V32-DEC-019`) — no admin/pro surface designed, matching the audited capability catalog |

## Not built

Referral analytics of any kind (click/conversion counts, invite-sent counts), platform-sent SMS/email/push/social delivery (all externally gated, blockers 6/7), manual review/appeal/override, any Pro/Admin referral surface (none exists upstream), the `/invite/:code` anonymous landing page (product decision, not designed this pass), any reward amount other than the real configured zero, any referee/referrer identity disclosure beyond the caller's own two claim-result facts.
