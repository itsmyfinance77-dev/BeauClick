# Route × contract matrix (#45)

**Implementation baseline:** `master` `2e3da4a43482680db5104c1e78dba48a8d2a18f4`.
**Single source:** [`verify/traceability.json`](verify/traceability.json). The table in §2 is the checker's own output (`node verify/check-traceability.mjs <master>/v3 --markdown`), not retyped. Re-run it against any later `master` to see whether a cited route, field, capability or recorded absence has changed.

## 1. What the checker proves

| Check | Result at the baseline |
|---|---|
| every cited `(method, path)` exists among the 291 routes derived from the NestJS controllers | 41 / 41 |
| every cited wire field appears in the cited source files | 125 / 125 |
| every capability named in the pack is in `capabilities.ts` | 11 / 11 |
| every value slot (`‹field›`) in the prototype is a cited field | 42 / 42 |
| every recorded absence still holds: no seller credit-balance read, no dispute/appeal route, no `reception` role, no `createdAt` on `/v1/me` | 4 / 4 |

**Non-vacuity:** each check was made to fail on purpose, then restored (`AUDIT.md` §2). An injected field on `/v1/me`, an injected `GET /v1/me/disputes`, four inverted absences, and a prototype slot renamed to `staffSeatsUsed` all exit `1`.

## 2. Routes the design reads

