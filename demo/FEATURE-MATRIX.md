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
check; "browser" = Milestone 3 (desktop + 390 px) — pending the owner's manual CA install.

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
| 9 | Outcome policy | admin publish; seller selection (screen 48); booking snapshot | `/admin/commercial/outcome-policy`, `/pro/outcome-policy` | A / P | synthetic policy, no legal cap/evidence | LIVE | seed:commercial, seed:governance |
| 10 | Cancellation | customer (timely, full refund) and seller cancellation (#161 default refund) | `/bookings`, `/pro/bookings` | C, P | F5–F7 | LIVE + SIM refund | read-only DB check |
| 11 | #212 | no-show declaration (governed, grace on DB clock); remedy panel | `/pro/bookings`, `/bookings` | P / C | 2 real no-shows | LIVE | seed:elapsed |
| 12 | #212 remedy "reschedule" | reschedule instead of refund | `/bookings` | C | — | LIVE but only while the refund decision is `pending`/`manual_required`; sandbox executes at once, so not demonstrable | code + DEMO-DEC-001 |
| 13 | **B** | durable replacement offer after provider cancellation (new booking, own terms/payment, refund continues) | `/bookings` | C (other customer **404**) | S1/S11/S12 offers | DEMO-EXT (LIVE + SIM payment) | verify:b-replacement 25/25; late-capture (running); web tests 8 |
| 14 | Completion & reviews | complete, review (async eligibility), seller reply, moderation hide | `/pro/bookings`, `/providers/[id]`, `/admin/reviews` | P / C / M | E2–E5 | LIVE (seller reply API-ONLY: no web) | seed:elapsed |
| 15 | Business | business profile, classification | `/business` | B (C denied) | salon | LIVE | seed:sellers |
| 16 | Business | locations, resources, resource requirements, staff location | — | B | 2 locations, 2 resources | API-ONLY | seed:sellers, seed:governance |
| 17 | Staff | phone invitations, accept, scoped grants (`finance_read`, `practitioner_chat`) | `/business`, `/dashboard` | B, S | manager, practitioner, finance reader | LIVE | seed:sellers, seed:governance |
| 18 | Workspaces | ownership-scoped workspace list (#210) | `/pro/*`, `/finance` | P/B | — | LIVE | browser pending |
| 19 | Finance | summary, funds by state, orders, ledger (+ commission snapshot) | `/finance`, `/pro/finance` | P/B/FR (unrelated denied) | collected money in `pending` | LIVE | read via API (pro2: collected 1.8 M, pending 1.8 M) |
| 20 | Finance | settlements, settlement series (#255), admin settlement | `/finance`, `/admin/settlements` | P/B / A | none | LIVE screens, **no settled data**: release predicate (#174/`#43c`) not built, so nothing becomes settleable | seed:engagement (admin: outstanding = []) |
| 21 | Commercial admin | commission (R/W), plans/price schedules catalogue, control plane | `/admin/commercial/*` | A (O/M denied) | synthetic commission 10 % | LIVE | seed:commercial |
| 22 | Commercial seller | subscriptions/plan selection, credit purchases, collection-policy assignment | — | P/B | base workspace | API-ONLY | — |
| 23 | Commercial admin | settlement schedules, seller risk classes, legal evidence registry | — / `/admin/commercial` (evidence) | A | none published | API-ONLY / not seeded (no invented legal or settlement values) | — |
| 24 | Verification | submit + synthetic evidence; moderator approve/reject; queue | `/pro/profile`, `/admin/verification` | P / M (C denied) | approved / rejected / pending | LIVE | seed:verification |
| 25 | Media moderation | abuse report, inspection, decision | `/providers/[id]`, `/admin/media` | C / M | 1 open report | LIVE | seed:engagement |
| 26 | Chat | conversations (customer↔professional, customer↔salon manager), report, moderation | `/messages`, `/pro/messages`, `/business/messages`, `/admin/chat-reports` | C/P/B/S / M | 3 threads, 1 report | LIVE | seed:engagement |
| 27 | AI assistant | recorded consent, conversation, recommendations | `/assistant` | C | 1 conversation | SIM (deterministic provider; disclosure copy pending legal V32-DEC-006) | seed:engagement |
| 28 | Loyalty | summary, history, tiers; admin policy | `/loyalty`, `/admin/loyalty` | C / A | completed bookings | LIVE (membership/tiers endpoints API-ONLY) | browser pending |
| 29 | Referral | code, claim, qualification | `/referral` | C | code claimed by another account | LIVE | seed:engagement |
| 30 | Wishlist | professionals and services | `/wishlist` | C | 3 items | LIVE | seed:engagement |
| 31 | Waitlist | join; offer accept/decline | `/waitlist` | C | 1 entry | LIVE | seed:engagement |
| 32 | Journey | profile, goals, timeline | `/journey` | C | profile + goal | LIVE | seed:engagement |
| 33 | Notifications | centre, preferences, unread; SMS via inbox; e-mail logged | `/notifications`, `/admin/notifications` | all / A | event-driven | LIVE in-app; SIM SMS/e-mail | seed (event fan-out) |
| 34 | Privacy | export, deletion request/cancel, admin queue | `/account/privacy`, `/admin/privacy` | C / A | 1 export | LIVE | seed:engagement |
| 35 | Analytics & audit | pro analytics/series, admin analytics, audit log | `/pro/analytics`, `/admin`, `/admin/audit-log` | P / A | derived | LIVE | browser pending |
| 36 | Content | terms, privacy policy, contact, support, SEO files | `/terms`, `/privacy-policy`, `/contact`, `/support` | public | — | LIVE (content as built; legal gates unchanged) | browser pending |
| 37 | Customer orders list / my reviews | `/v1/me/orders`, `/v1/me/reviews` | — | C | — | API-ONLY | — |
| 38 | Roadmap | #174/#176/#177/#178/#179, #162 disputes, #180, #99 paid credits, #227/#228, #47 production rail, real SMS/AI/payment providers | — | — | — | UNAVAILABLE | — |
