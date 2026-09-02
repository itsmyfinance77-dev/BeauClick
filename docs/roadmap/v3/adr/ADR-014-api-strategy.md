# ADR-014: API Strategy

**Status:** Accepted — implemented in `apps/api` and browser-safe contract packages.
**Date:** 2026-08-19.

## Context

`V3_API_CONTRACTS.md` already inventories 27 real V2 REST controllers under one disciplined `beauclick/v1` namespace with a proven response envelope (`{ data, meta, error }`), mandatory `permission_callback`, and session-derived-ownership discipline verified pervasive (`V3_SECURITY_MODEL.md` §3). The frontend (`app/src/lib/api.ts`) already depends on this envelope shape. No V2 evidence anywhere argues for a query-flexibility need (client-specified field selection, deeply nested resource graphs) that would justify GraphQL's added complexity — V2's endpoints are consistently shallow, resource-oriented, and purpose-built per screen.

## Decision

**REST**, not GraphQL, not hybrid — carrying forward V2's contract shape rather than re-litigating it. One namespace, versioned by URI path (`/v1/...`), matching V2's own `beauclick/v1` convention closely enough that the frontend's existing envelope-handling code needs adaptation, not a rewrite.

**Authentication flow**: OTP-verified login (identity-service, ADR-008) issues a short-lived **JWT access token** (15 min) and a longer-lived, rotating **refresh token** (30 days, stored server-side hashed, one row per device/session — enabling real device management and session revocation, both explicitly required by this task and absent from V2 entirely). Refresh rotates on every use (old token invalidated the moment a new one is issued) — detects token replay (a reused, already-rotated refresh token revokes the entire session chain, not just that request).

**Authorization model**: capability-based RBAC (`V3_SECURITY_MODEL.md` §9), enforced via a `libs/ownership` guard on every controller — never a role-string check inline.

**Ownership resolver pattern**: a NestJS decorator/guard, `@ResolveOwner(resolverFn)`, wrapping the `GAP-08` fix — accepts an owner-resolver function (not a raw ID), composable for indirect ownership (booking→provider→user). Concretely: `@ResolveOwner(bookingOwnerResolver) getBooking(@Owner() ownerId: string, @Param('id') id: string)` — the resolver runs server-side from the authenticated session, the handler never receives a client-trusted ID as the authorization input.

**Error format**: `{ data: null, meta: null, error: { code, message, details? } }` — `message` always Persian (server-side translated, matching V2's guarantee that a raw English/network error never reaches the UI), `code` a stable machine-readable string (`NOT_FOUND_OR_NOT_YOURS`, `RATE_LIMITED`, `VALIDATION_ERROR`, …) for frontend branching. Ownership failures always return the generic `NOT_FOUND_OR_NOT_YOURS` — never distinguish "doesn't exist" from "exists but isn't yours" (preserved exactly from `V3_SECURITY_MODEL.md` §3).

**Pagination**: page-based (`?page=1&limit=20`, response `meta.pagination: { page, limit, total }`) for admin/list screens, matching V2's existing pattern — **cursor-based** (`?cursor=...&limit=20`) specifically for high-write, real-time-ish feeds (notifications, booking lists) where page-based pagination can skip/duplicate rows under concurrent writes. Both conventions live under one `libs/http` pagination helper, not two ad hoc implementations.

**Filtering**: plain query parameters matching resource fields (`?cityId=&specialtyId=&priceMax=`), never a generic query-DSL parameter — matches search-service's confirmed real filter surface (`V3_API_CONTRACTS.md`) and keeps the contract simple and cacheable.

**Versioning**: URI-based (`/v1/`, `/v2/` if ever needed) — no content-negotiation versioning. A breaking change to one module's routes gets a new version prefix for *that module's* routes only, not a whole-API version bump (modules version independently, matching their independent-deploy-readiness per ADR-002).

## Consequences

- **Positive:** the frontend's existing API-client patterns (envelope handling, error hygiene, `ApiError` type) largely carry forward per `V3_MIGRATION_MATRIX.md`'s Frontend section — real risk-reduction on the one piece of the frontend rewrite that touches every screen. Refresh-token rotation + device management closes a real, confirmed V2 gap (no token infrastructure existed at all).
- **Negative:** REST's per-endpoint shape means a screen needing data from three modules makes three calls (or `apps/web` does light aggregation) — accepted, since no V2 evidence shows this was ever a real performance problem at V2's scale.
- **Risk:** refresh-token-rotation replay detection needs careful implementation (a legitimate race — e.g. a mobile app retrying a timed-out refresh call — must not be mistaken for replay) — a real engineering risk to test explicitly in Phase 1, not assumed correct from this design alone.

## Alternatives considered

- **GraphQL**: rejected — no V2 evidence of a client-side over/under-fetching problem GraphQL would solve, and it would require rebuilding the entire API contract layer from scratch rather than adapting V2's proven shape, for a benefit nothing in the discovery pass identified as needed.
- **Hybrid (REST + a GraphQL BFF for the frontend)**: rejected for launch — genuinely revisit only if a real aggregation need emerges (e.g. a future native mobile app with different data-shaping needs than the web frontend) — not built speculatively.
