# V3 API Contract Blueprint

Status: Phase 0 blueprint. **No controllers have been implemented.** Strategy decision: `docs/roadmap/v3/adr/ADR-014-api-strategy.md`. This document covers the conventions every module's real API must follow, plus example contracts (illustrative only, not a full spec) and the authentication/security model this task's item 7 asks for.

---

## 1. Standing contract rules (apply to every real V3 endpoint)

Carried forward verbatim from `V3_API_CONTRACTS.md`'s "standing contract rules," re-confirmed as the right discipline to keep:

1. Ownership/identity is always session-derived via the ownership-resolver pattern (§4) — never a request parameter trusted for authorization.
2. Response envelope: `{ data, meta: { pagination? }, error: { code, message, details? } | null }`.
3. A route without an explicit ownership/capability check must fail to register — enforced by a `libs/http` base-controller requirement, the direct successor to V2's `RestController::route()` registration-time guard, extended (per `V3_SECURITY_MODEL.md` §7) to also require a declared audit action or explicit audit-exemption for every capability-gated mutation.
4. Generic, non-leaking error messages for ownership failures.
5. Errors are always Persian, server-translated.

## 2. Authentication flow

```
1. POST /v1/auth/request-otp        { phone }              → 200 (always, anti-enumeration)
2. POST /v1/auth/verify-otp         { phone, code }         → { accessToken, refreshToken, user }
3. Every subsequent request:         Authorization: Bearer {accessToken}
4. On 401 (access token expired):    POST /v1/auth/refresh  { refreshToken } → new { accessToken, refreshToken }
5. POST /v1/auth/logout              { refreshToken }        → revokes that session only
6. POST /v1/auth/logout-all-devices  (session-derived)        → revokes every refresh token for the user
```

- **JWT access token**: 15-minute expiry, signed (asymmetric — private key held only by identity-service), carries `userId`, `roles`, `capabilities`, `iat`/`exp`. Never carries a raw PII field (no phone number in the token payload).
- **Refresh token lifecycle**: 30-day expiry, opaque random token, stored server-side **hashed** (never plaintext — the same discipline V2 applied to OTP codes), one row per device/session in `identity.refresh_tokens` with a `device_label`/`user_agent`/`last_used_at` for the device-management surface (`GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/{id}`). **Rotates on every use** — the token returned by `/refresh` invalidates the one that was just spent; reuse of an already-rotated token revokes the entire session chain (replay-detection, per ADR-014).
- **Session revocation**: logout (single session), logout-all-devices (every session), and automatic revocation on password/phone-recovery-equivalent events (OTP-reconfirmed phone change) or replay detection.

## 3. Authorization model

Capability-based RBAC (`V3_SECURITY_MODEL.md` §9), preserved role set: customer (implicit), professional, business, staff, moderator, platform-operator, administrator — each holding named capabilities checked at every authorization point, never a role-string comparison.

**Explicit anti-patterns this model must prevent** (this task's item 7):
- **IDOR**: every resource-scoped route re-verifies ownership at the service layer independent of the route-level capability check — a capability to "manage services" is necessary but never sufficient; the specific service ID must also resolve back to the caller's own owned provider.
- **Cross-tenant access**: the ownership-resolver pattern (§4) makes "whose data is this" a function of the session, never of a request parameter — structurally, not by convention.
- **Privilege escalation**: capability grants are only ever mutated through identity-service's own admin-capability-gated routes, audit-logged unconditionally (§5); no module may self-grant or infer a capability from data state.

## 4. Ownership resolver pattern

The `GAP-08` fix, formalized as reusable infrastructure (`libs/ownership`):

```typescript
// libs/ownership/resolver.decorator.ts (illustrative signature only — not implemented)
type OwnerResolver<T> = (userId: string, context: T) => Promise<string | null>;

@ResolveOwner<BookingParams>(async (userId, { bookingId }) => {
  // indirect ownership: booking -> provider -> user, resolved server-side
  return bookingService.resolveOwningUserId(bookingId, userId);
})
```

A handler decorated this way receives a resolved, verified owner context — it cannot accidentally trust `req.params.providerId`. This directly generalizes V2's confirmed-correct-but-unused helper: the new version accepts a resolver function so indirect-ownership domains (booking→provider→user, quote→business-account→user, AI conversation→provider→user) can actually use it, closing the "designed once, real call-site count near zero" failure mode by construction — verify by literally counting call sites during Phase 1 implementation (per `V3_SECURITY_MODEL.md` §3's own instruction).

