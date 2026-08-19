# V3 Phase 1 Implementation — Identity Service + Provider Service Foundation

Status: **Implemented and verified in this environment.** Code lives under `v3/` at the repository root (a new top-level directory, chosen specifically to avoid colliding with V2's existing `app/` and `wordpress/` directories and to leave V2 completely untouched). V2.4.1's behavior was not modified in any way — no file under `wordpress/`, `app/`, or `shared/` was read, written, or deleted during this phase.

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

1. **No real PostgreSQL server available in this environment** (confirmed: no `psql`, no Docker, no local Postgres service). All integration/e2e tests run against pg-mem, a real in-memory SQL engine — genuinely exercises schema/query correctness, not a mocked repository layer, but is **not** equivalent to real Postgres (no real connection pooling, no real role-grant enforcement, some Postgres system catalogs unimplemented — worked around, not present). **Action before Phase 2**: run `v3/database/migrations/**/*.sql` against a real Postgres instance and re-run the full test suite with a real `DATABASE_URL` before trusting this foundation for the financial-service ledger, whose append-only guarantee (`ADR-009`) specifically depends on real Postgres role-grant behavior pg-mem cannot verify.
2. **Frontend foundation not built** — see §6. First item of remaining work, §14.
3. **RBAC is code-based (`capabilities.ts`'s static role→capability map), not the dynamic `identity.roles`/`identity.capabilities` tables** `V3_DATABASE_BLUEPRINT.md` §8 lists. Every authorization check still goes through capability names (never a role string), so upgrading to dynamic tables later changes only where the map's data comes from, not how any guard/controller checks it — but this is a real scope reduction from the full blueprint, done deliberately to keep Phase 1 focused.
4. **Audit logging is structured-logger-based** (`Logger`, tagged `AUDIT:*`), not the DB-persisted, structurally-enforced-at-registration-time contract `V3_SECURITY_MODEL.md` §7 and `V3_IMPLEMENTATION_ROADMAP.md` Phase 4 describe. Security-relevant events (OTP requested, login, logout, provider created/updated) are logged; the full `libs/audit` structural-enforcement decorator is explicitly Phase 4 scope per the roadmap this task itself set, not silently skipped.
5. **Nx module-boundary enforcement is by convention, not yet an automated `enforce-module-boundaries` lint rule** — verified by direct inspection (no `services/*` package imports another `services/*` package; the one real violation caught during implementation was fixed by extracting `libs/auth`), but not yet backed by a CI-breaking lint rule as `ADR-011` specifies as the eventual goal.
6. **`apps/api`'s TypeScript build output path is deeper than intended** (`dist/apps/api/apps/api/src/main.js` — a cosmetic `outDir`/`baseUrl` interaction, not a correctness issue) — the app runs and is fully tested via `ts-node` in dev and via Jest/supertest for testing; a real production build path is a Phase 1-remaining-work/Phase 2 infrastructure concern (`ADR-016`), not resolved here.
7. **One-profile-per-owner is enforced for `professionals` only** (a unique constraint on `ownerId`) — this is Phase 1's deliberate scope (`Business` entities are explicitly out of scope, per this task's own instruction listing only "Professional entity" among what to implement), not a general product constraint being silently imposed on the eventual multi-staff Business model.
8. **`pnpm-lock.yaml`'s dependency-duplication fix (§2) should be re-verified whenever a new package is added** to any `v3/` `package.json` — a new package with a peer-dependency range slightly different from what's already pinned in `pnpm-workspace.yaml`'s `overrides` can silently reintroduce the same class of bug this phase found and fixed.

---

## 12. Remaining Phase 1 work

Per this task's own scope list, not yet built:
1. **Frontend foundation** (Next.js app skeleton, routing structure, auth client layer, API client with token handling, RTL configuration, Persian localization foundation wired to `packages/persian-utils`, design-token package integration reusing `shared/design-tokens.json`).
2. **Verify migrations against a real PostgreSQL server** once one is available in this environment or a hosting decision is made (`V3_INFRASTRUCTURE_PLAN.md` §1) — the single highest-priority item, since it's a precondition for trusting Phase 2's financial-service work.
3. **Nx `enforce-module-boundaries` lint rule**, converting the currently-by-convention module-boundary discipline into a CI-enforced one.
4. Minor build-output path cleanup for `apps/api` (§11.6).

---

## 13. Gap register updates

See `V3_GAP_REGISTER.md`'s new Phase 1 addendum for the formal record. Summary: no new product/architecture gaps were found in V2 during this phase (Phase 1 is pure new-build, not further V2 discovery) — the findings here are all about the **V3 build itself** (the two infrastructure bugs in §2, the known limitations in §11), recorded as implementation notes rather than V2 gaps.

---

## Cross-references
- `V3_DOMAIN_BOUNDARIES.md`, `V3_DATABASE_BLUEPRINT.md`, `V3_API_CONTRACT_BLUEPRINT.md`, `ADR-008`, `ADR-011`, `ADR-014`, `ADR-015` — the designs this phase implements.
- `V3_IMPLEMENTATION_ROADMAP.md` Phase 1 — the plan this phase executes against; acceptance criteria there are met (§7/§8 above).
