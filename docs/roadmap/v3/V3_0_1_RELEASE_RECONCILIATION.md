# V3.0.1 Release-Fix Reconciliation

**Purpose:** separate genuine release-fix work from product roadmap gaps, so the patch
release contains exactly what a patch release should and nothing else.
**Date:** 2026-08-24
**Inputs:** `V3_GLOBAL_QA_REPORT.md`, `V3_GLOBAL_UIUX_AUDIT.md`, `V3_GAP_REGISTER.md`
**CI evidence:** run `32721273257` on `5833610` — **all three jobs green**

This is **not** a feature-development phase. Nothing here authorises implementing a
missing domain.

---

## 0. Correction to the audit's own headline count

The Global QA report's summary line said *"Fifteen defects found and fixed; ten found and
reported."* An exact ID census of both reports gives:

| | Count | IDs |
|---|---|---|
| **Total findings** | **26** | `QA-01` … `QA-26` |
| **Fixed** | **17** | `QA-01`–`QA-16`, `QA-24` |
| **Open** | **9** | `QA-17`–`QA-23`, `QA-25`, `QA-26` |

"15" was a count of **landed changes**, not findings — `QA-03`/`04`/`05` shipped as one
edit and `QA-16`/`QA-24` as another — and "25" was an arithmetic slip. The defect list
itself was always complete and correct; only the headline arithmetic was wrong. Recorded
here rather than quietly corrected, because this document exists to reconcile counts.

**No finding was missed, and no fix is missing.** 17 + 9 = 26.

---

## 1. Classification key

| Class | Meaning |
|---|---|
| **1 · FIXED** | Landed, pushed, CI-verified. |
| **2 · V3.0.1 PATCH-ELIGIBLE** | Small, low-risk, in-scope for *this* patch. |
| **3 · PRODUCT GAP — FUTURE WORK** | Real missing capability; needs a design/build phase. |
| **4 · BUSINESS DECISION** | Blocked on a human choice, not on engineering. |
| **5 · EXTERNAL CONFIGURATION** | Blocked on credentials/infrastructure outside this repo. |
| **6 · EVIDENCE-GATED** | Cannot be verified in the available environment. |
| **7 · INFORMATIONAL** | Recorded for awareness; no action implied. |

---

## 2. Findings already fixed — class 1

All 17 are in `master` at `5833610` and passed CI run `32721273257`.

| ID | Finding | Severity |
|---|---|---|
| QA-01 | Auth DTO rejected Persian/Arabic-Indic phone digits | HIGH |
| QA-02 | OTP code not digit-folded; correct code burned attempts to lockout | HIGH |
| QA-03 | Search claimed "no results" when the request failed | MEDIUM |
| QA-04 | Loading state shown only on the first search | MEDIUM |
| QA-05 | Stale results left unlabelled after a failed search | MEDIUM |
| QA-06 | Journey editor over failed load → saving destroyed the profile | HIGH |
| QA-07 | Business offered "create business" after a failed load | MEDIUM |
| QA-08 | Notifications/Waitlist asserted empty on failure; no retry anywhere | MEDIUM |
| QA-09 | Dashboard error as bare text, no alert role, no retry | LOW |
| QA-10 | Payment amount check had no currency/unit assertion | HIGH |
| QA-11 | `markRead` ownership fallback paged one row → wrong 404 | MEDIUM |
| QA-12 | Double-charged customer told no money was deducted | HIGH |
| QA-13 | 18px touch targets on the post-payment screen | MEDIUM |
| QA-14 | Open redirect on `/sandbox-gateway` | HIGH |
| QA-15 | Sandbox page ignored `{accepted:false}` and redirected as success | MEDIUM |
| QA-16 | Homepage shipped with Phase 1 scaffold copy | MEDIUM |
| QA-24 | No `aria-current` anywhere | LOW |

**5 HIGH · 9 MEDIUM · 2 LOW · 1 (QA-24) LOW.** No BLOCKER was found at any point.

---

## 3. Open findings — individually classified

### QA-17 · Vazirmatn named but never shipped → **4 · BUSINESS DECISION**

- **Current state:** `--bc-font-family: 'Vazirmatn', -apple-system, …`. No `@font-face`,
  no `next/font`, no `.woff/.woff2/.ttf/.otf` anywhere, no `public/` directory.
- **Evidence:** repo-wide search; production CSS confirmed to contain the token and no
  font source. Every user without Vazirmatn locally installed gets a Latin-first system
  fallback, on every screen, in a Persian-only product.
