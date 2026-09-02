# ADR-013: Infrastructure Strategy

**Status:** Accepted for local/CI infrastructure — production hosting and provider activation remain open.
**Date:** 2026-08-20.

## Context

V2 has **zero infrastructure maturity today** — confirmed, not assumed: no automated backup exists (`OPS-02`, blocking severity), no health-check endpoint (`OPS-03`), no error monitoring (`OPS-04`), and WP-Cron's own reliability is explicitly flagged as needing a real system cron in production, never verified at real scale. V3 inherits none of this — it's a green-field infrastructure decision, constrained by the same unresolved Iran-specific facts V2's own Phase-0 doc flagged and never actually settled: AI-provider reachability, payment-gateway callback reachability, and domestic-vs-international hosting, all coupled decisions (`ARCHITECTURE_PROPOSAL.md` §29). ADR-002 already established the team/scale reality this ADR must match: small team, no production dataset yet, modular monolith at launch.

## Decision

**Containerized, orchestration-light at launch — Docker everywhere, Kubernetes deferred, not adopted by default.**

- **Docker**: every `apps/*` deployable (api, financial-service, payment-service, web, admin) ships as a container image — non-negotiable baseline regardless of orchestration choice, since it's what makes local dev (`docker-compose`), CI, and any future orchestration choice all consistent.
- **Kubernetes**: **deferred**, not decided against permanently. At launch, run containers via a simpler managed container platform (a PaaS-style container host, or plain `docker-compose`/a single-node orchestrator for staging, a managed container service for production) — matching ADR-002's own reasoning exactly: K8s's real operational cost (cluster management, manifest maintenance, a genuinely new skill the team must own) isn't justified by anything found in this discovery pass. **Trigger to revisit**: the same trigger ADR-002 names for service extraction — real load or team growth, not a scheduled "we'll need K8s eventually" migration.
- **PostgreSQL deployment**: a managed Postgres service (not self-hosted) — backup/point-in-time-recovery and the role-grant capability financial-service's ledger immutability requires (`ADR-009`) must be confirmed available on whatever managed offering is chosen, *before* Phase 1 begins (a real, named risk in `V3_MIGRATION_PLAN.md` §6, echoing V2's own MySQL `SUPER`-grant hosting constraint).
- **Redis, Kafka, OpenSearch**: managed services where available in the chosen hosting region; self-hosted only if no managed option exists there — minimizing new operational surface the team must run, consistent with the "no evidence any of this needs custom operation" finding.
- **Object storage**: S3-compatible, Iran-reachable provider (matching `ARCHITECTURE_PROPOSAL.md` §25's ArvanCloud/Liara-class recommendation — not re-decided here, no new evidence changes it).
- **Hosting region — the one genuinely open, high-stakes decision this ADR does not resolve**: domestic Iranian hosting vs. international, coupled to AI-provider reachability and payment-gateway callback latency, exactly as V2's own unresolved open question. **This ADR's decision is that this must be resolved before Phase 1 infrastructure setup begins** (a real precondition, not a detail to discover mid-build, per the risk register) — not a specific vendor pick, which requires real, current research this discovery pass does not have grounds to fabricate.
- **CI/CD**: GitHub Actions (matches the existing GitHub-hosted repository) — per-module pipelines, migrations run as a distinct, ordered step before the corresponding app's deploy (`V3_DATABASE_BLUEPRINT.md` §3).
- **Monitoring/logging**: OpenTelemetry (instrumentation) + Prometheus (metrics) + Grafana (dashboards) + Sentry (error tracking) — release-brief baseline, adopted without a contrary finding; this alone closes `OPS-03`/`OPS-04` (V2 had neither).
- **Backup strategy**: automated, scheduled database backups (managed-Postgres-provider-native where possible) with a defined retention policy and a tested restore runbook — closing `OPS-02` for real, not merely specifying it (V2's own gap was never even attempted, let alone tested).

## Consequences

- **Positive:** infrastructure complexity matches team size and actual (zero) production traffic; every V2 operational gap (backup, health-check, monitoring) is closed by design from Phase 1, not deferred to a "production hardening" phase that V2's own history shows tends not to happen on its own.
- **Negative:** deferring Kubernetes means a real re-platforming effort later if/when it's genuinely needed — accepted, since paying that cost now with no current justification is the worse trade.
- **Risk:** the hosting-region decision is a real, unresolved blocker for AI/payment reachability — this ADR flags it as must-resolve-before-Phase-1, matching the risk register, but does not itself resolve it.

## Alternatives considered

- **Kubernetes from day one** (the release brief's illustrative baseline names it). Deferred, not rejected outright — revisit once real load or team growth justifies the operational cost, per ADR-002's identical reasoning for service extraction.
- **Self-hosted Postgres/Redis/Kafka/OpenSearch on raw VMs.** Rejected as default — a managed service removes an entire category of operational burden (patching, backup mechanics, failover) a small team shouldn't be spending its time on pre-launch; only fall back to self-hosted where the chosen hosting region genuinely has no managed option.
