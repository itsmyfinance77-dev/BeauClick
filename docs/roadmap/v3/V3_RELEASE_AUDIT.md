# V3 Release Audit — Phase 5

> **SUPERSEDED BY §18.** The Phase 5 decision below — *V3 RELEASE BLOCKED* — was correct
> when written and is preserved unedited as the historical record. It has since been
> **superseded by an explicit release-policy exception (EXC-001, 2026-08-23)**, under which
> `v3.0.0` was released. The blocker was never a code defect; it was an unmet policy
> criterion this phase was not permitted to waive on its own. See **§18** for the final
> release gate, and `V3_RELEASE_POLICY_EXCEPTIONS.md` for the decision itself.
>
> Read §3 below as *"why this blocked release under the original policy"*, not as the
> current status.

**Release decision (Phase 5, superseded): V3 RELEASE BLOCKED — PAYMENT CONFIGURATION REQUIRED.**

This is the mandatory outcome under this phase's own release-gate rule, applied honestly rather than argued around: real payment is a stated mandatory V3 release capability (§3 below), no gateway of any kind — sandbox or production — has ever been configured or verified in any V3 environment, and no credentials exist in this session to change that. Every other release condition genuinely passes; see §7 for the full account. No `v3.0.0` tag was created.

Baseline: Phase 4 at `582c606`, confirmed `HEAD == origin/master` at start. Ended at `250a720` (2 commits). V2/V2.4.1 untouched — zero diff against `wordpress/`, `app/`, `shared/` since `v2.4.1`. No historical tag touched, no `v3.0.0` tag created.

---

## 1. Gap reconciliation

Every gap in `V3_GAP_REGISTER.md`, reconciled against current evidence. **CLOSED** means independently verified by a real-PostgreSQL test in this session's CI run (342/342 passing) unless noted otherwise.

| Gap | Origin | Status | Code blocker? | External config? | Business decision? | Release impact |
|---|---|---|---|---|---|---|
| GAP-01 (ledger append-only) | V2 | **CLOSED** — real PostgreSQL role grants, `financial-integrity.pg-spec.ts` | No | No | No | None |
| GAP-02 (audit bypass, V2 PHP) | V2 | N/A to V3 — no PHP touched; V3's own audit discipline is convention-based (see §16 below), a deliberate, documented, DEFERRED design choice, not this gap recurring | No | No | No | None |
| GAP-03 (booking→order double-create) | V2 | **CLOSED** — `UNIQUE(source_type, source_id)`, `booking-lifecycle.pg-spec.ts` | No | No | No | None |
| GAP-04 (campaign usage-cap race) | V2 | DEFERRED — Campaign domain not yet built in V3 | No | No | Yes (is Campaign in scope at all?) | None (out of current scope) |
| GAP-05 (financial party isolation) | V2 | **CLOSED, structurally** — `financial-integrity.pg-spec.ts` §"cross-party isolation" | No | No | No | None |
| **GAP-06 (real payment gateway)** | V2 | **OPEN — EXTERNAL_CONFIGURATION, RELEASE-BLOCKING** | No | **Yes — merchant credentials** | No | **BLOCKS RELEASE (§3, §20)** |
| GAP-07 (V2 event contracts) | V2 | Superseded — V3 built its own real, executable contract registry (`libs/event-contracts`) from Phase 1 onward | No | No | No | None |
| GAP-08 (V2 ownership helper) | V2 | Superseded — V3's `OwnershipGuard`/`OwnerResolver` pattern exists from Phase 1 | No | No | No | None |
| GAP-09 (SEO) | V2 | DEFERRED — not yet built in V3 | No | No | Yes | None (out of current scope) |
| GAP-10 (provisional numeric policy) | V2 | DEFERRED, made visible — `GET /v1/admin/loyalty/policy` reports live values | No | No | **Yes — needs real business sign-off** | None (documented, not launch-blocking) |
| GAP-11 (AI/SMS never exercised live) | V2 | OPEN — EXTERNAL_CONFIGURATION, no SMS/AI credentials exist | No | Yes | No | Not release-blocking (no stated mandatory-launch criterion, unlike GAP-06) |
| GAP-12 (AI conversation cardinality) | V2 | DEFERRED — AI domain minimal in V3 | No | No | Yes | None |
| GAP-13 (flat staff model) | V2 | **PARTIALLY CLOSED** — Phase 4's Business/Staff domain (owner/manager/staff), `business-authorization.pg-spec.ts` | No | No | No | None |
| GAP-14 (LIKE-search) | V2 | **CLOSED** — real OpenSearch, `opensearch.pg-spec.ts` | No | No | No | None |
| GAP-15 (profile_view entity_type) | V2 | **CLOSED, structurally** — CHECK constraint | No | No | No | None |
| GAP-16 (unbatched ranking/CRM) | V2 | Moot for search (OpenSearch, per-event scoring); CRM not yet built | No | No | No | None |
| GAP-17 (no notification center) | V2 | **CLOSED** — `notification-delivery.pg-spec.ts` | No | No | No | None |
| GAP-18 (no automated payout) | V2 | DEFERRED, deliberately — additive to existing settlement, not built | No | No | Yes | None (not a stated mandatory-launch criterion) |
| GAP-19–GAP-28 | V2 | DEFERRED — domains/features not yet built in V3, each individually justified in the register | No | No | Various | None (out of current scope) |
| GAP-29 (Journey boundary) | V2 | **CLOSED on evidence** — ADR-019 | No | No | No | None |
| PHASE4-01 (CI runner assumption wrong) | Phase 4 | **CLOSED** — CI genuinely green, 342/342 | No | No | No | None |
| PHASE4-02 (stand-in role-contract test) | Phase 4 | **CLOSED this phase** — deleted (hazardous `DROP ROLE` collision confirmed), its unique reader-role coverage activated against the real ledger instead | No | No | No | None |
| PHASE4-03 (PG15+ public-CREATE grant) | Phase 4 | CI-side **CLOSED**; real target hosting still unverified | No | **Yes — real hosting provider** | No | Documented requirement, not blocking (CI proves the code-level fix works) |
| PHASE4-04 (booking idempotency gap) | Phase 4 | **CLOSED** — verified by the same test twice green | No | No | No | None |
| **PHASE5-01 (homepage CTA touch target)** | Phase 5 | **CLOSED this phase** — see §14 | No | No | No | None |
| **PHASE5-02 (`ThrottlerGuard` configured, never wired)** | Phase 5 | **OPEN — new finding, deliberately not fixed this phase** | Yes, but real risk to fix blind (§6) | No | No | Not release-blocking (OTP, the actual attack surface, has its own dedicated, tested, enforced limiter) |