| # | Method | Path | Authority | Handler | Fields the design renders | Used by |
|---|---|---|---|---|---|---|
| 1 | GET | `/v1/me` | session; roles and capabilities resolved live from identity.user_roles | `services/identity/src/me/me.controller.ts:22` | `id`, `phone`, `displayName`, `roles`, `capabilities` | 51 §2, 51 §3, 52 §2 |
| 2 | GET | `/v1/me/finance/workspaces` | session; owned OR live finance_read grant; Cache-Control private, no-store | `services/financial/src/financial.controller.ts:158` | `items`, `workspaceRef`, `workspaceType`, `accessMode`, `displayLabel` | 51 §2.3, 51 §4 |
| 3 | GET | `/v1/me/finance/:workspaceRef/summary` | live ownership OR live finance_read grant; shared NotFoundOrNotYours refusal | `services/financial/src/financial.controller.ts:166` | `partyType`, `receivableNetToman`, `settledToman`, `outstandingToman`, `currency` | 51 §5 |
| 4 | GET | `/v1/me/finance/:workspaceRef/outstanding-orders` | as fin-summary | `services/financial/src/financial.controller.ts:182` | `orderId`, `outstandingToman` | 51 §5 |
| 5 | GET | `/v1/me/finance/:workspaceRef/settlements` | as fin-summary; cursor bound to the workspace | `services/financial/src/financial.controller.ts:198` | `items`, `nextCursor`, `kind`, `amountToman`, `method`, `reference`, `createdAt`, `'reversal'` | 51 §5 |
| 6 | GET | `/v1/me/finance/:workspaceRef/funds` | as fin-summary | `services/financial/src/financial.controller.ts:237` | `pending`, `disputed`, `available`, `reserve`, `settled`, `refunded`, `platformEarned`, `providerFee`, `recoveryOut`, `collected`, `platformAdvance`, `recoveredIn`, `currency` | 51 §5 |
| 7 | GET | `/v1/me/subscriptions` | session + live ownership (reads); writes additionally bc_manage_own_subscription (non-privileged) | `services/commercial-policy/src/seller-surface/seller-subscription-surface.controller.ts:128` | `workspaceRef`, `workspaceType`, `subscription`, `state`, `planKey`, `version`, `billingTermDays`, `includedBookingCredits`, `staffSeats`, `includedLocations`, `capabilityKeys`, `unitPriceToman`, `effectiveAt`, `baseWorkspace`, `availableActions`, `'select_plan'`, `'cancel'` | 51 §5.2 |
| 8 | GET | `/v1/me/subscriptions/:workspaceRef/history` | as subs | `services/commercial-policy/src/seller-surface/seller-subscription-surface.controller.ts:137` | `supersededAt`, `cancelledAt` | 51 §5.2 |
| 9 | GET | `/v1/me/subscriptions/:workspaceRef/credit-purchases` | as subs | `services/commercial-policy/src/seller-surface/seller-subscription-surface.controller.ts:249` | `purchaseId`, `quantity`, `unitPriceToman`, `totalToman`, `state`, `effectiveAt`, `createdAt`, `'awaiting_payment'`, `'abandoned'`, `purchase_unavailable` | 51 §5.3 |
| 10 | GET | `/v1/me/commercial-plans` | session | `services/commercial-policy/src/seller-surface/seller-subscription-surface.controller.ts:295` | `displayName`, `selectable`, `baseWorkspace` | 51 §5.2 |
| 11 | GET | `/v1/orders/:id` | OrderOwnerResolver: the customer who owns the order | `services/commerce/src/order/order.controller.ts:110` | `status`, `totalToman`, `collectedTotalToman`, `refundedTotalToman`, `paymentSchedule`, `collectionMode`, `serviceTotalToman`, `platformCollectibleNowToman`, `venueBalanceToman`, `'pay_at_venue'`, `'deposit_online_balance_at_venue'`, `'full_payment_online'`, `'online_collection_not_required'` | 51 §5.1 |
| 12 | GET | `/v1/me/bookings` | session; own bookings only | `services/booking/src/booking/booking.controller.ts:94` | `orderId`, `value`, `total`, `startAt` | 51 §3.1 |
| 13 | GET | `/v1/bookings/:id/remedy` | booking customer | `apps/api/src/outcome/booking-remedy.controller.ts:35` | — (presence/navigation only) | 51 §6 |
| 14 | GET | `/v1/bookings/:id/no-show` | booking parties | `services/booking/src/booking/booking.controller.ts:232` | — (presence/navigation only) | 51 §6 |
| 15 | GET | `/v1/me/professional-bookings` | session; the caller's own professional profile | `services/booking/src/booking/booking.controller.ts:109` | — (presence/navigation only) | 51 §3.2 |
| 16 | GET | `/v1/me/professional-bookings/upcoming-count` | session; own professional profile | `services/booking/src/booking/booking.controller.ts:141` | `upcomingCount` | 51 §3.2 |
| 17 | GET | `/v1/me/provider` | session; own profile | `services/provider/src/provider.controller.ts:154` | — (presence/navigation only) | 51 §2.2 |
| 18 | GET | `/v1/me/business` | session; owned business or null | `services/business/src/business.controller.ts:81` | `displayName` | 51 §2.2, 51 §3.3 |
| 19 | GET | `/v1/me/business-staff` | session; the caller's own memberships | `services/business/src/business.controller.ts:298` | `role`, `status`, `businessId`, `'manager'`, `'staff'` | 51 §2.2, 51 §3.4, 51 §3.5, 51 §3.6 |
| 20 | GET | `/v1/businesses/:id` | BusinessMembershipResolver: owner or live member | `services/business/src/business.controller.ts:88` | `displayName` | 51 §3.4, 51 §3.5 |
| 21 | GET | `/v1/businesses/:id/classification` | BusinessMembershipResolver: owner or live member | `services/business/src/business.controller.ts:119` | `vertical`, `traits` | 51 §3.3, 51 §3.11 |
| 22 | PATCH | `/v1/businesses/:id` | BusinessManagerResolver: owner or active manager | `services/business/src/business.controller.ts:96` | — (presence/navigation only) | 51 §3.4 |
| 23 | GET | `/v1/businesses/:id/staff` | BusinessMembershipResolver | `services/business/src/business.controller.ts:142` | — (presence/navigation only) | 51 §3.4 |
| 24 | GET | `/v1/businesses/:id/staff-management` | BusinessOwnerResolver: owner only | `services/business/src/business.controller.ts:163` | `displayLabel`, `labelSource`, `identificationHint`, `roles`, `role` | 51 §3.3 |
| 25 | GET | `/v1/businesses/:id/staff/:staffId/grants` | BusinessOwnerResolver: owner only | `services/business/src/business.controller.ts:246` | `'practitioner_chat'`, `'finance_read'` | 51 §3.3, 51 §3.6, 51 §3.7 |
| 26 | GET | `/v1/businesses/:id/locations` | owner only (per-handler resolver) | `services/business/src/business-location.controller.ts:38` | — (presence/navigation only) | 51 §3.3 |
| 27 | GET | `/v1/chat/unread-count` | bc_use_chat; conversations decided per request by the seller-access port | `services/chat/src/chat.controller.ts:251` | `total`, `conversations` | 51 §2.1 |
| 28 | GET | `/v1/me/notifications/unread-count` | session | `services/notification/src/notification.controller.ts:65` | `unreadCount` | 51 §2.1 |
| 29 | GET | `/v1/me/loyalty/summary` | session | `services/loyalty/src/loyalty.controller.ts:34` | `balance`, `lifetimeEarned` | 51 §3.1 |
| 30 | GET | `/v1/admin/verification/queue` | bc_moderate_verification (live re-check for privileged capabilities) | `services/provider/src/verification/verification.controller.ts:129` | `meta`, `pagination`, `total` | 52 §3 |
| 31 | GET | `/v1/admin/verification/:id/evidence` | bc_moderate_verification; URL minted per moderator | `services/provider/src/verification/verification.controller.ts:157` | `downloadUrl`, `issueProtectedDownloadUrl` | 52 §5 |
| 32 | GET | `/v1/admin/media/reports` | bc_moderate_media | `libs/media/src/media.controller.ts:270` | `mediaObjectId`, `reason`, `status`, `meta`, `total`, `createdAt` | 52 §3, 52 §5 |
| 33 | POST | `/v1/admin/media/reports/:id/decide` | bc_moderate_media | `libs/media/src/media.controller.ts:288` | — (presence/navigation only) | 52 §5 |
| 34 | GET | `/v1/admin/reviews/queue` | bc_moderate_reviews | `services/provider/src/review.controller.ts:180` | `meta`, `total` | 52 §3 |
| 35 | GET | `/v1/admin/chat/reports` | bc_moderate_chat (class-level) | `services/chat/src/chat-moderation.controller.ts:100` | `items`, `status`, `limit` | 52 §3 |
| 36 | GET | `/v1/admin/analytics` | bc_manage_platform | `services/analytics/src/analytics.controller.ts:97` | — (presence/navigation only) | 52 §4 |
| 37 | GET | `/v1/admin/audit-log` | bc_manage_platform | `services/identity/src/admin/admin-audit.controller.ts:49` | — (presence/navigation only) | 52 §4 |
| 38 | GET | `/v1/admin/users` | bc_manage_platform | `services/identity/src/admin/admin-roles.controller.ts:63` | — (presence/navigation only) | 52 §4 |
| 39 | GET | `/v1/admin/finance/totals` | bc_manage_platform | `services/financial/src/financial.controller.ts:307` | — (presence/navigation only) | 52 §4 |
| 40 | GET | `/v1/admin/commercial/plans` | bc_manage_commercial_plans | `services/commercial-policy/src/catalogue/commercial-catalogue.controller.ts:84` | — (presence/navigation only) | 52 §4 |
| 41 | GET | `/v1/admin/commercial/booking-credit-enforcement` | bc_manage_commercial_plans | `services/commercial-policy/src/enforcement/booking-credit-enforcement.controller.ts:57` | — (presence/navigation only) | 52 §4 |

