# BeauClick team demo — feature matrix (application through #212 + approved demo extensions A/B)

Source: demo branch `codex/demo-2026-09-28` on top of `b2477a3`. Status legend:

- **LIVE** — real internal behaviour on the real API/DB.
- **SIM** — real internal behaviour; the external party is a labelled local simulator (sandbox bank, SMS inbox,
  logging e-mail, deterministic AI provider).
- **API-ONLY** — implemented in the backend at the baseline, **no web screen**; exercised through the API (seed/verify
  scripts) and visible only through its effects. Not presented as a working screen.
- **UNAVAILABLE** — not built at the baseline, or blocked by an external/legal gate; nothing pretends otherwise.
- **DEMO-EXT** — owner-approved demo-only extension (DEMO-DEC-001), not production-approved.

Roles: C customer · P professional · B business owner · S staff (manager/practitioner) · FR finance-read grantee ·
M moderator · O platform operator · A administrator. "Denied" = the refusal verified or to be verified in M3.
Evidence: `seed:<stage>` = produced through the real API by that seed stage; `verify:<script>` = scripted real-API
check; "browser" = real-browser verification after the owner installed root v3 (section below).

| # | Area | Feature | Web route | Roles (denied) | Seed / scenario | Status | Evidence so far |
|---|---|---|---|---|---|---|---|
| 1 | Identity | OTP request/verify, refresh, logout, sessions | `/auth`, `/account/devices` | all | 13 synthetic accounts | SIM (code via local inbox) | seed:identities; verify:otp-signin-smoke 4/4 |
| 2 | Identity | dev-login seam | — | — | never enabled | UNAVAILABLE by design (404 at ingress + API) | verify:otp-signin-smoke |
| 3 | Platform roles | operator/administrator bootstrap; moderator via audited API | `/admin/users` | A/O (O→moderator **403**; admin via API **403**) | seed:identities | LIVE | seed:identities denied-path evidence |
| 4 | Discovery | home, provider list/profile, portfolio, cities, specialties | `/`, `/providers`, `/providers/[id]` | public | 3 professionals, 18 synthetic images | LIVE | seed:sellers, seed:engagement |
| 5 | Search | search, facets, autocomplete, views; admin reindex/status | `/search`, `/admin/search` | public / A | index rebuilt via admin routes | LIVE | seed/reindex (projection 200, reindex 200) |
| 6 | Availability | bulk/single slots | `/pro/availability` | P, S | 231 bulk + short real-time slots | LIVE | seed:availability |
| 7 | Checkout | booking + payment through the sandbox bank (success / declined / cancelled), retry | `/providers/[id]`, `/sandbox-gateway`, `/checkout/result` | C | F1–F9 | SIM | seed:future-bookings |
| 8 | **A** | customer acceptance of the disclosed terms in web checkout; accepted terms in booking details | `/providers/[id]`, `/bookings` | C (other customer **404**) | governed pro1 | DEMO-EXT (LIVE) | verify:a-acceptance 9/9; web tests 6 new (mutation-verified) |
| 9 | Outcome policy | admin publish; **seller selection (screen 48)**; booking snapshot | `/admin/commercial/outcome-policy`, `/pro/outcome-policy` | A / P (cross-owner: generic 409, controlled) | synthetic policy, no legal cap/evidence | LIVE | browser (390): pro2 selects 24 h / none / 15 min / none with a reason → DB live assignment by pro2 → pre-selected after reload → customer then gets pro2's terms with an unticked box and payment closed; controlled cross-owner test (owner 200/200, requester authenticated, generic 409 `outcome_policy_assignment_unavailable`, row unchanged) |
| 10 | Cancellation | customer (timely, full refund) — **web**; seller cancellation (#161 default refund) — **API-ONLY: no cancel control on `/pro/bookings` at the baseline** | `/bookings` (customer) | C (other customer **404**) / P via API | F5–F7 | LIVE + SIM refund | browser flow: customer cancel → full refund in DB → pro cancelled tab; seller cancel exercised via API (seed, verify:b-replacement) |
| 11 | #212 | no-show declaration (governed, grace on DB clock, statement required) | `/pro/bookings` | P (other customer **404**) | 2 seeded + 1 real-time in browser | LIVE | browser flow: real-time slot → booking → "not yet" notice → after grace declared in UI → DB no_show + declaration; customer card shows "عدم مراجعه" (no remedy panel on a no-show card — observed) |
| 12 | #212 remedy "reschedule" | reschedule instead of the default refund (governed seller cancellation) | `/bookings` | C | — | LIVE code, **not demonstrable with the sandbox provider — owner exception needed to show it**. Exact contract: the remedy is offered only while the cancellation decision's `execution_status` is `pending` or `manual_required` (`customer-remedy-resolution.service.ts` ESCAPABLE set). `BookingCancelledRefundHandler` decides and then immediately executes the refund in the same handler; the sandbox provider declares `supportsAutomaticRefund = true` and returns a final `succeeded`/`failed` synchronously, so the decision leaves `pending` within milliseconds. It IS reachable in production shape when a provider has no refund API (`supportsAutomaticRefund = false` → refund `manual_required`, `payment.service.ts`) or a refund stays unfinished. Showing it here needs such a provider/sandbox mode = a baseline change outside A/B. Unrelated to B (B is a new booking after the refund, not a replacement of it). | code reading + DEMO-DEC-001 |
| 13 | **B** | durable replacement offer after provider cancellation (new booking, own terms/payment, refund continues) | `/bookings` | C (other customer **404**) | S1/S11/S12 offers | DEMO-EXT (LIVE + SIM payment) | verify:b-replacement 25/25 (also after restore); b-late-capture 4/4; web tests 8; browser: see below |
| 14 | Completion & reviews | complete (**web**); review writing (**API-ONLY**: no customer form); seller reply (**API-ONLY**); moderation hide (**web**) | `/pro/bookings`, `/admin/reviews` | P / C / M | E2–E5 | LIVE | browser: completion → loyalty; moderation hide. **API functional** (`evidence/api-only-exercise-*`): customer writes a review 201 (in the moderation queue), duplicate refused 409, another customer refused `REVIEW_NOT_ELIGIBLE`; seller reply 201 persisted + shown publicly, another professional 404 |
| 15 | Business | business profile, classification | `/business` | B (C denied) | salon | LIVE | seed:sellers |
| 16 | Business | locations, resources, resource requirements, staff location | — | B (manager 404 `NOT_FOUND_OR_NOT_YOURS`, finance reader 404) | 2 locations, 2 resources | API-ONLY | **API functional**: location create → suspend → reactivate; room resource create → retire; requirement `room` set → **a new booking of that service received 1 resource assignment** → cleared. Staff location: not exercised |
| 17 | Staff | phone invitations, accept, scoped grants (`finance_read`, `practitioner_chat`) | `/business`, `/dashboard` | B, S | manager, practitioner, finance reader | LIVE | seed:sellers, seed:governance |
| 18 | Workspaces | ownership-scoped workspace list (#210) | `/pro/*`, `/finance` | P/B | — | LIVE | browser: see below |
| 19 | Finance | summary, funds by state, orders, ledger (+ commission snapshot) | `/finance`, `/pro/finance` | P/B/FR (unrelated denied) | collected money in `pending` | LIVE | read via API (pro2: collected 1.8 M, pending 1.8 M) |
| 20 | Finance | settlements, settlement series (#255), admin settlement | `/finance`, `/admin/settlements` | P/B / A | none | LIVE screens, **no settled data**: release predicate (#174/`#43c`) not built, so nothing becomes settleable | seed:engagement (admin: outstanding = []) |
| 21 | Commercial admin | commission (R/W), plans/price schedules catalogue, control plane | `/admin/commercial/*` | A (O/M denied) | synthetic commission 10 % | LIVE | seed:commercial |
| 22 | Commercial seller | subscriptions/plan selection, credit purchases, collection-policy assignment | — | P/B | base workspace | API-ONLY | **API functional**: select D-7 v1 → `active` + history → cancel; another seller refused `SUBSCRIPTION_SELLER_NOT_ELIGIBLE` (generic; owner control 201). **Credit purchase: needs a plan with a credit price schedule — none exists; creating prices = inventing commercial values; paid credits #99 not built → owner exception.** **Collection-policy assignment beyond the default: no admin route creates a collection policy (none exist); SQL seeding is outside demo rules → owner exception.** |
| 23 | Commercial admin | settlement schedules, seller risk classes, legal evidence registry | — / `/admin/commercial` (evidence) | A | none published | API-ONLY / not seeded (no invented legal or settlement values) | api-only-evidence: all three 200 and **empty** |
| 24 | Verification | submit + synthetic evidence; moderator approve/reject; queue | `/pro/profile`, `/admin/verification` | P / M (C denied) | approved / rejected / pending | LIVE | seed:verification |
| 25 | Media moderation | abuse report, inspection, decision | `/providers/[id]`, `/admin/media` | C / M | 1 open report | LIVE | seed:engagement |
| 26 | Chat | conversations (customer↔professional, customer↔salon manager), report, moderation | `/messages`, `/pro/messages`, `/business/messages`, `/admin/chat-reports` | C/P/B/S / M | 3 threads, 1 report | LIVE | seed:engagement |
| 27 | AI assistant | recorded consent, conversation, recommendations | `/assistant` | C | 1 conversation | SIM (deterministic provider; disclosure copy pending legal V32-DEC-006) | seed:engagement |
| 28 | Loyalty | summary, history, tiers; admin policy | `/loyalty`, `/admin/loyalty` | C / A | completed bookings | LIVE (tiers/membership endpoints API-ONLY; **no membership plans defined**) | browser flow: completion → points 15→25 shown on `/loyalty`; api-only-evidence: tiers 200 (2), plans 200 (0) |
| 29 | Referral | code, claim, qualification | `/referral` | C (claim rules) | code claimed by another account | LIVE | browser (390): cust2's code created on first read; financeReader (the one eligible account: no completed booking) claims in the UI → DB pending attribution; a customer with a completed booking refused (no attribution); duplicate claim refused (**business rule**, not authorization); financeReader's first booking completed by pro2 in the UI → **referral `qualified`**; reward grants 0 points (LOYALTY_POINTS_REFERRAL_* unset; referee 0 by owner decision). Claim facts shown only at claim time (by design) |
| 30 | Wishlist | professionals and services | `/wishlist` | C | 3 items | LIVE | seed:engagement |
| 31 | Waitlist | join; offer accept/decline | `/waitlist` | C | fresh professional made in the UI | LIVE up to acceptance; **payment after acceptance: no supported path (F-8)** | browser (390): join, offer on cancellation, decline, second offer, accept → booking `pending`; **F-8: no order/payment intent is created by acceptance, the card shows "در انتظار پرداخت" with no pay control, the hold lapses** → owner exception |
| 32 | Journey | profile, goals, timeline | `/journey` | C | profile + goal | LIVE | seed:engagement |
| 33 | Notifications | centre, preferences, unread; SMS via inbox; e-mail logged | `/notifications`, `/admin/notifications` | all / A | event-driven | LIVE in-app; SIM SMS/e-mail | seed (event fan-out) |
| 34 | Privacy | export, deletion request/cancel, admin queue | `/account/privacy`, `/admin/privacy` | C / A | 1 export | LIVE | seed:engagement |
| 35 | Analytics & audit | pro analytics/series, admin analytics, audit log | `/pro/analytics`, `/admin`, `/admin/audit-log` | P / A | derived | LIVE | browser: see below |
| 36 | Content | terms, privacy policy, contact, support, SEO files | `/terms`, `/privacy-policy`, `/contact`, `/support` | public | — | LIVE (content as built; legal gates unchanged) | browser: see below |
| 37 | Customer orders list / my reviews | `/v1/me/orders`, `/v1/me/reviews` | — | C | — | API-ONLY | api-only-evidence: orders 200 (9 = DB), reviews 200 (1 = DB) |
| 38 | Roadmap | #174/#176/#177/#178/#179, #162 disputes, #180, #99 paid credits, #227/#228, #47 production rail, real SMS/AI/payment providers | — | — | — | UNAVAILABLE | — |

## Browser verification (2026-09-27, after the owner's manual install of root v3)

Real browsers only, no TLS bypass: the Claude desktop in-app pane and separate headless Microsoft Edge instances
(`verify/browser-sweep.mjs`, `verify/browser-flows.mjs`; per-persona throw-away profiles; no certificate flags).
Every sign-in is the real OTP flow. **A rendered page is not an exercised feature** — the classes below are kept
apart. A flow check has four kinds: `ui` (action + on-screen effect), `persist` (survives a reload and/or is in the
DB, read-only query), `other` (the counterpart role sees it), `denied` (a role that must not, cannot — API attempt
by a foreign persona, never to perform the feature itself).

### 1. Exercised through the UI (flows; evidence `E:\BeauClick-demo\evidence\flows-*`)

| # | Flow (width) | ui | persist | other | denied |
|---|---|---|---|---|---|
| 1 | sign-out (1280) | leaves account area | DB: session revoked server-side; protected page → `/auth` | — | — |
| 1 | `/account/devices`: sign out all other devices (1280) | other devices listed | DB: one active session left; this device stays signed in after reload | — | the second device → `/auth` |
| 1 | real OTP sign-in of 11 personas; refused request (cooldown) shows "تعداد درخواست‌ها بیش از حد مجاز است…" | ✓ | — | — | — |
| 5 | anonymous visitor types a search query (1280) | results incl. نگار رحیمی | — | after an admin index rebuild | — |
| 5 | admin: rebuild the index (confirm "اجرا کن") | ✓ | DB: index state changed | search answers | — |
| 6 | pro2 adds / deletes a single free time (1280) | ✓ | DB row created / deleted | customer sees ۰۶:۰۰ / no longer | pro1 refused (**409** SLOT_NOT_RELEASABLE; slot untouched) |
| 6 | pro2 adds / removes a service | ✓ | DB with typed values / soft-deleted | customer sees / no longer | pro1 **404** |
| 7 | payment **declined** → "تلاش دوباره" → success (1280) | result pages | DB: attempts failed→succeeded, order paid; listed after reload | pro2 sees it | — |
| 7 | payment **cancelled** at the bank | result `reason=cancelled_by_user` | DB: order not paid | — | — |
| 8 A | full A **at 390** (terms unticked → pay closed → tick → pay → accepted terms after reload; no overflow) | ✓ | DB snapshot | pro1 sees booking | other customer **404** |
| 10 | customer cancels (1280), dialog "بله، لغو کن" | ✓ | DB cancelled + full refund; "لغو شده" after reload | pro2's cancelled tab (weekday + time) | other customer **404** |
| 11 | real-time no-show: slot → booking → "not yet" notice → after start + 5 min grace, declared with the required statement | ✓ | DB `no_show` + 1 declaration; row status after reload | customer sees "عدم مراجعه" | other customer **404** |
| 13 B | **use at 390** (unticked terms, pay closed, fresh payment, no overflow) | ✓ | DB: one confirmed linked attempt; offer row settled `used` on the next read (DEMO-DEC-001 derivation) | — | other customer **404** |
| 13 B | **dismiss** (1280), confirmation says the refund continues | ✓ | DB `dismissed`, refund untouched; no booking control after reload | — | — |
| 14 | practitioner marks a past booking done | ✓ | DB completed | customer: "انجام شده"; loyalty 15 → 25 on `/loyalty` | customer **404** |
| 14 | moderator removes a review with a reason | ✓ | DB hidden, by moderator, with reason; left the queue | public reviews API no longer lists it | customer **403** |
| 15/17 | owner invites cust3 → cust3 accepts → grants finance-read → revokes (acknowledgement required) | ✓ | DB invited → active; grant live → revoked | cust3 sees the invitation; sees the salon finance space while granted | cust3 without / after the grant does not see it |
| 24 | moderator approves a pending verification with a reason | ✓ | DB approved, by moderator, with reason; left the queue | public profile shows "هویت تأیید شده" | customer **403** |
| 25 | moderator upholds an image report ("تأیید و حذف") | ✓ | DB report upheld; queue shrank by one | the image object is deleted (`deleted_at`, `taken_down_by`) | — |
| 26 | chat: customer writes, professional replies | ✓ | DB message; in the thread after reload | pro sees it; customer sees the reply | other customer **404** |
| 26 | moderator rejects a chat report with a reason | ✓ | DB rejected + reason; under "ردشده" after reload | — | customer **403** |
| 27 | AI assistant: one-time consent, new conversation, question → sandbox answer | ✓ | DB consent; question + answer stored; in the conversation after reload | — | — |
| 3 | admin grants "ناظر محتوا" to cust4 with a reason → cust4 signs in again → can moderate → admin revokes | ✓ | DB role added / removed | cust4 opens the moderation queue; audit log lists both | cust4 refused **immediately** after revoke (same session) |
| 21 | **INCIDENT (test driver, NOT coverage)** 15:11–15:12: create/draft/publish of acquisition, then the retire click hit the LIVE `demo-booking-commission@1` (too-wide row scope) | — | preserved evidence from `beauclick_demo_prev_1790522067919`: audit `commission_version_retired demo-booking-commission@1` 15:12:18; 0 orders after it | — | — |
| 21 | **strict rerun after the guarded restore**: acquisition create → draft ("nothing collected") → publish → retire, with the target's identity asserted before EVERY mutation (its own section "جذبِ مشتری — تاریخچهٔ نسخه‌ها", no booking-commission text) | ✓ | DB: `acquisition-standard@1` draft → published → retired by admin; **booking commission byte-identical after each step**; audit shows only acquisition actions | recovery checkout: browser order snapshots `demo-booking-commission@1` (1000 bp) | operator **403** |
| 30 | wishlist save (reached in-app) → listed → remove | ✓ | DB saved; gone after reload | — | — |
| 31 | waitlist end-to-end: cust4 registers as a professional **in the UI**, adds a service + one time; cust3 books it; cust2 sees "no free time" and joins; cust3 cancels → offer to cust2 → **decline**; second round → **accept** → booking (pending payment) | ✓ | DB waiting → offered → declined; waiting → accepted + booking | the offer appears on `/waitlist` | cust3 acting on cust2's entry **404** |
| 32 | journey: budget saved, goal added, marked achieved | ✓ | DB goal achieved, budget stored; goal after reload | — | — |
| 33 | notifications: read one, then all | ✓ | DB unread −1, then 0; persists after reload | — | — |
| 34 | privacy: export request (becomes ready; download offered — not clicked, no file saved), erasure scheduled (7-day window) then cancelled | ✓ | DB export ready; erasure pending → cancelled | admin privacy queue lists both (status only) | — |

### 2. Rendered only — seeded state displayed, no UI action (1280 and 390, 0 app console errors)

4 (`/providers` list, profiles, portfolio) · 9 (`/admin/commercial/outcome-policy`, `/pro/outcome-policy` — no
selection change made) · 19/20 (`/pro/finance`, `/finance`, `/admin/settlements` — empty by design) · 21 plans /
control-plane pages · 28 `/admin/loyalty` · 29 `/referral` (no code claimed in the UI) · 33 `/admin/notifications` ·
35 (`/pro/analytics`, `/admin`, `/admin/audit-log` — overflows at 390, F-1) · 36 (`/terms`, `/privacy-policy`,
`/contact`, `/support`) · `/admin/phone-conflicts` · `/pro/profile` edit (not saved) · `/account/devices` list only in
the device flow.

### 3. Not exercised in a browser — with the reason

| # | What | Why / evidence instead |
|---|---|---|
| 2 | dev-login | unavailable by design; curl 404 at ingress |
| 10 | seller cancellation | **no web control** at the baseline (API-ONLY; exercised via API by seed and verify:b-replacement) |
| 12 | #212 "reschedule instead of refund" | only while a refund is pending/manual; the sandbox executes refunds at once |
| 14 | customer review writing; seller reply | **no web form** at the baseline (API-ONLY). Seller reply: no reply exists in the data (api-only-evidence) |
| 16, 22, 23, 37 | business locations/resources, seller subscriptions/credits/collection policy, settlement schedules/risk classes/legal evidence, my orders/reviews | API-ONLY (no screen). Evidence: `evidence/api-only-*.json` — real GETs + DB counts; credit purchases refused **404 SUBSCRIPTION_SELLER_NOT_ELIGIBLE**; resource requirements **0 rows**; #23 all **empty** |
| 29 | claiming a referral code in the UI | not run |
| 9 | seller outcome-policy selection change | not run (would change the terms A depends on during the check window) |
| 38 | roadmap items | not built |

### Browser findings (baseline, not changed; each a proposal at most)

- **F-1** `/admin/audit-log` at 390: 473 px wide — `.before`/`.after` lack `overflow-wrap: anywhere` (proposal tested
  by injection only).
- **F-2** Provider page, FULL load while signed in: the provider is fetched before the session refresh, so a signed-in
  customer gets the anonymous "برای ذخیرهٔ … وارد شوید" link to `/auth`; in-app navigation shows the real save button.
- **F-3** Deleting another professional's free time is refused with **409 SLOT_NOT_RELEASABLE** ("assigned to an active
  booking") — correct refusal (owner-scoped delete), misleading reason.
- **F-4 (test-driver incident, not app)** the lifecycle flow's first retire click retired the LIVE booking commission (too-wide
  row scope). Real UI action by the administrator; reset by the guarded restore; guard added so it cannot recur.
- **F-5** 60-min slots offered for the 120-min service ("پایان تقریبی" = slot end).
- **F-6** Commission page frame visible to the operator; the API refuses the data (403).
- **F-7** Late capture after a hold lapse is labelled "duplicate" on the result page in one path.
- Customer's no-show card offers only "پیام" and "شرایط پذیرفته‌شده" (the #212 remedy panel appears on seller-cancelled
  bookings) — observation.


## Round 3 (2026-09-27 evening) — actions at 390, remaining gaps, owner exceptions

**Every UI flow group was re-run with actions at 390 px** (`--width 390`; evidence `evidence/flows-2026-09-27T15-37-04-787Z`,
`…16-17-46-251Z`, `…16-41-46-366Z`, `…16-59-51-028Z`): checkout variants, A, B use/dismiss, account, professional
(service, free time, completion, real-time no-show), moderation ×4, engagement, business, admin (role, index, strict
lifecycle), waitlist, recovery, referral, seller outcome selection — with the same ui/persist/other/denied checks. Driver
fixes made on the way are in the commits; denied checks no longer accept 401 (an expired API session is refreshed).

**Authorization evidence rules applied.** A refusal counts as cross-owner authorization only with: the exact status/code/
body, a control where the owner's identical valid request succeeds, an authenticated requester (not 401/429), and the target
unchanged. Generic-by-design refusals are named as such (`outcome_policy_assignment_unavailable` 409,
`SUBSCRIPTION_SELLER_NOT_ELIGIBLE` 404, `SLOT_NOT_RELEASABLE` 409 for a foreign slot with an owner-scoped delete,
`REVIEW_NOT_ELIGIBLE` 409). Business rules (duplicate referral claim, second review) are labelled rules, not authorization.

**New baseline findings (not changed).**
- **F-8** Waitlist acceptance creates the booking via `BookingService.create`, not checkout: no order, no payment intent,
  no pay control; the booking lapses with its hold.
- **F-9** "Sign out all other devices": when a signed-out device later returns (after the 10 s replay grace), its revoked
  token is treated as theft (`TokenService.handleUnclaimableToken` → `revokeAllForUser`) and the device that did the
  sign-out is signed out too (measured: 0 active sessions, remaining device → `/auth`).

**Needs an owner exception (not marked complete).**
1. #12 reschedule-instead-of-refund: needs a provider/sandbox mode without automatic refunds (baseline change).
2. #22 credit purchase (commercial prices + #99) and collection-policy assignment beyond the default (no admin route).
3. #23 settlement schedules / risk classes / legal evidence registry: legal- or finance-gated values (#174 not built) —
   reads are empty; nothing invented.
4. #28 loyalty membership: no admin route creates a plan; none defined.
5. #31 payment of a waitlist-accepted booking (F-8).
6. F-9 behaviour of "sign out other devices"; F-1…F-7 as listed above.
7. Not exercised at all: #16 staff-location assignment; dev-login (unavailable by design); profile W / team devices.

## Round 4 (2026-09-27 night) — owner-approved remediation ("همه اش را رفع کن")

Status legend: **CODE+TESTS** = implemented, real-PostgreSQL/web tests green on the final source, mutation-proved where
stated; **BROWSER PENDING** = desktop/390 flows run only after the new artifact is built and golden re-taken.

| Item | Fix (demo branch) | Evidence | Status |
|---|---|---|---|
| F-5 | Slot must be ≥ the service's duration: listing (`?serviceId`), claim (→ checkout), reschedule (`409 SLOT_TOO_SHORT_FOR_SERVICE`), waitlist matcher; web end label = start + duration | `service-duration-slot-fit.pg-spec` 12/12 (mutant: 6 fail, 4 controls pass); provider-profile 36/36 | CODE+TESTS; BROWSER PENDING |
| F-9 | `refresh_tokens.revocation_reason` written in the same UPDATE as `revoked_at`, never overwritten; intentional ends → 401 only; rotated/NULL → unchanged replay cascade | `refresh-revocation-reason.pg-spec` 10/10 incl. injected failure after the claim (documents: rotation is NOT crash-atomic); 2 mutants caught | CODE+TESTS; BROWSER PENDING |
| F-8 | Waitlist acceptance = checkout (offer CAS as the checkout claim), Idempotency-Key required, `{acceptedPolicy?}`, bank redirect; web panel with amount + terms | `waitlist-checkout.pg-spec` 12/12 (mutant caught); waitlist web 13/13 | CODE+TESTS; BROWSER PENDING |
| F-7 | Capture on a lapsed, never-collected order classified as a refund (same money path); "refunded" only when the refund row is `succeeded`, else `refund_pending` (new status; `duplicate_refund_pending` likewise) | `late-capture-classification.pg-spec` 5/5 (2 mutants caught); checkout-result 84/84; contract 13/13 | CODE+TESTS; BROWSER PENDING |
| F-3 | Foreign/nonexistent slot delete → generic `404 NOT_FOUND_OR_NOT_YOURS`; own booked slot keeps `409` | `professional-surface.pg-spec` (owner control + nonexistent identical body) | CODE+TESTS |
| F-6 | Commission page guard = `bc_manage_commercial_plans` | web 117/117 (operator refused, holder admitted) | CODE+TESTS; BROWSER PENDING |
| F-2 | Provider page reads per-caller state after the session is known | web 36/36 (mutant caught) | CODE+TESTS; BROWSER PENDING |
| F-1 | audit-log snapshots `overflow-wrap:anywhere` | CSS only | BROWSER PENDING (390) |
| #12/#212 | Sandbox decision "paid, bank without automatic refund" per transaction → refund `manual_required` → reschedule offered | `no-show-and-remedy.pg-spec` +3 cases (synthetic repro); sandbox page 6/6 | **BLOCKED by F-10** (unresolved correctness blocker: after the reschedule the `manual_required` refund row remains — see `E:\BeauClick-demo\F10-DECISION-PROPOSAL.md`); simulator itself works; not a passing scenario |
| #14 | Web: customer review form, `/pro/reviews` reply/edit, professional cancel | `demo-web-paths.spec` 9/9 | CODE+TESTS; BROWSER PENDING |
| #16 staff location | API-only exercise step (bind → slot carries branch → manager refused → restore) | script ready | PENDING (runtime) |
| #22/#23/#28 | Round-3 "no admin route" was WRONG for collection policy / price schedules / settlement / risk / evidence; blockers are owner/commercial/legal VALUES and #99/#176/#177; membership plans have no creation route | `E:\BeauClick-demo\GAP-INVESTIGATION-ROUND4.md` | OWNER DECISIONS |

Regression on the pre-F-7/F-3 source: 26 booking/waitlist/checkout/auth/outcome/remedy/payment suites, 956/956.

**Unresolved test evidence (not claimed pre-existing):** `services/booking/src/availability/delivery-location-boundary.spec.ts`
fails to run (`Cannot find module 'reflect-metadata'` at its line 1). Evidence gathered: `reflect-metadata` does not
resolve from `v3/services/booking/src` (MODULE_NOT_FOUND); the spec file, `services/booking/package.json`,
`services/booking/jest.config.js` and `pnpm-lock.yaml` are byte-identical to baseline `b2477a3`. A baseline run has NOT
been performed, so it stays UNRESOLVED until one confirms or refutes it.
