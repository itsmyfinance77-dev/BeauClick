# BeauClick

Persian-first, nationwide Iranian beauty technology platform — marketplace, booking,
commerce, payments, loyalty, referral, wishlist, internal chat, and an AI beauty
assistant. Launch market: **Yazd**. The location model is
`Iran → Province → City → District/Neighborhood`; Yazd is a starting point, never a
hard limit.

**The active line of development is V3** — a TypeScript modular monolith that replaced
the original WordPress/WooCommerce implementation. It lives in [`v3/`](v3/). The V2 tree
(`wordpress/`, `app/`, `shared/`) is frozen historical reference and is not built,
deployed, or maintained.

---

## Table of contents

1. [Where the project stands](#1-where-the-project-stands)
2. [Repository layout](#2-repository-layout)
3. [Architecture](#3-architecture)
4. [Getting started](#4-getting-started)
5. [Command reference](#5-command-reference)
6. [Testing](#6-testing)
7. [Continuous integration and delivery](#7-continuous-integration-and-delivery)
8. [Operations](#8-operations)
9. [What is deliberately not enabled](#9-what-is-deliberately-not-enabled)
10. [Documentation map](#10-documentation-map)
11. [Working agreements](#11-working-agreements)
12. [The frozen V2 tree](#12-the-frozen-v2-tree)

---

## 1. Where the project stands

The latest release tag is **`v3.1.0`**. The V3.2-A through V3.2-C engineering
milestones have landed on `master`; V3.3-A is the current work after an explicit
owner reprioritisation. V3.2-D through V3.2-G remain roadmap scope and have not been
silently counted as delivered.

| Programme | Delivered | Status |
|---|---|---|
| **V3.0** (Phases 0–5) | The WordPress exit: 16 ADRs, the Nx/pnpm workspace, and the identity, provider, booking, commerce, payment, financial, search, loyalty, journey, notification, analytics, admin and privacy domains on PostgreSQL | Released — `v3.0.0`, `v3.0.1` |
| **V3.1** (Task 1, Phases A–G) | Made what existed usable: the professional operating surface, the operability foundation, media/portfolio, reviews and the rating signal, privacy and the SMS provider port, and the non-external half of production enablement | Released — `v3.1.0` |
| **V3.2-A** | AI assistant foundation — the `ai` domain, a provider port that refuses to guess, and a deterministic assistant that states what it is | Merged; deterministic sandbox only |
| **V3.2-B** | Internal chat foundation — chat schema, immutable counterparty, proven eligibility, moderation and privacy boundary | Merged; backend only |
| **V3.2-C** | Referral and Wishlist — code generation, attribution, qualification, two-sided reward, full-refund reversal and loyalty clawback; wishlist persistence, discovery integration and target-state projection | **Engineering complete 2026-09-02 — 59/59 story points, 0 data-quality warnings** |
| **V3.3-A** | Commercial policy control plane (ADR-039) and the commercial parameter decision packet | **In progress** — epic #38 |
| **V3.2-D … V3.2-G** | CRM/delegation, B2B quotes and campaigns, payout and calendar automation, evidence-gated improvements | **Planned, not started** — product-, external- or evidence-gated |
| **V3.4** | Conditional mobile, marketplace, AI/realtime and scale expansion | Planned; no commitment without its evidence and gates |

Four different states must not be collapsed into the word "done":

| State | Current fact |
|---|---|
| **Engineering milestone** | V3.2-A, V3.2-B and V3.2-C are complete on `master`; the V3.2-C closure is commit `647162b`. V3.2-D through V3.2-G are still planned. |
| **User-facing product surface** | The V3.2 AI, chat, wishlist and referral capabilities have backend contracts and tests, but no corresponding route in `v3/apps/web/app`; the design prototypes are not production frontend code. |
| **Release** | No `v3.2.0` tag or GitHub Release exists. `v3.1.0` remains the newest release. |
| **Production enablement** | No production host, real payment gateway, SMS vendor or AI provider has been activated; the gates in [§9](#9-what-is-deliberately-not-enabled) remain open. |

Therefore **V3.2-A through V3.2-C are engineering-complete and unreleased**, not a
user-facing V3.2 release and not a claim that V3.2-D through V3.2-G are finished. The
release audit that prompted this clarification used baseline `e3f6b62`; that commit
includes the V3.2-C closure and later V3.3 documentation, so it must not be presented as
a pure V3.2 release commit.

There is no clean historical commit where all completed V3.2-A–C work exists while the
interleaved V3.3 control-plane work does not. In addition,
[`EXC-002`](docs/roadmap/v3/V3_RELEASE_POLICY_EXCEPTIONS.md#exc-002--v30x--v31x-payment-sandbox-release-exception)
covers only the V3.0.x and V3.1.x release lines and explicitly requires a new governance
decision before any V3.2.x tag. A milestone closure, green CI run or prerelease suffix
does not provide that authorization.

One historical naming collision also remains visible: the older V3.1 release strategy
reserved the name `v3.2.0` for externally gated V3.1 Phases E+F, while the later V3.2
product programme means AI, chat, wishlist and referral. Until release governance
reconciles those meanings, use the milestone names and immutable commit SHAs rather than
inferring a release from the number alone.

### V3.3 in one paragraph

V3.3 turns BeauClick's revenue model into architecture without inventing commercial
values. The owner's directions are closed as binding decisions in
[`V3.3_DECISION_REGISTER.md`](docs/roadmap/v3.3/V3.3_DECISION_REGISTER.md): customer
booking carries no BeauClick fee and seller subscriptions are the primary revenue
(`V33-DEC-001`); identity, workspace role and business vertical are three separate axes
(`V33-DEC-002`); the v1 collection modes are `pay_at_venue`,
`deposit_online_balance_at_venue` and `full_payment_online` (`V33-DEC-003`); policy
changes create immutable versions and every booking stores a snapshot of the terms it
accepted (`V33-DEC-004`); Booking emits facts, Commercial Policy decides, Payment
executes (`V33-DEC-005`); and rollout flag, plan entitlement, business policy and kill
switch are four independent controls that each fail closed (`V33-DEC-007`).

On **2026-09-02** the product owner ratified the *structure* of `V33-DEC-009` (plan
catalogue and booking-credit pricing) and `V33-DEC-010` (consumption, return and
overage), and Story #40 was decomposed from one 13-point item into four:

| Story | Points | Outcome it owns |
|---|---:|---|
| #40 (`#40a`) | 8 | Admin-versioned plan and price catalogue — immutable versions, non-overlapping activation windows, tier schedules, the `D-7` zero-price base workspace, the `bc_manage_commercial_plans` capability, audit with a mandatory reason |
| #56 (`#56a`) | 8 | Subscription foundation: snapshotted subscriber party, `D-7` backfill and lazy ensure, plan-included grants. No seller-facing route |
| #69 (`#56b`) | 8 | Seller subscription surface: a workspace collection reached by an opaque `workspaceRef`, explicit initialization, history, zero-price selection and cancellation |
| #57 (`#40c`) | 5 | Custom booking-credit purchase and immutable price snapshots |
| #58 (`#40d`) | 8 | Atomic consumption at first `confirmed` and idempotent return |

`#40b` was split again on 2026-09-03 (`V33-DEC-018`): #56 keeps its number and its
8 points as the foundation, and #69 carries the 5-point seller surface, so the
foundation can land with no seller-facing route while the capability and
audit-charter questions that only affect those routes are settled.

#56 shipped on 2026-09-03. #69 was re-estimated to 8 points the same day by
`V33-DEC-019`, which rejected its singular `/me/subscription` contract: one user
may own both a professional and a business workspace, so a singular route has no
answer that is not a silent choice. It becomes a workspace collection reached by
an opaque, server-issued `workspaceRef`. #69 shipped on 2026-09-04.

The same readiness audit found the pattern already shipped on the finance
surface, and `V33-DEC-020` closed it on 2026-09-04. `/api/v1/me/finance`
resolves one party per caller, business-first, so a dual owner cannot reach
their professional earnings — and the same resolver follows staff affiliation,
so an affiliated professional can read the employing business's financial
position. **Staff affiliation is not financial ownership:** finance reads move to
live ownership only, the workspace-aware routes reuse #69's `workspaceRef`
unchanged through a shared primitive, and the four singular routes stay,
corrected, refusing with `finance_workspace_selection_required` rather than
choosing a workspace for the caller. Tracked as #72, re-estimated to 8 points,
shipped on 2026-09-04.

`V33-DEC-020` deliberately did **not** enforce `bc_view_own_finance`, because no
production path grants a seller the role that carries it. That gap became #75,
and `V33-DEC-021` closed it on 2026-09-04 after the readiness audit found it is
an **active** defect rather than a latent one: #69 enforces
`bc_manage_own_subscription` on three mounted routes while account creation
grants only `customer`, so a genuine seller is refused `403` on subscription
initialization, plan selection and cancellation and never receives the base
`D-7` workspace. The `professional` and `business` roles will be granted
atomically on ownership creation — never on verification, never from
`business_staff`, never from a caller-supplied field — with an idempotent
ownership-only backfill, `customer` never removed, live ownership still the
authorization boundary, and a grant taking effect at the next access-token
issuance rather than inside an already-issued one. Tracked as #75, re-estimated
to 8 points, not yet started.

Prices, included allowances, bounds, cutoffs, legal copy and accounting treatment stay
open under issue #46, and real money movement stays blocked by #47. No allowance may
exist as a code constant, default, fallback or seed; an unconfigured plan or price
schedule refuses rather than falling back.

Story #40 (`#40a`) is now implemented on top of that foundation
([ADR-041](docs/roadmap/v3/adr/ADR-041-commercial-plan-and-price-catalogue.md)). The
`commercial` schema holds the administrator-versioned plan and price catalogue on the
shared application cluster: immutable versions with a one-way `draft -> published ->
retired` lifecycle, activation windows whose non-overlap is enforced by PostgreSQL
exclusion constraints rather than by application code, immutable tier schedules where a
flat price is a one-tier schedule, and the `D-7` base workspace as a published,
zero-price, automatically assignable plan version reached through a row property so no
code names it. The administrator routes live under `/api/v1/admin/commercial`, gated on
the new privileged `bc_manage_commercial_plans` capability, and every mutation writes an
audit record with a mandatory reason in the mutation's own transaction.

Story #39's contract, registry and control gate are unchanged; the catalogue is a second,
additive surface in the same service. Still absent by design: any seller-facing
subscription, purchase, grant, consumption or return (#56, #69, #57, #58), any recurring
billing or gateway, any commercial event, and any production price. No allowance —
including 200 — exists as a code constant, default, fallback or seed, and a repository
check in `v3/services/commercial-policy` enforces that against the implementation, its
contract and its migration.

---

## 2. Repository layout

```
v3/                       the active platform (Nx + pnpm workspace)
  apps/api/               the single NestJS deployable that composes every domain
  apps/web/               Next.js 14 App Router frontend (Persian, RTL)
  services/               19 domain modules — one bounded context each
  libs/                   11 cross-cutting libraries (auth, ownership, audit, events, …)
  packages/               8 shareable contracts and utilities (design tokens, Persian utils, …)
  database/               45 hand-written SQL migrations across 20 schemas, roles, seeds, scripts
  infra/docker/           local development containers and the API image

docs/                     ADRs, roadmaps, decision registers, runbooks, design handoffs
scripts/                  backlog reporting used by CI
.github/workflows/        V3 CI, V3 CD, PR policy, backlog report

wordpress/  app/  shared/  bin/    the frozen V2 tree — see §12
```

---

## 3. Architecture

### Shape

One deployable API composing independent domain modules — a **modular monolith**
(`ADR-002`), in TypeScript on NestJS (`ADR-003`), with PostgreSQL as the system of record
(`ADR-004`). Domains talk through published contracts and a transactional outbox
(`ADR-007`), never by reaching into each other's tables. Nx tags and ESLint module
boundaries enforce that: a domain importing another domain **fails CI** rather than
merely disappointing a reviewer.

### Domains (`v3/services/`)

| Domain | Owns |
|---|---|
| `identity` | OTP lifecycle, JWT/refresh issuance, RBAC capabilities, devices, session revocation, phone conflicts |
| `provider` | Professionals, services, specialties, cities, portfolio, verification, reviews |
| `business` | Businesses, locations and staff membership |
| `booking` | Availability, holds, claim/cancel/confirm/no-show/complete and rescheduling |
| `commerce` | Orders, items, the single unified pricing chain, idempotent order creation |
| `payment` | Payment intents, attempts, refunds, provider-abstracted gateways, verification contract |
| `financial` | Append-only commission ledger and settlements, on its own DataSource and role |
| `search` | OpenSearch read model, Persian/Arabic-Indic normalization, indexing projections |
| `loyalty` | Points ledger, tiers, benefits, membership |
| `journey` | Beauty profile, goals, timeline, and the one-way curated seam into `ai` |
| `notification` | Templates, preferences, channel ports, retry and delivery records |
| `analytics` | Versioned event store and the one shared `MetricsService` every dashboard reads |
| `business` | Business entity, staff and its own outbox |
| `waitlist` | Waitlist entries and concurrency-safe promotion |
| `privacy` | Subject export, erasure, anonymization, sweeps, request lifecycle |
| `ai` | AI assistant, provider port, deterministic fallback, curated context assembly |
| `chat` | Conversations, immutable counterparty, eligibility, moderation |
| `wishlist` | Saved items, target-state projection, tombstones |
| `referral` | Code generation, attribution claims, qualification, two-sided reward, reversal |
| `commercial-policy` | V3.3 control plane — versioned policy registry and a fail-closed gate (not yet composed into the API) |

### Cross-cutting libraries (`v3/libs/`)

`auth` (JWT guard, capability guard, throttler, privileged-capability port) · `ownership`
(server-side owner resolution, `not-found-or-not-yours`) · `audit` (admin audit log plus
the boot-time assertion that every privileged mutation is audited) · `events` (correlation,
outbox writer, envelopes) · `event-contracts` (versioned catalog and registry) · `http`
(response envelope, domain exceptions, pagination) · `media` (S3 driver with a hand-written
SigV4 signer, policies, image probing) · `money` (integer Toman, no floats) ·
`observability` (structured logging, redaction, metrics, error reporter) · `subject-data`
(the contract every data-owning table must register with before the app may boot) ·
`testing` (in-memory DataSource, real-PostgreSQL harness, adversarial ownership helpers).

### Data model

- **Schema per domain.** 45 hand-written migrations across 20 schemas — no ORM
  autogeneration, snake_case columns, re-runnable so a partial deploy can be retried.
- **The ledger is isolated by database role, not by convention.** `financial.*` is owned by
  `beauclick_financial_owner`; the application connects as a separate `INSERT + SELECT`
  writer on a second DataSource (`ADR-017`). The application role cannot even `SELECT` the
  ledger from the shared pool. `pnpm verify:roles` proves that contract against any
  target, as the ordinary application role — no superuser required.
- **The admin audit log** is owned by `beauclick_admin_audit_owner` for the same reason,
  but stays on the main pool so an audit row commits in the same transaction as the
  mutation it records.
- **Transactional outbox** per domain, drained post-commit by independent relays.

### Frontend

Next.js 14 App Router (`v3/apps/web`), Persian and RTL throughout, consuming the API as a
separate origin with an explicit CORS allow-list. Route groups cover search and provider
profiles, auth, booking and checkout, the customer dashboard, journey, loyalty,
notifications, waitlist, the professional surface (`/pro`: availability, bookings,
services, finance, analytics, profile), business, admin (verification, users, settlements,
loyalty, notifications, search, audit log, phone conflicts), and the sandbox gateway page.

### Security model

Session-derived ownership (a client-supplied professional, business, conversation or
subscriber id is never trusted), capability-based RBAC with live revocation rechecking for
privileged capabilities, refresh cookie plus double-submit CSRF (`ADR-020`), five named
rate-limit policies keyed on user id or IP, helmet, an explicit CORS allow-list, and a
secret contract in [`env.validation.ts`](v3/apps/api/src/config/env.validation.ts) that
refuses to boot in production on a missing, too-short, placeholder, or reused secret. See
[`V3_SECURITY_MODEL.md`](docs/roadmap/v3/V3_SECURITY_MODEL.md).

---

## 4. Getting started

### Prerequisites

- **Node.js ≥ 22.13** — pnpm 11 refuses to run under anything older.
- **pnpm 11.22.0** — pinned in `packageManager`; a different major computes a different
  lockfile overrides hash and rejects a lockfile this workspace installs cleanly.
- **Docker** — for PostgreSQL 16, OpenSearch 2.19 and MinIO.
- `psql` on `PATH` for provisioning, and `pg_dump` if you intend to run `pnpm backup`.

### 1. Install

```bash
cd v3 && pnpm install --frozen-lockfile
```

### 2. Start the development services

Create the ignored Compose environment file first. Secret-bearing values are never
provided as tracked defaults:

```bash
cp v3/infra/docker/.env.example v3/infra/docker/.env
```

Fill every blank with an independently generated local value, following
[`LOCAL_SECRETS.md`](docs/runbooks/LOCAL_SECRETS.md). Compose deliberately refuses to
start when one is missing.

```bash
docker compose -f v3/infra/docker/docker-compose.yml up -d
```

That gives you PostgreSQL on **5433** (not 5432, so a system PostgreSQL does not have to be
stopped), OpenSearch on 9200, and MinIO on 9100.

### 3. Provision the database roles — once per database

The financial and admin-audit owner roles must exist **before** the migrations that create
their schemas run, because those schemas are deliberately not owned by the application
role. Run both scripts as a superuser.

No password is written down here, and none should be: choose your own local values and
export them for the shell you are provisioning from. `ADMIN_DATABASE_URL` is the superuser
connection for the container `docker-compose.yml` just started — its user, database name
and port are in that file.

```bash
export ADMIN_DATABASE_URL='postgres://<superuser>:<password>@localhost:5433/beauclick_v3_dev'
```

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v owner_password="$FINANCIAL_OWNER_PASSWORD" -v writer_password="$FINANCIAL_WRITER_PASSWORD" -v reader_password="$FINANCIAL_READER_PASSWORD" -v db_name=beauclick_v3_dev -v app_role=beauclick_app -f v3/database/scripts/financial-roles.sql
```

```bash
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v owner_password="$ADMIN_AUDIT_OWNER_PASSWORD" -v db_name=beauclick_v3_dev -v app_role=beauclick_app -f v3/database/scripts/admin-audit-roles.sql
```

PostgreSQL 15+ no longer grants `CREATE` on the public schema to `PUBLIC`, and
database-level `ALL` does not include it, so the application role also needs:

```bash
psql "$ADMIN_DATABASE_URL" -c 'GRANT CREATE ON SCHEMA public TO beauclick_app'
```

Keep the values you chose out of Git — they belong in `v3/apps/api/.env`, which is
ignored, and the same values go into the connection strings in the next step.

> PostgreSQL roles are **cluster-global** and both scripts run `ALTER ROLE … PASSWORD`.
> Never point them at a scratch database on a cluster that another database is using — it
> silently resets those passwords everywhere.

### 4. Configure and migrate

```bash
cp v3/apps/api/.env.example v3/apps/api/.env
```

Fill in `DATABASE_URL`, `FINANCIAL_DATABASE_URL`, `JWT_ACCESS_SECRET` and
`OTP_HMAC_SECRET` (the last two are refused if shorter than 32 characters or if they
contain placeholder text). Then:

```bash
cd v3 && pnpm migrate
```

Re-running must apply nothing — CI asserts exactly that.

### 5. Run

```bash
cd v3 && PORT=3099 pnpm api:dev
```

```bash
cd v3/apps/web && pnpm dev
```

The API serves under the `/api` prefix and the web app calls
`http://localhost:3099/api` by default, so either start the API on `3099` as above or set
`NEXT_PUBLIC_API_BASE_URL`. The web app listens on **3100**, which is also the only origin
in the default CORS allow-list.

### Seeding

Reference data (provinces, cities, specialties) lives in
[`v3/database/seeds/reference-data.seed.ts`](v3/database/seeds/reference-data.seed.ts).
`v3/database/scripts/grant-platform-operator.ts` grants the administrative capability set
to a user so the admin surfaces become reachable.

---

## 5. Command reference

All commands run from `v3/`.

| Command | What it does |
|---|---|
| `pnpm build` | `nx run-many -t build` across every project |
| `pnpm typecheck` | Type-checks every project |
| `pnpm lint` | ESLint, including the Nx module-boundary rules that enforce `ADR-011` |
| `pnpm test` | The fast suite — unit tests and pg-mem, no external services |
| `pnpm test:pg` | The real-PostgreSQL/OpenSearch/object-storage suite (see §6) |
| `pnpm migrate` | Applies pending migrations; idempotent |
| `pnpm verify:roles` | Runs the role-grant contract; as the application role, no superuser |
| `pnpm backup` | `pg_dump` to `BACKUP_DIR` from `BACKUP_SOURCE_URL` |
| `pnpm restore:rehearse` | Dumps, restores into a disposable database, compares row counts and schema version, and re-runs the role contract against the restored copy |
| `pnpm api:dev` | Runs the API from source |

`ts-node` scripts under `database/scripts/` must be run with
`--project database/scripts/tsconfig.json` — there is no root `tsconfig.json`, and without
it ts-node emits ESM and any script importing a sibling dies at `ERR_MODULE_NOT_FOUND`.
The `pnpm` scripts already pass it.

---

## 6. Testing

Two layers, and the split is deliberate (`ADR-015`).

**Fast suite — `pnpm test`.** Unit tests and pg-mem, with no external services, so an
obvious break fails quickly. pg-mem does **not** honour TypeORM's `ROLLBACK`, so nothing
about atomicity, isolation, locking, or a unique constraint can be proven here.

**Real-PostgreSQL suite — `pnpm test:pg`.** 44 `*.pg-spec.ts` suites in
[`v3/apps/api/test`](v3/apps/api/test) covering booking and waitlist concurrency, the
append-only ledger and its grants, the outbox, payment retry/security/verification,
referral attribution, qualification, reversal and adversarial abuse, chat eligibility and
moderation, AI lifecycle privacy, media over a real S3 API, OpenSearch projections, role
contracts, and readiness. Every correctness guarantee this platform rests on is proved
here or nowhere.

Each suite self-skips when its environment variable is absent, so CI additionally runs
[`assert-jest-zero-skipped.ts`](v3/database/scripts/assert-jest-zero-skipped.ts) against
the captured output — a silently skipped suite is the exact failure mode the gate exists
to prevent.

Locally the suite reads `TEST_DATABASE_URL` and `TEST_FINANCIAL_WRITER_URL` (it skips
entirely without them), plus `TEST_FINANCIAL_OWNER_URL` (the two financial suites skip
without it, because only the owner role may clear `financial.*`),
`TEST_FINANCIAL_READER_URL`, `TEST_OPENSEARCH_URL` and the `TEST_S3_*` values. Run with
`TZ=UTC`. [`LOCAL_SECRETS.md`](docs/runbooks/LOCAL_SECRETS.md) says how to supply each one
securely and where the financial owner password comes from.

> Every pg-spec `TRUNCATE`s shared tables in `beforeEach`. Two concurrent runs against one
> database deadlock on that truncate, and the fallout looks like product bugs — unrelated
> 403s, null timestamps on writes that succeeded, dozens of failures at once — rather than
> like contention. Run one at a time, or give each run its own database.

---

## 7. Continuous integration and delivery

Four workflows in [`.github/workflows/`](.github/workflows):

- **`v3-ci.yml`** — runs the *same commands a developer runs locally*, so a gate that
  passes in CI and fails on a laptop is an environment bug, not a second definition of
  green. Three jobs: static (`typecheck`, `lint`, `build`); fast tests; and the real gate —
  ephemeral PostgreSQL 16, OpenSearch 2.19.1 and MinIO containers, role provisioning,
  migration, a migration-idempotency assertion, `verify:roles`, a backup/restore rehearsal,
  and the full `test:pg` suite with the zero-skipped assertion. No production credential,
  no deploy step, no real gateway or SMS provider.
- **`v3-cd.yml`** — the deploy job fails with an enablement message rather than pretending,
  because the hosting decision (`HOSTING`) is open.
- **`pr-policy.yml`** — validates PR metadata and the branch prefix
  (`feature/`, `fix/`, `docs/`, `chore/`, `design/`, `codex/`).
- **`backlog-report.yml`** — validates backlog metrics and regenerates the dashboard.

---

## 8. Operations

[`docs/runbooks/`](docs/runbooks/) holds six runbooks, each written around a command that
exists and can be run today, and each stating plainly which steps have actually been
exercised and which are waiting on the hosting decision:
[LOCAL_SECRETS](docs/runbooks/LOCAL_SECRETS.md), [DEPLOY](docs/runbooks/DEPLOY.md), [ROLLBACK](docs/runbooks/ROLLBACK.md),
[RESTORE](docs/runbooks/RESTORE.md), [SECRET_ROTATION](docs/runbooks/SECRET_ROTATION.md),
[PAYMENT_INCIDENT](docs/runbooks/PAYMENT_INCIDENT.md).

None of them closes a gap. They remove the excuse that the work is undocumented; they do
not perform it.

The API exposes `/health`, `/health/ready` and a `/metrics` endpoint that answers **404**
unless `METRICS_AUTH_TOKEN` is set — the worst outcome of forgetting it should be a
missing dashboard, not an open one.

---

## 9. What is deliberately not enabled

This matters as much as the feature list, and the project's execution policy
([`V3.1_EXTERNAL_ENABLEMENT_STRATEGY.md`](docs/roadmap/v3.1/V3.1_EXTERNAL_ENABLEMENT_STRATEGY.md))
is explicit that a mock, a local harness, or an unperformed check is never production
evidence.

| Area | State |
|---|---|
| Hosting | Undecided (`HOSTING`). The CD deploy job fails closed; the real restore drill and the role-grant verification against a real host remain open. |
| Payment gateway | No real Iranian gateway adapter and no merchant credentials. Only the sandbox provider exists, and it requires both `PAYMENT_ENVIRONMENT=sandbox` **and** a non-production `NODE_ENV` — there is deliberately no override that re-enables it in production. |
| SMS | No vendor selected. The port and configuration contract exist; missing credentials leave SMS unavailable rather than falling back. |
| AI provider | No vendor, SDK, credential or external call. The `ai` domain runs a deterministic assistant that states what it is. |
| Object storage vendor | MinIO proves the S3 API locally and in CI; the production vendor is undecided and downstream of hosting. |
| Error tracking | Generic JSON collector only; no backend selected. |
| Commercial values | Plan prices, allowances, deposit bounds, cancellation cutoffs, dispute windows, settlement policy, tax and revenue recognition are open under #46. |
| Real money movement | Blocked by #47. Structural and deterministic sandbox work may proceed; paid collection and settlement may not. |
| Legal copy | Approved Persian policy text and terminology are open under #46. |

---

## 10. Documentation map

| Path | What it holds |
|---|---|
| [`docs/roadmap/v3/adr/`](docs/roadmap/v3/adr/) | **ADR-001 … ADR-040** — architecture decisions and their dated status. ADR-040 reconciles the implemented deployment topology. |
| [`docs/roadmap/v3/`](docs/roadmap/v3/) | The V3 blueprint corpus: domain boundaries, database and API blueprints, event architecture and catalog, security model, infrastructure plan, migration matrix, release audits |
| [`docs/roadmap/v3.1/`](docs/roadmap/v3.1/) | V3.1 roadmap, phase reports, release strategy, and the external-enablement execution policy |
| [`docs/roadmap/v3.2/`](docs/roadmap/v3.2/) | V3.2 roadmap, capability catalog, decision register, external-dependency ledger, phase reports |
| [`docs/roadmap/v3.3/`](docs/roadmap/v3.3/) | **Current** — the commercial decision register and the parameter decision packet |
| [`docs/product/`](docs/product/) | Backlog index and the backlog operating model; the live backlog is GitHub Issues |
| [`docs/runbooks/`](docs/runbooks/) | Deploy, rollback, restore, secret rotation, payment incident |
| [`docs/design/`](docs/design/) | Handoffs merged to `master`. Later V3.2 workspace snapshots remain on `design/claude-design`; see `docs/design/README.md` before treating either location as current production UI. |
| [`docs/business/`](docs/business/) | Business idea and business plan (Persian) |
| [`docs/architecture/`](docs/architecture/) | The V2-era architecture proposal, superseded by the V3 ADRs |
| [`docs/archive/`](docs/archive/) | Documents kept for the record — see [`ARCHIVE_NOTE.md`](docs/archive/ARCHIVE_NOTE.md) for what each one was and what replaced it |

When an implementation reveals a real deviation from an accepted ADR, record the change
and why — do not let the documents silently drift from the code.

---

## 11. Working agreements

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. In short:

- **Pull-request first.** `master` is the latest reviewed, integration-tested state, never
  a working branch. Direct pushes are prohibited by project policy.
- **Backlog first.** Every implementation PR references an accepted GitHub issue carrying
  type, milestone, priority, status and story-point labels
  ([`BACKLOG_OPERATING_MODEL.md`](docs/product/BACKLOG_OPERATING_MODEL.md)).
- **One scoped branch per task**, prefixed `feature/`, `fix/`, `docs/`, `chore/`,
  `design/` or `codex/`.
- **Green means green.** Cancelled is not green, and a later green run proves only the
  later revision.
- **A green PR authorizes nothing external.** A release tag, deployment, credential change,
  paid provider, public repository or external integration each needs its own documented
  approval.
- Commit prefixes are conventional and scoped, e.g.
  `feat(booking): prevent double-booking on concurrent requests`.
- Never commit secrets. Every secret-bearing entry in `v3/apps/api/.env.example` is left
  **blank** — the file documents names and non-sensitive defaults, never a real value. The
  authoritative list of what each secret protects is `SECRET_CONTRACT` in code, because a
  list in a document drifts from the code that reads it.

---

## 12. The frozen V2 tree

`wordpress/`, `app/`, `shared/` and `bin/` hold V2.4.1 — the WordPress + WooCommerce
implementation with 18 `beauclick-*` plugins and a React app-shell. It is kept unchanged
as historical reference and as migration evidence. It is **not** built, tested, deployed
or maintained: the V3 CI pipeline is path-filtered to `v3/**` and never runs against it.

Why it was replaced, and what exactly WordPress was doing for the product, is recorded in
[`ADR-001`](docs/roadmap/v3/adr/ADR-001-wordpress-exit.md) and
[`WORDPRESS_EXIT_MATRIX.md`](docs/roadmap/v3/WORDPRESS_EXIT_MATRIX.md). The README that
described how to run it is preserved at
[`docs/archive/README-v2-wordpress.md`](docs/archive/README-v2-wordpress.md).
