# V3 API Contracts (draft)

Status: Phase 2 output, organized as a starting inventory for Phase 5 service design — not a final V3 API spec. Every route below is a real, verified V2.3.0 REST endpoint (`beauclick/v1` namespace), grouped by the V3 service that would own its successor per `V3_ARCHITECTURE_PLAN.md` §1. The point of this document is to carry forward the **contract shape** (what identity resolution looks like, what error codes mean, what the response envelope is) — not to lock V3 into the same URL structure.

## Standing contract rules (apply to every route below, verified pervasive in V2)

1. **Ownership/identity is always session-derived, never a request parameter** (see `V3_SECURITY_MODEL.md` §3). No route in this inventory accepts a `user_id`/`provider_id`/`customer_id` parameter and trusts it for authorization — where such a field appears in a request body, it's either ignored or validated-not-trusted.
2. **Response envelope**: `{ data, meta: { pagination? }, error: { code, message, details? } | null }` — V2's frontend (`app/src/lib/api.ts`) already depends on this shape; carrying it forward avoids an unrelated frontend rewrite.
3. **A route without an explicit permission check must fail to register**, not silently default to open. V2 enforces this at the framework level (`RestController::route()` throws if any variant lacks a `permission_callback`); V3 should keep the equivalent build-time/startup-time guarantee.
4. **Generic, non-leaking error messages** for ownership failures ("not found or not yours") — never distinguish "doesn't exist" from "exists but isn't yours."
5. **Errors are always in the caller's language** (Persian) — V2's API client guarantees a raw English/network error never reaches the UI; the backend contract should make this the server's job (translated error messages), not leave it to frontend patching.

---

## identity-service

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/auth/request-otp` | POST | public | Anti-enumeration: never reveals whether the phone has an account. |
| `/auth/verify-otp` | POST | public | On success: issues session, fires `AIConversationCreated`-adjacent... no — fires account-registration event for referral attribution. |
| `/auth/logout` | POST | session | |
| `/auth/change-phone/request` | POST | session | Anti-enumeration: identical "sent" response whether or not the target phone is already taken by someone else. |
| `/auth/change-phone/confirm` | POST | session | Real conflict (409) only ever surfaces here, post-auth *and* post-OTP-verification — never earlier. |

## provider-service

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/marketplace/providers` | GET | public | Backed by the search-service read-model in V3, not a live join. |
| `/marketplace/providers/{id}` | GET | public | Logs a `profile_view` analytics fact — bounded/allow-listed fields only. |
| `/marketplace/specialties` | GET | public | Reference data. |
| `/marketplace/my/profile` | GET, PATCH | session | Self-only. |
| `/marketplace/my/services` | GET, POST | session | Capability: `bc_manage_own_services`. |
| `/marketplace/my/services/{id}` | PATCH, DELETE | session | Owner-or-platform-capability gate. |
| `/marketplace/verification/me` | GET | session | Identity resolved via session→owned-provider lookup, never a request id. |
| `/marketplace/verification/submit` | POST | session | Requires ≥1 evidence file; rolls back the whole request on partial upload failure. |
| `/marketplace/verification/evidence/{id}` | GET | session | Re-checks `isOwner OR moderationCapability` on **every** request, not just at issuance — see Security Model §8. |
| `/marketplace/verification/queue` | GET | moderation capability | Narrower than the general platform-admin capability — deliberate least-privilege split. |
| `/marketplace/verification/queue/{id}/decide` | POST | moderation capability | `verified`/`rejected` only, requires reason for reject. |
| `/marketplace/verification/provider/{id}/suspend`, `/revoke`, `/reinstate` | POST | moderation capability | Reason required except reinstate. |
| `/marketplace/my/staff` | GET, POST | session | Literal-owner-only (`post_author` match) — staff cannot manage staff. |
| `/marketplace/my/staff/{user_id}` | DELETE | session | Same gate. |

## search-service

No dedicated V2 controller — search is served through `provider-service`'s `/marketplace/providers` browse endpoint today. V3's search-service should own this route directly once OpenSearch replaces the denormalized SQL index, with the same filter surface (city, district, specialty, price range, rating floor, verified-only, free-text query, sort).

