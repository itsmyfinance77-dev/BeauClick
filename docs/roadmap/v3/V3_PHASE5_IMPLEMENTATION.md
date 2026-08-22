# V3 Phase 5 Implementation — Finalization, Release Audit, v3.0.0 Readiness

Status: **Audit complete. Release BLOCKED — payment configuration required.** Full findings, the gap reconciliation table, and the exact release-gate reasoning live in `V3_RELEASE_AUDIT.md`; this document records what was done and why, in the phase-report format the previous four phases used.

Baseline: Phase 4 at `582c606`, confirmed `HEAD == origin/master` at start. Ended at `250a720`. V2/V2.4.1 untouched — zero diff against `wordpress/`, `app/`, `shared/`. No historical tag touched. No `v3.0.0` tag created.

---

## 1. What this phase actually was

Not a feature phase. Two real things were fixed, one real thing was found and deliberately left unfixed with reasoning recorded, and everything else — the overwhelming majority of the brief's own 22-section ask — was **audit**: confirming that Phases 1–4's already-substantial real-PostgreSQL test suite (17 files) still proves what it claims to prove, reconciling every open gap against current evidence, and determining honestly whether the one remaining precondition for release (a real payment gateway) is satisfied. It is not, and this phase's own instructions say what that means: the release is blocked, not "blocked except this once."

## 2. The real-PostgreSQL suite, as inherited and re-verified

No new `*.pg-spec.ts` files were added this phase (Phase 4 added the last three: `waitlist-concurrency`, `business-authorization`, `financial-outbox-consumer`). What this phase did was confirm the full 17-file suite still passes for real, after removing one file and reconciling one dormant assertion:

| File | Domain |
|---|---|
| `real-postgres.pg-spec.ts` | Identity/provider foundation, transactions, constraints |
| `auth-cookie.pg-spec.ts` | Full auth lifecycle, refresh rotation, replay, CSRF |
| `booking-concurrency.pg-spec.ts` | Atomic slot claim under genuine races |
| `booking-lifecycle.pg-spec.ts` | State machine, idempotency, authorization |
| `payment-security.pg-spec.ts` | Amount tampering, duplicate charge, mock-gateway production gate |
| `financial-integrity.pg-spec.ts` | Append-only ledger, settlement, refund reversal, cross-party isolation |
| `outbox-transactional.pg-spec.ts` | Transactional outbox rollback/commit, exactly-once dispatch |
| `search-projection.pg-spec.ts` | Revision ordering, reindex/recovery, event-driven indexing |
| `opensearch.pg-spec.ts` | Persian normalization, fuzzy matching, autocomplete, facets |
| `loyalty-idempotency.pg-spec.ts` | Points/tier idempotency |
| `journey-privacy.pg-spec.ts` | The ADR-019 privacy boundary |
| `notification-delivery.pg-spec.ts` | Notification center, dedupe, dead-letter |
| `analytics-isolation.pg-spec.ts` | Fact-table idempotency, privacy allow-list |
| `correlation.pg-spec.ts` | Correlation ID propagation across schemas |
| `business-authorization.pg-spec.ts` | Cross-business isolation, staff consent |
| `waitlist-concurrency.pg-spec.ts` | GAP-26's invariant, proven under a real race |
| `financial-outbox-consumer.pg-spec.ts` | The financial-outbox → analytics/notification path |

**Result: 342/342 passing, 0 skipped, all three CI jobs green.** Verified via `gh run view` on the actual run, not asserted.

## 3. What was fixed

**3.1 — The last knowingly-broken test artifact (PHASE4-02), resolved.** Investigated instead of guessed at: `financial-role-contract.pg-spec.ts`'s own setup script opens with `DROP ROLE IF EXISTS beauclick_financial_writer/reader` — the identical role names the real, CI-provisioned `financial-roles.sql` also creates. Wiring both into one CI database would let either script's `DROP ROLE` tear down the other's roles mid-run. That is why it was never fixed by adding it to CI provisioning — the "obvious" fix was actively dangerous. Its one piece of genuinely unique coverage (asserting the read-only role's grants) was found to already exist, dormant, inside `financial-integrity.pg-spec.ts:161` — gated on `TEST_FINANCIAL_READER_URL`, which CI had simply never set, despite the role itself being provisioned with a known password by the existing step all along. Wiring that one variable activated real coverage against the real ledger instead of a stand-in table. Deleted the obsolete file and its hazardous script; net effect is more real coverage, not less.

**3.2 — The homepage's only interactive element had no real touch target.** `apps/web/app/page.tsx`'s `/auth` link measured 21×135px in a real browser check — under the 44px minimum this codebase's own `Button` component already documents and enforces, and the same class of bug Phase 2 found once already (`PHASE2-06`). Fixed to match `Button`'s own convention; verified in-browser (now 44–53px) with zero overflow introduced. The header nav's own, much smaller-width "ورود" link was investigated and left alone — its own source comment documents the 375px-wrap tradeoff deliberately, uniformly, across every nav item; not a regression.

## 4. What was found and deliberately NOT fixed