**Nothing was silently closed.** Every CLOSED row above is backed by a named test file that ran green in this session's own CI run, not by assertion.

## 2. Hosting grants

Verified only against CI's ephemeral, freshly-provisioned PostgreSQL 16 container — never a real target hosting provider. This session additionally confirmed the local native PostgreSQL 16 install's `beauclick_app`/`beauclick_financial_writer` credentials in `.env` are stale (`password authentication failed`), and Docker Desktop, though installed, did not start in this environment (attempted; no process appeared after 10 minutes) — so no local real-Postgres alternative to CI was available either. **HOSTING_GRANTS = EXTERNAL_CONFIGURATION.** Not treated as proof of production readiness.

## 3. Payment gateway — why this specifically blocks release

Investigated rather than assumed. Two independent sources make real (or sandbox) payment a **stated mandatory** V3 capability, not a nice-to-have:

- `V3_GAP_REGISTER.md` GAP-06's own words: *"Explicit precondition for a real V3 launch, not merely a code gap."*
- `V3_IMPLEMENTATION_ROADMAP.md`'s Phase 2 acceptance criteria: *"a real booking flows through hold→confirm→pay (**sandbox gateway**)→complete→review."*

Neither has ever been satisfied, in any V3 phase, in any environment. Confirmed this session:
- `apps/api/.env`: `PAYMENT_DEFAULT_PROVIDER=mock`, no gateway credential of any kind present.
- `.env.example`: `ZARINPAL_MERCHANT_ID=` empty, same as it has been since V2.
- `payment.module.ts`: `MockGatewayProvider` is the **only** registered `PaymentProvider` — there is no second adapter waiting on a credential, there is no adapter at all.
- The mock gateway's own production gate (`isEnabled()`) correctly fails **closed** whenever `NODE_ENV=production` unless `PAYMENT_ALLOW_MOCK_GATEWAY=true` is explicitly set — verified in code and already covered by `payment-security.pg-spec.ts`. This is good engineering, and it is exactly why production has **zero** functioning payment providers today: the one honest, correct behavior available is refusal.

