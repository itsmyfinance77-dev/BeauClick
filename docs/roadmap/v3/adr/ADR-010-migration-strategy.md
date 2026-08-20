# ADR-010: Migration Strategy

**Status:** Proposed — discovery only, not decided/approved.
**Date:** 2026-08-19.

## Context

**BeauClick has no production dataset yet** — stated as a fact in the V3 discovery brief, and consistent with everything found in this pass (no backup/DR tooling exists, per `OPS-02`; no real payment gateway has ever processed a live transaction, per `GAP-06`; the platform has never had a public self-registration path exercised at scale). This is the single most consequential fact for choosing a migration strategy — it eliminates the entire category of risk (live-user data-loss, zero-downtime cutover, dual-write consistency) that normally makes "big bang vs. strangler vs. dual-run" a hard choice.

## Decision

**Clean V3 rebuild — not big-bang data migration, not strangler-fig, not dual-run.** V2 remains a reference implementation and a source of validated business rules/tests (per `V3_MIGRATION_MATRIX.md`'s BUSINESS-RULE EXTRACTION / TEST-SPEC REUSE classifications) — V3 is built fresh against those extracted rules and re-seeded with demo/reference data (locations, specialties, seed professionals for QA), not migrated row-by-row from V2's live tables, because there are no live rows with real user data to preserve.

**Per-entity classification** (detailed matrix already exists per-component in `V3_MIGRATION_MATRIX.md`; this ADR states the entity-level default):
- **Reseed** (reference/static data): province/city/district tables, specialty taxonomy — DIRECT REUSE of the data itself, trivial reseed script.
- **Rebuild from business rules** (everything else with real logic): booking, financial, campaigns, loyalty, verification, etc. — schema and business rules ported per the migration matrix; no literal data migration since no production rows exist to carry forward.
- **Discard, no migration path needed**: WooCommerce-native data shapes (coupons [unused], tax classes), the mount-point DOM-signaling architecture, WP-Cron job registrations, CPT/postmeta storage itself.
- **Optional history**: V2's own git history and the accumulated gap-register/architecture-doc corpus (`docs/roadmap/*`) — worth preserving as institutional memory/onboarding material even though no code or data from it migrates; **do not discard this corpus** even though it isn't "data" in the migration sense — it's the evidence base every other ADR in this set cites.

**Sequencing** (detailed in `V3_MIGRATION_PLAN.md`'s phase roadmap): identity + provider-service first (the highest-risk re-platform, per ADR-001 — CPT/postmeta → relational tables — and everything else depends on a real user/provider identity existing), then booking + commerce/payment together (the core value loop), then the remaining domains in roughly the dependency order `V3_ARCHITECTURE_PLAN.md` §1 implies.

## Consequences

- **Positive:** the single hardest part of any real migration — live-data cutover risk — simply does not apply here. This lets V3 be built to the *target* schema/architecture directly (real relational provider tables, event-driven cross-module communication, Postgres from day one) without a transitional compatibility layer for data that doesn't exist.
- **Negative:** none of V2's operational experience (real traffic patterns, real gateway callback behavior, real user-support edge cases) exists yet either — V3 launches with the same "unvalidated against real production load" status V2's own payment/AI paths have today (`GAP-06`, `GAP-11`), just for a new system instead of an old one. This is a genuine, disclosed risk, not eliminated by the clean-rebuild choice — tracked in the risk register.
- **Risk:** "no production data" must be re-confirmed true at the start of actual V3 implementation, not assumed stale from this discovery date (2026-08-19) — if real users/transactions accumulate on V2 between this discovery pass and V3 implementation start, this ADR's premise changes and must be revisited before Phase 1 begins.

## Alternatives considered

- **Strangler-fig (incrementally replace V2 modules behind a shared gateway while both run).** The standard choice for a live system with real users — rejected here specifically *because* that precondition (real users depending on continuous availability) doesn't hold. Revisit if the "no production dataset" premise changes.
- **Dual-run (V2 and V3 process the same real traffic in parallel, compare outputs).** Same rejection reason — no real traffic exists to dual-run against; the comparison this technique is designed to enable has nothing to compare.
- **Big-bang data migration (freeze V2, migrate all rows, cut over).** Rejected as unnecessary complexity — there's no meaningful volume of rows to migrate; a reseed is simpler and produces cleaner V3-native data than transforming V2's WordPress-shaped rows would.