## 5. Audit logging enforcement

Every controller extending the `libs/http` base class that is also capability-gated (not public, not merely session-authenticated) must declare either an `@AuditAction(actionType)` decorator or an explicit `@AuditExempt(reason)` — a controller missing both fails to compile/register (the structural successor to V2's `RestController::route()` guard, extended per `V3_SECURITY_MODEL.md` §7 to cover the exact bug class that recurred three times in V2).

## 6. Error format

```json
{
  "data": null,
  "meta": null,
  "error": { "code": "NOT_FOUND_OR_NOT_YOURS", "message": "این مورد یافت نشد.", "details": null }
}
```

Standard `code` values (non-exhaustive, extended per-module as needed): `VALIDATION_ERROR`, `NOT_FOUND_OR_NOT_YOURS`, `RATE_LIMITED`, `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT`, `INTERNAL_ERROR`.

## 7. Pagination & filtering conventions

- **Page-based**: `GET /v1/{resource}?page=1&limit=20` → `meta.pagination: { page, limit, total }`.
- **Cursor-based** (notifications, booking lists): `GET /v1/{resource}?cursor={opaque}&limit=20` → `meta.pagination: { nextCursor, hasMore }`.
- **Filtering**: plain query parameters matching resource fields, allow-listed server-side per endpoint (never an arbitrary passthrough to the query layer — the same discipline `analytics.track`'s `TRACKABLE_EVENTS` allow-list already models in V2).

## 8. Versioning

URI-based, per-module independence: `/v1/booking/...`, `/v1/commerce/...` — a breaking change to one module's contract ships as `/v2/{module}/...` for that module alone.

## 9. Example endpoint contracts (illustrative only — no controllers implemented)

```
POST /v1/auth/verify-otp
  Request:  { phone: string, code: string }
  Response: { data: { accessToken, refreshToken, user: { id, phone, roles } }, meta: null, error: null }

GET /v1/booking/bookings?page=1&limit=20
  Auth: session (customer or owning provider)
  Response: { data: [ { id, providerId, serviceId, slotStart, slotEnd, status } ],
              meta: { pagination: { page: 1, limit: 20, total: 42 } }, error: null }

POST /v1/booking/bookings/{id}/cancel
  Auth: session, ownership resolved via bookingOwnerResolver(bookingId)
  Response: { data: { id, status: "cancelled" }, meta: null, error: null }
  Errors: 404 NOT_FOUND_OR_NOT_YOURS (not owner or doesn't exist — identical response)

GET /v1/financial/my-summary
  Auth: session, identity resolved exclusively via identity.resolveOwner — no staff fallback
  Response: { data: { partyType, partyId, receivableNet, settledTotal }, meta: null, error: null }

POST /v1/loyalty/admin/tiers
  Auth: platform capability, @AuditAction('loyalty.tier.create') mandatory
  Response: { data: { id, name, threshold }, meta: null, error: null }
```

---

## Cross-references
- `ADR-014-api-strategy.md` — the decision this blueprint operationalizes.
- `V3_SECURITY_MODEL.md` — the full authorization/ownership/audit model this blueprint's §3-5 formalize into API-layer mechanics.
- `V3_DOMAIN_BOUNDARIES.md` — per-module public/internal API lists this blueprint's conventions apply to.
- `ADR-008-authentication.md` — the identity-service design this blueprint's §2 implements.