The code-level architecture is genuinely release-ready (§7) — provider abstraction, idempotent callback handling, server-to-server verification, amount-tampering rejection, refund handling, all real and tested. What is missing is a real adapter and real merchant credentials, and this phase's own instructions are explicit and non-overridable: no credentials were fabricated, no workaround was invented, and the mandatory-capability override in this phase's own rules is applied as written.

## 4. Security audit

Adversarial coverage, all proven against real PostgreSQL (not asserted):
- **Cross-business IDOR**: `business-authorization.pg-spec.ts` — a stranger gets an identical 404 whether a business exists or not (non-enumerable ids); Business B's owner cannot invite staff into Business A.
- **Consent bypass / privilege escalation**: an owner cannot accept a staff invite on the invitee's own behalf; a `staff`-role member cannot perform `manager`-role actions.
- **Cross-professional / cross-customer isolation**: `financial-integrity.pg-spec.ts`'s "cross-party financial isolation" suite — one professional's figures never appear in another's response, byte-for-byte.
- **Waitlist duplicate acceptance under a genuine race**: `waitlist-concurrency.pg-spec.ts` fires a waitlist accept and a competing direct booking with `Promise.allSettled` and no `await` between them — exactly one booking results, every time.
- **Refresh-token replay**: `auth-cookie.pg-spec.ts` — presenting an already-rotated token revokes the **entire session chain**, not just that token.
- **CSRF**: origin-validated on the cookie refresh path; rejected from a foreign origin, rejected on a header/cookie mismatch.
- **Amount tampering**: `payment-security.pg-spec.ts` — a gateway-reported success whose captured amount disagrees with what was owed is never treated as success.
- **Financial forged-ownership**: `MyFinanceService`'s every method takes a session user id and nothing else — there is no party argument to spoof (GAP-05's structural fix, still true).

