# V3 Infrastructure Plan

Status: Phase 0 blueprint. **Nothing has been deployed, no cloud account provisioned, no IaC written.** Decision basis: `docs/roadmap/v3/adr/ADR-013-infrastructure-strategy.md`.

---

## 1. Hosting strategy

**Not decided here — the one deliberately open item in this entire blueprint.** Domestic (ArvanCloud/Liara/ParsPack-class) vs. international hosting is coupled to AI-provider reachability and payment-gateway callback latency, exactly as `ARCHITECTURE_PROPOSAL.md` §29 left it in V2 and never resolved. This plan's decision is procedural: **resolve this before any Phase 1 infrastructure provisioning begins** — treat it as a Phase 0 exit blocker (`V3_MIGRATION_PLAN.md` §6 risk register), not a detail to discover mid-build a second time.

## 2. Docker

Every `apps/*` deployable ships as a container image, built in CI, tagged immutably (`{app}:{gitSha}`), pushed to a container registry. `infra/docker/` holds one Dockerfile per app plus a `docker-compose.yml` for local development (Postgres, Redis, Kafka, OpenSearch as local containers — matching V2's own Laragon-based "run everything locally, no cloud dependency for dev" value, carried forward with modern tooling).

## 3. Kubernetes decision

**Deferred, not adopted at launch** (ADR-013). Launch topology: a managed container platform (specific vendor deferred to §1's hosting decision) running the five `apps/*` images directly, or `docker-compose`-equivalent for staging. Revisit only on real load or team-growth evidence, mirroring ADR-002's identical trigger condition for service extraction — the two decisions should be reviewed together, since K8s adoption and further service extraction would likely happen at the same inflection point, not independently.

## 4. PostgreSQL deployment

Managed Postgres (vendor deferred to §1). **Hard precondition to confirm before Phase 1**: the chosen provider must grant the role-level permissions financial-service's ledger immutability requires (revoked `UPDATE`/`DELETE` on `ledger_entries`, ADR-009) — this is the same class of constraint that silently blocked V2's own MySQL trigger-based attempt (missing `SUPER`/`log_bin_trust_function_creators` grants on its dev/test hosts). Verify with a real `SHOW GRANTS`-equivalent check against the actual target environment, not assumed from the provider's marketing material.

## 5. Redis / Kafka / OpenSearch / Object storage

| Component | Strategy | Fallback |
|---|---|---|
| Redis (cache) | Managed, if available in the chosen hosting region | Self-hosted single-instance, only if no managed option exists there |
| Kafka (events, ADR-007) | Managed (e.g. a hosted Kafka-compatible service) | Self-hosted, minimal cluster — accepted only as a last resort given the real operational burden Kafka carries |
| OpenSearch (search, ADR-005) | Managed | Self-hosted single-node for staging only, never production |
| Object storage | S3-compatible, Iran-reachable provider (`ARCHITECTURE_PROPOSAL.md` §25 precedent — ArvanCloud/Liara-class) | — |

## 6. CI/CD

GitHub Actions, per-app pipelines (`ADR-016`). Pipeline shape, per deployable:

```
1. Lint + typecheck (Nx-affected — only touched projects, per ADR-011's project graph)
2. Unit + integration tests (testcontainers-backed Postgres, per ADR-015)
3. Build container image, tag {app}:{gitSha}
4. Run migrations for this app's owned schema(s) (database/migrations/{schema}/) — separate step, must succeed before step 5
5. Deploy (rolling for apps/api, independent rolling for financial-service/payment-service, platform-native for web/admin)
6. Post-deploy health check — automatic rollback to previous tag on failure
```

## 7. Monitoring

- **OpenTelemetry**: instrumentation library wired into every `apps/*` NestJS/Next.js process at bootstrap — traces spanning a request across module boundaries (even within the monolith, since a request may synchronously call multiple `services/*` modules) and across the financial/payment service boundary.
- **Prometheus**: scrapes standard app + infrastructure metrics (request rate/latency/error-rate per module, DB connection pool saturation, Kafka consumer lag, DLQ depth per `V3_EVENT_ARCHITECTURE.md` §7).
- **Grafana**: dashboards per module, plus one cross-cutting "platform health" dashboard — closes `OPS-03` (no health-check visibility existed in V2).
- **Sentry**: error tracking for every `apps/*` process — closes `OPS-04` (no error monitoring existed in V2).

## 8. Logging

Structured JSON logs from every process, correlation-ID-tagged (propagated from the API gateway/edge through every synchronous call and carried in the event envelope's `producedBy`/trace context for async flows) — enabling a single request or event chain to be traced across module and service boundaries, a real capability V2 never had (no centralized logging existed at all).

## 9. Backup strategy

- **Database**: automated daily snapshots (managed-provider-native where available) + continuous WAL archiving for point-in-time recovery, retention policy TBD by the hosting decision (§1) but non-negotiable as a Phase 1 requirement — closes `OPS-02` (V2 had zero backup tooling of any kind, confirmed by direct inspection, not assumption).
- **Object storage**: provider-native versioning/replication (verification evidence and portfolio media — the same protected-file security model from `V3_SECURITY_MODEL.md` §8 must extend to backup/restore: a restored file must not become more publicly accessible than the original).
- **Restore runbook**: written and **tested** (a real restore drill, not just a documented procedure) before Phase 2 goes live with real user-facing data — a backup that has never been restored is not a verified backup.

## 10. Iran-specific constraints (cross-cutting, not resolved here)

Re-stated from `V3_ARCHITECTURE_DISCOVERY.md`/`ARCHITECTURE_PROPOSAL.md` §29, carried forward as unresolved:
1. AI-provider (Anthropic-class) direct API reachability from Iranian infrastructure is restricted — the AI relay/module's outbound calls likely need to originate from non-restricted infrastructure, coupling to §1's hosting decision.
2. Payment-gateway callback reachability — Iranian gateway webhooks must reliably reach wherever V3 is hosted.
3. These two facts, plus domestic-vs-international hosting cost/latency tradeoffs, are one coupled decision, not three independent ones — resolve together, before Phase 1.

---

## Cross-references
- `ADR-013-infrastructure-strategy.md` — the decision this plan operationalizes.
- `ADR-016-deployment-strategy.md` — the pipeline/rollback mechanics §6 details.
- `ADR-009-financial-ledger.md` — the DB-grant precondition in §4.
- `V3_MIGRATION_PLAN.md` §6 — the risk register entries this plan's open items map to.
