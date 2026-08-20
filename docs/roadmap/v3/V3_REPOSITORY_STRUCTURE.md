# V3 Repository Structure

Status: Phase 0 blueprint. **No repository has been created, no project initialized.** This document specifies the target structure; nothing here has been scaffolded. Decision and rationale: `docs/roadmap/v3/adr/ADR-011-repository-architecture.md`.

---

## 1. Tooling

- **Package manager**: pnpm workspaces.
- **Build/task orchestration + module-boundary enforcement**: Nx.
- **Language**: TypeScript everywhere (backend and frontend) — confirming ADR-003, no PHP anywhere in V3.

## 2. Top-level layout

```
beauclick-v3/
├── apps/
│   ├── api/                    # NestJS host app — composes every services/* module EXCEPT financial and payment
│   ├── financial-service/      # separate deployable (ADR-002 #2, ADR-009) — imports only services/financial
│   ├── payment-service/        # separate deployable (ADR-002 #2, ADR-006) — imports only services/payment
│   ├── web/                    # Next.js customer/provider-facing frontend (ADR-012)
│   └── admin/                  # Next.js internal admin/ops application (WORDPRESS_EXIT_MATRIX.md §9's 16-screen equivalent)
├── services/
│   ├── identity/
│   ├── provider/
│   ├── search/
│   ├── booking/
│   ├── commerce/
│   ├── payment/                # imported only by apps/payment-service
│   ├── financial/              # imported only by apps/financial-service
│   ├── loyalty/
│   ├── referral/
│   ├── notification/
│   ├── analytics/
│   ├── ai/
│   └── journey/
├── libs/
│   ├── auth/                   # JWT strategy, session/refresh-token guards
│   ├── ownership/               # the ownership-resolver primitive (GAP-08 fix), ownership guards/decorators
│   ├── audit/                   # structural audit-logging enforcement decorator (V3_SECURITY_MODEL.md §7)
│   ├── http/                    # shared REST base controller, response envelope, error-code taxonomy
│   ├── events/                  # Kafka producer/consumer base classes, outbox-pattern plumbing
│   └── testing/                 # shared test fixtures, testcontainers setup, adversarial-ownership test harness
├── packages/
│   ├── design-tokens/           # DIRECT REUSE of shared/design-tokens.json + generator
│   ├── persian-utils/           # DIRECT REUSE of jalali.ts / format.ts (Jalali calendar math, Persian digit/currency formatting)
│   ├── provider-abstraction/    # the generic Provider<TRequest,TResult> interface + factory + safe-fallback shape (V3_ARCHITECTURE_PLAN.md §4)
│   ├── event-contracts/         # generated TS types from the event catalog (V3_EVENT_ARCHITECTURE.md) — the wire contract, shared by every producer/consumer
│   └── ui/                      # design-system primitives (Button/Card/Chip/Modal/etc.) — DIRECT REUSE with extended a11y coverage
├── database/
│   ├── migrations/
│   │   ├── identity/
│   │   ├── provider/
│   │   ├── booking/
│   │   ├── commerce/
│   │   ├── payment/
│   │   ├── financial/
│   │   ├── loyalty/
│   │   ├── referral/
│   │   ├── notification/
│   │   ├── analytics/
│   │   ├── ai/
│   │   └── journey/
│   ├── seeds/                   # reference data (provinces/cities/districts/specialties) — reseed strategy per ADR-010
│   └── erd/                     # entity-relationship diagrams, per-schema
├── infra/
│   ├── docker/                  # per-app Dockerfiles, docker-compose for local dev
│   ├── k8s/  or  paas/          # deferred — see V3_INFRASTRUCTURE_PLAN.md / ADR-013
│   ├── terraform/               # IaC, once hosting target is decided
│   └── ci/                      # CI/CD pipeline definitions (GitHub Actions)
└── docs/
    └── roadmap/                  # this entire document corpus, moved/continued from the V2 repo
```

## 3. Ownership boundaries — what belongs where, and why

| Directory | Contains | Does NOT contain | Why it exists |
|---|---|---|---|
| `apps/` | Thin composition roots: NestJS module wiring, Next.js route trees, bootstrap/main.ts files | Business logic, entity definitions, controllers with real handler code | Deployables should be trivial to reason about — "what does this process run" answered by reading one file's imports, not by reading business logic. This is also the literal extraction mechanism: promoting a `services/*` module to its own deployable is adding a new, equally-thin `apps/*` entry. |
| `services/` | One directory per domain bounded context (`V3_DOMAIN_BOUNDARIES.md`) — controllers, application services, domain entities, repository implementations, that domain's own event producers/consumers | Direct imports from another `services/*` directory (Nx boundary rule enforced) | This is where ADR-002's 13 logical boundaries actually live as code. A service may depend on `libs/*` and `packages/*` freely; it may never import another `services/*` directly — cross-module communication is events (`libs/events`) or, for genuinely synchronous same-process calls, an explicit public-API interface package, never a raw import of internal classes. |
| `libs/` | BeauClick-specific platform conventions every service is expected to use — auth guards, the ownership-resolver primitive, the audit-logging decorator, the shared REST envelope/error format, event-plumbing base classes, shared test harnesses | Domain business logic, anything portable outside this specific product | This is where V2's "a good shared abstraction, built once, then bypassed by every caller" failure (`GAP-08`, the 3×-recurring audit-logging bug) gets fixed structurally: a `libs/*` primitive is enforced via Nx boundary tags as the *only* legal way to do the thing it does (e.g. every controller must extend `libs/http`'s base controller, every mutation-capable endpoint must use `libs/audit`'s decorator or fail to build) — not merely offered and hoped for. |
| `packages/` | Code with zero BeauClick-specific coupling — pure functions, generic abstractions, design tokens | Anything that reads a BeauClick domain concept (a booking, a provider, a ledger entry) | These are the pieces already proven, in this pass's own migration-matrix classification, to be DIRECT REUSE with zero framework coupling (`design-tokens`, `persian-utils`) — kept separate from `libs/` specifically because a package here could, in principle, be published or reused in a completely unrelated project; a `libs/` entry could not. |
| `database/` | Per-schema SQL migrations, seed scripts, ERDs | Application code | Migrations are applied on a different lifecycle than app deploys (a migration can run ahead of a rolling deploy under the expand/contract pattern, `V3_IMPLEMENTATION_ROADMAP.md`) and multiple `apps/*` (api, financial-service, payment-service) each own migrations against only their own schemas — keeping this centralized-but-namespaced avoids both a single monolithic migration history and a scattered one. |
| `infra/` | IaC, container definitions, CI/CD pipelines | Application or business logic | Ops-owned, changes on its own cadence (a hosting-region decision, a CI runner change) independent of any domain's business logic — see `V3_INFRASTRUCTURE_PLAN.md`. |
| `docs/` | The full architecture-discovery and blueprint corpus (this document set) | — | Continues the exact discipline V2's own `docs/roadmap/` already validated: docs live in the same repo as the code they describe, so they can never silently drift the way an external wiki would — the same reasoning `ADR-010` gives for treating this corpus as "optional history" worth deliberately carrying forward, not discarding. |

## 4. What this structure deliberately does not decide

- The exact Nx generator/plugin configuration, CI runner specifics, and Dockerfile contents — implementation detail, not architecture, out of scope for a Phase 0 blueprint.
- Whether `apps/admin` is a fully separate Next.js app or a route group within `apps/web` gated by role — a real, open frontend decision noted in `V3_FRONTEND_ARCHITECTURE.md`, not settled here.
- Nothing in this document has been scaffolded, initialized, or committed as actual project files — it is a specification for Phase 1 to build against.