**New finding, not fixed this phase (PHASE5-02):** `ThrottlerModule` is registered (`identity.module.ts`) but its guard is never wired to `APP_GUARD` — no endpoint anywhere gets generic per-IP flood protection. Investigated for a same-session fix and deliberately not applied: `ThrottlerGuard` rate-limits per requester IP, every real-Postgres test file shares ONE Nest app instance (and therefore one IP/throttle bucket) across dozens of `it()` blocks, and wiring this in globally without first adding a test-environment escape hatch (mirroring the existing `DISABLE_BACKGROUND_SWEEPS` pattern) risks tripping false 429s across the exact 342-test-green suite this audit relies on as evidence. The actual attack surface that matters most — OTP request flooding, the unauthenticated entry point — already has its own dedicated, tested, always-enforced limiter (`OtpService`'s `OTP_MAX_PER_PHONE_PER_HOUR`/`OTP_MAX_PER_IP_PER_HOUR`), independent of the unused generic guard. Recorded as a real, medium-severity, deliberately-deferred finding, not silently dropped.

## 5. Authentication audit

Full lifecycle proven in `auth-cookie.pg-spec.ts` and `real-postgres.pg-spec.ts`: OTP request/verify (with rate limiting), access token, httpOnly-cookie refresh token, rotation on every refresh, replay detection revoking the whole chain, logout revocation, CSRF validation, concurrent-refresh handled without destroying the session (the "benign race"), and the refresh token confirmed never returned on any route but login/refresh.

## 6. Business/staff audit

`business-authorization.pg-spec.ts`: owner/manager/staff permission boundaries, staff removal, cross-business access denial, forged business ids treated identically to nonexistent ones, and the consent invariant (an owner cannot self-grant a professional's earnings) proven end-to-end through real HTTP requests, not by calling the service layer directly.

## 7. Booking / waitlist / commerce / financial / event-outbox / search audits

All proven green in this session's CI run — see the 17-file real-Postgres suite inventory in `V3_PHASE5_IMPLEMENTATION.md` §2 for the exact file-by-file mapping to each domain the brief asks about (booking concurrency, waitlist race safety, payment security, financial integrity/settlement/refund-reversal, transactional-outbox rollback and exactly-once delivery, financial-outbox consumer, OpenSearch Persian normalization/fuzzy matching/autocomplete). Nothing in this list was newly written this phase; it was inherited from Phases 2–4, re-verified, and (for the two items in §1's CLOSED/reconciled rows) genuinely fixed where it had never actually passed before.

## 8. Frontend / live QA

Unauthenticated surfaces verified in a real browser this session: all 11 top-level routes return 200; zero horizontal overflow at 375/390/412px across every route; RTL (`dir="rtl"`, `lang="fa"`) confirmed at the document level on every route checked; zero images without `alt`, zero buttons without an accessible name, zero unlabeled inputs, on every route sampled. One real, minor accessibility finding was found and fixed in-session (§14). Authenticated flows (create a business, invite/accept staff, join/accept a waitlist offer) were **not** driven through a browser — no working local PostgreSQL credentials existed for the local API to connect to, and Docker Desktop did not start when launched — and are instead exercised end-to-end (HTTP layer included, via `supertest`) by the real-Postgres suites that did run, for real, in CI.

## 9. Performance

No N+1 in any audited read path. Waitlist matching is one indexed query with `LIMIT 1`. The financial-outbox relay drains in bounded batches. No new performance-impacting code was introduced this phase — this was an audit-and-close phase, not a feature phase.

## 10. Test matrix

- TypeScript: clean, all 24 projects.
- ESLint (incl. Nx module boundaries): clean.
- Unit/pg-mem: 26 tests, all passing.
- Real PostgreSQL + OpenSearch: **342/342 passing**, 17 suites, 0 skipped.
- Frontend build: clean (Next.js, 14 static/dynamic routes).
- Frontend unit tests: 33 passing.
- PHP lint: not executed against changed code, because **zero PHP files changed** since `v2.4.1` (confirmed by diff) — phpcs findings against `wordpress/` are pre-existing V2 state, not a V3 release concern.
- CI: genuinely green, verified via `gh run view`, not asserted.

## 11. Bugs discovered and fixed this phase

1. **The stand-in `financial-role-contract.pg-spec.ts` artifact** (Phase 4, PHASE4-02) — investigated fully: its own setup script opens with `DROP ROLE IF EXISTS beauclick_financial_writer/reader`, the same names the real, CI-provisioned `financial-roles.sql` creates — a genuine collision, not a hypothetical one. Deleted, and its one piece of real unique coverage (the read-only role) was found to already exist, dormant, inside `financial-integrity.pg-spec.ts` — activated by wiring `TEST_FINANCIAL_READER_URL` into CI, which the role-provisioning step had already prepared a password for. Net effect: coverage strengthened, not weakened.
2. **Homepage login CTA had no real touch target** (21×135px, no `Button` styling at all) — found during the accessibility pass, fixed to match the app's own established `minHeight: 44` convention, verified in a real browser (now 44–53px depending on font metrics), zero overflow introduced.

## 12. Bugs discovered, NOT fixed (deliberately)

- ~~**PHASE5-02**: `ThrottlerGuard` never wired globally~~ — **RESOLVED in a later authorized pass.** See §17 below.

## 13. Remaining limitations

Unchanged from Phase 4 except where this phase's own audit closed something: GAP-06 (payment) remains the release blocker; hosting grants remain unverified against a real provider; Business still cannot own an independent service catalogue (ADR-023's deliberate scope line, unchanged); RBAC remains code-based and audit remains structured-logger-based platform-wide (deliberate, unchanged); `ThrottlerGuard` is configured but unwired (new this phase, PHASE5-02).

## 14. Homepage touch-target fix, in detail

`apps/web/app/page.tsx`'s only interactive element — a `next/link` to `/auth` with `style={{ fontWeight: 600 }}` and nothing else — measured 21×135px in a real browser at 375px, well under the 44px minimum this codebase's own `Button` component already documents and enforces (`minHeight: 44, // accessibility: comfortable touch target on mobile`), and the exact class of bug Phase 2 already found and fixed once (`PHASE2-06`, 25px header nav targets). Fixed by matching `Button`'s own sizing convention directly on the link (no new shared component invented for one use site). Reviewed and deliberately left alone: the site-wide header nav's own "ورود" link (44px tall, ~30px wide) is a **documented, deliberate, uniform** convention across every nav item — `app-shell.tsx`'s own comment explains the 375px-wrap tradeoff — not a regression to chase.

## 15. External configuration required before release can be reconsidered

1. Real (or sandbox) Iranian payment gateway merchant credentials — the sole release blocker.
2. A real target PostgreSQL hosting provider, to re-verify PHASE4-03's grant fix and the append-only role contract outside CI's ephemeral container.
3. (Non-blocking, GAP-11) Real SMS/AI provider credentials, if those channels are wanted live before launch.

## 16. Business decisions still open

