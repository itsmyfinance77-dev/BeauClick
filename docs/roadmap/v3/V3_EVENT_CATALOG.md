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

---

# Phase 2 implementation status (2026-08-20)

The events below are **built and running**, produced through a transactional outbox and consumed by idempotent handlers. Ones not listed remain specification only.

| Event | Producer | Consumers in Phase 2 | Idempotency mechanism |
|---|---|---|---|
| `BookingCreated` v1 | booking | (none yet) | `bookingId` natural key |
| `BookingConfirmed` v1 | booking | audit observer | status CAS — the transition happens once or not at all |
| `BookingCancelled` v1 | booking | payment (refund decision) | `UNIQUE(order_id, request_key)` on the refund |
| `BookingCompleted` v1 | booking | (loyalty/referral, later phases) | status CAS |
| `BookingRescheduled` v1 | booking | (notifications, later phase) | CAS on `(status, reschedule_count)` |
| **`BookingExpired` v1 (NEW)** | booking | commerce (cancel unpaid order) | status CAS |
| `OrderCreated` v1 | commerce | (none yet) | `UNIQUE(source_type, source_id)` |
| `OrderPaid` v1 | commerce | financial (commission + receivable) | `UNIQUE(entry_type, reference_type, reference_id)` |
| `OrderCancelled` v1 | commerce | (campaign usage release, later phase) | status CAS |
| `OrderRefunded` v1 | commerce | financial (reversal at the ORIGINAL rate) | same ledger unique constraint |
| `PaymentInitiated` v1 | payment | (analytics, later phase) | `UNIQUE(provider_key, provider_reference)` |
| `PaymentSucceeded` v1 | payment | commerce (via the checkout orchestrator) | attempt-status CAS |
| `PaymentFailed` v1 | payment | (none yet) | attempt-status CAS |
| `RefundCompleted` v1 | payment | commerce (order refunds only — see below) | refund-status CAS |
| `LedgerEntriesRecorded` v1 | financial | (analytics, later phase) | ledger unique constraint |
| `SettlementRecorded` v1 | financial | (none yet) | append-only batch |
| `SettlementReversed` v1 | financial | (none yet) | `UNIQUE(reverses_settlement_id)` |

## `BookingExpired` — new in Phase 2

Not in the original catalog because V2 had no such concept: it modelled an abandoned hold as `cancelled` with `reason='expired'`. Separating them makes "did a customer actually cancel on us?" answerable from a status column, and — more importantly — makes the refund decision independent of parsing a free-text string. A cancellation may need a refund; an expired unpaid hold never does.

**Payload:** `{ bookingId, professionalId, customerId, slotId, expiredAt }`.
**Consumer:** commerce cancels the unpaid order. `cancel()` only touches a `pending` order, so an order that was in fact paid just as the hold lapsed is left alone — that case belongs to the paid-but-unconfirmable path.

## `RefundCompleted` carries a `kind`

`kind: 'order' | 'duplicate_charge'`. Consumers **must** branch on it.

A `duplicate_charge` refund corrects a second gateway charge that should never have happened; the order was legitimately paid once. Recording it as an order refund would drive a correctly-paid order to `refunded` and reverse a commission the professional genuinely earned. See `V3_PHASE2_IMPLEMENTATION.md` §5.2 for how such a charge becomes reachable at all.

## The no-secrets rule is now enforced by a throw

The catalog's warning that an OTP code must never appear in an event payload was, until now, a comment. Every outbox write scans its payload recursively against a deny-list of credential-shaped keys (`code`, `otp`, `codeHash`, `password`, `token`, `accessToken`, `refreshToken`, `secret`, `apiKey`, `merchantId`, `cardNumber`, `cvv`, …). A payload carrying one **fails at the write, inside the producing transaction** — not later, in a log aggregator.

Deliberately an exact-key deny-list rather than a substring heuristic: `providerReference` and `paymentIntentId` are legitimate, necessary payload fields, and a naive `/token|secret/` rule would reject them and push authors toward disabling the check entirely.

Asserted by `outbox-transactional.pg-spec.ts`, which scans every payload the real checkout flow actually produced.

## Transport

Phase 2 ships an **in-process relay**, not Kafka (ADR-018). The correctness-bearing parts — the transactional outbox, versioned envelopes, and the idempotent-consumer contract — are built. No producer writes to a broker directly and no consumer knows how the envelope arrived, so adopting Kafka changes one file.

Delivery is **at-least-once**: rows are dispatched first and marked published second, because the opposite order loses events when a process dies mid-dispatch. That is why every consumer above names a real database constraint or a status compare-and-swap.

---

# Phase 3 implementation status (2026-08-21)

## The catalog is now executable

This document is no longer the only place a contract lives. `libs/event-contracts`
carries **33 registered contracts**, each with a name, an integer version, exactly
one producer, a runtime schema, and the idempotency strategy a consumer signs by
registering. The TypeScript payload type is *derived* from the schema rather than
declared beside it, so the two cannot drift.

Three consequences worth stating, because they change what "the catalog says" means:

* **Validation runs inside the producing transaction.** A payload that violates its
  own contract fails the business write, not a log aggregator.
* **Unknown keys are stripped, not passed through.** An accidental entity spread
  cannot publish a field nobody declared — which is exactly how a `phone` or a
  private note would otherwise reach a consumer that should never see it. Phase 2's
  credential deny-list still runs underneath as an independent second layer.
* **A consumer registered against an event nobody produces fails STARTUP.** Every
  wired handler is recorded at boot and checked. V2's `beauclick/auth/otp_generated`
  — a real hook with zero subscribers, found only by grepping the whole codebase —
  is the mirror image of that blind spot.

