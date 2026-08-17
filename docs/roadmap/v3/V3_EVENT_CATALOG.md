# V3 Event Catalog (draft)

Status: Phase 11 output, first draft. **Important finding from Phase 2**: V2 has no formal event contract to migrate — `beauclick/*` action hooks are plain, unversioned WordPress `do_action()` calls (in-process only, nothing persisted, no schema), and the separate `wp_bc_events` analytics table has a free-text `event_type` string with an unvalidated JSON `meta` blob documented only in a code comment. These are two independent, ungoverned mechanisms that don't reference each other. This catalog is therefore **new formal structure**, not a migration of existing structure — grounded in the real event names, producers, and consumers V2 already has, so V3's version is a superset that closes real gaps rather than an invention disconnected from the actual domain.

Each entry: **name**, **version**, **producer** (V3 service), **payload**, **consumers**, **idempotency strategy**, and **V2 precedent** (what it's based on, verified against real code — `none` where V3 needs genuinely new instrumentation).

Kafka is the transport per the architecture brief; nothing below assumes a specific broker — the contract is the payload/versioning discipline, not the pipe.

---

## Booking domain

### `BookingCreated` v1
- **Producer**: booking-service
- **Payload**: `{ bookingId, providerId, customerId, serviceId, slotId, startAt, status: "pending" }`
- **Consumers**: commerce-service (create order), analytics-service
- **Idempotency**: `bookingId` is the natural key; consumers must no-op on redelivery.
- **V2 precedent**: `beauclick/booking/after_create` (filter, not action) — payments/loyalty/campaigns all hook this same point today. **Gap to fix**: V2's order creation triggered by this hook has no idempotency guard (`GAP-03`); V3's consumer contract must require idempotent handling by design, not by accident.

### `BookingConfirmed` v1
- **Producer**: booking-service (on payment success, via `PaymentSucceeded` consumption) or booking-service directly (provider manual confirm)
- **Payload**: `{ bookingId, providerId, customerId, confirmedAt }`
- **Consumers**: notification-service (confirmation message)
- **Idempotency**: status-transition CAS in booking-service (only `pending → confirmed` fires this); redelivery-safe by construction since the transition can't happen twice.
- **V2 precedent**: no dedicated `do_action` — confirmation is a direct status write inside `BookingService`, reacting synchronously to `on_payment_complete()`. V3 formalizes this as a real event.

### `BookingCompleted` v1
- **Producer**: booking-service
- **Payload**: `{ bookingId, providerId, customerId, serviceId, completedAt }`
- **Consumers**: loyalty-service (award points), referral-service (qualification check), search-service (ranking signal), analytics-service
- **Idempotency**: consumers must dedupe on `bookingId` — V2's loyalty consumer already does this via a real DB unique constraint (`UNIQUE(reference_type, reference_id, reason)`), the strongest idempotency evidence found anywhere in the codebase; carry that discipline into every V3 consumer of this event, not just loyalty's.
- **V2 precedent**: `beauclick/booking/completed` — real action, real production consumers confirmed (loyalty's `EarningRules`, referral's `QualificationListener`, ranking recompute).

### `BookingCancelled` v1
- **Producer**: booking-service
- **Payload**: `{ bookingId, providerId, customerId, cancelledAt, actorId? }`
- **Consumers**: payment-service (refund-if-paid decision), search-service (ranking signal — cancellation rate)
- **Idempotency**: refund logic must recheck "remaining amount &gt; 0" before acting (V2's exact pattern) so a redelivered event is a safe no-op.
- **V2 precedent**: `beauclick/booking/cancelled` — real action; payments' `on_booking_cancelled()` deliberately decides refund eligibility itself rather than trusting the firer, preserving the domain boundary (booking never knows commerce exists). Preserve this separation-of-concerns in V3: booking-service fires the fact, commerce/payment-service decides financial consequence.

### `BookingRescheduled` v1
- **Producer**: booking-service
- **Payload**: `{ bookingId, providerId, customerId, oldSlotId, newSlotId, oldStartAt, newStartAt, rescheduleCount }`
- **Consumers**: notification-service (invalidate stale reminder, schedule new one), search-service
- **Idempotency**: booking-service's own 4-step claim→move→release algorithm already has rollback-on-failure; the event fires only after the transaction commits.
- **V2 precedent**: no dedicated action fired — V2 calls `NotificationService::invalidate()` directly inline. Real, confirmed V2 bug this formalization would have prevented: a stale reminder for the old slot time wasn't originally invalidated on reschedule (found and fixed live).

### `SlotOpened` v1
- **Producer**: booking-service
- **Payload**: `{ slotId, providerId, serviceId?, slotDate }`
- **Consumers**: booking-service itself (waitlist matching)
- **Idempotency**: waitlist matcher's 30-minute per-entry cooldown is the real guard against duplicate-notification spam from a burst of near-simultaneous slot openings.
- **V2 precedent**: `beauclick/booking/slot_opened` — real action, single real consumer (`WaitlistMatcher`).

### `AvailabilityPublished` v1
- **Producer**: booking-service
- **Payload**: `{ providerId, slotIds[], generatedAt }`
- **Consumers**: search-service (availability-aware ranking, if adopted — see `V3_ARCHITECTURE_PLAN.md` search notes)
- **Idempotency**: booking-service's bulk-generate is already idempotent (skips exact `start_at` duplicates on re-run) — the event should fire once per bulk-generate call, not once per slot, to avoid a burst-event storm.
- **V2 precedent**: none directly — V2's ranking doesn't currently consume availability as a signal. Net-new if V3 adopts "availability-aware ranking" per the brief's Search phase; **OPTIONAL**, not required for parity.

---

## Commerce / Payment domain

### `OrderCreated` v1
- **Producer**: commerce-service
- **Payload**: `{ orderId, sourceType: "booking"|"b2b_quote"|"shop", sourceId, customerId, subtotal, currency }`
- **Consumers**: payment-service, analytics-service
- **Idempotency**: **REQUIRED fix over V2** — creation must be idempotent on `(sourceType, sourceId)`, closing `GAP-03`.
- **V2 precedent**: no single unified event — three separate, uncoordinated code paths create WooCommerce orders today (booking bridge, B2B quote acceptance, direct shop checkout). Unifying them behind one `OrderCreated` producer is itself the Commerce pricing-engine merge decision from `V3_ARCHITECTURE_PLAN.md` §2.

### `OrderPaid` v1
- **Producer**: commerce-service (reacting to `PaymentSucceeded`)
- **Payload**: `{ orderId, totalAmount, paidAt }`
- **Consumers**: booking-service (confirm), financial-service (record commission/receivable), loyalty-service (points for non-booking orders only — see V2's explicit double-counting guard below)
- **Idempotency**: financial-service's `UNIQUE(entry_type, reference_type, reference_id)` constraint is the strongest, DB-enforced idempotency pattern found anywhere in V2 — reuse this exact shape.
- **V2 precedent**: `woocommerce_payment_complete`, chosen over a generic status-changed hook specifically because it "fires specifically when a gateway confirms money actually moved" — preserve this precision in V3's own event semantics (an `OrderPaid` event must mean payment-confirmed, never merely status-changed-to-something-that-looks-paid). V2's loyalty consumer deliberately excludes booking-linked orders from this event's point-award path (booking's own `BookingCompleted` already awards points) to avoid double-counting "paid" and "service delivered" — preserve this exclusion rule explicitly in V3's consumer contract, not as an implicit accident of wiring.

### `OrderRefunded` v1
- **Producer**: commerce-service
- **Payload**: `{ orderId, refundId, refundAmount, refundedAt }`
- **Consumers**: financial-service (reversal entries), campaign-pricing (usage release)
- **Idempotency**: financial-service's reversal reuses the *original* payment entry's captured commission rate, never live config — preserve this exactly; it's what makes a rate change never retroactively alter historical refund math.
- **V2 precedent**: `woocommerce_order_refunded` — real WooCommerce core action, independently consumed by financial's `RefundRecorder` (kept as a separate listener from the refund-*issuing* code, so the ledger reacts to the real refund fact rather than assuming its own refund call succeeded — preserve this listen-to-the-fact-not-the-intent discipline).

### `OrderCancelled` v1
- **Producer**: commerce-service
- **Payload**: `{ orderId, cancelledAt, reason }`
- **Consumers**: campaign-pricing (usage release)
- **Idempotency**: usage-release is a status flip (`applied → released`), naturally idempotent.
- **V2 precedent**: `woocommerce_order_status_cancelled`/`_failed`/`_refunded` — three explicit discrete hooks rather than one generic status-changed hook, deliberately, "because a generic status-changed hook can fire for reasons that aren't payment failure (e.g. manual admin edits)." Preserve this precision — V3's `OrderCancelled` must mean a real terminal-failure transition, not any status write.

### `CampaignApplied` v1
- **Producer**: commerce-service (pricing engine)
- **Payload**: `{ campaignId, bookingId, orderId, customerId, discountAmount }`
- **Consumers**: analytics-service
- **Idempotency**: `UNIQUE(booking_id)` on the usage record — same pattern V2 already proved correct.
- **V2 precedent**: real `wp_bc_events` fact (`campaign_applied`) fired only when a fee is genuinely added, plus a DB-enforced `UNIQUE(booking_id)` usage record preventing double-application.

### `CampaignUsageReleased` v1
- **Producer**: commerce-service (pricing engine)
- **Payload**: `{ campaignId, bookingId, releasedAt, reason }`
- **Consumers**: analytics-service
- **Idempotency**: status flip on an existing usage row.
- **V2 precedent**: `UsageReleaseListener` — independently registered on the same three order-dead hooks payments already listens to (multiple independent consumers per hook is the established V2 convention; preserve it rather than forcing a single-consumer-per-event model).

### `PaymentInitiated` / `PaymentSucceeded` / `PaymentFailed` v1
- **Producer**: payment-service
- **Payload**: `{ paymentId, orderId, provider, amount, status }`
- **Consumers**: commerce-service
- **Idempotency**: provider-callback idempotency key, per the shared provider-abstraction pattern (see `V3_ARCHITECTURE_PLAN.md` §4).
- **V2 precedent**: no real gateway ever integrated (`GAP-06`) — this is the one payment-lifecycle sub-event set with **no direct V2 precedent to draw shape from**, only the target contract described in V2's own gap register ("gateway swap = install a plugin, zero bridge-code changes" — V3's equivalent is "gateway swap = new provider implementation, zero consumer changes").

### `RefundCompleted` v1
- **Producer**: payment-service
- **Payload**: `{ refundId, paymentId, amount, completedAt }`
- **Consumers**: commerce-service (fires `OrderRefunded` in turn)
- **Idempotency**: `remaining amount &gt; 0` recheck before acting — V2's exact, proven pattern.
- **V2 precedent**: `wc_create_refund()` call sites in payments' auto-refund logic (paid-but-unconfirmable-booking race, refund-on-cancel) — both always recompute the real remaining amount from the commerce system's own data, never an independently-tracked figure.

---

## Provider / Marketplace domain

### `ProfessionalVerified` v1 (and `ProfessionalSuspended`, `ProfessionalRevoked`, `ProfessionalRejected`)
- **Producer**: provider-service
- **Payload**: `{ providerId, providerType, fromStatus, toStatus, actorId, reason? }`
- **Consumers**: search-service (re-index), analytics-service
- **Idempotency**: status-transition CAS (V2's `VALID_TRANSITIONS` table) — a transition either legally happens once or is rejected, never double-applies.
- **V2 precedent**: **no dedicated domain event exists today** — verification status changes propagate to search only because `VerificationService::transition()` directly, synchronously calls `Indexer::sync()` in the same request. This is flagged in the marketplace discovery report as worth promoting to a real event in V3 rather than a tight synchronous coupling — this catalog entry is that promotion. Every transition already writes to an append-only history table with actor/reason, which maps directly onto this event's payload.

### `ReviewCreated` v1
- **Producer**: provider-service (reviews sub-module)
- **Payload**: `{ reviewId, targetType, targetId, authorId, bookingId, rating }`
- **Consumers**: loyalty-service (points), search-service (rating resync)
- **Idempotency**: `UNIQUE(booking_id)` — one review per completed booking, DB-enforced in V2, preserve exactly.
- **V2 precedent**: `beauclick/reviews/submitted` — real action, confirmed consumed by loyalty's `EarningRules`.

---

## Loyalty / Referral domain

### `LoyaltyPointsEarned` v1
- **Producer**: loyalty-service
- **Payload**: `{ userId, points, reason, referenceType, referenceId }`
- **Consumers**: loyalty-service itself (tier/membership auto-sync)
- **Idempotency**: `UNIQUE(reference_type, reference_id, reason)` — the single strongest idempotency guarantee found anywhere in V2, NULL-safe (reference-less manual adjustments are never blocked by the constraint). Preserve verbatim.
- **V2 precedent**: `beauclick/loyalty/points_awarded` — real action, real consumer (`TierMembershipSync`).

### `MembershipActivated` v1
- **Producer**: loyalty-service
- **Payload**: `{ userId, planId, source: "manual"|"tier_qualification", activatedAt, expiresAt? }`
- **Consumers**: analytics-service
- **Idempotency**: upsert-on-user (V2's `UNIQUE(user_id)` — one membership row max per user).
- **V2 precedent**: `MembershipService::activate()` direct call, not a fired event — auto-activation is triggered by `TierMembershipSync` reacting to `points_awarded` in-process. V3 formalizing this as an explicit event is mostly for observability/analytics; the underlying business rule (never auto-overwrite a membership from a *different* source, additive-only) must be preserved regardless of transport.

### `ReferralQualified` v1
- **Producer**: referral-service
- **Payload**: `{ referralId, referrerUserId, refereeUserId, qualifiedAt }`
- **Consumers**: loyalty-service (reward both parties)
- **Idempotency**: atomic `UPDATE ... WHERE status='pending'` guards the qualify transition against a genuine concurrent-event race — V2's proven pattern for exactly this kind of race, preserve it.
- **V2 precedent**: internal to `ReferralService::qualify()`, triggered by `BookingCompleted`/`OrderPaid`-equivalent listeners — no dedicated fired action in V2, but the qualification *rule* itself (first completed booking OR first completed order, whichever happens first — registration alone never qualifies) is precise and must transfer exactly.

---

## Notification / AI / Search domain

### `NotificationRequested` v1
- **Producer**: any service (booking, loyalty, referral, etc.)
- **Payload**: `{ category, templateKey, userId, vars, entityType, entityId, channels[] }`
- **Consumers**: notification-service
- **Idempotency**: `{templateKey}:{entityType}:{entityId}:{userId}:{channel}` as the dedupe key — V2's exact, proven idempotency-key shape (insert-before-dispatch, a losing insert never reaches the channel). Preserve verbatim; this is one of the cleanest, most directly portable pieces of business logic found in the entire discovery pass.
- **V2 precedent**: `beauclick_notifications()->notify(...)` — a **direct imperative call today, not an event** (booking's schedulers and referral both call it as a function, not via `do_action`). Formalizing this as a real event is a genuine V3 improvement (decouples every producer from notification-service's availability) but the call contract and idempotency key must survive unchanged.

### `SearchPerformed` v1
- **Producer**: search-service (or frontend, forwarded)
- **Payload**: `{ query, filters, resultCount, userId? }`
- **Consumers**: analytics-service
- **Idempotency**: not required — analytics fact, append-only.
- **V2 precedent**: `search_performed` — a real `wp_bc_events` fact, deliberately never logging raw query text for privacy reasons. Preserve that redaction discipline exactly in V3.

### `AIConversationCreated` v1 (and `AIMessageSent`)
- **Producer**: ai-service
- **Payload**: `{ conversationId, userId or providerId, mode: "customer"|"professional" }`
- **Consumers**: analytics-service
- **Idempotency**: not required for the create event; message-level dedup not needed since messages are user-initiated turns.
- **V2 precedent**: implicit in `wp_bc_ai_conversations`/`wp_bc_ai_professional_conversations` row creation, never a fired event. **Real gap to resolve, not just format**: V2's schema hard-caps one conversation per tenant (`UNIQUE(user_id)` / `UNIQUE(provider_id)`) — before this event's payload can support a real `conversationId` history concept, V3 must decide (per `GAP-12`) whether to keep or relax that constraint.

---

## Framework/lifecycle (not domain events — noted for completeness)

V2 has two purely structural hooks with no business meaning of their own: `beauclick/core/register_rest_routes` (route-registration bootstrap seam every plugin's `Plugin::boot()` hooks) and `beauclick/seed` (demo-data seeding trigger). Neither has a V3 event-catalog equivalent — they're framework wiring, not domain facts, and V3's own service-startup/seeding mechanism will have its own analog outside this catalog.

---

## Cross-cutting note: `beauclick/auth/otp_generated`

V2's OTP-generation hook (`do_action('beauclick/auth/otp_generated', $phone, $code, $purpose)`) is confirmed to have **zero production subscribers** — it exists solely so the test suite can observe a real generated code without a test-only return-value path (and, as this project's own live QA session confirmed, as a legitimate local-only debugging aid via a temporary, deliberately non-committed mu-plugin). **This must never become a real, persisted `OTPGenerated` event in V3's catalog** — an OTP code must never appear in an event payload, log, or message bus, even internally. Its absence from this catalog is deliberate, not an oversight.