GAP-10's provisional numeric policy sign-off; whether GAP-04/09/12/18–28's deferred domains are in scope for a near-term release or genuinely later; whether `ThrottlerGuard` (PHASE5-02) should be enabled globally now (requiring the test-harness escape hatch first) or deferred further.

---

**Commit range this phase:** `582c606` → `250a720` (2 commits: `25371a3`, `250a720`). **Git status:** clean, `HEAD == origin/master`. **No `v3.0.0` tag exists.**

---

## 17. PHASE5-02 — RESOLVED (later authorized pass)

Global rate limiting is now enforced. Full design rationale lives in `V3_SECURITY_MODEL.md` §13; what matters for this audit:

**The finding recorded in §4 was correct but understated.** It said the guard was "never wired" — true — but the audit did not check whether route-level `@Throttle` decorators existed. They did: `request-otp`, `verify-otp`, and `refresh` each carried one. Without a registered guard those decorators were **inert metadata**, which is worse than no protection, because the source reads as though those routes are limited. A reader auditing `auth.controller.ts` alone would reasonably have concluded the auth surface was rate-limited. It was not.

**A second defect would have defeated a naive fix.** `ThrottlerModule.forRoot()` is not `@Global` in v6 and was configured in `IdentityModule`, so simply adding `{ provide: APP_GUARD, useClass: ThrottlerGuard }` to `AppModule` would have failed to resolve `ThrottlerStorage` at boot. Both defects had to be fixed together.

**The §4 deferral reasoning is superseded, and the concern it raised was legitimate.** §4 declined to fix this blind because global throttling could trip false 429s across a suite that shares one app instance and IP. That risk was real. It is resolved properly rather than avoided: the guard stays **fully active in every test suite**, with only the *limits* raised via environment overrides, and a dedicated `throttling.pg-spec.ts` boots its own app with deliberately tiny limits to prove enforcement. A `DISABLE_THROTTLING` switch was explicitly rejected — an off switch is precisely why this went unnoticed for four phases.

**Regression-proofing.** The new suite asserts the guard is registered *structurally*, not only behaviourally. Removing the `APP_GUARD` line fails the suite even though every high-limit behavioural test would still pass — which is exactly the blind spot that let the original gap survive.

**Live QA limitation, stated plainly.** Browser/HTTP throttling verification against a locally-running V3 app was **not** performed: the API refuses to boot without `FINANCIAL_DATABASE_URL` (correct fail-closed behaviour per ADR-017), the local PostgreSQL credentials remain stale, and the credential-recovery runbook is blocked by this environment's permission policy. The strongest available evidence is used instead, and it is genuinely strong: `throttling.pg-spec.ts` boots the **real `AppModule`** against **real PostgreSQL** in CI and drives **real HTTP** through supertest — the same stack a browser would hit, minus the browser.

**Release impact: none.** This closes a medium-severity security gap. GAP-06b (real production payment gateway) remains the sole release blocker.

---

## 18. Final release gate (2026-08-23) — v3.0.0 RELEASED under EXC-001

**Release decision: V3.0.0 RELEASED — SANDBOX PAYMENT RELEASE EXCEPTION ACTIVE.**

This section supersedes the Phase 5 decision at the top of this document. Nothing in the
underlying engineering changed to make it possible; what changed is that the release-policy
question §3 identified — and deliberately refused to answer on its own authority — has now
been answered explicitly by the project owner and recorded as **EXC-001** in
`V3_RELEASE_POLICY_EXCEPTIONS.md`.

### 18.1 What the exception does and does not do

It waives **one** release criterion — *"the core loop runs against a real (even sandbox)
payment gateway"* — for the **`v3.0.0` tag only**, on the strength of a verified sandbox
lifecycle plus a production lockout that makes accidental use structurally impossible.

It does **not** close GAP-06b, does not extend to any successor release, and does not
authorize production payment. **Production payment enablement remains fully blocked** and
carries its own seven-item activation checklist (`V3_RELEASE_POLICY_EXCEPTIONS.md`
§ "Production activation requirements"). A `v3.0.0` production deployment today has **zero
enabled payment providers** and checkout fails closed.

### 18.2 GAP-06 reclassification

| Row | Status | v3.0.0 release impact | Production impact |
|---|---|---|---|
| GAP-06 (original) | **SUPERSEDED** — retained for history | n/a | n/a |
| **GAP-06a** — sandbox payment lifecycle | **RESOLVED / VERIFIED** | None | None |
| **GAP-06b** — real production gateway | **OPEN / EXTERNAL_CONFIGURATION** | **NON-BLOCKING under EXC-001** | **BLOCKING for payment activation** |

