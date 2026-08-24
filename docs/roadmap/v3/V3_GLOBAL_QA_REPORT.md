# V3 Global Product QA Report

**Pass:** Global product-wide stabilization QA, post-v3.0.0
**Date:** 2026-08-24
**Baseline:** `v3.0.0` → `cfecfdf` (annotated, published), branch `master` at `a83927b`
**Companion:** `V3_GLOBAL_UIUX_AUDIT.md` (visual/experiential findings)
**Verdict:** **V3 GLOBAL QA + UI/UX AUDIT — FIXES REQUIRED** (all fixes in this pass are landed; see §9 for what remains)

---

## 1. Git baseline

| Check | Result |
|---|---|
| Branch | `master` |
| `HEAD` at start | `a83927b` |
| `origin/master` | `a83927b` — in sync |
| `v3.0.0` target | `cfecfdf9789328066d53729c71bc7cd90a3cb126` |
| `v3.0.0` object type | annotated tag (`74024ab…`), published remotely |
| Historical tags | all nine V1/V2 tags byte-identical to their remote counterparts |
| Working tree at start | clean except one untracked file, `start-beauclick.vbs` |

`v3.0.0` was **not** moved, re-pointed, deleted, or re-signed. No historical tag was
touched. Every fix in this pass is a **new commit after** the tag (§10).

`start-beauclick.vbs` remains untracked and was deliberately left alone — it is a local
launcher, not a project artifact, and adopting or deleting it is not this pass's call.

---

## 2. Previous-audit reconciliation

Sources read in full: `V3_GAP_REGISTER.md` (649 lines, including all five phase
addenda and the final release gate), `V3_RELEASE_AUDIT.md`,
`V3_RELEASE_POLICY_EXCEPTIONS.md`, `V3_PAYMENT_SANDBOX.md`,
`V3_SECURITY_MODEL.md`, `V3_PHASE1–5_IMPLEMENTATION.md`, `PRODUCT_GAP_REGISTER.md`.

### Confirmed still true — not re-litigated

| Item | Status carried forward |
|---|---|
| `GAP-06a` sandbox lifecycle | RESOLVED / VERIFIED. Re-read the provider and checkout paths; the design holds (§5). |
| `GAP-06b` real gateway | **OPEN / EXTERNAL_CONFIGURATION.** Unchanged. No adapter, no credentials, none fabricated. |
| `EXC-001` | Active. Sandbox provider still fails closed under `NODE_ENV=production` with no override; re-read and confirmed. |
| `PHASE5-02` throttling | RESOLVED. Single registered throttler, per-route `@Throttle(policy(...))`, `/health` exempt. Structure re-read and confirmed. |
| `HOSTING_GRANTS` | EXTERNAL_CONFIGURATION. Still CI-only evidence (§8). |
| `GAP-10` provisional numerics | Unchanged business decision. |
| RBAC code-based, audit logging logger-based | Unchanged, deliberate. |

### Corrected

The register's Phase 5 note that local PostgreSQL is unavailable is **partly stale**:
PostgreSQL 16.15 *is* installed and listening on 5432 in this environment. What remains
true is the operative part — the `beauclick_app` / `beauclick_financial_writer`
credentials in `apps/api/.env` are stale, and `pg_hba.conf` requires `scram-sha-256`
for every local connection. Recovering access needs either the `postgres` superuser
password (not present anywhere in the repo) or an administrative single-user reset.
Neither was attempted: guessing credentials and editing `pg_hba.conf` are both outside
what this pass may do, and the brief forbids bypassing OS/security permissions.
Docker Desktop is installed but its daemon is still not running
(`dockerDesktopLinuxEngine` pipe absent).

**Net effect on evidence: unchanged from Phase 5.** The API still cannot boot locally,
so authenticated and payment browser QA remain CI-covered rather than browser-covered.
What *did* change this pass is that the **frontend was driven against a real production
build** rather than only a dev server (§8) — which is how three of this pass's findings
were caught.

### No regressions found