## booking-service

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/booking/availability` | GET | public | Read-only public browse. |
| `/booking/bookings` | GET, POST | session | POST requires `bc_book_service` capability; `customer_id` always session-derived. |
| `/booking/bookings/{id}/cancel` | POST | session | Ownership re-checked inline: customer, or owning provider, or platform capability. |
| `/booking/bookings/{id}/confirm` | POST | session | Owning-provider-only (via provider lookup) or platform capability. |
| `/booking/bookings/{id}/no-show` | POST | session | Same gate as confirm; only legal once `slot_end` has passed. |
| `/booking/bookings/{id}/reschedule-eligibility` | GET | session | Customer, owning provider, or platform capability. |
| `/booking/bookings/{id}/reschedule` | POST | session | Same gate. |
| `/booking/bookings/{id}/reschedule-history` | GET | session | Same gate. |
| `/booking/my/stats` | GET | session | Provider identity resolved server-side only. |
| `/booking/crm/customers` | GET | session | Provider identity + staff-role fallback (CRM is one of the two surfaces staff access actually reaches). |
| `/booking/crm/customers/{id}` | GET | session | Re-verified `is_customer_of()` server-side, independent of the route gate. |
| `/booking/crm/customers/{id}/notes` | POST | session | |
| `/booking/crm/customers/{id}/notes/{note_id}` | PATCH, DELETE | session | Dual ownership: real customer-of-provider relationship AND author match. |
| `/booking/waitlist` | POST | session | `customer_id` always session-derived. |
| `/booking/waitlist/mine` | GET | session | Self-scoped. |
| `/booking/waitlist/provider` | GET | session | Provider-scoped via lookup. |
| `/booking/waitlist/{id}/cancel` | POST | session | Owner-or-platform-capability. |
| `/booking/my/availability` | GET, POST | session | Capability: `bc_manage_own_availability`; provider identity server-side only. |
| `/booking/my/availability/bulk` | POST | session | Same. |
| `/booking/my/availability/{id}` | DELETE | session | Provider id passed to the delete query as a `WHERE` clause, not trusted alone. |

## commerce-service

| V2 route (spread across payments/B2B today) | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/booking/bookings` → order creation (side effect) | POST | session | Order creation should become idempotent per `(sourceType, sourceId)` in V3 — see `GAP-03`. |
| `/my-orders` (equivalent) | GET | session | Always filtered server-side by session identity; **never** accepts a client-supplied customer id — proven by test in V2, not just claimed. |
| `/receipts/{order_id}` (equivalent) | GET | session | Three-way ownership gate: customer, owning provider, or platform capability. Values always read from the authoritative order, never recalculated. |
| `/b2b/pricing/{product_id}` | GET | public | Publicly viewable tier table; grants no purchasing power — cart price is always recomputed server-side. |
| `/b2b/quotes` | GET, POST | approved-business-account | |
| `/b2b/quotes/{id}/accept` | POST | approved-business-account | Ownership of *this specific quote* re-checked one layer below the route gate — the route gate alone only proves "an approved business," not "the right one." |
| `/b2b/account`, `/b2b/apply` | GET, POST | session | Self-scoped. |
| `/b2b/accounts/pending`, `/{id}/approve`, `/{id}/reject` | GET, POST | platform capability | |
| `/b2b/quotes/{id}/quote` (admin counter-price) | POST | platform capability | |
| `/b2b/tiers/{product_id}` | POST | platform capability | **Confirmed open gap**: has no audit logging in V2 (`GAP-02`) — must be fixed in V3, not ported as-is. |

## payment-service

No real gateway routes exist in V2 to inventory (`GAP-06`) — the callback/webhook contract is genuinely new. The one shape to preserve: a payment-status webhook/callback endpoint must be idempotent per provider-supplied transaction reference, and must never trust a client-supplied "payment succeeded" claim without independent provider verification.

**V3.1 Phase F — what has since been built** (full contract:
`docs/roadmap/v3.1/V3.1_PHASE_F_IMPLEMENTATION.md` §§2.1, 2.2b–2.2d; architecture: `ADR-028`):

| Route | Method | Auth | Contract |
|---|---|---|---|
| `/v1/payments/callback/:provider` | GET + POST | public | The gateway's return leg. Idempotent per `(provider_key, provider_reference)`; the callback parameters identify the transaction and never attest to it. Redirects 303 to `PUBLIC_WEB_BASE_URL/checkout/result?status&orderId[&reason]` |
| `/v1/orders/:id/payment/retry` | POST | session + `OrderOwnerResolver` | **V3.1 Phase F.** Order-scoped, so no intent id is ever put in a URL. Empty body — the server reads nothing from the request but the order id. Returns `{ redirectUrl }` only; refuses 409 `PAYMENT_RETRY_NOT_AVAILABLE` with a `reason` from a closed set |

Two rules the redirect contract carries and that must not be relaxed:

