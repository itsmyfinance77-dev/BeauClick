# ADR-011: Repository Architecture

**Status:** Accepted and amended — Nx/pnpm monorepo implemented; deployable examples superseded by ADR-040.
**Date:** 2026-08-19.

## Context

V3 is a modular monolith at launch (ADR-002) with two extracted deployables (financial-service, payment-service) from day one, targeting NestJS/TypeScript across the entire backend and Next.js on the frontend (ADR-003), with 12-13 domain modules (`V3_DOMAIN_BOUNDARIES.md`) whose whole architectural value depends on their boundaries staying real over time — not aspirational, the way V2's own `require_owner_or_capability()` helper was correctly designed and then never used (`GAP-08`). A single-repo, single-language (TypeScript throughout) codebase is the natural fit once WordPress/PHP is gone (ADR-001/ADR-003), but the repository's internal structure needs to make illegal cross-module coupling hard to write, not just discouraged by convention — the same lesson V2's own shared-ownership-helper history teaches, applied one level up.

## Decision

**A single monorepo**, package-manager: **pnpm workspaces** (fast installs, strict dependency isolation — a package can only import what it explicitly declares, which is real, not incidental, given past drift risk), orchestrated by **Nx** (not Turborepo): Nx's tag-based module-boundary enforcement (`enforce-module-boundaries` ESLint rule, checked at lint time and in CI, not just documented) is the deciding factor — it can make "financial-service's code may never be imported by anything except `apps/financial-service`" a build-breaking rule, not a code-review hope. This directly operationalizes ADR-002's "extraction-ready boundaries" promise and ADR-009's "financial isolation is structural, not optional" requirement at the repository-tooling level, not just the deployment level.

**Top-level structure** (full rationale and contents: `V3_REPOSITORY_STRUCTURE.md`):

```
apps/        — deployable entry points only (thin composition, no business logic)
services/    — the 13 domain bounded-context modules (business logic + persistence)
libs/        — internal, BeauClick-specific cross-domain platform code (guards, decorators, base classes)
packages/    — generic, domain-agnostic code with no BeauClick-specific coupling
database/    — SQL migrations, seed scripts, ERD docs (schema-per-module, per ADR-004)
infra/       — IaC, container/orchestration manifests, CI/CD pipeline definitions
docs/        — this entire document corpus, versioned alongside code
```

The `apps/services/libs/packages` four-way split (rather than Nx's more common two-way apps/libs convention) is deliberate: it makes the **kind** of a given piece of code legible from its top-level directory alone — "is this a deployable, a domain's business logic, an internal platform convention, or a portable utility" — which is exactly the distinction that matters for enforcing ADR-002's boundaries and for a future contributor (or a future extraction of a module into its own service) to know instantly what they're looking at.

## Consequences

- **Positive:** module-boundary violations fail CI, not just code review — directly closes the recurring "a good abstraction existed and nobody used it" failure mode found three times in V2 (`require_owner_or_capability()`, the audit-logging bug class). Extracting `services/booking` into its own deployable later is adding one thin `apps/booking-service` that imports it — no restructuring.
- **Negative:** Nx has a real learning curve and its own configuration surface (project graph, tags, generators) that a two-person team must actually learn — a real cost, not free.
- **Risk:** none specific found; this is a well-trodden pattern for TypeScript monorepos at this scale.

## Alternatives considered

- **Turborepo + plain pnpm workspaces, no Nx.** Faster to adopt, lighter configuration — but has no equivalent to Nx's enforceable module-boundary tagging; boundary discipline would fall back to code-review convention, which is the exact failure mode this ADR exists to avoid.
- **Polyrepo (one repository per service).** Rejected — at current team size (ADR-002's own team-size evidence), polyrepo's cross-repo versioning/dependency-update overhead is pure cost with no benefit; a monorepo lets `packages/`-level changes (e.g. the shared ownership-resolver primitive, `GAP-08`'s fix) land atomically everywhere that uses them.