- **Why open:** the fix is not the code — it is choosing **self-host vs CDN**.
  Self-hosting adds ~100KB+ of binaries per weight to the repo and build. A CDN (Google
  Fonts) adds an external origin with genuine availability problems for an Iranian
  audience. That is a deployment and network-policy call.
- **In v3.0.1?** **No.** Adding binary assets or an external network dependency is not a
  patch-level change, and I cannot make the availability trade-off on the team's behalf.
- **Recommended phase:** V3.1 design/infrastructure. **Recommendation:** self-host a
  subset (Latin + Arabic, weights 400/600/700) via `next/font/local` — keeps it inside
  the build, no external origin, automatic `font-display`.
- **Note:** this is the highest visual-impact open item in the entire audit.

### QA-18 · Rating signals have no writer → **3 · PRODUCT GAP — FUTURE WORK**

- **Current state:** `provider_search_signals.ratingSum` / `.reviewCount` default to 0
  and are written by nothing.
- **Evidence:** searched every insert, update, and migration — no writer exists. The
  review domain does not exist (`booking.service.ts:383` describes reviews as something
  "later phases … will consume"). Therefore `ratingAvg` is permanently 0, the
  `high_rating` badge is unreachable, and ranking's rating term always collapses to its
  cold-start baseline.
- **Why open:** it is a downstream *consequence* of the absent Reviews domain, not an
  independent bug. Nothing can write a rating until something can capture one.
- **In v3.0.1?** **No.** Fixing it means building Reviews.
- **Recommended phase:** V3.1, bundled with Reviews.
- **Blast radius today:** limited — the frontend exposes neither `minRating` nor the
  `rating` sort, so the visible effect is a badge that never appears and slightly flatter
  ranking. Not user-breaking.

### QA-19 · No resend-OTP and no expiry countdown → **3 · PRODUCT GAP — FUTURE WORK**

- **Current state:** after requesting a code, the only affordances are the code field and
  "تغییر شماره موبایل". The server enforces a 300s expiry and a resend cooldown; neither
  is surfaced.
- **Evidence:** `apps/web/app/auth/page.tsx`; `OtpService` cooldown/expiry config.
- **Why open:** doing it properly requires the API to **return the remaining cooldown**
  so the button can show a countdown. Without that, a resend button just fails with a
  `RATE_LIMITED` the user could not have anticipated — worse than no button.
- **In v3.0.1?** **No.** It needs an API response-shape change, which is not patch-level.
- **Recommended phase:** V3.1 auth polish.
- **Honest note:** this is the strongest candidate for "should have been patch-eligible".
  It is excluded because the *good* version needs a contract change, and the cheap
  version would be a worse user experience than the current dead end.

### QA-20 · `GET /v1/auth/sessions` returns `current: false` hardcoded → **3 · PRODUCT GAP — FUTURE WORK**

- **Current state:** `auth.controller.ts` sets `current: false` on every row, so a user
  can never tell which session is the one they are using.
- **Evidence:** direct read of the controller.
- **Why open:** identifying the current session requires a session/token identifier in
  the JWT, which does not exist today.
- **In v3.0.1?** **No.** Token-claim changes affect every issued token.
- **Recommended phase:** V3.1, alongside a device-management UI (none exists — no
  frontend consumes this endpoint at all today, so the field currently misleads nobody).

### QA-21 · Cancel and decline conflated on the result page → **3 · PRODUCT GAP — FUTURE WORK**

- **Current state:** the backend distinguishes `cancelled_by_user` from `declined` — an
  explicit `GAP-06a` deliverable — and the sandbox offers them as separate buttons. The
  result page collapses both into "پرداخت انجام نشد".
- **Evidence:** `sandbox-payment.provider.ts` failure codes vs. `OUTCOME_COPY`.
- **Why open:** `failureCode` is not carried on the redirect; adding it changes the
  gateway-return contract that a real adapter will also have to satisfy.
- **In v3.0.1?** **No** — deliberately. This contract should be settled **once**, when
  the real gateway adapter is designed (`GAP-06b`), not changed twice.
- **Recommended phase:** V3.1, with the production payment adapter.

### QA-22 · Label maps fall back to raw English keys → **7 · INFORMATIONAL**

- **Current state:** `BADGE_LABELS[badge] ?? badge` and equivalents.
- **Evidence:** verified **not currently reachable** — all five ranking signal keys
  (`verified`, `high_rating`, `recent_activity`, `complete_profile`, `reliable`) and all
  four price bands are covered by the frontend maps.
- **Why open:** latent only. A future backend key would surface English in a Persian UI.
- **In v3.0.1?** **No.** There is nothing to fix; the maps are complete.
- **Recommended phase:** address structurally when Reviews/ranking adds signals — a
  shared enum or a lint rule, not a patch.

