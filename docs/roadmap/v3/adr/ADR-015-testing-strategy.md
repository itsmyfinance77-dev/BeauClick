# ADR-015: Testing Strategy

**Status:** Proposed — Phase 0 blueprint only, not decided/approved. No tests have been written.
**Date:** 2026-08-20.

## Context

V2's testing discipline is real and proven where it exists: 944 backend PHPUnit tests, 72 frontend Vitest tests, and — critically — `V3_MIGRATION_MATRIX.md` classifies entire test suites across Booking, B2B, Loyalty, and Referral as **TEST-SPEC REUSE**: the acceptance criteria they encode (idempotency, ownership boundaries, adversarial forged-parameter checks) are independently valuable even where the implementation is discarded. `V3_SECURITY_MODEL.md` §4 names the adversarial-ownership test shape (seed party B with a distinguishable value, ask as party A, assert it never leaks) as "the bar V3 should hold itself to for every cross-tenant-sensitive endpoint, not just the two domains that have it today." Conversely, `ARCHITECTURE_PROPOSAL.md` §22 originally specified a full test pyramid including Playwright E2E — never actually built in V2 (no Playwright anywhere in the current codebase, confirmed by this discovery pass's own inventory).

## Decision

**A real test pyramid, with the adversarial-ownership pattern promoted from "two domains have it" to "structurally required for every tenant-scoped endpoint":**

1. **Unit tests** — pure business-rule functions (the exact class of logic `V3_MIGRATION_MATRIX.md` classifies BUSINESS-RULE EXTRACTION), tested in isolation, no DB/network. Highest-value, cheapest tier — this is where V2's provisional-but-precise rules (OTP windows, campaign eligibility, ranking formula) get their acceptance criteria.
2. **Integration tests** — per-module, real Postgres via testcontainers (not mocked DB) — matching V2's own `PHPUnit + WP core test suite` precedent of testing against real infrastructure, not mocks, for anything touching persistence/ownership.
3. **Adversarial ownership tests — mandatory, not optional, for every tenant-scoped endpoint.** The exact shape from `V3_SECURITY_MODEL.md` §4: seed a second party with a distinguishable real value, request as the first party, assert the value never appears anywhere in the response. `libs/testing` ships a shared harness for this pattern specifically so writing one is as cheap as calling a helper, not authoring a bespoke test each time — removing the friction that arguably kept this pattern confined to 2 of V2's domains despite being correct everywhere.
4. **Contract tests** — every `V3_API_CONTRACT_BLUEPRINT.md` endpoint's request/response shape validated against its declared schema in CI, catching drift between documented and actual contracts before a frontend consumer does.
5. **E2E (Playwright)** — critical paths only: search→book→pay→confirm, shop→cart→checkout→order, B2B quote→accept→order — run in RTL/Persian locale explicitly (never LTR-default), per `ARCHITECTURE_PROPOSAL.md` §22's original, never-executed intent. **This is new coverage V2 never actually had**, not a port.
6. **Idempotency tests** — for every event consumer (`V3_EVENT_ARCHITECTURE.md` §5): assert a redelivered event produces no duplicate side effect, mirroring the exact double-fire scenarios V2's own DB-constraint idempotency demonstrably absorbed in production-equivalent testing.

**Port, don't rewrite from scratch**: every TEST-SPEC-REUSE-classified suite in `V3_MIGRATION_MATRIX.md` (Booking's hold/expiry/concurrency tests, B2B's MOQ/tier/IDOR tests, Loyalty's idempotency/tier-boundary tests, Referral's self-referral-prevention/replay tests, Financial's cross-professional-isolation tests) is re-authored against the new stack **using the same scenarios and assertions**, not reinvented from a blank page — these are proven acceptance criteria, not disposable scaffolding.

## Consequences

- **Positive:** the adversarial-ownership pattern's promotion from 2-domains-have-it to structurally-required directly prevents the class of oversight it exists to catch, at the cheapest possible point (test-authoring friction removed via a shared harness). Real E2E coverage in Persian/RTL is new, genuine risk reduction V2 never had.
- **Negative:** real testcontainers-based integration tests and Playwright E2E both add real CI time/infrastructure V2's PHPUnit-against-a-local-DB setup didn't need to think about — a real, accepted cost.
- **Risk:** porting TEST-SPEC-REUSE suites requires the underlying business rule to already be correctly reimplemented — these tests are acceptance criteria, not something that can be ported ahead of the code they test; sequence test-porting alongside each module's implementation, not as an afterthought.

## Alternatives considered

- **Snapshot/visual-regression testing as a required tier.** Not adopted as a required tier — no V2 evidence of a visual-regression problem it would have caught; worth adding opportunistically (e.g. for the design-system primitives in `packages/ui`) but not mandated platform-wide.
- **Mocking the database for unit-level "integration" tests.** Rejected — this session's own standing feedback record explicitly warns against this pattern (mocked-vs-prod divergence risk); real testcontainers-backed Postgres is the only acceptable integration-test substrate.
