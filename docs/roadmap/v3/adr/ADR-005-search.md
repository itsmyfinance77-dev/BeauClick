# ADR-005: Search Architecture

**Status:** Proposed — discovery only, not decided/approved.
**Date:** 2026-08-19.

## Context

V2's search is plain, unbounded MySQL `LIKE '%term%'` over the denormalized `wp_bc_provider_index` table (`V3_GAP_REGISTER.md` GAP-14) — explicitly an accepted-at-the-time tradeoff, not an oversight (`ARCHITECTURE_PROPOSAL.md` §17 named Meilisearch as the natural upgrade path if free-text relevance ever became a real problem, gated on evidence, not built speculatively). No fuzzy/typo-tolerant matching, no Persian-specific normalization beyond a shared digit-folding utility. `V3_MIGRATION_MATRIX.md`'s Search section confirms the *denormalization strategy* (flatten filterable/sortable attributes, resync on every relevant write) is real, tested, and portable — only the storage/query mechanism needs replacing.

The release brief's baseline names OpenSearch. `V3_ARCHITECTURE_PLAN.md` §1 already assigns `search-service` as a read-model rebuilt from `provider-service` + `booking-service` + review events — never a system of record.

## Decision

**OpenSearch**, per the release brief's baseline, confirming rather than deviating from it — no domain evidence argues for a lighter engine (Meilisearch/Typesense) now that a real search-service is being built from scratch rather than layered onto MySQL; OpenSearch's aggregation/faceting support directly serves the marketplace's real filter surface (city, district, specialty, price range, rating floor, verified-only, sort — confirmed exhaustively in `V3_API_CONTRACTS.md`'s provider-service section).

**Required, evidence-grounded requirements for the indexing pipeline** (not optional nice-to-haves):
- Persian/Arabic-Indic digit normalization at index and query time — carrying forward the one confirmed, already-fixed real bug class in this area (`format.ts`'s documented digit-substitution-≠-calendar-conversion fix, per `V3_MIGRATION_MATRIX.md` Persian/RTL/Jalali section).
- Fix the one confirmed schema inconsistency in ranking signal collection before it's carried into the new index: `profile_view`'s `entity_type` logs the raw CPT type instead of the normalized `'provider'` value every other event uses (`V3_GAP_REGISTER.md` GAP-15).
- Reindex triggers on every write to provider profile, service, review, or booking-completion — the exact "resync on every relevant write" discipline V2 already got right structurally (even though its own hook coverage occasionally missed a case), now backed by the formal `V3_EVENT_CATALOG.md` events (`ProfessionalVerified`, `ReviewCreated`, `BookingCompleted`) instead of ad hoc WordPress save-hooks.
- Ranking's scoring *algorithm* (Bayesian-shrinkage rating average + cold-start blend + weighted signal sum) is DIRECT-REUSE per the migration matrix — OpenSearch changes storage/retrieval, not the scoring math.

## Consequences

- **Positive:** real typo-tolerance and Persian-aware relevance ranking — genuinely closes GAP-14, not merely re-platforms the same limitation onto new infrastructure. Faceted filtering scales cleanly as city/specialty coverage grows.
- **Negative:** new operational dependency (a stateful search cluster) that V2 never had — needs its own backup/reindex-from-scratch runbook (search-service is a read-model, so full reindex from provider-service + booking-service + reviews is always possible, but must be a documented, tested procedure, not assumed).
- **Risk:** none domain-specific found; general OpenSearch operational complexity is the accepted cost of the release brief's baseline choice.

## Alternatives considered

- **Meilisearch/Typesense** (lighter self-hosted footprint, good typo tolerance): the V2-era recommendation when search was a bolt-on to MySQL. Revisited here because V3's search-service is being built as a first-class service, not a bolt-on — OpenSearch's facet/aggregation depth better serves the marketplace's real filter surface, and matches the release brief's baseline without a countervailing V2 finding.
- **Elasticsearch**: functionally similar to OpenSearch; the release brief specifies OpenSearch, and no domain evidence distinguishes between them for BeauClick's use case — deferred to the brief's choice.
