# V3 Phase 1 Implementation — Identity Service + Provider Service Foundation

Status: **COMPLETE.** Verified against real PostgreSQL 16, with a real frontend, in a real browser. Code lives under `v3/` at the repository root (a new top-level directory, chosen specifically to avoid colliding with V2's existing `app/` and `wordpress/` directories and to leave V2 completely untouched). V2.4.1's behavior was not modified in any way — no file under `wordpress/`, `app/`, or `shared/` was written or deleted during this phase (`shared/design-tokens.json` was read once, to copy into the V3 design-tokens package).

> **Document history.** The first pass built the backend foundation and disclosed four things as incomplete: no real PostgreSQL, no frontend, no automated module-boundary enforcement, and a build-output path problem. **All four are now closed** — see §15 (Phase 1 completion pass). Sections 1–14 describe the foundation; §15 records what the completion pass changed, including three real bugs that only a real database could surface.

---

## 1. What was built

### A) Repository foundation
pnpm workspace + Nx monorepo under `v3/`, exactly matching `V3_REPOSITORY_STRUCTURE.md`'s `apps/services/libs/packages/database/infra` layout (ADR-011). 9 workspace projects: `api` (app), `identity`, `provider` (services), `auth`, `ownership`, `http`, `testing` (libs), `persian-utils` (packages). Nx's module-boundary discipline is enforced by convention in this phase (no `services/*` package imports another `services/*` package directly — verified by inspection, not yet by an automated `enforce-module-boundaries` lint rule, a disclosed simplification — see §12).

### B) Backend foundation
NestJS (`apps/api`), TypeScript strict mode (`tsconfig.base.json`: `strict`, `noImplicitAny`, `strictNullChecks`, `noImplicitReturns`), `@nestjs/config`-based environment configuration with fail-fast production validation (`config/env.validation.ts`), structured logging (Nest's built-in `Logger`, tagged `AUDIT:*` for security-relevant events), a global exception filter translating every error into the standard Persian-messaged envelope (`BeauClickExceptionFilter`), a global `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true`), URI-based API versioning (`/api/v1/...`, per ADR-014), and a real health endpoint (`GET /api/health`) that checks the actual database connection, not just process liveness.

### C) Database foundation
PostgreSQL via TypeORM, schema-per-module (`identity`, `provider`), UUIDv7 primary keys generated application-side (`uuidv7` package), full audit columns (`createdAt`/`updatedAt`, `createdBy`/`updatedBy` foundation) per `V3_DATABASE_BLUEPRINT.md`. Real SQL migration files written for both schemas (`v3/database/migrations/identity/`, `v3/database/migrations/provider/`) matching the entity definitions exactly. **Known limitation, disclosed in §11**: these migrations have not been executed against a real PostgreSQL server in this environment (none available — see below); they were validated structurally via TypeORM's schema-sync path against an in-memory Postgres-compatible engine (pg-mem) in the automated test suite, which exercises the same DDL shape and every real query against it, but is not a substitute for a real Postgres run.

### D) Identity service
`v3/services/identity` — implements ADR-008 in full for this phase's scope:
- **User entity** (`identity.users`): phone (unique, canonical E.164), roles, verification flag, soft-delete-ready.
- **Phone identity**: canonicalization (`phone.util.ts`, handles `09...`/`+98...`/`0098...`/Persian-Arabic digit variants), `AccountResolverService` (find-or-create by phone, **never silently merges** — a genuine concurrent-first-verification race is recorded, not merged, matching V3_SECURITY_MODEL.md §1 exactly).
- **OTP authentication foundation** (`OtpService`): 6-digit crypto-secure codes, HMAC-SHA256 hashed (never plaintext), constant-time comparison, atomic single-use consumption, purpose-scoping, configurable expiry/attempt-lockout/cooldown/rate-limit windows (all `GAP-10`-provisional, matching the shape not the exact numbers).
- **JWT access tokens + rotating refresh tokens** (`TokenService`): 15-minute access tokens, 30-day refresh tokens stored hashed with device/session metadata, **rotation-with-replay-detection** (a reused, already-rotated token revokes the caller's entire session chain, not just that request).
- **Session lifecycle**: single-session logout, logout-all-devices, a self-scoped session list (`GET /v1/auth/sessions`) and per-session revocation (`DELETE /v1/auth/sessions/:id`) — the device-management surface this task's security requirements ask for.
- **RBAC capability model**: capability-based checks throughout (`CapabilityGuard`/`@RequireCapability`, in `libs/auth`); role→capability mapping is code-based for this phase (see §11).
- **Ownership resolver foundation**: `libs/ownership`'s `OwnerResolver` interface + `OwnershipGuard` + `@ResolveOwner` decorator — the concrete GAP-08 fix, accepting an injectable resolver class (not a raw ID), so indirect ownership is actually expressible.

### E) Provider service
`v3/services/provider` — the CPT→relational re-platform for **Professional** only (see §11 for why Business is out of this phase's scope). Real tables: `provider.professionals` (owner_id unique per this phase's "one profile per identity" scope, display name, bio, city, verification status), `provider.specialties` (+ `professional_specialties` join table), `provider.locations_cities`, `provider.services` (catalog fields only — no availability/booking logic). Every mutation resolves ownership server-side (`ProviderOwnerResolver`, `@ResolveOwner`) — no client-supplied owner ID is ever trusted, verified by dedicated adversarial tests (§7). `ProviderService.update()` re-checks `ownerId` at the data-access layer itself, independent of the HTTP-layer guard — the same defense-in-depth pattern GAP-05 established for financial-service, applied here from day one rather than added after an audit.

### F) Testing foundation
Jest across every project. `libs/testing` provides a real in-memory Postgres-compatible `DataSource` (pg-mem) for integration/e2e tests — a disclosed, documented stand-in for the testcontainers-backed real Postgres ADR-015 specifies (§11). `apps/api/test/test-app.factory.ts` boots the actual NestJS application (same guards, filters, interceptors as production) against that in-memory database for true e2e coverage via supertest.

### G) Documentation updates
This document, plus `V3_GAP_REGISTER.md` updated with this phase's findings (§13).

---

## 2. Architecture decisions confirmed or refined during implementation

- **ADR-011's `apps/services/libs/packages` split held up exactly as designed** — no restructuring was needed once real code was written into it.
- **`libs/auth` was created during implementation, not anticipated in the original Phase 0 blueprint's exact file list** — while writing `services/provider`'s controller, an attempt to import the `@Public()` decorator from `services/identity` was caught as a real Nx module-boundary violation (a `services/*` package should never import another `services/*` package directly). `JwtAuthGuard`, `CapabilityGuard`, and their decorators were extracted into `libs/auth` (already named in `V3_REPOSITORY_STRUCTURE.md`'s original directory listing, just not yet populated) — this is the blueprint working as intended, not a deviation from it.
- **A real NestJS/`@nestjs/config` interaction bug was found and fixed**: `JwtModule.registerAsync({ inject: [ConfigService], ... })` and `TypeOrmModule.forRootAsync({ inject: [ConfigService], ... })` both silently fail to resolve `ConfigService` at boot unless `ConfigModule` is also listed in that specific call's own `imports` array — `isGlobal: true` alone is not sufficient for an async dynamic module's own `inject` resolution. This is a well-known NestJS/`@nestjs/config` interaction, not specific to this codebase, but it was a real, boot-blocking bug this phase's e2e tests caught and fixed in both `libs/auth/src/jwt-config.module.ts` and `apps/api/src/app.module.ts`.
- **A real pnpm monorepo dependency-duplication bug was found and fixed**: pnpm's per-peer-dependency-context install strategy had resolved **two separate physical copies** of `@nestjs/common`, `@nestjs/core`, and `@nestjs/typeorm` across the workspace (`apps/api` resolved one set, `services/identity`/`services/provider` resolved another). This was invisible at the type-checking level but broke dependency injection at runtime — a `DataSource` provided using one physical copy's class reference was not recognized by `@InjectRepository` decorators compiled against the other copy. Fixed via `pnpm-workspace.yaml`'s `overrides` field, pinning one exact version of every `@nestjs/*` package, `typeorm`, `pg`, `rxjs`, and related packages workspace-wide. This is disclosed as a real, non-obvious finding worth carrying forward into every later phase's dependency additions — a new package with a slightly different peer-dependency range can silently reintroduce this class of bug.

---

## 3. Database changes

Per `V3_DATABASE_BLUEPRINT.md`'s conventions exactly:
- Schemas: `identity`, `provider`.
- Tables created (migration files in `v3/database/migrations/{identity,provider}/`): `identity.users`, `identity.otp_requests`, `identity.refresh_tokens`, `identity.phone_conflicts`; `provider.professionals`, `provider.specialties`, `provider.professional_specialties`, `provider.services`, `provider.locations_cities`.
- No `financial`, `payment`, `booking`, or other future-phase schemas were created — scope held exactly to identity + provider, per this phase's explicit instruction.

---

## 4. API contracts implemented

All under `/api/v1/`, matching `V3_API_CONTRACT_BLUEPRINT.md`'s envelope/error/pagination conventions exactly:

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/request-otp` | public | Anti-enumeration verified by test |
| POST | `/auth/verify-otp` | public | Issues access + refresh token pair |
| POST | `/auth/refresh` | public (refresh token in body) | Rotates; replay revokes entire chain |
| POST | `/auth/logout` | session | Revokes one session |
| POST | `/auth/logout-all-devices` | session | Revokes every session |
| GET | `/auth/sessions` | session | Self-scoped device list |
| DELETE | `/auth/sessions/:id` | session | Ownership re-checked; forged id → 404 |
| GET | `/me` | session | Self-scoped, no ownership resolver needed (no `:id` param) |
| PATCH | `/me` | session | Self-scoped |
| GET | `/providers` | public | Paginated, filterable by city/specialty |
| GET | `/providers/:id` | public | 404 for nonexistent id |
| POST | `/providers` | session | ownerId always session-derived; 409 on second profile |
| PATCH | `/providers/:id` | session + `@ResolveOwner` | 404 (not 403) for a forged id — existence never leaks |
| GET | `/providers/:id/services` | public | |
| POST | `/providers/:id/services` | session + `@ResolveOwner` | Ownership-gated on the parent professional |
| GET | `/health` | public | Real DB-connection check |

---

## 5. Security model implemented

Per ADR-008/`V3_SECURITY_MODEL.md`, verified (not merely designed) by the test suite in §7:
- OTP: crypto-secure generation, HMAC-hashed storage, constant-time comparison, atomic single-use consumption, purpose-scoping, phone+IP rate limiting, anti-enumeration (identical response for known/unknown phone; identical error for expired/never-requested/wrong code up to the attempt-lockout boundary).
- JWT/refresh: short-lived access tokens, rotating refresh tokens, replay detection revoking the full session chain, per-device session listing/revocation.
- Ownership: every resource-mutating route re-verifies ownership server-side, both at the HTTP-guard layer (`OwnershipGuard`) and, for `ProviderService.update()`, at the data-access layer itself — defense in depth from day one, not retrofitted.
- Error responses never distinguish "doesn't exist" from "exists but isn't yours" (`NotFoundOrNotYoursException`, one type, used everywhere).
- Every unexpected/internal error returns a generic Persian message to the client; full detail is logged server-side only — verified by a dedicated test asserting no English text leaks into a 500 response.

---

## 6. Frontend foundation

**Not built in this phase.** This task's own scope list places "Frontend foundation" under Phase 1's required deliverables (§8: Next.js foundation, routing, auth client layer, API client, token handling, RTL config, Persian localization, design-token integration), but given the scale already consumed by a fully working, tested backend foundation (66 passing tests across 6 projects, two real infrastructure bugs found and fixed), building a second application in the same pass risked shipping either an untested backend or an untested frontend. **Decision: prioritize a fully verified backend foundation over a partially-verified backend + frontend.** `packages/persian-utils` (the one piece of frontend-shared code Phase 1 could deliver with genuine confidence) is complete and tested — see §9. The Next.js application itself is the first item of remaining Phase 1 work (§14), not deferred to Phase 2.

---

## 7. Test results

**All 66 tests pass. TypeScript strict-mode typecheck clean across all 8 projects. ESLint clean (0 errors, 0 warnings). Build succeeds** (`apps/api` compiles to real JS output).

| Project | Tests | Result |
|---|---|---|
| `persian-utils` | 21 | ✅ all pass (ported verbatim from V2, including the documented digit-substitution-≠-calendar-conversion regression test) |
| `http` | 7 | ✅ all pass (response envelope, exception filter — including a real bug this test suite caught and fixed: a bare 500 `InternalServerErrorException` was being mislabeled `VALIDATION_ERROR`) |
| `ownership` | 4 | ✅ all pass (`OwnershipGuard` unit tests: allow-on-match, `NotFoundOrNotYours` on mismatch, identical exception for "doesn't exist") |
| `identity` | 8 | ✅ all pass (`OtpService` integration tests against pg-mem: verify success, wrong code, expiry, replay, attempt lockout, purpose-scoping, rate limiting, never-stores-plaintext) |
| `provider` | 11 | ✅ all pass (`ProviderService` integration tests: create/read/update/list, one-profile-per-owner, ownership mismatch rejected, pagination/filtering, verification state machine) |
| `api` (e2e) | 15 | ✅ all pass — see breakdown below |

**`api` e2e breakdown** (`apps/api/test/*.e2e-spec.ts`, real HTTP requests via supertest against the actual NestJS app):
- **Authentication flow** (8 tests): full request-otp→verify-otp→refresh→logout lifecycle; anti-enumeration; invalid OTP; expired OTP; reused OTP (replay); attempt lockout; rate limiting; token revocation (both single-session and replay-triggers-full-chain-revocation).
- **Provider ownership isolation** (7 tests, this task's explicit "provider isolation" requirement): a client-supplied `ownerId` is rejected outright (400, `forbidNonWhitelisted`); provider A cannot modify provider B (404, data verified untouched, not just "request failed"); a forged id and a nonexistent id return the **identical** response shape; unauthenticated requests are rejected (401); a service offering cannot be created under another provider's profile; one user cannot create a second professional profile.

**Two real bugs were found and fixed during test-writing itself** (not pre-existing, caught by the act of writing adversarial tests, which is the point of writing them): the `BeauClickExceptionFilter`'s 500-status mislabeling (§ above), and two broken test assertions of my own (a nonsensical `201 in res` expression, and a wrong expected status for the attempts-exhausted case) — both fixed once the real, correct application behavior was understood, not by weakening the assertions.

---

## 8. Security testing — explicit checklist against this task's requirements

| Required test | Status | Where |
|---|---|---|
| Invalid OTP | ✅ | `auth.e2e-spec.ts`, `otp.service.spec.ts` |
| Expired OTP | ✅ | `auth.e2e-spec.ts`, `otp.service.spec.ts` |
| Reused OTP | ✅ | `auth.e2e-spec.ts`, `otp.service.spec.ts` |
| Rate limiting | ✅ | `auth.e2e-spec.ts`, `otp.service.spec.ts` |
| Token revocation | ✅ | `auth.e2e-spec.ts` (single-session + replay-triggers-chain-revocation) |
| User cannot access another user's provider | ✅ | `provider-ownership.e2e-spec.ts` |
| Forged provider ID rejected | ✅ | `provider-ownership.e2e-spec.ts`, `ownership.guard.spec.ts` |
| Unauthorized update rejected | ✅ | `provider-ownership.e2e-spec.ts` (both unauthenticated and cross-tenant cases) |
| Provider A cannot modify provider B | ✅ | `provider-ownership.e2e-spec.ts` (data verified untouched, not just request-failed) |

---

## 9. What was directly reused from V2 (verbatim)

`packages/persian-utils` — `jalali.ts` and `format.ts`, ported with **zero logic changes** from `app/src/lib/`, including their existing test suites (converted Vitest→Jest syntax only, same assertions) — all 21 tests pass unchanged, confirming the port introduced no regressions. This is the first concrete instance of `V3_MIGRATION_MATRIX.md`'s DIRECT REUSE classification actually being executed, not just planned.

---

## 10. Git discipline

See §14 (Git status) and the commit log for the actual commits created. Baseline verified before any change: `master` branch, HEAD `f30e0d6` (tag `v2.4.1`), clean working tree except the pre-existing untracked `docs/roadmap/v3/*` blueprint files and `start-beauclick.vbs` (neither created by this phase). No `v3.0.0` tag was created.

---

## 11. Known limitations (disclosed, not silently worked around)

> **Items 1, 2, 5, and 6 below were CLOSED by the Phase 1 completion pass — see §15.** They are left here unedited as an accurate record of the first pass's state; §15 states what changed. Items 3, 4, 7, and 8 remain open and are restated in §15's own limitations list.

1. ~~**No real PostgreSQL server available in this environment**~~ — **CLOSED (§15.1)**: PostgreSQL 16.15 installed, migrations run and verified, 26 real-DB integration tests passing. *(Original text:)* All integration/e2e tests run against pg-mem, a real in-memory SQL engine — genuinely exercises schema/query correctness, not a mocked repository layer, but is **not** equivalent to real Postgres (no real connection pooling, no real role-grant enforcement, some Postgres system catalogs unimplemented — worked around, not present). **Action before Phase 2**: run `v3/database/migrations/**/*.sql` against a real Postgres instance and re-run the full test suite with a real `DATABASE_URL` before trusting this foundation for the financial-service ledger, whose append-only guarantee (`ADR-009`) specifically depends on real Postgres role-grant behavior pg-mem cannot verify.
2. ~~**Frontend foundation not built**~~ — **CLOSED (§15.4)**: Next.js App Router foundation built, 30 frontend tests passing, live-verified in a real browser.
3. **RBAC is code-based (`capabilities.ts`'s static role→capability map), not the dynamic `identity.roles`/`identity.capabilities` tables** `V3_DATABASE_BLUEPRINT.md` §8 lists. Every authorization check still goes through capability names (never a role string), so upgrading to dynamic tables later changes only where the map's data comes from, not how any guard/controller checks it — but this is a real scope reduction from the full blueprint, done deliberately to keep Phase 1 focused.
4. **Audit logging is structured-logger-based** (`Logger`, tagged `AUDIT:*`), not the DB-persisted, structurally-enforced-at-registration-time contract `V3_SECURITY_MODEL.md` §7 and `V3_IMPLEMENTATION_ROADMAP.md` Phase 4 describe. Security-relevant events (OTP requested, login, logout, provider created/updated) are logged; the full `libs/audit` structural-enforcement decorator is explicitly Phase 4 scope per the roadmap this task itself set, not silently skipped.
5. ~~**Nx module-boundary enforcement is by convention**~~ — **CLOSED (§15.3)**: `@nx/eslint-plugin`'s `enforce-module-boundaries` is now active with scope tags and verified by deliberate violation in both directions.
6. ~~**`apps/api`'s TypeScript build output path is deeper than intended**~~ — **CLOSED (§15.5)**: output is now a clean `dist/apps/api/src/main.js`.
7. **One-profile-per-owner is enforced for `professionals` only** (a unique constraint on `ownerId`) — this is Phase 1's deliberate scope (`Business` entities are explicitly out of scope, per this task's own instruction listing only "Professional entity" among what to implement), not a general product constraint being silently imposed on the eventual multi-staff Business model.
8. **`pnpm-lock.yaml`'s dependency-duplication fix (§2) should be re-verified whenever a new package is added** to any `v3/` `package.json` — a new package with a peer-dependency range slightly different from what's already pinned in `pnpm-workspace.yaml`'s `overrides` can silently reintroduce the same class of bug this phase found and fixed.

---

## 12. Remaining Phase 1 work

**All four items in this section were completed by the Phase 1 completion pass (§15).** Left unedited as a record of what the first pass owed:
1. ~~**Frontend foundation**~~ — done, §15.4.
2. ~~**Verify migrations against a real PostgreSQL server**~~ — done, §15.1.
3. ~~**Nx `enforce-module-boundaries` lint rule**~~ — done, §15.3.
4. ~~Minor build-output path cleanup for `apps/api`~~ — done, §15.5.

---

## 13. Gap register updates

See `V3_GAP_REGISTER.md`'s new Phase 1 addendum for the formal record. Summary: no new product/architecture gaps were found in V2 during this phase (Phase 1 is pure new-build, not further V2 discovery) — the findings here are all about the **V3 build itself** (the two infrastructure bugs in §2, the known limitations in §11), recorded as implementation notes rather than V2 gaps.

---

## 15. Phase 1 completion pass (2026-08-20)

Closes the four items the first pass disclosed as outstanding, and adds real-database + real-browser verification throughout.

### 15.1 Real PostgreSQL verification

**Environment**: PostgreSQL **16.15** installed locally (via Chocolatey, with Administrator rights available in this session — the first pass had correctly reported none was installed). Disposable dev database `beauclick_v3_dev` owned by a non-superuser role `beauclick_app`.

**Migration runner built** (`database/scripts/migrate.ts`): applies `database/migrations/{schema}/*.sql` in filename order, tracks applied files in `public.schema_migrations`, wraps each file in its own transaction (rollback on failure), and skips already-applied files. The first pass had migration *files* but no runner — TypeORM's `synchronize` was doing the work in tests, which is precisely why the divergences below went unnoticed.

**Verified, in this order:**
1. Applied both migrations to an empty database → both `APPLY`.
2. Re-ran → both `SKIP (already applied)`, zero writes. **Idempotency confirmed.**
3. Dropped the database entirely, recreated, migrated from zero → clean success.
4. Inspected the resulting schema directly via `psql` (`\d`): every table, column, type, default, index, PK, FK, and unique constraint matches the migration source.
5. Exercised constraints with real SQL: duplicate phone → `duplicate key value violates unique constraint "uq_users_phone"`; bad city FK → `violates foreign key constraint "professionals_city_id_fkey"`; second professional per owner → `violates unique constraint "uq_professionals_owner_id"`.

**Three real bugs found — all invisible to pg-mem, because pg-mem generated its own schema from entity metadata instead of running the real migration SQL:**

| # | Bug | Fix |
|---|---|---|
| 1 | TypeORM's default naming strategy is **camelCase**; the migrations (and `V3_DATABASE_BLUEPRINT.md` §2) are **snake_case**. Every generated query referenced non-existent columns (`"createdAt"` vs `created_at`). The live API returned `INTERNAL_ERROR` on `/auth/request-otp` and `/providers` while the health check passed. | `SnakeNamingStrategy` applied at **both** DataSource construction sites (`apps/api`, `libs/testing`) — so the fast test layer now matches real Postgres rather than diverging from it. |
| 2 | Two hand-written raw SQL fragments hardcoded quoted camelCase identifiers, which a naming strategy cannot rewrite: `OtpService`'s atomic consume-on-success `WHERE "consumedAt" IS NULL`, and `TokenService`'s `WHERE "userId" = ... AND "revokedAt" IS NULL`. | Corrected to the real snake_case columns. Grepped the whole codebase for the same pattern; no others exist. |
| 3 | An explicit `@JoinColumn({ name: 'cityId' })` **overrides** the naming strategy entirely, so `provider.professionals` was queried for a `cityId` column the migration never created. | Corrected to `city_id`. Found by the new real-Postgres suite *after* fixes 1–2, which is the point of having it. |

The `professional_specialties` join table's columns were also normalized to snake_case (`professional_id`/`specialty_id`) in both the entity and the migration, for consistency with the stated convention.

### 15.2 PostgreSQL role/grant verification (ADR-009 / GAP-01)

`database/scripts/financial-role-contract.sql` + an automated spec (`apps/api/test/financial-role-contract.pg-spec.ts`). financial-service is **not** implemented in Phase 1 (out of scope) — this verifies the *infrastructure contract* Phase 2 will depend on, per this phase's explicit instruction.

Two disposable, **non-superuser** roles were created (granting SUPERUSER to make the test pass would defeat it — the spec asserts `usesuper = false` explicitly):

| Operation | `financial_writer` | `financial_reader` |
|---|---|---|
| INSERT | ✅ allowed | ❌ `permission denied` |
| SELECT | ✅ allowed | ✅ allowed |
| UPDATE | ❌ `permission denied` | ❌ `permission denied` |
| DELETE | ❌ `permission denied` | — |
| TRUNCATE | ❌ `permission denied` | — |

The row was re-read after every denied mutation and confirmed **byte-identical**. **`ADR-009`'s append-only ledger guarantee is empirically enforceable on this database** — the guarantee V2 could never achieve, because its MySQL hosting lacked the `SUPER`/`log_bin_trust_function_creators` privileges its trigger approach needed (`PRODUCT_GAP_REGISTER.md` §53).

### 15.3 Nx module-boundary enforcement

`@nx/eslint-plugin` with `enforce-module-boundaries`, `scope:*`/`type:*` tags on all 10 projects, and `depConstraints` in `.eslintrc.json`. Each project has a real `lint` target, so `nx run-many -t lint` (CI-ready) enforces it.

**Verified by deliberate violation, not assumed:**
- `provider` → `@beauclick/identity`: ❌ *"A project tagged with scope:provider can only depend on libs tagged with scope:shared"*
- `identity` → `@beauclick/provider`: ❌ same rule, reverse direction
- relative-path cross-project import: ❌ *"Projects cannot be imported by a relative or absolute path"*
- legitimate `services/*` → `libs/*` (scope:shared): ✅ passes

Constraints encoded: no service may depend on another service (blocks cross-module persistence access and circular domain dependencies); `scope:shared` libs may not depend on any domain or app; only `scope:app` may compose domains. `financial` and `payment` scopes are pre-declared so Phase 2 inherits the isolation automatically.

### 15.4 Frontend foundation

`apps/web` — Next.js 14 App Router, TypeScript, per `ADR-012`.

- **Shell/routing**: root layout with `lang="fa" dir="rtl"`, header + `<main>`, skip link, error boundary; routes `/` (server-rendered), `/auth`, `/dashboard` (protected).
- **API client** (`lib/api-client.ts`): carries forward the one genuinely portable piece of V2's `api.ts` (envelope + `ApiError` + error-message hygiene) and drops everything WordPress-specific. Handles 401 by invoking a refresh callback and retrying **exactly once** — never a loop.
- **Auth integration** (`lib/auth-context.tsx`): OTP request → verify → session, refresh with rotation, logout. Refresh uses a deliberately *bare* client so it cannot recurse into its own 401 handler.
- **Token security** (`lib/token-storage.ts`): access **and** refresh tokens are held **in memory only** — never localStorage, sessionStorage, or cookies. Asserted by tests *and* verified live in the browser while genuinely logged in (`localStorage`/`sessionStorage`/`document.cookie` all empty, no `eyJ` JWT prefix anywhere). The cost is that a page reload signs the user out; that is a **deliberate, disclosed** trade (see §15.7 item 1) — the correct fix is an httpOnly refresh cookie, which needs a server-side auth route that is Phase 2 scope.
- **Design tokens**: `packages/design-tokens` carries V2's `shared/design-tokens.json` **verbatim** plus a CSS-custom-property file. Verified live: `--bc-color-primary` resolves to the real V2 value `oklch(0.4 0.16 290)`.
- **Persian/RTL/Jalali**: `packages/persian-utils` wired in; the dashboard rendered **پنجشنبه، ۲۹ مرداد ۱۴۰۵** and the auth screen rendered the phone number as **۰۹۱۲۷۷۷۸۸۹۹** in a real browser. `globals.css` uses only logical properties (asserted by a test that strips comments first, after the file's own docblock naming the banned properties tripped the check).
- **Accessibility baseline**: labelled inputs, `role="alert"` errors tied via `aria-describedby`, `aria-busy` buttons, `role="status"` loading states, visible focus rings, 44px touch targets, `prefers-reduced-motion`.
- **Responsive**: mobile-first; verified at 375×812 — no horizontal overflow, 44px targets, mobile padding, RTL intact.

### 15.5 Build output

`apps/api`'s output was `dist/apps/api/apps/api/src/main.js` (doubled) because `outDir` already contained `apps/api` while tsc *also* preserved each file's path from an inferred common root. Fixed by setting `outDir` to the dist root and pinning `rootDir` to the workspace root: output is now a clean `dist/apps/api/src/main.js` mirroring the source tree. `dist/`, `.next/`, and `.nx/` are all git-ignored and confirmed untracked.

### 15.6 Live verification (real stack, real data)

Real PostgreSQL + real NestJS API (`:3099`) + real Next.js frontend (`:3100`), driven through a real browser:

- Health endpoint reports a genuine DB connection.
- OTP requested **through the browser UI** → real row in `identity.otp_requests` with the canonicalized phone `+989127778899` and a **64-char HMAC hash** (never the plaintext code).
- Code verified → JWT issued → redirected to `/dashboard` → dashboard fetched `/v1/me` with the real token and rendered real data from real Postgres.
- **Refresh rotation**: new token differs from the old; replaying the old token → `401` **and** the freshly-rotated token is also killed — full-chain revocation confirmed live.
- **Cross-tenant isolation**: two real users; party A's PATCH of party B's provider → `404 NOT_FOUND_OR_NOT_YOURS`, party B's secret marker absent from the response, and party B's row verified **unchanged** afterwards.
- **Protected route**: after logout, `/dashboard` redirects to `/auth`.
- Unauthenticated `/v1/me` → `401`.

**A real integration bug was found here and fixed**: the API had **no CORS configuration**, so every browser call from `:3100` was blocked at preflight. (The frontend degraded correctly — Persian network message, no raw error leaked — which is how it was noticed rather than mis-diagnosed.) Fixed with an explicit **allow-list** from `CORS_ALLOWED_ORIGINS`, never a wildcard. Verified: the real origin receives `Access-Control-Allow-Origin`; `http://evil.example.com` receives **no** allow-origin header.

### 15.7 Known limitations remaining after this pass

1. **Refresh token is in memory, so a page reload signs the user out.** Deliberate: the alternative available today (localStorage) is strictly worse for XSS exposure. The real fix — an httpOnly/Secure/SameSite refresh cookie set by a server-side route handler — is Phase 2 scope.
2. **RBAC data is still code-based** (`capabilities.ts`), not the dynamic `identity.roles`/`identity.capabilities` tables. Every check still goes through capability names, so this changes only where the map's data comes from. *(Unchanged from §11.3.)*
3. **Audit logging is still structured-logger-based**, not the DB-persisted, registration-time-enforced contract (`V3_SECURITY_MODEL.md` §7). Phase 4 scope per the roadmap. *(Unchanged from §11.4.)*
4. **One-profile-per-owner applies to `professionals` only** — Business entities remain out of scope, and the `UNIQUE(owner_id)` constraint will need revisiting when multi-staff Business arrives. *(Unchanged from §11.7.)*
5. **`pnpm-workspace.yaml` `overrides` must be re-checked when adding packages** — a new peer-dependency range can silently reintroduce the duplicate-install DI bug. *(Unchanged from §11.8.)*
6. **The local PostgreSQL is a disposable dev instance**, not a provisioned environment. Hosting/region remains the open decision in `V3_INFRASTRUCTURE_PLAN.md` §1 — this pass proves the *contract* is enforceable, not that a production database exists.
7. **No CI pipeline is wired yet.** Every gate (typecheck, lint incl. module boundaries, tests, build, real-DB suite) is runnable as an `nx` target and CI-ready, but `ADR-016`'s actual pipeline is Phase 2 infrastructure scope.
8. **Screenshots could not be captured** in this environment (the browser pane doesn't composite frames headlessly). Live verification was done via DOM/accessibility-tree reads and computed-style assertions instead — stronger evidence than a screenshot for the properties being checked, but no image artifacts exist.

### 15.8 Final verification bar

| Gate | Result |
|---|---|
| TypeScript (strict) | ✅ 10/10 projects clean |
| ESLint incl. module boundaries | ✅ 10/10 projects clean |
| Backend + frontend test suites | ✅ **96 passed** (7 projects) |
| Real PostgreSQL integration suite | ✅ **26 passed** (2 suites) |
| **Total automated tests** | ✅ **122 passing, 0 failing** |
| Build | ✅ `api` + `web` both succeed |
| Real migrations from zero | ✅ apply → verify → re-run idempotent |
| DB role/grant contract | ✅ UPDATE/DELETE/TRUNCATE denied |
| Live browser auth flow | ✅ end to end on real data |

---

## Cross-references
- `V3_DOMAIN_BOUNDARIES.md`, `V3_DATABASE_BLUEPRINT.md`, `V3_API_CONTRACT_BLUEPRINT.md`, `ADR-008`, `ADR-011`, `ADR-012`, `ADR-014`, `ADR-015` — the designs this phase implements.
- `V3_IMPLEMENTATION_ROADMAP.md` Phase 1 — the plan this phase executes against; acceptance criteria there are met (§7/§8/§15).