`ThrottlerModule` is registered (`identity.module.ts`) but its guard was never wired to `APP_GUARD` anywhere — no route gets generic per-IP flood protection. Real, but not blind-fixed this session: every real-Postgres test file shares one Nest app instance (and therefore one throttle bucket) across dozens of requests, and wiring a global guard in without first adding a test-environment bypass (the same shape as the existing `DISABLE_BACKGROUND_SWEEPS` escape hatch) risked breaking the exact 342-test-green result this audit depends on as its evidence. The actual security-critical surface — OTP request flooding — already has its own dedicated, tested, always-on limiter, independent of this unused generic one. Recorded as PHASE5-02 in the gap register, not silently dropped.

## 5. The release decision, stated plainly

This phase's own instructions contain a specific, non-overridable rule: *"If real payment functionality is a stated mandatory V3 release capability and no gateway can be verified, the final decision must be: V3 RELEASE BLOCKED — PAYMENT CONFIGURATION REQUIRED."* Two independent V3 documents state exactly that mandate — `V3_GAP_REGISTER.md` calls GAP-06 an "explicit precondition for a real V3 launch," and `V3_IMPLEMENTATION_ROADMAP.md`'s own Phase 2 acceptance criteria requires the core loop to run "against a real (even sandbox) payment gateway." Neither has ever been true in any V3 environment, confirmed again this session (`PAYMENT_DEFAULT_PROVIDER=mock`, no credential of any kind present, `MockGatewayProvider` the only registered provider). The rule applies as written. No `v3.0.0` tag was created.

This is not a verdict on code quality. The payment **architecture** — provider abstraction, idempotent callbacks, server-to-server verification, amount-tampering rejection, the mock gateway's fail-closed production gate — is real, tested, and release-ready. What is missing is a real adapter and real merchant credentials, which this phase's own rules forbid fabricating or working around.

## 9. Addendum — GAP-06 sandbox implementation (same phase, later pass)

After the release audit above concluded, the sandbox half of GAP-06 was implemented. Full architecture, security properties, and limitations: `V3_PAYMENT_SANDBOX.md`.

**What was built:** `SandboxPaymentProvider`, an **evolution of** the Phase 2 `MockGatewayProvider` rather than a second provider beside it. The mock already was a sandbox by every meaningful measure (its own gateway-side table, a `verify()` that genuinely asks that table and ignores callback params, a redirect checkout page, idempotent refunds, a production gate); building a parallel one would have produced two simulators, two tables, two checkout pages, and two suites proving the same properties. What was genuinely missing — and is now added — is `cancelled` as an outcome distinct from `declined`, the richer gateway-side data model, a two-condition production gate with **no** override, a decide endpoint that refuses unrecognised input rather than defaulting to paid, and CAS-hardened concurrent refunds.

**The most security-relevant change is a removal.** The old provider honoured `PAYMENT_ALLOW_MOCK_GATEWAY=true`, which re-enabled the simulated bank under `NODE_ENV=production`. That escape hatch is **gone**: production is now a hard stop with no override of any kind, and `PAYMENT_ENVIRONMENT` must independently be `sandbox`. A simulated bank that one environment variable can switch on in production is exactly the hazard the gate exists to prevent — and is the same class of hazard a V2 readiness audit found in that version's Cash-on-Delivery stand-in.

**What it does NOT do:** it makes no network call, moves no money, and leaves the money-unit and field semantics of any real Iranian gateway entirely unexercised. It is not, and is never claimed to be, production payment.

**Release implication — the sandbox does not unblock v3.0.0, and was not treated as if it did.** See `V3_GAP_REGISTER.md`'s Phase 5 addendum II for the full reasoning: the roadmap's Phase 2 acceptance criterion ("against a real (even sandbox) payment gateway") sits alongside its own risk note describing the sandbox-test cycle as part of *building* the gateway integration, not a substitute for having one. Treating a locally-simulated bank as satisfying that gate would be the silent policy override this phase's brief explicitly forbids. **v3.0.0 remains uncreated, pending an explicit human release-policy decision.**

## 6. Documentation

This document, `V3_RELEASE_AUDIT.md` (the full audit, gap reconciliation table, and release reasoning), `V3_GAP_REGISTER.md`'s Phase 5 addendum, and brief addenda to `V3_SECURITY_MODEL.md` and `V3_EVENT_CATALOG.md`.

## 7. Commits

`25371a3` (retire the stand-in role-contract test, activate the real one), `250a720` (homepage touch-target fix). Both pushed, both independently confirmed green by CI before this report was written.

## 8. Git status

Clean. `HEAD == origin/master` at `250a720`. No `v3.0.0` tag. V2/V2.4.1 untouched.

---

**V3 RELEASE BLOCKED — PAYMENT CONFIGURATION REQUIRED**

*(Updated after the §9 sandbox pass: the sandbox payment lifecycle is now implemented and CI-verified, but GAP-06b — a real production gateway — remains open and EXTERNAL_CONFIGURATION. The blocker is unchanged in substance; what changed is that everything buildable around it is now built and proven. Whether a verified sandbox is sufficient for a v3.0.0 pre-release is a release-policy decision for a human to make explicitly, not one this phase may take silently.)*