## Events implemented in Phase 3

| Event | Producer | Consumers | Idempotency |
|---|---|---|---|
| `ProfessionalUpdated` v1 | provider | search projection | `revision` — an older revision is DISCARDED, not applied |
| `ProfessionalVerificationChanged` v1 | provider | analytics | status CAS; also emits `ProfessionalUpdated` |
| `ServiceOfferingUpdated` v1 | provider | search (validation) | owning professional's `revision` |
| `LoyaltyPointsEarned` v1 | loyalty | analytics | `UNIQUE(reference_type, reference_id, reason)` |
| `LoyaltyTierChanged` v1 | loyalty | notification, journey, analytics | `UNIQUE(user, toTier, lifetimeEarned)` on the crossing |
| `MembershipActivated` v1 | loyalty | notification, journey, analytics | `UNIQUE(user_id)` on the membership |
| `MembershipEnded` v1 | loyalty | analytics | status CAS from active |
| `BeautyGoalCreated` v1 | journey | (analytics-only, none yet) | goalId natural key |
| `BeautyGoalStatusChanged` v1 | journey | (none yet) | status CAS |
| `NotificationRequested` v1 | notification | analytics | `UNIQUE(idempotency_key)` |
| `NotificationSent` v1 | notification | analytics | status CAS |
| `NotificationFailed` v1 | notification | analytics | attempt counter |
| `NotificationDeadLettered` v1 | notification | analytics | status CAS |
| `NotificationRead` v1 | notification | analytics | CAS on `read_at IS NULL` |
| `SearchPerformed` v1 | search | analytics | not required — append-only fact |
| `ProviderProfileViewed` v1 | search | search ranking, analytics | not required; `signal_applications` dedupes the increment |

## `SearchPerformed` has no field that could hold a query

V2 logged a `search_performed` fact that deliberately never recorded the raw query.
That redaction is now **structural**: the contract carries `queryClass`
(`empty` | `text` | `filtered` | `text_and_filtered`) and `queryTermCount`, and there
is no field a query string could occupy. Adding one would require editing the
contract and bumping the version — a reviewable act rather than an accident.

## `ProviderProfileViewed` closes GAP-15

`entityType` is `z.literal('provider')`. V2 logged the raw CPT post type here while
every other provider-scoped event logged `provider`, making the two uncomparable.
The analytics fact table additionally carries a `CHECK` constraint that makes the
un-normalized value unstorable.

## A note on idempotency keys for RECURRING facts

Keying a consumer on the subject id is correct for a fact that happens at most once
per entity (a booking is confirmed once). It is **wrong** for a fact that legitimately
recurs for one subject: a customer crosses bronze → silver → gold against one loyalty
account, so keying on the account id records the first crossing and silently swallows
every later one.

Both the notification and journey-timeline consumers of `LoyaltyTierChanged` and
`MembershipActivated` therefore key on the **source event's id**, which is stable
across redeliveries of one event and distinct between different events. This was a
real bug, found by crossing two tiers against the running stack and reading the
notification table.

## Transport

Still an **in-process relay**, and now on evidence rather than deferral. `OrderPaid`
has five independent consumers (ledger, loyalty, journey timeline, notification,
analytics) and runs correctly. See `ADR-022` for why nothing in the observed load
argues for a broker yet, and what would change the answer.

## Every event now carries a correlation ID

This catalog required one from the start and the column did not exist. Phase 3 adds it, because Phase 3 is where it became load-bearing: a single completed booking now reaches five independent consumers in five schemas, several of which emit further events of their own. Without a correlation ID, *"why did this customer get this notification"* is answered by comparing timestamps across five schemas and hoping nothing else happened in the same second.

- **At the edge.** Every HTTP request runs under a correlation id, taken from `X-Correlation-Id` when the client supplies a UUID-shaped one and minted otherwise. It is echoed back on the response, so a browser network log or a support ticket can name the exact request without server access. A non-UUID value is **replaced, not sanitised** — the id reaches nine outbox tables and every log line, and this system produces exactly one id shape.
- **On the way out.** `emitEvent` and `emitContractEvent` stamp the ambient id onto the outbox row inside the producing transaction. It is captured rather than passed as an argument for the reason the rest of this project keeps rediscovering: a parameter every producer has to remember is a guarantee that holds until the first author forgets, and the failure mode here is a silent null.
- **Across the fan-out.** The relay re-enters the context with the **stored** id before invoking handlers, so an event emitted by a consumer inherits the id of the event it was reacting to. This is the hop that makes the id worth having, and it is one explicit line in `outbox.relay.ts` rather than something ambient that happens to work.
- **Into analytics.** `analytics.events.correlation_id` makes a cross-domain trace one query instead of nine. It is an identifier and never a dimension — grouping by it produces one bucket per action, which is a trace, not a metric.
- **When there is no request.** A scheduler tick mints a fresh id rather than writing null. An unreliable column stops being used, and a sweep's own cascade is still worth tracing as a unit.

The column is nullable **only** because rows written before the migration have no honest value to backfill. Every row written after it has one, and a test asserts that.

### What the id must never become

A correlation id is an opaque identifier and nothing else. It is not derived from a user id, a phone number, or a session, and nothing may be inferred from it — otherwise a value that travels into logs, response headers, and any future third-party aggregator quietly becomes a personal identifier. UUIDv7 is used for the same reason every other id here is: it sorts in creation order, which is useful, and encodes nothing else.