`GAP-06b` was **not** marked resolved, and nothing was silently closed.

### 18.3 Production safety — re-verified, not assumed

`SandboxPaymentProvider.isEnabled()` requires two independent conditions and fails closed.
`NODE_ENV=production` is an unconditional hard stop: the former `PAYMENT_ALLOW_MOCK_GATEWAY`
escape hatch was removed rather than carried forward, and no equivalent bypass exists.
`payment-security.pg-spec.ts` asserts the gate stays shut under
`PAYMENT_ALLOW_MOCK_GATEWAY=true`, `PAYMENT_ALLOW_SANDBOX=true`, `PAYMENT_ENVIRONMENT=sandbox`,
and `PAYMENT_ENVIRONMENT=production` — every combination an operator might reach for — and
does so against the provider's own logic rather than through `@nestjs/config`'s cached
boot snapshot, which would have made the assertion vacuous. The registry additionally
refuses an unknown provider key rather than falling back to another gateway, and the
unauthenticated sandbox checkout route re-checks the gate independently.

### 18.4 Gates at the release commit

| Gate | Result | Evidence |
|---|---|---|
| Payment regression (success, failure, cancel, refund, duplicate callback, concurrent callback, amount tampering, wrong/unknown transaction, invalid verification, duplicate refund, concurrent refund) | **PASS** | `sandbox-payment-lifecycle.pg-spec.ts` (20), `payment-security.pg-spec.ts` (26) |
| Security (auth, refresh replay, cross-user/professional/business, staff boundaries, forged callback, financial isolation, waitlist & booking races, event idempotency, throttling) | **PASS** | 19 real-PostgreSQL suites |
| Financial integrity (append-only ledger via real role grants, refund reversal, no duplicate entries) | **PASS** | `financial-integrity.pg-spec.ts` |
| CI on the release commit | **GREEN** — 3/3 jobs | run `32591448813` |
| Real PostgreSQL + OpenSearch | **375/375, 19 suites, 0 skipped** | CI enforces skip-detection as fatal |
| Unit / pg-mem, frontend unit | **48 passing, 21 projects** | run locally |
| Typecheck · ESLint (incl. Nx boundaries) · build | **CLEAN** | run locally and in CI |
| Historical V1/V2 tags | **UNTOUCHED** — all 9 byte-identical to remote | `git ls-remote --tags` |

### 18.5 Live QA limitation — stated, not worked around

Authenticated and payment-flow browser QA was **not** performed. The API refuses to boot
locally without a working `FINANCIAL_DATABASE_URL` (correct fail-closed behaviour per
ADR-017), the local PostgreSQL credentials remain stale, and Docker Desktop still does not
start in this environment. The unauthenticated frontend was driven in a real browser this
session and renders correctly (RTL, Persian, login CTA present); the only console errors
were `ERR_CONNECTION_REFUSED` from the absent API. Authenticated and payment flows are
covered instead by the real-PostgreSQL CI suites, which boot the real `AppModule` and drive
real HTTP through supertest. **BROWSER QA LIMITATION** is recorded as a limitation, not
presented as equivalent coverage, and nothing was fabricated to fill it.

### 18.6 Hosting grants

**`HOSTING_GRANTS = EXTERNAL_CONFIGURATION`**, unchanged. The append-only ledger role
contract is proven only against CI's ephemeral PostgreSQL 16 container — never a real
target hosting provider. This is a production deployment prerequisite and is **not**
cancelled by EXC-001; it is item 5 of the production activation checklist.

### 18.7 Release criteria — final

| Criterion | Met |
|---|---|
| No code-level BLOCKER | ✅ |
| No HIGH security issue | ✅ |
| No financial integrity issue | ✅ |
| Payment sandbox lifecycle fully verified | ✅ |
| Production sandbox lockout verified | ✅ |
| Throttling resolved | ✅ (PHASE5-02) |
| CI green | ✅ |
| Full tests green, none skipped | ✅ |
| Historical V2 tags untouched | ✅ |
| Documentation contains the release exception | ✅ (EXC-001) |
| Working tree clean | ✅ |
| Real payment gateway | ❌ **OPEN / EXTERNAL_CONFIGURATION — waived for `v3.0.0` only, under EXC-001** |

**`v3.0.0` released.**