### QA-23 · No footer anywhere → **4 · BUSINESS DECISION** (with a product-gap component)

- **Current state:** `AppShell` is `<header>` + `<main>`. No `contentinfo` landmark;
  confirmed live (landmarks are exactly `HEADER, NAV, MAIN`).
- **Evidence:** `components/app-shell.tsx`; browser landmark inspection.
- **Why open:** the blocker is **content, not markup**. A footer's purpose is to link
  terms, privacy policy, contact, and support — none of which exist as documents. For a
  platform that takes payments and holds personal data, those are legal artifacts
  someone must author and approve.
- **In v3.0.1?** **No.** Shipping an empty footer shell, or one linking to 404s, is worse
  than shipping none.
- **Recommended phase:** V3.1, gated on legal/content sign-off.

### QA-25 · Business nav link shown to every authenticated user → **3 · PRODUCT GAP — FUTURE WORK**

- **Current state:** "کسب‌وکار" renders for all signed-in users regardless of whether they
  own or staff a business.
- **Evidence:** **verified this step.** A `business` role exists in
  `CAPABILITIES_BY_ROLE`, but `identity.users.roles` is **never populated dynamically** —
  confirmed by grep, and consistent with the register's standing note that RBAC is
  code-based and both `professional` and `business` are answered entirely by row
  ownership. So the frontend has **no signal at all** to condition the link on.
- **Why open:** it looks like a one-line conditional and is not. It needs either dynamic
  role population or a business-membership flag on `/v1/me`.
- **In v3.0.1?** **No.**
- **Recommended phase:** V3.1, with the dynamic roles/capabilities work
  (`V3_DATABASE_BLUEPRINT.md` §8).

### QA-26 · `next dev` invalidates its own stylesheet URL → **7 · INFORMATIONAL**

- **Current state:** under rapid edits the dev server's `?v=` CSS URL 404s, silently
  dropping every design token.
- **Evidence:** reproduced during the audit; **not** reproducible against `next build` +
  `next start`, where the production CSS was confirmed to contain all tokens.
- **Why open:** it is Next.js dev-server behaviour, not product code. Recorded because it
  cost this audit real time and would mislead the next person auditing CSS.
- **In v3.0.1?** **No — nothing to fix.**
- **Mitigation already landed:** the `beauclick-v3-web-prod` launch config, so UI audits
  run against a production build by default.

---

## 4. Absent product domains — classification

Each was verified **absent by exhaustive search**, not assumed. None is a defect; none is
patch-eligible; none may be implemented in this pass.

| Domain | Class | Current state / evidence | Recommended phase |
|---|---|---|---|
| **AI** (customer + professional) | **3 · PRODUCT GAP** | No service, module, controller, or entity. Every filename match was a `.nx/cache` build artifact. `bc_use_ai_assistant` exists as a capability with nothing behind it. Tracked as `GAP-12` (conversation cardinality) and `GAP-11` (provider never exercised live). | V3.1 — new domain |
| **Reviews** | **3 · PRODUCT GAP** | No entity, no write path. Consumed only as ranking signals that nothing writes (QA-18). `bc_moderate_reviews` exists unbacked. | V3.1 — **highest priority**, unblocks QA-18 and ranking quality |
| **Referrals** | **3 · PRODUCT GAP** | No service/controller/entity. Only a loyalty ledger reason code and a notification category reference it. Tracked as `GAP-28`. | V3.1 |
| **Wishlist** | **3 · PRODUCT GAP** | Zero files. Never scoped in any V3 phase. | V3.1 |
| **CRM** | **3 · PRODUCT GAP** | Zero files. V2 had one; not ported. Related: `GAP-16` (unbatched V2 implementation — do not port as-is). | V3.1 |
| **Portfolio** | **3 · PRODUCT GAP** | Zero files. `GAP-23` explicitly says V2's half-built version must be **redesigned, not ported**. Blocks marketplace imagery. | V3.1 — pair with imagery |
| **B2B Quotes** | **3 · PRODUCT GAP** | Only pricing-engine "quote" terminology; no quote domain. Related `GAP-19`. | V3.1+ |
| **Privacy export / deletion / anonymization** | **3 · PRODUCT GAP** | Only `confirm_deletion` as an OTP *purpose*. No export endpoint, no deletion endpoint, no anonymization. Tracked as `GAP-21`, `GAP-22`. | V3.1 — **carries regulatory weight**, should rank above cosmetic gaps |
| **Admin UI** | **3 · PRODUCT GAP** | Zero admin pages. Admin **API** exists and is correctly gated (`bc_manage_platform` on every route, verified by enumerating all controllers). Related `GAP-20`, `GAP-24`. | V3.1 |
| **Professional-specific frontend** (dashboard, profile, services, availability, bookings) | **3 · PRODUCT GAP** | API complete; **no frontend surface**. `/dashboard` is a shared 3-field identity page. This is the single largest UI gap — a professional cannot operate their business through the product at all. | V3.1 — **highest-priority frontend work** |
| **Marketplace imagery** (avatars, covers, portfolio) | **3 · PRODUCT GAP** | **Zero images in the entire product** — no `<img>`, no `next/image`, no `public/`. For a beauty marketplace, customers choose by looking; this is the most consequential product gap after the font. Depends on Portfolio. | V3.1 — pair with Portfolio |

