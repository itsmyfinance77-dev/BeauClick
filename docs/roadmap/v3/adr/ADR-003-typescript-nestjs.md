# ADR-003: TypeScript / NestJS Backend

**Status:** Accepted — implemented in the V3 TypeScript/NestJS/Next.js workspace.
**Date:** 2026-08-19.

## Context

The release brief's baseline stack names NestJS/TypeScript for the backend. `V3_ARCHITECTURE_PLAN.md` treats this as "the default, not re-litigated except where V2 evidence argues for a specific deviation" — no domain-discovery report found such a deviation. Separately, the React app-shell (`app/`) is already TypeScript + Vite, and `shared/design-tokens.json` is already framework-agnostic JSON consumed by both PHP and TS today. A same-language backend removes the PHP/TS split entirely.

## Decision

**Adopt NestJS + TypeScript for every V3 backend module**, confirming the brief's baseline rather than deviating from it. Concretely:
- One NestJS monorepo (Nx or a plain npm workspace — implementation detail, not this ADR's concern) with one module per logical boundary from ADR-002.
- financial-service and payment-service are separate NestJS applications (per ADR-002 #2), sharing library code (the provider-abstraction package from `V3_ARCHITECTURE_PLAN.md` §4, the ownership-resolver primitive from §5) via internal npm packages, not copy-paste.
- The provider-abstraction pattern (`Provider<TRequest,TResult>` interface + factory + safe local fallback), independently reinvented three times in V2 (SMS, AI, Professional-AI) per `V3_ARCHITECTURE_PLAN.md` §4, ships as one shared package from day one rather than being rebuilt ad hoc per service a fourth and fifth time (Payment, Notification channels).

## Consequences

- **Positive:** one language across frontend, backend, and shared token/business-rule code (Jalali calendar math, Persian digit formatting — currently duplicated in concept between `app/src/lib` and BeauClick's PHP helpers — becomes one shared TS package, zero drift risk). NestJS's DI/module system maps directly onto the ADR-002 module boundaries. Team hiring/onboarding surface shrinks to one language.
- **Negative:** the entire PHP domain-logic codebase (18 plugins) requires a real rewrite in the new language for anything classified REFACTOR or REIMPLEMENT in `V3_MIGRATION_MATRIX.md` — "same shape, different language" is still a full rewrite effort per component, not a transpile.
- **Risk:** none specific to this ADR beyond general new-stack ramp-up; no V2 evidence contradicts NestJS/TypeScript's fit for this domain.

## Alternatives considered

Not independently re-evaluated (Fastify, a non-Nest Node framework, or a different backend language entirely) because no domain-discovery report surfaced a reason to deviate from the brief's baseline — per `V3_ARCHITECTURE_PLAN.md`'s own stated methodology, deviations from the brief are only proposed where V2 evidence argues for one, and none was found here.
