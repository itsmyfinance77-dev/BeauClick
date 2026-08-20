# ADR-004: Database Strategy

**Status:** Proposed — discovery only, not decided/approved.
**Date:** 2026-08-19.

## Context

V2 uses MySQL/MariaDB (WordPress's default) with a `wp_bc_` prefix, deliberately never using cross-plugin foreign keys — `V3_ARCHITECTURE_PLAN.md` §6 confirms this was because "WordPress doesn't guarantee plugin activation order," a WordPress-specific constraint that doesn't exist in V3. Every domain's real schema was verified via migration-file inspection (not assumed), and `V3_ARCHITECTURE_PLAN.md` §6 already assigns table ownership per the 12 services (plus Journey, this pass's addition).

## Decision

**PostgreSQL, one logical schema per module (ADR-002), real foreign keys within a module's own schema, event-driven/ID-reference-only across module boundaries** — matching the release brief's baseline and `V3_ARCHITECTURE_PLAN.md` §6's "no cross-service database FKs, consistent with avoiding distributed transactions unless absolutely necessary."

Two specific, evidence-driven deviations from "just port the MySQL schema":
1. **financial-service requires real DB-level append-only enforcement** (revoked UPDATE/DELETE grants on the ledger role, or an insert-only table + read model) — confirmed gap, not speculative: V2's guarantee is application-convention only (`GAP-01`), and a same-class gap exists for the admin audit log (`V3_SECURITY_MODEL.md` §7). This is the one place Postgres's row-level security / role-grant model should be used as a structural control, not just an implementation detail.
2. **provider-service's core entities become real tables, not CPT/postmeta** — the single largest schema-shape change in the whole migration (see ADR-001, `V3_MIGRATION_MATRIX.md` Professional/Business row).

## Consequences

- **Positive:** real FKs within a module catch data-integrity bugs at write time that V2 could only catch (or miss) in application code; Postgres's row-level security gives financial-service a real enforcement mechanism for its single highest-stakes invariant.
- **Negative:** every custom table across 18 plugins needs a real migration-writing effort (schema translation + data-type mapping, e.g. MySQL `JSON` columns → Postgres `jsonb`), not an automated port — sequenced per `V3_MIGRATION_PLAN.md`'s phase plan, domain by domain.
- **Risk:** none of the 10 domain-discovery reports found a MySQL-specific feature (e.g. a stored procedure, a MySQL-only SQL dialect dependency) that would complicate a Postgres move — every custom table found was plain `dbDelta`-created relational DDL.

## Alternatives considered

- **Stay on MySQL/MariaDB** (avoid a migration-language change on top of everything else moving). Rejected — the release brief specifies PostgreSQL as baseline, and no V2 evidence argues for staying on MySQL; Postgres's role-based grant system is the more natural fit for the financial-service append-only requirement specifically.
- **One shared database, schema-per-module via search_path only (not separate logical databases/roles).** Acceptable as an implementation detail within "one schema per module," but financial-service's role-grant isolation requirement (append-only enforcement) argues for at minimum a distinct database role/grant boundary for that module specifically, even if hosted on the same Postgres cluster as the rest.