1. **`status`, `orderId`, and `reason` are presentation inputs, not payment truth.** Every figure on the result page is re-fetched from `GET /v1/orders/:id` under a valid session; editing the query string changes a sentence and nothing else.
2. **The gateway's own failure code is never published.** It is stored for support and narrowed to a closed eight-member public vocabulary (`@beauclick/payment-contract`) before it reaches a URL — a redirect URL is browser history, a referrer header, and whatever analytics the page loads.

Retry eligibility is derived **server-side** from the stored failure code, the order's status, and whether a gateway attempt is still open; the client's `reason` is never consulted. An unresolved verification writes nothing, so the intent's stored failure code may still be a retryable one — which is why an open attempt refuses a retry independently of it.

## financial-service

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/financial/my-summary` | GET | session | Identity resolved exclusively via session→owned-provider lookup — **no staff fallback** (deliberately narrower default than CRM/analytics). Adversarially tested: a forged `provider_id` parameter proven to leak nothing. |
| Admin settle/reverse/set-rate (admin-post in V2, not REST) | POST | platform capability | Should become real REST/RPC endpoints in V3 with the same re-validation-at-write-time discipline (outstanding amount recomputed fresh, ownership re-verified, never trusting stale UI state). |

## loyalty-service

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/loyalty/summary` | GET | session | Self-scoped. |
| `/loyalty/tiers` | GET | session | |
| `/loyalty/admin/tiers`, `/plans`, `/benefits` (+ `/{id}`) | GET, POST, PATCH, DELETE | platform capability | Every admin mutation is audit-logged in current code — a fix applied *after* the same bypass bug class hit this plugin too; keep the audit call mandatory in V3 from day one. |
| `/loyalty/admin/memberships/grant`, `/{user_id}/cancel` | POST | platform capability | |

## referral-service

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/referrals/summary` | GET | session | Self-scoped. |
| `/referrals/admin/list` | GET | platform capability | No admin write endpoints exist — referral state is entirely event-driven, never admin-editable. Preserve this: don't add an admin override path without a real product reason. |

## notification-service

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/notifications/preferences` | GET, PATCH | session | |
| `/notifications/mine` | GET | session | |
| `/notifications/admin/list` | GET | platform capability | |

## privacy (orchestrator, not a full service — see Architecture Plan §3a)

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/privacy/export/status`, `/request` | GET, POST | session | Reuses an existing unexpired export rather than regenerating. |
| `/privacy/export/download` | GET | session | Token-gated (random, not the request id), re-checked on every call — see Security Model §8. Identical 404 for "unknown token" and "someone else's token." |
| `/privacy/deletion/status`, `/otp/request`, `/request`, `/cancel` | GET, POST | session | Deletion always OTP-reconfirmed via the *same* OTP service as login — no second auth mechanism invented. |

No admin route exists (or should exist) for triggering export/deletion on another user's behalf, and no admin route should ever allow downloading another user's export file — both deliberate V2 decisions, preserve them.

## analytics-service

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/analytics/overview` | GET | platform capability | Platform-wide. |
| `/analytics/track` | POST | session | Event name allow-listed server-side (`TRACKABLE_EVENTS`) — never an arbitrary client-supplied event type. |
| `/analytics/my/summary` | GET | session | Provider identity via lookup, with staff-role fallback (same pattern as CRM). |

## ai-service

| V2 route | Method | Auth | Notes to preserve |
|---|---|---|---|
| `/ai/messages` | GET, POST | capability: `bc_use_ai_assistant` | Customer-mode discovery assistant. |
| `/ai/recommendations/{id}/click` | POST | capability | Click-through measurement. |
| `/ai/professional/messages` | GET, POST | capability: `bc_use_professional_ai` | Identity resolved via session→owned-provider lookup only — **no staff fallback** (same deliberately-narrow default as financial). Adversarially tested against forged `provider_id`/`providerId`/`user_id` parameters — all proven to have zero effect. |

---

## Gaps this inventory surfaces for Phase 5 API design

- **No unified order/cart API exists in V2** — it's WooCommerce's own REST/Store API plus BeauClick-specific bridges. V3's `commerce-service` API is close to a clean-slate design, informed by the *contracts* above (ownership rules, receipt/my-orders shape) rather than a route-by-route port.
- **Payment callback contract has no V2 precedent** (`GAP-06`) — design fresh against the provider-abstraction pattern in `V3_ARCHITECTURE_PLAN.md` §4.
- **SEO-relevant routes** (sitemaps, structured data endpoints) are not inventoried here — see `GAP-09`.
