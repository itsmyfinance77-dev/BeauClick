# ADR-016: Deployment Strategy

**Status:** Accepted for CI/CD mechanics and amended — production remains undeployed; deployable topology superseded by ADR-040.
**Date:** 2026-08-20.

## Context

V3 is a modular monolith (`apps/api`) plus two independently-deployable services (`apps/financial-service`, `apps/payment-service`) plus two frontends (`apps/web`, `apps/admin`) — five real deployables at launch (ADR-002, ADR-011). `V3_DATABASE_BLUEPRINT.md` §3 already mandates the expand/contract migration pattern specifically to avoid the class of risk `GAP-03` represents (a business operation whose correctness silently depends on deploy-ordering luck). No V2 evidence bears directly on deployment mechanics (V2 has never had a real production deploy pipeline — it's a local/dev environment throughout its documented history), so this is a green-field decision constrained by team size (ADR-002) and the modules' physical-isolation requirements (ADR-002 #2, ADR-009).

## Decision

**Per-app CI/CD pipelines, migrations-then-deploy ordering, rolling deploys for `apps/api`, independent pipelines for the two isolated services.**

- **One pipeline per `apps/*` deployable** — a change to `services/booking` triggers only `apps/api`'s pipeline (booking is a module within it); a change to `services/financial` triggers only `apps/financial-service`'s pipeline. This is the direct operational payoff of ADR-011's Nx project graph: CI can compute exactly which deployables are affected by a given change and build/deploy only those.
- **Migrations run as a distinct pipeline step, before the app's own deploy step, never bundled into app startup** (`V3_DATABASE_BLUEPRINT.md` §3) — a migration that fails halts the deploy before any new app instance starts, rather than surfacing as a runtime error under real traffic.
- **Expand/contract is enforced by convention + PR review checklist at launch** (not yet a fully automated gate — a real, disclosed limitation, not claimed otherwise) — every schema-changing PR must state which phase (expand / migrate-code / contract) it represents.
- **`apps/api` (the modular monolith)**: rolling deploy — multiple instances behind a load balancer, new instances brought up and health-checked before old ones are drained, zero-downtime for the common case. A single bad deploy affects the whole monolith (the accepted tradeoff of ADR-002's topology, mitigated by fast automated rollback on health-check failure, not eliminated).
- **`apps/financial-service` / `apps/payment-service`**: independent rolling deploys, on their own schedule, never coupled to `apps/api`'s release cadence — this is the actual operational meaning of ADR-002 #2's "separate deployable" decision; if it deployed in lockstep with `apps/api` it wouldn't really be separate.
- **`apps/web` / `apps/admin`**: standard Next.js deployment (a platform-native rolling/atomic deploy, e.g. the hosting platform's own zero-downtime release mechanism) — no custom orchestration needed beyond what a mainstream Next.js hosting target already provides.
- **Rollback**: every deploy is a tagged, immutable container image; rollback is redeploying the previous tag, never a hotfix-forward-only policy. Database rollback is explicitly **not** symmetric with app rollback (a contract migration, once applied, is not blindly reversed) — this is why expand/contract is mandatory, not optional: it's what makes "roll back the app without also needing to roll back the schema" possible at all.

## Consequences

- **Positive:** the two highest-stakes modules (financial, payment) can never be blocked on or accidentally coupled to an unrelated `apps/api` change's deploy — the isolation ADR-002 promised is real at the pipeline level, not just the code level.
- **Negative:** five independent pipelines is real CI/CD surface to build and maintain — more than a single monolithic pipeline would be, though matched to the five real deployables that actually exist (not more).
- **Risk:** the expand/contract discipline being convention-enforced (not yet tooling-enforced) at launch is a real, honest gap — flagged, not silently assumed solved; a Phase 2+ improvement (a CI lint check that flags a migration adding a `NOT NULL` column without a corresponding backfill step) is a reasonable target once real migration volume exists to justify building it.

## Alternatives considered

- **Blue-green deployment for `apps/api`** instead of rolling. Considered — genuinely comparable safety property; rolling was chosen as the simpler default (no need to provision a full duplicate environment) given no current evidence of a rolling-deploy-specific problem (e.g. long-lived in-flight requests spanning a deploy) that would require blue-green's cleaner cutover. Revisit if that evidence appears.
- **Monorepo-wide single pipeline (build/deploy everything on every change).** Rejected — wastes CI time and, worse, couples financial/payment's deploy cadence to unrelated frontend changes, directly undermining ADR-002 #2's isolation intent.