Every previously-fixed item that was spot-checked still holds: booking idempotency
under N-way concurrent retries (`BookingService.create`'s widened replay check),
the waitlist offer path, the single-flight refresh in `auth-context.tsx`, the
`SnakeNamingStrategy` conventions, and the four historical touch-target fixes.
One **new** instance of the touch-target bug class was found on a page added later
(§4, QA-13) — the class recurred, the previous fixes did not regress.

---

## 3. Scope reality check — audited surface vs. requested surface

The audit brief enumerates a product much larger than V3 currently implements. Auditing
requires saying which is which, so nothing is reported as "tested and passing" that does
not exist.

**Implemented and audited** — 13 services, 17 controllers, 15 frontend routes:
identity/auth/OTP, provider, search (+OpenSearch), booking, availability, waitlist,
commerce/orders/pricing, payment (sandbox), financial/ledger/settlement, loyalty,
journey, notification, analytics, business/staff.

**Not implemented in V3 at all** — verified by exhaustive search, not assumed:

| Brief domain | Evidence |
|---|---|
| AI (customer + professional) | No service, module, controller, or entity. Every filename match was a `.nx/cache` artifact containing the letters "ai". |
| Reviews | No entity, no write path. `booking.service.ts:383` says the completion event is what "later phases (loyalty, referral, **reviews**) **will** consume". `bc_moderate_reviews` exists as a capability with nothing behind it. |
| Referrals | No service/controller/entity. Only a loyalty ledger reason code and a notification category mention it. |
| Wishlist | Zero files. |
| CRM | Zero files. |
| Portfolio | Zero files (`GAP-23`, deliberately deferred). |
| B2B quotes | Only pricing-engine "quote" terminology; no quote domain. |
| Privacy export / deletion / anonymization | Only `confirm_deletion` as an OTP *purpose*. No export endpoint, no deletion endpoint, no anonymization path. |
| Admin UI | Zero admin pages. Admin **API** routes exist (analytics, finance, loyalty policy, notification status, search reindex), all `@RequireCapability('bc_manage_platform')`. |
| Professional dashboard / profile / services / availability UI | API only; no frontend surface. `/dashboard` is a shared 3-field identity page. |
| Business services / bookings / analytics UI | API only. |

These are **product gaps, not defects**, and most are already recorded (`GAP-12`,
`GAP-13`, `GAP-22`, `GAP-23`, `GAP-28`). They are restated here because a report that
silently omitted them would read as coverage.

**Consequence found (QA-18).** `provider_search_signals.ratingSum` and `.reviewCount`
have **no writer anywhere in the codebase** — confirmed by searching every insert,
update, and migration. Because the review domain does not exist, they are permanently 0.
Therefore `ratingAvg` is always 0, the `high_rating` ("امتیاز بالا") badge can never be
awarded, the ranking formula's rating term always collapses to its cold-start baseline,
and the `minRating` filter and `rating` sort in `SearchProvidersDto` match nothing
useful. The frontend does not currently expose `minRating` or the `rating` sort, which
limits blast radius to the badge and ranking quality. **MEDIUM / PRODUCT GAP.**

---

## 4. Findings

**26 findings: 17 fixed, 9 open.** IDs are `QA-nn`.

*(Corrected 2026-08-24 during the v3.0.1 reconciliation. This line previously read
"Fifteen defects found and fixed; ten found and reported" -- 15 was a count of landed
CHANGES, not findings (QA-03/04/05 shipped as one edit, QA-16/24 as another), and 25 was
an arithmetic slip. The finding list below was always complete; only the headline
arithmetic was wrong. See V3_0_1_RELEASE_RECONCILIATION.md section 0.)*

### Fixed this pass

| ID | Sev | Class | Finding |
|---|---|---|---|
| QA-01 | **HIGH** | BUG | Auth DTOs rejected Persian/Arabic-Indic phone digits — login impossible from a Persian keyboard (§5.1). |
| QA-02 | **HIGH** | BUG | OTP code never digit-normalized: a correct code typed in Persian digits was scored wrong **and burned an attempt**, reaching lockout in five (§5.1). |
| QA-03 | MEDIUM | UX | Search reported "نتیجه‌ای یافت نشد" when the request had *failed* — and announced it via `aria-live`. |
| QA-04 | MEDIUM | UX | Search showed a loading state only for the *first* search; every filter/sort/page change appeared inert. |
| QA-05 | MEDIUM | UX | Results from a previous successful search stayed on screen, unlabelled, after a later search failed. |
| QA-06 | **HIGH** | DATA INTEGRITY | Journey rendered its profile editor after a *failed* load, with empty fields over data that still existed; submitting sent `notes: null, budgetMaxToman: null` and destroyed the real profile. |
| QA-07 | MEDIUM | BUG | Business rendered the **create-a-business** form after a failed load, because a failed load and "you own nothing" are the same `null`. |
| QA-08 | MEDIUM | UX | Notifications and Waitlist asserted "you have nothing" after a failed load; no retry existed anywhere in the app. |
| QA-09 | LOW | UX | Dashboard rendered errors as bare text in a `Card` — no `role="alert"`, no retry, off the design system. |
| QA-10 | **HIGH** | SECURITY / DATA INTEGRITY | Payment verification compared amounts as bare numbers with **no currency/unit check** (§5.2). |
| QA-11 | MEDIUM | BUG | `markRead`'s ownership fallback paged **one row** of the user's notifications, so only the newest could be recognised as owned; re-reading any older already-read notification returned a wrong 404. |
| QA-12 | **HIGH** | UX / FINANCIAL | Checkout result had no copy for `duplicate_refunded`, so a **double-charged** customer was told "مبلغی از حساب شما کسر نشده است" (§5.3). |
| QA-13 | MEDIUM | ACCESSIBILITY | The payment result page's only two ways forward measured 18px against this project's own 44px baseline. |
| QA-14 | **HIGH** | SECURITY | Open redirect on `/sandbox-gateway` via an unvalidated `callback` parameter (§5.4). |
| QA-15 | MEDIUM | BUG | The sandbox page ignored `{accepted:false}` and redirected as success — reachable by double-clicking. |
| QA-16 | MEDIUM | UX | The **homepage** shipped in v3.0.0 still carrying Phase 1 scaffold copy telling visitors product pages would be built later. |
| QA-24 | LOW | ACCESSIBILITY | No `aria-current` anywhere; the nav gave no current-page cue to anyone. |

*(17 finding IDs, delivered as 15 discrete changes -- QA-03/04/05 landed together, as did
QA-16/24.)*

### Found, reported, not fixed

| ID | Sev | Class | Finding | Why not fixed here |
|---|---|---|---|---|
| QA-17 | MEDIUM | UX | `--bc-font-family` names **Vazirmatn** first, but the font is never loaded — no `@font-face`, no `next/font`, no font files, no `public/`. Every user without it installed silently gets a Latin-first system fallback for a Persian-only product. | Self-host (~100KB+ binaries) vs. CDN is a real deployment/network-policy decision, especially for Iranian users. Product call, not a mechanical fix. |
| QA-18 | MEDIUM | PRODUCT GAP | Rating signals have no writer; badge and ranking consequences (§3). | Requires the review domain. |
| QA-19 | LOW | UX | Auth has no resend-OTP affordance and no expiry countdown. The only recovery is "تغییر شماره موبایل" → retype the same number. | Small feature, needs the cooldown surfaced in the API response to do properly. |
| QA-20 | LOW | BUG | `GET /v1/auth/sessions` returns `current: false` hardcoded — a user can never tell which session is theirs. | No frontend consumes it yet; fixing needs a session identifier in the JWT. |
| QA-21 | LOW | UX | Backend distinguishes `cancelled_by_user` from `declined` (a `GAP-06a` deliverable), but the result page collapses both into "پرداخت انجام نشد". | Needs `failureCode` threaded through the redirect contract. |
| QA-22 | INFO | UX | Label maps fall back to raw English keys (`BADGE_LABELS[k] ?? k`). All five badge keys and all four price bands are currently covered, so nothing leaks **today**; a new backend key would surface English in a Persian UI. | Latent, not live. |
| QA-23 | MEDIUM | UX | No footer anywhere in the app — no contact, terms, privacy, or support route. | Content/legal deliverable. |
| QA-25 | LOW | UX | The "کسب‌وکار" nav link shows for every authenticated user regardless of business ownership. | Needs a capability signal in `/v1/me`. |
| QA-26 | INFO | PERF | `next dev` invalidates its own `?v=` stylesheet URL under rapid edits; the CSS then 404s and every design token silently disappears. Not a product bug — production is content-hashed and correct — but it made dev-server CSS auditing unreliable. | Tooling behaviour; documented so the next auditor does not chase it (as this one briefly did). |

---

## 5. Detail on the four highest-severity findings

### 5.1 QA-01 / QA-02 — the login door was closed to Persian keyboards

`canonicalizePhone()` (`phone.util.ts`) was written to accept Persian (۰–۹) and
Arabic-Indic (٠–٩) digits and documents that as its purpose. The `@Matches`
validator standing **in front** of it did not: `\d` in a JavaScript regex is
ASCII-only. Verified directly rather than reasoned:

```
"09123456789"   -> DTO @Matches: true
"۰۹۱۲۳۴۵۶۷۸۹"   -> DTO @Matches: false   (canonicalizePhone: +989123456789)
"٠٩١٢٣٤٥٦٧٨٩"   -> DTO @Matches: false   (canonicalizePhone: +989123456789)
```

The two layers genuinely disagreed, and the DTO ran first — so the canonicalizer's
Persian support was **unreachable over HTTP for the whole of V3**. BeauClick is
Persian-only by design (`V3_FRONTEND_ARCHITECTURE.md` §7: no language switcher exists),
so this is not an edge case; it is the product's single entry point refusing its own
primary audience.

The OTP **code** had the same root cause and a worse failure mode. `VerifyOtpDto.code`
is `@IsString() @Length(6,6)`, which Persian digits satisfy, and `OtpService` then HMACs
the string verbatim. `HMAC('۱۲۳۴۵۶') ≠ HMAC('123456')`, so a correct code retyped on a
Persian keyboard was scored **wrong** — and `verifyOtp` decrements `attemptsRemaining`
on a mismatch. Five attempts and the correct code is dead, with the deliberately generic
"کد وارد شده نامعتبر یا منقضی شده است" giving the user no way to work out why.

**Fixed** by folding both digit ranges to ASCII *before* validation, using
`normalizeDigits` from `@beauclick/persian-utils` — the same utility **search's own
DTO already applies**, for the same reason, stated there as *"one implementation of the
mapping, used both directions, so the two cannot disagree."* Auth simply never adopted
it. Validation still runs after the fold, so this widens accepted numeral systems and
nothing else.

**Covered by** `services/identity/src/auth/dto/otp-dto-normalization.spec.ts` — 9 cases,
including that a landline, a short code, and an over-long code stay rejected in **either**
numeral system. Confirmed failing (5 of 9) against the pre-fix code.

### 5.2 QA-10 — the amount check was unit-blind

`applyVerification` compared `providerResult.paidAmountToman === intent.amountToman`.
Both sides are bare numbers; the only thing asserting they meant the same unit was the
field's **name**. `VerifyPaymentResult` carried no currency at all.

This is a live trap for exactly the work `GAP-06b` still requires. Iranian gateway APIs
commonly denominate in **rials**, and 1 toman = 10 rials. An adapter passing the
gateway's own figure straight into `paidAmountToman` would settle a 200,000-toman order
for 20,000 tomans of real money — and **every existing amount-tampering test would still
have passed**, because both sides are just numbers.

The sandbox cannot surface this class of bug on its own: it is IRT by construction,
which is precisely the limitation the register already records against `GAP-06b`
(*"leaves the money-unit and field semantics of any actual gateway entirely
unexercised"*). So the contract was tightened now, while it is cheap, rather than after
an adapter is written against the looser one.

`VerifyPaymentResult.paidCurrency` is now documented as rule 3 of the provider contract;
verification requires it to be **present and matching**, so an adapter that reports no
currency **fails closed** rather than being assumed to mean tomans. The audit log records
expected and reported currency separately, because "wrong number" and "wrong unit" are
different investigations. The sandbox reports its own transaction row's currency rather
than a literal, and that column is now typed `CurrencyCode` rather than `string`.

### 5.3 QA-12 — a double-charged customer was told no money moved

`checkout.controller.ts` emits `status=duplicate_refunded` when a **second real charge**
lands on an already-paid order and is automatically refunded. `OUTCOME_COPY` had no entry
for it, so it fell through to `failed`: *"پرداخت انجام نشد — مبلغی از حساب شما کسر نشده
است."*

That is the opposite of what happened. The booking is confirmed and the customer's bank
statement will show two debits and a credit. Telling them no money was taken reads as a
failure, hides a real double-charge, and invites a support call or a chargeback for a
problem the platform had already fixed itself. Now reported as the success it is, naming
the duplicate charge and the automatic refund with a realistic settlement window.

### 5.4 QA-14 — open redirect on the sandbox gateway page

The sandbox checkout page took its return address from a plain query parameter and
navigated to it unchecked:

```
/sandbox-gateway?reference=x&callback=https://evil.example
```

renders a plausible BeauClick payment screen and then lands the visitor on someone
else's site — a ready-made phishing step with BeauClick's own domain in the address bar.

Critically, **this is not covered by the sandbox's production gate.** That gate disables
the payment *provider*; this is a static frontend route that renders regardless of what
the API decides. The page could not rely on the API's gate to be safe, and now validates
for itself: an exact origin match against the configured API, whose callback endpoint is
the only legitimate destination (built server-side in `SandboxPaymentProvider.initiate`).

Confirmed in a real browser against a production build: the forged callback renders a
refusal with **no payment buttons at all**, and the legitimate callback still renders the
full gateway page and its three decisions.

---

## 6. Domain-by-domain QA results

Legend: **CODE** = verified by reading the implementation and its tests;
**BROWSER** = verified live in a real browser; **CI** = covered by real-PostgreSQL
suites this environment cannot run; **N/I** = not implemented.

| Domain | Method | Result |
|---|---|---|
| **Authentication / OTP** | CODE + BROWSER | **2 HIGH bugs found and fixed** (§5.1). Design otherwise sound: HMAC-only storage, constant-time compare, atomic single-use consume, purpose scoping, anti-enumeration (identical response for expired / never-requested / wrong), independent phone+IP hourly limits, resend cooldown. Live-verified: network-failure error state renders correct Persian in `role="alert"` and re-enables the button. |
| **Session / refresh / CSRF** | CODE | Sound. httpOnly refresh cookie, refresh token never in `localStorage` (asserted by the app's own test), single-flight refresh guarding rotation-replay revocation, Origin-based CSRF on the cookie path only, `trust proxy` off so `X-Forwarded-For` is unspoofable. QA-20 (hardcoded `current: false`) is the only defect. |
| **Marketplace / search** | CODE + BROWSER | **3 state bugs found and fixed** (QA-03/04/05). Digit normalization, query cap (120), specialty-array cap, deep-pagination cap, out-of-order-response guard, 250ms debounce, combobox ARIA all correct. Rating filter/sort are structurally inert (QA-18). |
| **Provider / business profile** | CODE | Ownership sound. `ProviderOwnerResolver` / `BusinessOwnerResolver` / `BusinessManagerResolver` / `BusinessStaffSelfResolver` all resolve server-side from the session; forged ids collapse to `NotFoundOrNotYours`. **1 bug fixed** (QA-07). |
| **Booking** | CODE + CI | No new defects. Idempotency correct including the Phase 4 widened replay check (any failure with a key, not only a caught unique violation) — the N-way-retry case where losing callers never reach the key insert. `findByIdempotencyKey` is scoped by `customerId` **and** key, so no cross-customer replay. |
| **Waitlist** | CODE + CI | **1 bug fixed** (QA-08). Offer/accept/decline/expire ownership resolvers correct. |
| **Payment / sandbox** | CODE + BROWSER | **3 bugs fixed** (QA-10/14/15). Server-to-server verify, callback params never used as evidence, CAS on decide and refund, settlement reference minted only on the paid path, production gate with no override. See §7 for the sandbox/production boundary. |
| **Commerce / financial** | CODE + CI | No new defects. `MyFinanceController` takes **no** party argument anywhere; `myLedgerForOrder` filters to the caller's own party, so a foreign `orderId` returns an empty list rather than another party's rows. Admin cross-party surface is a separate controller and service, both `bc_manage_platform`. |
| **Loyalty / journey** | CODE | **1 HIGH data-integrity bug fixed** (QA-06). Journey goal updates are scoped by `userId` in the WHERE clause with compare-and-swap. |
| **Referral** | N/I | Not implemented (§3). |
| **Notifications** | CODE | **2 bugs fixed** (QA-08, QA-11). `markRead`/`markAllRead` scoped by `user_id`; preferences response is the true post-update state, not an echo, so a refused mandatory-category opt-out is visible. |
| **AI** | N/I | Not implemented (§3). |
| **Privacy / data controls** | N/I | Not implemented (§3). |
| **Admin** | CODE (API only) | No admin UI exists. All admin API routes carry `@RequireCapability('bc_manage_platform')`; verified by enumerating every controller route. |

---

## 7. Payment status — stated precisely

**SANDBOX VERIFIED** — the full lifecycle (initiate → redirect → decide → callback →
server-to-server verify → paid → booking confirmed → ledger entry → refund → ledger
reversal) is implemented, and is covered by `sandbox-payment-lifecycle.pg-spec.ts` and
`payment-security.pg-spec.ts` against real PostgreSQL **in CI**. This pass added three
cases to the latter (currency mismatch, missing currency, and an honest-path control so
the new check cannot pass by refusing everything). Those three are typecheck- and
lint-clean but **were not executed in this environment** — see §8.

**PRODUCTION PAYMENT NOT CONFIGURED** — `GAP-06b` remains OPEN /
EXTERNAL_CONFIGURATION. No real gateway adapter exists, no merchant credentials exist
here, and none were fabricated. A production deployment of this code has **zero enabled
payment providers** and checkout fails closed. Re-verified this pass: `isEnabled()`
returns false under `NODE_ENV=production` unconditionally, and no override flag exists.

QA-10 is a direct contribution to `GAP-06b` readiness: it removes a unit-confusion trap
that the sandbox is structurally incapable of catching, before an adapter can fall into it.

---

## 8. Test, build, and live-QA evidence

### Ran, green

| Gate | Result |
|---|---|
| `pnpm typecheck` (`--skip-nx-cache`) | **PASS**, 24 projects |
| `pnpm lint` | **PASS**, 0 errors — includes the Nx `enforce-module-boundaries` rule, which is what proves `identity → @beauclick/persian-utils` is a legal `scope:shared` dependency |
| `pnpm test` (`--skip-nx-cache`) | **PASS — 343/343** across 21 projects |
| `pnpm build` (`--skip-nx-cache`) | **PASS** |
| `next build` (production) | **PASS**, 16 routes |

**343 local tests pass, of which 21 are new in this pass** (9 auth-DTO normalization,
3 failed-load state, 9 sandbox open-redirect allowlist). Pre-pass baseline was 322.

Three new cases in `payment-security.pg-spec.ts` require CI's PostgreSQL and were
**not executed here**. They are typechecked (the API `typecheck` target covers `test/`)
and lint-clean; that is compilation evidence, not execution evidence, and is not
presented as more.

### Live browser QA — what was actually done

Driven in a real browser (`mcp__Claude_Browser`) against **`next build` + `next start`**,
not only the dev server. Switching to a production build was itself load-bearing: the dev
server's stylesheet URL 404s under rapid edits and silently drops every design token
(QA-26), which would have produced false findings.

Verified live:

- **Responsive/RTL sweep:** 8 routes × 4 viewports (375 / 390 / 412 / desktop) plus a
  12-route re-run after the final commit — **zero horizontal overflow, zero sub-44px
  touch targets, `dir="rtl"` and `lang="fa"` on every page**.
- **Error states:** submitting the login form with the API down produces the correct
  Persian message in `role="alert"` and re-enables the button.
- **QA-03/04 fix:** sampled the search page's live region across a filter toggle —
  `"" → "در حال جست‌وجو…" → settled`, and the false "نتیجه‌ای یافت نشد" is gone on failure.
- **QA-12 fix:** `?status=duplicate_refunded` now renders the correct headline and copy.
- **QA-13 fix:** both result-page links measure exactly 44px.
- **QA-14 fix:** a forged `callback` renders a refusal with **no payment buttons**; the
  legitimate callback still renders the full gateway page.
- **QA-16/24 fix:** the homepage no longer contains "فاز ۱"; `/search` reports
  `aria-current="page"` on جست‌وجو and `null` on the others.
- **Design tokens:** confirmed present in the production CSS
  (`--bc-color-primary: oklch(0.4 0.16 290)`, `--bc-font-family`), and the skip link
  correctly renders 1×1 with `clip: rect(0,0,0,0)`.

### Live browser QA — what was NOT done, and why

**Authenticated and payment-flow browser QA was not performed.** The API cannot boot
locally: it refuses without a working `FINANCIAL_DATABASE_URL` (correct fail-closed
behaviour per ADR-017), and the local role credentials are stale. Recovering them needs
the `postgres` superuser password (absent from the repo) or an administrative
single-user reset; Docker's daemon is not running. Guessing credentials and rewriting
`pg_hba.conf` were both declined as out of bounds.

So every authenticated assertion in this report is **CODE** or **CI**, never BROWSER,
and is labelled that way in §6. No authenticated browser testing is claimed.

One honest caveat on the sweep: `/bookings`, `/notifications`, `/journey`, `/loyalty`,
`/waitlist`, `/business` are protected routes, so unauthenticated they measure their
redirect/loading state rather than their populated state. Their populated layouts were
reviewed by **code**, not by browser.

### CI

**RUN AND GREEN** *(updated 2026-08-24, after this report's first draft)*. The eight
audit commits were pushed to `origin/master` and CI run **`32721273257`** executed
against `5833610`. All three jobs succeeded:

| Job | Result |
|---|---|
| `typecheck · lint · build` | **success** — typecheck 24 projects, lint clean (incl. Nx module boundaries), build 2 projects |
| `unit · pg-mem` | **success** — 21 projects |
| `real PostgreSQL · real OpenSearch` | **success** — **19 suites / 378 tests / 0 skipped** |

378 is exactly **+3** over the 375 the `cfecfdf` release gate recorded, which are the
three new `payment-security.pg-spec.ts` cases guarding QA-10. Their execution is directly
evidenced in the job log by the audit lines the new check emits:
`expectedCurrency: "IRT", reportedCurrency: "IRR"` (currency mismatch) and
`expectedCurrency: "IRT", reportedCurrency: null` (missing currency, failing closed).

The workflow's "Assert no suite was silently skipped" step also passed, so the 0-skipped
figure is enforced rather than merely reported.

*The original text of this section read "Not run for this pass ... the three new pg-spec
cases have never executed anywhere," which was accurate when written. It is superseded by
the run above.*

---

## 9. Classification summary

| Severity | Found | Fixed | Remaining |
|---|---|---|---|
| BLOCKER | 0 | — | 0 |
| HIGH | 5 | 5 | 0 |
| MEDIUM | 12 | 9 | 3 (QA-17, QA-18, QA-23) |
| LOW | 7 | 3 | 4 (QA-19, QA-20, QA-21, QA-25) |
| INFORMATIONAL | 2 | 0 | 2 (QA-22, QA-26) |
| EXTERNAL_CONFIGURATION | 2 | 0 | 2 (`GAP-06b`, `HOSTING_GRANTS`) |

Totals: **26 findings, 17 fixed, 9 open.** By class: BUG 7 - SECURITY 2 -
DATA INTEGRITY 2 - UX 10 - ACCESSIBILITY 3 - PERFORMANCE 0 - PRODUCT GAP 2
(plus the eleven unimplemented domains in section 3).

Per-item classification for every open finding -- and for each absent domain -- is in
`V3_0_1_RELEASE_RECONCILIATION.md`. Its conclusion: **zero open items are
v3.0.1-patch-eligible**, so the patch contains exactly the 17 landed fixes.

**No BLOCKER was found.** No finding in this pass invalidates `v3.0.0` as a tag or
`EXC-001` as a decision. The two HIGH security/data-integrity findings (QA-10, QA-14)
and the two HIGH auth findings (QA-01, QA-02) are all fixed.

---

## 10. Commits

All seven are **after** `v3.0.0`, on `master`, and **not pushed**.

```
083ed8d fix(v3): remove Phase 1 scaffold copy from the homepage, and mark the current page in the nav
36c4557 fix(v3): close an open redirect on the sandbox gateway page, and stop it ignoring a refused decision
aa94995 fix(v3): tell a double-charged customer the truth on the payment result page
a5a3617 fix(v3): check the CURRENCY of a verified payment, not just the number
f392a7b fix(v3): never show an empty state for data that failed to load
8d60715 fix(v3): stop the search page reporting "no results" when the search failed
fbdc6f8 fix(v3): accept Persian/Arabic-Indic digits at the auth DTO gate
```

29 files, +809 / −61. No `v3.0.1` tag was created — per the brief, that awaits explicit
authorization after this report is reviewed.

---

## 11. Recommendation

**Recommended next release: `v3.0.1`** — a patch release. Every change is a bug or UI
fix; no feature was added, no architecture changed, no public API contract broken except
the deliberate `VerifyPaymentResult.paidCurrency` tightening, which is additive
(optional field) and affects only the one provider that exists.

**Do not cut it until CI has run these seven commits**, specifically the three new
`payment-security.pg-spec.ts` cases, which have never executed. That is the one
outstanding verification this environment could not provide.