---

## 5. Pre-existing register items — reconfirmed, unchanged

| Item | Class | Note |
|---|---|---|
| **`GAP-06b`** — real production gateway | **5 · EXTERNAL CONFIGURATION** | OPEN. Production-blocking. No adapter, no credentials, none fabricated. `EXC-001` waives it for the **tag** only, never for production payment enablement. **QA-10 reduced its risk surface** by making the amount check unit-aware before an adapter exists. |
| **`HOSTING_GRANTS`** — append-only ledger role contract | **6 · EVIDENCE-GATED** | Proven only against CI's ephemeral PostgreSQL 16 container, never a real target host. Local roles remain stale; Docker daemon still down. Deployment prerequisite, not a release blocker. |
| **`GAP-10`** — provisional numeric policy | **4 · BUSINESS DECISION** | OTP timings, hold windows, reschedule caps still V2 placeholders. Made visible via `GET /v1/admin/loyalty/policy`. |
| **`GAP-11`** — AI/SMS providers never exercised live | **5 · EXTERNAL CONFIGURATION** | Channels report `providerVerified: false`, so a logging provider can never be mistaken for a delivering one. |
| **Business service catalogue** | **4 · BUSINESS DECISION** | ADR-023's disclosed consequence. Not a defect. |
| **RBAC code-based; audit logging logger-based** | **3 · PRODUCT GAP** | Deliberate since Phase 1. Blocks QA-25. |
| **Throttler storage in-memory per process** | **7 · INFORMATIONAL** | At multi-instance scale the effective limit multiplies by instance count. Redis is the correct fix at that scale. |
| **`GAP-04`, `GAP-09`, `GAP-16`, `GAP-18`, `GAP-19`–`GAP-28`** | **3 · PRODUCT GAP** | Deferred domains, each individually justified in the register. |

---

## 6. Reconciliation result

| Class | Count |
|---|---|
| 1 · FIXED | **17** |
| 2 · V3.0.1 PATCH-ELIGIBLE | **0** |
| 3 · PRODUCT GAP — FUTURE WORK | 6 findings + 11 domains |
| 4 · BUSINESS DECISION | 4 |
| 5 · EXTERNAL CONFIGURATION | 2 |
| 6 · EVIDENCE-GATED | 1 |
| 7 · INFORMATIONAL | 3 |

### Nothing is patch-eligible, and that is a real finding rather than a convenience

Every open item was tested against one question: *can this be fixed correctly, at low
risk, without a contract change, a design decision, or a new domain?* All nine failed it,
and for specific reasons recorded above — QA-19 and QA-21 need API/redirect contract
changes; QA-20 needs a JWT claim; QA-25 needs a role signal that is never populated;
QA-17 and QA-23 need human decisions; QA-18 needs Reviews; QA-22 and QA-26 need nothing.

The two closest calls were **QA-19** (resend OTP) and **QA-25** (business nav link). Both
look like small UI fixes and both turn out to need backend signals that do not exist. In
each case the cheap version would be *worse* than the current state — a resend button
that fails unpredictably, or a nav link hidden by guesswork.

**Therefore `v3.0.1` should contain exactly the 17 landed fixes and nothing more.** The
patch is complete as it stands.

---

## 7. Recommended V3.1 priority order

Not authorised by this document — recorded so the sequencing argument is not lost.

1. **Professional-specific frontend** — the API is built; professionals currently cannot
   operate at all through the product.
2. **Reviews** — unblocks QA-18, ranking quality, and the `high_rating` badge.
3. **Portfolio + marketplace imagery** — a visual marketplace with no images.
4. **Privacy export/deletion** — regulatory weight.
5. **Vazirmatn (QA-17)** — cheapest high-impact visual fix once the hosting decision is made.
6. **Admin UI** — API already exists and is gated.
7. Footer/legal (QA-23), resend OTP (QA-19), then the remaining domains.
