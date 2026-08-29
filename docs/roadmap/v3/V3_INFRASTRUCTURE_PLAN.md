# V3 Infrastructure Plan

Status: Phase 0 blueprint, partially implemented. **Nothing has been deployed, no cloud account provisioned, no IaC written** — that is unchanged. Decision basis: `docs/roadmap/v3/adr/ADR-013-infrastructure-strategy.md`.

**V3.1 Phase F (2026-08-29)** built the provider-neutral half of §2, §4, §6, §7, §8, and §9: a container image, a CD pipeline shape, role-verification and backup/restore commands, structured logging, metrics, and an error-reporter port. Each section below marks what now exists. **No external item closed** — §1's hosting decision is still open and every live-evidence gate still is. See `docs/roadmap/v3.1/V3.1_PHASE_F_IMPLEMENTATION.md` §11 for the blocker ledger.

---

## 1. Hosting strategy

**Not decided here — the one deliberately open item in this entire blueprint.** Domestic (ArvanCloud/Liara/ParsPack-class) vs. international hosting is coupled to AI-provider reachability and payment-gateway callback latency, exactly as `ARCHITECTURE_PROPOSAL.md` §29 left it in V2 and never resolved. This plan's decision is procedural: **resolve this before any Phase 1 infrastructure provisioning begins** — treat it as a Phase 0 exit blocker (`V3_MIGRATION_PLAN.md` §6 risk register), not a detail to discover mid-build a second time.

## 2. Docker

