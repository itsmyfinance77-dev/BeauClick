# V3 Phase 0 — Implementation Blueprint & Engineering Foundation

Status: **Phase 0 blueprint. No backend service, frontend application, database migration, infrastructure deployment, or production code has been created.** This document is the master index for this phase's deliverables, produced as the continuation of the approved V3 Architecture Discovery (`V3_ARCHITECTURE_DISCOVERY.md`). Read the linked documents for full detail on any topic; this document states what was decided, where, and why it fits together.

---

## 1. What this phase produced

| # | Document | Covers |
|---|---|---|
| 1 | This document | Master index and cross-cutting decisions summary |
| 2 | `V3_REPOSITORY_STRUCTURE.md` | Monorepo tooling and directory ownership boundaries |
| 3 | `V3_DOMAIN_BOUNDARIES.md` | Final 13-domain module design — responsibility, schema, APIs, events, ownership rules |
| 4 | `V3_DATABASE_BLUEPRINT.md` | PostgreSQL strategy, naming, UUIDs, audit columns, soft-delete, outbox pattern, initial entity list |
| 5 | `V3_API_CONTRACT_BLUEPRINT.md` | REST conventions, JWT/refresh auth flow, ownership-resolver pattern, example contracts |
| 6 | `V3_EVENT_ARCHITECTURE.md` | Kafka topic/naming/versioning/DLQ strategy, extended event catalog |
| 7 | `V3_FRONTEND_ARCHITECTURE.md` | Next.js App Router structure, SSR/SSG/CSR split, design-system migration |
| 8 | `V3_INFRASTRUCTURE_PLAN.md` | Hosting, containers, managed services, CI/CD, monitoring, backup |
| 9 | `V3_IMPLEMENTATION_ROADMAP.md` | Phase 0-5 detailed plan — goals, deliverables, dependencies, risks, acceptance criteria |
| 10 | `V3_GAP_REGISTER.md` (updated) | GAP-29 resolved; Phase 0 addendum recorded |
| — | `docs/roadmap/v3/adr/ADR-011` through `ADR-016` | Repository, frontend, infrastructure, API, testing, deployment decisions |

Plus the six prior-phase ADRs (`ADR-001` through `ADR-010`) and the full discovery corpus (`V3_ARCHITECTURE_DISCOVERY.md`, `V3_MIGRATION_PLAN.md`, `WORDPRESS_EXIT_MATRIX.md`, `V3_MIGRATION_MATRIX.md`, `V3_EVENT_CATALOG.md`, `V3_SECURITY_MODEL.md`, `V3_API_CONTRACTS.md`) — this phase extends that corpus, it does not replace it.

## 2. Decisions carried forward unchanged from discovery

Per ADR-002 (modular monolith, financial/payment isolated), ADR-001 (WordPress/WooCommerce exit), ADR-003 through ADR-010 — nothing in this phase revisits those decisions; this phase makes them concrete (repository layout, schema, API shape, events, frontend, infra, roadmap) without re-litigating the choices themselves.

## 3. Decisions this phase settled that were open after discovery

- **Beauty Journey's service boundary** (`GAP-29`): this task's own required-domain list names `journey` as standalone, settling by explicit direction what the discovery phase had only a preliminary recommendation for (fold into ai-service). Recorded honestly as decided-by-direction, not re-derived independently — see `V3_GAP_REGISTER.md`'s Phase 0 addendum.
- **Monorepo tooling** (Nx + pnpm, `ADR-011`), **REST over GraphQL** (`ADR-014`), **Next.js over continued Vite-SPA** (`ADR-012`), **Kubernetes deferred** (`ADR-013`) — none of these had a discovery-phase precedent to draw from (V2 has no monorepo, no typed API-strategy decision, no real deploy history at all); each is a green-field Phase 0 decision, justified in its own ADR against team-size and evidence-based reasoning consistent with `ADR-002`'s established method, not against new V2 findings (there were none to find).

## 4. What remains genuinely open (not decided by this phase)

Carried forward honestly, not silently resolved:
1. **Hosting region** (`V3_INFRASTRUCTURE_PLAN.md` §1) — the one deliberately unresolved architectural decision in this entire blueprint, coupled to AI-provider and payment-gateway reachability. Must resolve before Phase 1 infrastructure provisioning.
2. **Target Postgres hosting's role-grant capabilities** for financial-service's ledger immutability (`ADR-009`, `V3_INFRASTRUCTURE_PLAN.md` §4) — must be verified against the real chosen provider, not assumed.
3. **`GAP-10`'s provisional numeric policies** — still need a real business sign-off pass; this phase did not attempt to settle them (they're product decisions, not architecture).
4. **Persian-slug `post_name` encoding** and **pretty city/specialty URL paths** — both carried over from the discovery phase's SEO findings, neither resolved here.
5. **`apps/admin` separate-app-vs-route-group** (`V3_FRONTEND_ARCHITECTURE.md` §10) — a Phase 1-2 operational call, not forced now.

## 5. How the pieces fit together (reading order for a new implementer)

```
V3_ARCHITECTURE_DISCOVERY.md  (why V3 looks the way it does)
        ↓
V3_DOMAIN_BOUNDARIES.md       (what the 13 modules are, precisely)
        ↓
V3_REPOSITORY_STRUCTURE.md    (where their code lives)
        ↓
V3_DATABASE_BLUEPRINT.md ──┬── V3_API_CONTRACT_BLUEPRINT.md ──┬── V3_EVENT_ARCHITECTURE.md
   (their data)            │      (how they're called)        │      (how they talk to each other)
                            └──────────────┬────────────────────┘
                                            ↓
                              V3_FRONTEND_ARCHITECTURE.md  (what calls the API)
                                            ↓
                              V3_INFRASTRUCTURE_PLAN.md    (where it all runs)
                                            ↓
                              V3_IMPLEMENTATION_ROADMAP.md (in what order it gets built)
```

## 6. Explicit non-goals of this phase

Per this task's own stop condition — none of the following happened, and none should be inferred from the specificity of the documents above:
- No repository was created or initialized.
- No `package.json`, `nx.json`, `docker-compose.yml`, or any project file was written.
- No database was created; no migration file exists.
- No controller, service class, or React component was written.
- No cloud account, container registry, or CI pipeline was provisioned.
- No ADR's status is anything other than **Proposed**.

---

## Final status

**V3 PHASE 0 BLUEPRINT COMPLETE — IMPLEMENTATION NOT STARTED**

STOP. Await explicit approval before:

**BEAUCLICK V3 — PHASE 1 IMPLEMENTATION**