## 3. Routes the design deliberately does not read

| Route family | Why not |
|---|---|
| `/v1/me/finance/summary`, `…/outstanding-orders`, `…/settlements`, `…/orders/:id/ledger` (the four singular routes) | ownership-only compatibility routes that return `409 finance_workspace_selection_required` for a dual owner. The design uses the workspace-aware family only (screen 46 §2) |
| `/v1/admin/finance/parties/*` | take a party argument. `bc_manage_platform` only, never a dashboard input |
| `/v1/me/analytics/series`, `/v1/admin/analytics/series` | daily event series, not money. The finance trend is #255's server series |
| `/v1/admin/commercial/*` writes | administrator publication surfaces (screens 40, 44, 47, 50). The dashboard links to them and draws none |
| anything under `/v1/chat/conversations/*` and `/v1/me/ai/*` beyond the unread count | #237 owns those screens |

## 4. Authority summary

| Authority | Enforced by | Live? | Where the design relies on it |
|---|---|---|---|
| session | `JwtAuthGuard` | per request | every route |
| privileged capability (`bc_manage_platform`, `bc_moderate_*`, `bc_manage_commercial_plans`) | `CapabilityGuard` with a per-request role re-read | yes | 52 §2, §4 |
| non-privileged capability (`bc_manage_own_subscription`, `bc_manage_own_collection_policy`) | `CapabilityGuard`, token claim | **no**: next token issue (`V33-DEC-019`) | 51 §2.4 |
| ownership | per-handler `@ResolveOwner` resolvers, or a workspace reference matched against live owned parties | yes | 51 §2.3, §3.3 |
| membership / manager | `BusinessMembershipResolver`, `BusinessManagerResolver` | yes | 51 §3.4–§3.6 |
| scoped grant | `finance_read` on the finance family, `practitioner_chat` in the seller-access port | yes, re-read per request | 51 §3.6–§3.7, §4 |