Every `apps/*` deployable ships as a container image, built in CI, tagged immutably (`{app}:{gitSha}`), pushed to a container registry. `infra/docker/` holds one Dockerfile per app plus a `docker-compose.yml` for local development (Postgres, Redis, Kafka, OpenSearch as local containers — matching V2's own Laragon-based "run everything locally, no cloud dependency for dev" value, carried forward with modern tooling).

**Implemented (Phase F), partially.** `infra/docker/Dockerfile.api` exists and was built and STARTED against a real PostgreSQL — health, readiness, metrics, and JSON logs all verified from the running container. `infra/docker/docker-compose.yml` stands up Postgres, OpenSearch, and S3-compatible object storage for local development; Redis and Kafka are absent because neither is adopted (Redis is conditional on §5's topology question, Kafka is deferred by ADR-022). **`apps/web` has no image yet** — it lacks `output: standalone`, and the API is the deployable the pipeline shape needed to be proven against.

Building an image is not a hosting decision: it is the artifact every candidate platform in §3's launch topology consumes, which is why it could be built before §1 is answered.

## 3. Kubernetes decision

**Deferred, not adopted at launch** (ADR-013). Launch topology: a managed container platform (specific vendor deferred to §1's hosting decision) running the five `apps/*` images directly, or `docker-compose`-equivalent for staging. Revisit only on real load or team-growth evidence, mirroring ADR-002's identical trigger condition for service extraction — the two decisions should be reviewed together, since K8s adoption and further service extraction would likely happen at the same inflection point, not independently.

## 4. PostgreSQL deployment

Managed Postgres (vendor deferred to §1). **Hard precondition to confirm before Phase 1**: the chosen provider must grant the role-level permissions financial-service's ledger immutability requires (revoked `UPDATE`/`DELETE` on `ledger_entries`, ADR-009) — this is the same class of constraint that silently blocked V2's own MySQL trigger-based attempt (missing `SUPER`/`log_bin_trust_function_creators` grants on its dev/test hosts). Verify with a real `SHOW GRANTS`-equivalent check against the actual target environment, not assumed from the provider's marketing material.

**Implemented (Phase F): the check is now a command.** `pnpm verify:roles` runs 44 assertions — ownership, non-superuser, the ledger's append-only grants, the application role's total exclusion from `financial`, the audit log's grants, `PHASE4-03`, and the default privileges covering tables no migration has written yet. It needs **no superuser**, which is what makes it usable against a managed provider that may never hand one out.

`HOSTING_GRANTS` is **unchanged and still open.** Running it against CI's ephemeral container proves the command works, not that the contract holds on a host nobody has chosen. What closed is the "one script, one afternoon" half: the afternoon is one command, and the command is exercised on every build.

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

**Implemented (Phase F): the shape, not the deployment.** `.github/workflows/v3-cd.yml` has all six steps as real jobs with real gating — gates, image (immutably SHA-tagged, no `latest`), migrations as their own step plus an idempotency re-run, the §4 role contract on every deploy, deploy, and a post-deploy liveness/readiness/configuration check. `workflow_dispatch` only.

**The `deploy` job FAILS**, naming the hosting decision and listing exactly what has to be set. That is deliberate: a CD workflow reporting success without deploying produces a green check somebody will later cite as evidence that deployment works.

**Step 6's automatic rollback is deliberately not implemented.** An automatic redeploy of the previous image after a forward migration has already applied leaves old code running against a newer schema — frequently a worse failure than the one being escaped, and executed by a workflow at the moment a human is least able to catch it. The decision depends on what the migration did, which nothing here can read. `docs/runbooks/ROLLBACK.md` carries the four cases and the command; revisit once migrations carry a machine-readable backward-compatibility marker.

## 7. Monitoring

- **OpenTelemetry**: instrumentation library wired into every `apps/*` NestJS/Next.js process at bootstrap — traces spanning a request across module boundaries (even within the monolith, since a request may synchronously call multiple `services/*` modules) and across the financial/payment service boundary.
- **Prometheus**: scrapes standard app + infrastructure metrics (request rate/latency/error-rate per module, DB connection pool saturation, Kafka consumer lag, DLQ depth per `V3_EVENT_ARCHITECTURE.md` §7).
- **Grafana**: dashboards per module, plus one cross-cutting "platform health" dashboard — closes `OPS-03` (no health-check visibility existed in V2).
- **Sentry**: error tracking for every `apps/*` process — closes `OPS-04` (no error monitoring existed in V2).

**Implemented (Phase F): the instrumentation, behind provider-neutral configuration.**

- **Prometheus**: `GET /metrics` serves the text exposition format — request rate, latency histogram, and error rate by route TEMPLATE and status CLASS, plus payment verifications by outcome. Hand-written, because implementing an open FORMAT commits to no vendor, unlike a client library carrying the whole OpenTelemetry SDK into a workspace with pnpm overrides pinning one physical copy of every Nest package. The endpoint requires a bearer token and answers **404** without one: it describes every route, its volume, its latency, and the payment-outcome counts, and most deployments hide it on a private network this platform does not yet have.
- **Sentry**: an `ErrorReporterPort` with a logging default that reports `reportsExternally: false`, and a configurable HTTP reporter that never throws, never waits on the response, and never retries. **Not the Sentry SDK** — binding a vendor would settle a question Phase F may not settle, and would not close `OPS-04` anyway, which needs a DSN, a deployment, and a real error in a real dashboard.
- **OpenTelemetry**: not started. Correlation IDs already propagate across every module boundary and into the event envelope, which is the hard half; an OTLP exporter is additive and is worth writing against a real collector rather than a local double.

`OPS-03` and `OPS-04` are **unchanged and still open**: both ask for real production signal reaching a selected backend, and no backend is selected.

The one metric worth an alert: `beauclick_payment_verifications_total{outcome="unresolved"}`, which counts payments whose result nobody knows and is invisible in every other signal.

## 8. Logging

Structured JSON logs from every process, correlation-ID-tagged (propagated from the API gateway/edge through every synchronous call and carried in the event envelope's `producedBy`/trace context for async flows) — enabling a single request or event chain to be traced across module and service boundaries, a real capability V2 never had (no centralized logging existed at all).

**Implemented (Phase F).** `StructuredLogger` emits one JSON object per line, correlation-tagged, with stack traces on a single line — a multi-line stack in a line-delimited stream is N events, N-1 of them unparseable, and the aggregator drops them. Installed at `NestFactory.create` rather than after, so the framework's own boot lines go through it, including a dependency-resolution failure. JSON in production, human-readable elsewhere, forceable either way with `LOG_FORMAT`.

**Redaction is the load-bearing half**, and it is applied to every line. A log aggregator is a second copy of whatever reaches it, retained for months, readable by more people than can read the database, and outside every access control this platform enforces: `financial.ledger_entries` is append-only by grant and a log line quoting one is not; `otp_codes` stores an HMAC and a log line carrying the code is plaintext. Two rules together — by key, and by value SHAPE for the free text (an error message, a stack frame, a `QueryFailedError` embedding its connection string) that no key-based rule can reach.

Shipping the logs somewhere central remains external, with §7's backends.

## 9. Backup strategy

- **Database**: automated daily snapshots (managed-provider-native where available) + continuous WAL archiving for point-in-time recovery, retention policy TBD by the hosting decision (§1) but non-negotiable as a Phase 1 requirement — closes `OPS-02` (V2 had zero backup tooling of any kind, confirmed by direct inspection, not assumption).
- **Object storage**: provider-native versioning/replication (verification evidence and portfolio media — the same protected-file security model from `V3_SECURITY_MODEL.md` §8 must extend to backup/restore: a restored file must not become more publicly accessible than the original).
- **Restore runbook**: written and **tested** (a real restore drill, not just a documented procedure) before Phase 2 goes live with real user-facing data — a backup that has never been restored is not a verified backup.

**Implemented (Phase F): the mechanism. NOT the drill.**

`pnpm backup` produces a dump plus a manifest (sha256, byte length, server version, applied migrations, per-table row counts). `pnpm restore:rehearse` runs the whole loop against a **disposable** database — verifying the manifest BEFORE restoring, because a truncated dump restores a partial database perfectly happily and a silent partial restore is worse than a failed one — then compares row counts and schema version.

Then the check that justifies the exercise: **it re-runs §4's role contract against the RESTORED database.** The append-only guarantee is a role contract, not a column constraint, so a restore that returns every row and drops the grants produces a database where the financial writer can `UPDATE ledger_entries` — with every count matching, every query working, and every smoke test passing. That is this section's own object-storage rule (a restored file must not become more publicly accessible than the original) applied to the database, which is where this platform's security boundary actually lives.

Executed locally: 71 tables, 37 migrations, 44/44 role checks on the restored copy. Runs in CI on every build.

**`OPS-02` is unchanged and still open.** The drill this section requires is a real backup of real production data restored into a clean target on the real host — including the **new-cluster** case, which needs `pg_dumpall --globals-only` for the cluster-global roles and which the same-cluster rehearsal does not exercise. Scheduling is likewise absent: daily snapshots and WAL archiving are a property of the managed provider, and selecting one here would be inventing §1's decision.

**Object storage backup remains entirely absent**, and `media.objects` — the authorization record for every file — IS in the database backup, so a database restore without a corresponding object restore yields a system that knows about files it cannot serve. Recorded in `docs/runbooks/RESTORE.md` so it is not discovered during an incident.

## 10. Iran-specific constraints (cross-cutting, not resolved here)

Re-stated from `V3_ARCHITECTURE_DISCOVERY.md`/`ARCHITECTURE_PROPOSAL.md` §29, carried forward as unresolved:
1. AI-provider (Anthropic-class) direct API reachability from Iranian infrastructure is restricted — the AI relay/module's outbound calls likely need to originate from non-restricted infrastructure, coupling to §1's hosting decision.
2. Payment-gateway callback reachability — Iranian gateway webhooks must reliably reach wherever V3 is hosted.
3. These two facts, plus domestic-vs-international hosting cost/latency tradeoffs, are one coupled decision, not three independent ones — resolve together, before Phase 1.

---

## Cross-references
- `docs/roadmap/v3.1/V3.1_PHASE_F_IMPLEMENTATION.md` — what Phase F built, and the External Enablement blocker ledger.
- `docs/roadmap/v3/adr/ADR-028-ambiguous-verification-and-readiness.md` — the readiness model §7's health reporting now uses.
- `docs/runbooks/` — deploy, rollback, restore, secret rotation, payment incidents.
- `ADR-013-infrastructure-strategy.md` — the decision this plan operationalizes.
- `ADR-016-deployment-strategy.md` — the pipeline/rollback mechanics §6 details.
- `ADR-009-financial-ledger.md` — the DB-grant precondition in §4.
- `V3_MIGRATION_PLAN.md` §6 — the risk register entries this plan's open items map to.
