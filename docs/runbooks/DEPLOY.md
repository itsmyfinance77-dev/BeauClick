# Runbook — deploy

## Status

Every command below has been run except the deploy step itself, which requires
a host. `HOSTING` — the hosting/region decision, the standing Phase 0 exit
blocker — is open, so `.github/workflows/v3-cd.yml`'s `deploy` job fails with
the enablement message rather than pretending.

---

## Part 1 — first-time provisioning (once per environment)

### 1.1 The managed PostgreSQL

The one hard precondition `V3_INFRASTRUCTURE_PLAN.md` §4 states: the provider
must grant the role-level permissions the ledger's immutability rests on, and
it must be **checked against the actual target**, not assumed from marketing
material. V2's MySQL hosting silently lacked the grants its trigger-based
approach needed, and that is `GAP-01`.

Create the database, then apply the two role scripts **as a superuser**, once:

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v owner_password="$FINANCIAL_OWNER_PASSWORD" \
  -v writer_password="$FINANCIAL_WRITER_PASSWORD" \
  -v reader_password="$FINANCIAL_READER_PASSWORD" \
  -v db_name="$DATABASE_NAME" \
  -v app_role=beauclick_app \
  -f v3/database/scripts/financial-roles.sql
```

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v owner_password="$ADMIN_AUDIT_OWNER_PASSWORD" \
  -v db_name="$DATABASE_NAME" \
  -v app_role=beauclick_app \
  -f v3/database/scripts/admin-audit-roles.sql
```

PostgreSQL 15+ no longer grants `CREATE` on the public schema to `PUBLIC`, and
database-level `ALL` does not include it (`PHASE4-03`). Without this the FIRST
migration fails on `permission denied for schema public`:

```bash
psql "$ADMIN_DATABASE_URL" -c 'GRANT CREATE ON SCHEMA public TO beauclick_app'
```

### 1.2 Verify the grants before trusting them

```bash
DATABASE_URL="$APP_DATABASE_URL" pnpm verify:roles
```

44 checks, run as the ordinary application role — no superuser needed, which
matters for a provider that never hands one out. A failure here means the
append-only ledger guarantee does **not** hold on this host, and the deployment
must stop. This is what closes `HOSTING_GRANTS`, and only when run against the
real target.

### 1.3 Secrets

Set as environment secrets on the platform, and as GitHub environment secrets
for the CD workflow. Never in Git.

| Secret | Used by | Notes |
|---|---|---|
| `DEPLOY_DATABASE_URL` | CD migrate, verify-roles | The application role |
| `DEPLOY_MIGRATION_URL_FINANCIAL` | CD migrate | `beauclick_financial_owner` |
| `DEPLOY_MIGRATION_URL_ADMIN` | CD migrate | `beauclick_admin_audit_owner` |
| `DEPLOY_PUBLIC_API_BASE_URL` | CD post-deploy | Where the health check points |
| `DEPLOY_COMMAND` | CD deploy | The platform's own rolling-deploy invocation. Receives `$IMAGE` |

The application's own runtime secrets are enumerated, with what each one
protects, in `SECRET_CONTRACT` (`v3/apps/api/src/config/env.validation.ts`).
That table is the authority; this runbook deliberately does not duplicate it.

The application **refuses to boot** on a configuration that breaks any
production rule, and reports every problem at once rather than one per deploy.
Read `v3/apps/api/.env.example` for what each variable does.

### 1.4 Confirm the configuration before deploying

There is no way to dry-run `validateEnv` against a remote host. What you can do
is run the API image locally with the target's non-secret configuration and see
whether it boots:

```bash
docker run --rm --env-file ./production.env beauclick-api:<sha>
```

A refusal prints every failing rule and names no values.

---

## Part 2 — a routine deploy

Run **V3 CD** from the Actions tab. `workflow_dispatch` only — deliberately no
push trigger; see the workflow's own header.

Inputs:

- `environment` — must have its secrets configured.
- `image_tag` — leave blank to build from this ref. Set it to a previous SHA to
  **roll back** (see [ROLLBACK.md](ROLLBACK.md) first).

The pipeline, in order, each step gating the next:

1. **gates** — typecheck, lint, the full fast suite, build. Re-run rather than
   trusted from an earlier run: the commit being deployed may not be the commit
   that was reviewed.
2. **image** — built and pushed, tagged immutably by commit SHA. No `latest`,
   so "which build is running" is always answerable.
3. **migrate** — its own step, which must succeed first, then re-run to prove
   it was idempotent.
4. **verify-roles** — the role contract, on every deploy rather than once at
   setup. A provider can change a default and a restore can reset an ACL.
5. **deploy** — currently fails with the enablement message.
6. **post-deploy** — liveness, readiness, and the deployment's own
   configuration verdict.

---

## Part 3 — after a deploy

### Confirm what is actually running

```bash
curl -s "$PUBLIC_API_BASE_URL/health/ready" | jq
```

Read `dependencies[].state`. The words mean different things and the difference
is the point:

- `reachable` — probed on this request and answered.
- `configured` — real settings are present; not probed.
- **`simulated`** — a local stand-in is serving. Not an error, and not a
  marketplace: the sandbox gateway, the in-memory search engine, the local disk
  driver, and the null SMS provider all report this.
- `not_configured` — the dependency is off.

`productionVerified` is **false on every row** until the External Enablement
Gate is executed. No probe can set it true; it is a person's statement that a
live check was performed, recorded in
`v3/apps/api/src/health/readiness.ts`.

### Metrics

`GET /metrics` requires `METRICS_AUTH_TOKEN` and answers **404** without one.
That is deliberate: the endpoint describes every route, its volume, its
latency, its error rate, and the payment-outcome counts. The worst outcome of a
forgotten variable should be a missing dashboard, not an open one.

```bash
curl -sH "authorization: Bearer $METRICS_AUTH_TOKEN" "$PUBLIC_API_BASE_URL/metrics"
```

The one metric worth an alert:
`beauclick_payment_verifications_total{outcome="unresolved"}`. It counts
payments whose result **nobody knows** — and it is invisible in every other
signal, because the request returned 303, the customer got a page, no error was
thrown, and no event was emitted.

---

## Local development

```bash
docker compose -f v3/infra/docker/docker-compose.yml up -d
```

Then §1.1's role scripts against `postgres://postgres:postgres@localhost:5433/beauclick_v3_dev`,
then `pnpm migrate`, then `pnpm api:dev`.
