# ADR-040 — Current deployment topology follows the implemented modular monolith

**Status:** Accepted — documentation reconciliation, 2026-09-02.

**Approver:** product owner

**Amends:** ADR-002 decision 2, ADR-011 deployable examples, ADR-016 deployable count

**Preserves:** ADR-017 financial role/DataSource isolation

## Context

The Phase 0 documents selected a modular monolith but also proposed separate
`apps/financial-service`, `apps/payment-service` and `apps/admin` deployables from day
one. The implemented repository does not have those entry points. Its production-shaped
entry points are `apps/api` and `apps/web`.

This is not merely incomplete scaffolding. Later implementation established a safer and
simpler boundary that the early documents did not reconcile explicitly:

- financial writes use a separate TypeORM `DataSource` and restricted PostgreSQL roles;
- the main application role cannot access the financial schema;
- payment remains an in-process module on the shared application connection because its
  integrity comes from constraints, idempotency and state transitions rather than an
  append-only role boundary;
- administrator APIs are composed into `apps/api`, and administrator UI belongs to the
  same Next.js application unless evidence later justifies a separate deployable.

Leaving the original five-deployable language as the apparent current architecture makes
the repository and its ADR corpus disagree about a security boundary that should be
unambiguous.

## Decision

V3 currently has **two deployables**:

1. `apps/api`: the NestJS composition root for the bounded domain modules;
2. `apps/web`: the Next.js customer, professional and administrator web application.

Financial isolation is a **connection, role and schema boundary inside the API
deployable**, as accepted and tested by ADR-017. It is not represented as a separate
process today. Payment is also an in-process bounded module. Neither module may be
reached through another module's tables; composition ports, contracts and transactional
outboxes remain the allowed integration mechanisms.

This decision changes deployment topology only. It does not weaken:

- schema ownership or Nx/ESLint module boundaries;
- the financial role contract or append-only ledger;
- fail-closed production payment readiness;
- the requirement that modules be extraction-ready.

## Extraction triggers

A module becomes a separate deployable only after a new ADR identifies a measured reason,
such as independent scaling, a materially different availability or retention regime, a
provider/network boundary that cannot safely share the process, or a team ownership model
that benefits from an independent release cadence.

Extraction must preserve the existing contract and data-ownership boundary. It is not a
calendar milestone and is not inferred from a module name ending in `service`.

## Consequences

- Documentation now matches the code and the actual CI/container surface.
- Local and early hosted operations have fewer moving parts while the product model is
  still changing.
- Financial compromise resistance continues to rely on PostgreSQL roles and a distinct
  connection, so every target host must pass `verify:roles` before enablement.
- A process crash can affect multiple domains; extraction remains available when real
  evidence outweighs that operational simplicity.
- ADR-002's modular-monolith choice and ADR-011's monorepo choice remain accepted. Only
  their separate-day-one-deployable statements are superseded.
