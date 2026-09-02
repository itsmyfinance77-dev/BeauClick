# V3 Domain Boundaries — Final

Status: Phase 0 blueprint, finalizing `V3_ARCHITECTURE_PLAN.md` §1's evidence-based 12-service list against this task's explicit required-domain list. **One boundary question is resolved by this task itself, not by new evidence**: this task's own required-domain list names **journey** as a top-level domain, separate from `ai`. The prior discovery pass's preliminary recommendation (`V3_GAP_REGISTER.md` GAP-29) was to fold Journey into ai-service, explicitly flagged as needing its own evidence-based review before being final. That review is superseded here by explicit direction: **Journey is its own bounded module.** `V3_GAP_REGISTER.md` is updated accordingly (see its Phase 0 addendum). This does not change Journey's real data or its one-way AI seam — only its status as an independently-named module vs. a folded-in one.

No microservices beyond the two already decided in ADR-002 (financial, payment) are created here — every domain below is a `services/*` module inside the modular monolith (`apps/api`) unless noted otherwise.

---

## identity

- **Responsibility**: phone-as-root-of-trust OTP authentication, JWT/refresh-token session issuance and revocation, RBAC/capability grants, business-account approval status (a data fact, not a workflow of its own).
- **Own schema**: `identity` — `users`, `otp_requests`, `phone_conflicts`, `sessions`/`refresh_tokens`, `roles`, `capabilities`, `business_account_approvals`.
- **Public API**: `POST /v1/auth/request-otp`, `POST /v1/auth/verify-otp`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `POST /v1/auth/change-phone/{request,confirm}`.
- **Internal API**: `resolveOwner(userId): OwnerContext` — the shared ownership-resolver entry point (`libs/ownership`) every other module calls to turn a session into a resolved identity; `checkCapability(userId, capability): boolean`.
- **Events produced**: `UserCreated` v1 *(new — no V2 precedent, see `V3_EVENT_ARCHITECTURE.md`)*, `BusinessAccountApproved`/`Rejected`.
- **Events consumed**: none (identity is upstream of everything else).
- **Data ownership rules**: identity is the only module permitted to write to `identity.*`. No other module ever stores a password/OTP/session artifact. Phone number is canonical here; every other module references a user only by `user_id`.

## provider

- **Responsibility**: professional/business/service/portfolio profiles (the CPT→relational re-platform, `WORDPRESS_EXIT_MATRIX.md` §2), verification workflow, business staff, reviews, wishlist.
- **Own schema**: `provider` — `professionals`, `businesses`, `services`, `portfolio_items`, `specialties`, `verification_requests`/`_evidence`/`_history`, `business_staff`, `reviews`, `wishlist_items`.
- **Public API**: `GET /v1/providers`, `GET /v1/providers/{id}`, `GET /v1/specialties`, `GET/PATCH /v1/my/profile`, `GET/POST /v1/my/services`, `POST /v1/verification/submit`, moderation-capability-gated verification queue/decide routes.
- **Internal API**: `getProviderSummary(providerId)` (consumed by search-service reindex, ai-service context assembly), `isVerified(providerId)`.
- **Events produced**: `ProfessionalVerified`/`Suspended`/`Revoked`/`Rejected` v1, `ReviewCreated` v1.
- **Events consumed**: `BookingCompleted` (review eligibility), `AvailabilityPublished`.
- **Data ownership rules**: owns the only writable copy of profile/verification/review data. Ownership resolved via `identity.resolveOwner` — never a request-supplied provider ID for mutation.

## search

- **Responsibility**: read-model only — OpenSearch index rebuilt from provider/booking/review events, never a system of record. Serves the marketplace filter/facet surface (city, district, specialty, price, rating, verified, free-text, sort).
- **Own schema**: none relational — OpenSearch index (`provider_index`) is its store; a thin Postgres `search` schema may hold reindex-job bookkeeping only.
- **Public API**: `GET /v1/search/providers` (the real successor to V2's `/marketplace/providers` browse endpoint).
- **Internal API**: none consumed by other modules — search is a leaf.
- **Events produced**: `SearchPerformed` v1 (analytics fact, never raw query text — redaction discipline preserved from V2).
- **Events consumed**: `ProfessionalVerified`, `ReviewCreated`, `BookingCompleted`, `AvailabilityPublished` (all trigger reindex).
- **Data ownership rules**: search never writes back to provider/booking data; a full reindex from those modules' own APIs must always be possible (documented, tested runbook, per `V3_ARCHITECTURE_DISCOVERY.md` §14 ADR-005 consequence).

## booking

- **Responsibility**: availability/slots, booking lifecycle (hold/confirm/cancel/no-show/complete), rescheduling, waitlist, CRM notes (folded in, narrow scope), ranking signal collection, reminder/rebooking/retention scheduling.
- **Own schema**: `booking` — `availability_slots`, `bookings`, `booking_reschedules`, `waitlist_entries`, `crm_notes`.
- **Public API**: `GET /v1/availability`, `GET/POST /v1/bookings`, `POST /v1/bookings/{id}/{cancel,confirm,no-show,reschedule}`, `GET/POST /v1/waitlist`, `GET/POST /v1/crm/customers`.
- **Internal API**: `getBookingSummary(bookingId)` (consumed by commerce-service, financial-service).
- **Events produced**: `BookingCreated/Confirmed/Completed/Cancelled/Rescheduled` v1, `SlotOpened` v1, `AvailabilityPublished` v1.
- **Events consumed**: `PaymentSucceeded` (→ confirm), `OrderRefunded` (ranking signal).
- **Data ownership rules**: the atomic CAS hold/claim discipline is enforced only inside this module's own transaction boundary — no other module ever writes a booking-status transition.

## commerce

- **Responsibility**: replaces WooCommerce — cart/order lifecycle, the unified pricing-rule-provider chain (Campaign + Membership discount + B2B tier pricing), B2B account/quote workflow, receipt presentation.
- **Own schema**: `commerce` — `orders`, `order_items`, `pricing_rule_applications`, `campaigns`, `campaign_usages`, `b2b_price_tiers`, `quotes`.
- **Public API**: `GET /v1/my-orders`, `GET /v1/receipts/{orderId}`, `GET /v1/b2b/pricing/{productId}`, `GET/POST /v1/b2b/quotes`, admin campaign/tier-management routes.
- **Internal API**: `createOrder(sourceType, sourceId, ...)` — the single order-creation entry point every producer (booking, B2B quote acceptance, shop) must call through, idempotent on `(sourceType, sourceId)` (closes `GAP-03`).
- **Events produced**: `OrderCreated/Paid/Refunded/Cancelled` v1, `CampaignApplied`/`CampaignUsageReleased` v1.
- **Events consumed**: `BookingCreated` (→ create order), `PaymentSucceeded`/`RefundCompleted` (from payment-service), `BookingCancelled`.
- **Data ownership rules**: the only module that computes a price. No other module (booking, B2B) is ever allowed to compute or trust a client-supplied total.

## payment *(separate deployable — `apps/payment-service`)*

- **Responsibility**: payment intent/initiation/callback/verification, refund issuance, gateway-provider abstraction.
- **Own schema**: `payment` — `payment_intents`, `provider_callbacks`, `refunds`. Physically isolated database/role from every other module (ADR-002 #2).
- **Public API**: gateway callback/webhook endpoint (provider-specific path, verified server-to-gateway per ADR-006), no direct customer-facing routes beyond payment initiation redirect.
- **Internal API**: `initiatePayment(orderId, amount, currency)`, `issueRefund(paymentId, amount)`.
- **Events produced**: `PaymentInitiated`/`Succeeded`/`Failed` v1, `RefundCompleted` v1.
- **Events consumed**: `OrderCreated` (initiate payment).
- **Data ownership rules**: the only module holding gateway credentials/callback secrets. Never shares a database or a deploy pipeline with any other module.

## financial *(separate deployable — `apps/financial-service`)*

- **Responsibility**: append-only commission ledger, settlement batch/item recording and reversal.
- **Own schema**: `financial` — `ledger_entries` (DB-role UPDATE/DELETE revoked, ADR-009), `settlement_batches`, `settlement_items`. Physically isolated database/role (ADR-002 #2, ADR-009).
- **Public API**: `GET /v1/financial/my-summary` (self-scoped, zero staff fallback — the deliberately narrower default preserved from `V3_SECURITY_MODEL.md` §4), platform-capability-gated settle/reverse/set-rate routes.
- **Internal API**: `receivableNetForCurrentSession()` — party identity resolved entirely internally, no caller-supplied party argument ever accepted (the `GAP-05` fix pattern, mandatory for every method on this module, not just the ones that already had it).
- **Events produced**: `LedgerEntryCreated` v1 *(new — no direct V2 event precedent; V2's ledger writes were never event-driven, only directly called)*.
- **Events consumed**: `OrderPaid` (record commission), `OrderRefunded` (reversal at original captured rate).
- **Data ownership rules**: append-only, enforced at the database role level, not application convention (closes `GAP-01` for real — contingent on confirming target Postgres hosting grants this, `V3_MIGRATION_PLAN.md` §6 risk).

## loyalty

- **Responsibility**: points ledger, tiers, membership (merged in — real frequent in-process coupling), benefits.
- **Own schema**: `loyalty` — `loyalty_points`, `loyalty_tiers`, `membership_plans`, `memberships`, `loyalty_benefits`.
- **Public API**: `GET /v1/loyalty/summary`, `GET /v1/loyalty/tiers`, platform-capability-gated tier/plan/benefit CRUD (**mandatory audit-logging from day one** — this is the domain that had the still-open `GAP-02` instance in V2).
- **Internal API**: `awardPoints(userId, points, reason, referenceType, referenceId)` — idempotent via `UNIQUE(reference_type, reference_id, reason)`, the strongest-proven idempotency pattern in the whole V2 codebase.
- **Events produced**: `LoyaltyPointsEarned` v1, `MembershipActivated` v1.
- **Events consumed**: `BookingCompleted`, `ReviewCreated`, `OrderPaid` (non-booking orders only — the double-counting exclusion rule preserved explicitly).

## referral

- **Responsibility**: referral codes, attribution, qualification, reward (kept separate from loyalty — own data model/lifecycle, only calls loyalty's `awardPoints` through an already-decoupled boundary).
- **Own schema**: `referral` — `referral_codes`, `referrals`.
- **Public API**: `GET /v1/referrals/summary`, platform-capability-gated read-only admin list (no admin write path — preserved by design).
- **Internal API**: none exposed beyond its own routes.
- **Events produced**: `ReferralQualified` v1.
- **Events consumed**: `BookingCompleted`/`OrderPaid`-equivalent (qualification trigger).

## notification

- **Responsibility**: dispatch (SMS/email/push — real channel delivery is net-new, `GAP-11`), preferences, delivery log, in-app notification center (net-new).
- **Own schema**: `notification` — `notifications`, `notification_preferences`.
- **Public API**: `GET/PATCH /v1/notifications/preferences`, `GET /v1/notifications/mine`.
- **Internal API**: `notify(category, templateKey, userId, vars, entityType, entityId, channels[])` — any module may call this directly (synchronous) or via `NotificationRequested` (async, preferred in V3 to decouple producers from notification-service's availability).
- **Events produced**: none domain-significant beyond delivery-status facts (internal to analytics).
- **Events consumed**: `NotificationRequested` (from any module).
- **Data ownership rules**: idempotency key `{templateKey}:{entityType}:{entityId}:{userId}:{channel}` preserved verbatim — insert-before-dispatch, a losing insert never reaches the channel.

## analytics

- **Responsibility**: the formal, versioned event store (replaces `wp_bc_events`), metric computation — the single shared read-model both dashboards and AI must read (never two engines).
- **Own schema**: `analytics` — the event store itself (partitioned by time), plus derived metric tables/materialized views as needed.
- **Public API**: `GET /v1/analytics/overview` (platform-capability), `GET /v1/analytics/my/summary` (self-scoped, staff-fallback allowed — CRM/analytics' deliberately broader default).
- **Internal API**: `MetricsService.compute(metricKey, filters)` — the one computation every consumer (dashboards, AI) must call, never a second parallel engine.
- **Events produced**: none (analytics is a pure consumer/aggregator).
- **Events consumed**: every event in `V3_EVENT_ARCHITECTURE.md`'s catalog, by design (it's the system-of-record for "what happened").

## ai

**Implemented in V3.2-A to the deterministic sandbox milestone.** ADR-029 decides the
boundary and the provider port; ADR-030 amends `V3_SECURITY_MODEL.md` §5 into nine named
threats with named controls. The entries below are updated from the Phase 0 blueprint to what
was actually built; where the two differ, the difference is stated rather than quietly
overwritten.

- **Responsibility**: customer discovery assistant — provider-abstracted, context-curated,
  output-validated, and re-verified against the authoritative catalogue.
  **Professional mode is deferred** (`V32-DEC-001`, decided 2026-08-29): no
  `bc_use_professional_ai` capability exists, and no professional conversation table was
  created. When it is approved it gets its own table keyed on the party, not a `scope` column
  on the customer table.
- **Own schema**: `ai` — `conversations`, `messages`, `recommendations`, `assistant_consents`,
  `usage_daily`, `outbox_events`. `GAP-12`'s one-thread-per-tenant constraint was revisited and
  **not** re-adopted: `V32-DEC-002` chose bounded sessions, so there is no `UNIQUE(user_id)`,
  and there are instead a `status`, a `last_activity_at`, a 24-hour inactivity horizon, a
  20-conversation retained cap, and a 30-day retention sweep.
  Ownership is enforced by composite foreign keys — `messages` and `recommendations` reference
  `conversations(id, user_id)` — so a row whose owner disagrees with its parent's is
  unwritable, not merely absent from today's queries.
- **Public API**: `GET/POST /v1/me/ai/consent`, `POST/GET /v1/me/ai/conversations`,
  `GET /v1/me/ai/conversations/{id}`, `POST /v1/me/ai/conversations/{id}/messages`,
  `DELETE /v1/me/ai/conversations/{id}`, `POST /v1/me/ai/recommendations/{id}/click`.
  Under `/v1/me/` rather than the blueprint's `/v1/ai/`, because every route is self-scoped and
  the prefix says so. **No route accepts an owner, customer, party, or user id**, and there is
  no professional route.
- **Internal API**: none exposed. `ai` only ever calls into other modules' already-scoped
  summary methods, through two typed ports bound in the composition root
  (`AI_JOURNEY_CONTEXT` → `journey.inferAiDefaults`, `AI_PUBLIC_CATALOGUE` → the existing
  search read model plus provider's own tables for re-verification). Never the reverse.
- **Events produced**: `AIConversationStarted` v1 and `AIMessageExchanged` v1.
  Renamed from the blueprint's `AIConversationCreated`/`AIMessageSent` — the second carries one
  customer message AND its reply, so "sent" would have described half of it. Neither schema has
  a field able to hold prose, asserted mechanically by walking the zod schema.
- **Events consumed**: none. Context is assembled synchronously per request.
- **Data ownership rules**: never given direct database access to any other module. Every fact
  it sees comes through an already-authorized, already-curated summary call, and the
  allow-listed set is fixed by `V32-DEC-005`: string-free Journey inference, public
  professional summaries, public service summaries, approved public search summaries.
  Journey `notes` and goal titles, review comments and professional replies, CRM notes,
  internal chat, moderation reasons, verification evidence, direct identifiers, financial
  figures, and tenant-private analytics are excluded **by construction** — no port returns
  them and no type can hold them. A professional's public `bio` is excluded too, because a
  public string authored by one party and fed into a prompt on behalf of another is an
  injection surface with no compensating benefit.
- **Operator access**: none to content (`V32-DEC-009`). There is no admin route, no
  impersonation, and no moderation queue for AI conversations. Operators get counts, latency,
  provider mode, refusal mix, and the re-verification drop rate.
- **Provider**: one registry, one port, and exactly one registered provider — `deterministic`,
  a local assistant that narrates the real catalogue, needs no credential, makes no network
  call, and says in its own reply that it is not a language model. Readiness reports
  `ai_provider: simulated`, and `productionVerified` stays false with no code path able to
  change it.

## chat

**New in V3.2-B.** Human messaging between a customer and the seller party they actually
transacted with. ADR-031 decides who may talk and for how long; ADR-032 decides privacy, abuse,
and moderation. Decisions `V32-DEC-010` … `V32-DEC-015`, closed 2026-08-30.

- **Responsibility**: two-party conversations gated on a proven booking relationship, with
  blocking, reporting, and a moderation queue. Polling transport, in-app notification only.
- **Own schema**: `chat` — `conversations`, `conversation_participants`, `messages`, `blocks`,
  `reports`, `send_counters`, `outbox_events`. **No `message_attachments`**: attachments are out
  of the milestone entirely, not stubbed.
- **Public API**: `GET/POST /v1/chat/conversations`, `GET /v1/chat/conversations/{id}`,
  `GET/POST /v1/chat/conversations/{id}/messages`, `POST /v1/chat/conversations/{id}/read`,
  `GET /v1/chat/unread-count`, `POST/DELETE /v1/chat/blocks`, `POST /v1/chat/reports`, and three
  `bc_moderate_chat` routes under `/v1/admin/chat/reports`.
- **Internal API**: none exposed. `chat` calls out through typed ports bound in the composition
  root — booking eligibility, the historical seller snapshot, and business-inbox membership — and
  nothing calls into it.
- **Events produced**: `ConversationStarted` v1 and `MessageSent` v1. Ids, enums, counts, and
  instants only; **no field can hold a message body**.
- **Events consumed**: none.
- **Data ownership rules**: the counterparty is the **immutable historical seller-party snapshot**
  from `commerce.orders` (`source_type='booking'`), recorded at creation and never recomputed —
  **no fallback** to current `business_staff` affiliation, and a missing snapshot fails closed.
  A business conversation belongs to the business; inbox access is the **owner and active
  managers only**, with practitioner-specific access deferred to the V3.3-C role matrix. Read
  state is a monotonic watermark on the participant row, never a per-message flag.
- **Erasure**: ADR-027-consistent and taking **no exception** to it. The erased subject's prose is
  destroyed, leaving a neutral structural placeholder with no excerpt or reconstructable content;
  the counterparty's own messages survive; the identity is tombstoned. 24-month retention swept by
  hard delete and cascade.
- **Moderation**: entry is a report id and nothing else — no conversation browsing, no user or
  message search, no arbitrary conversation-id access. A moderator may not send, impersonate,
  edit, or delete. Reading a reported window is itself audited.
- **The AI boundary**: **no chat context port exists and none may be added.** Human chat is not AI
  context, `V3.2_PRODUCT_ROADMAP.md` §4 states it as a non-goal, and the capability catalog lists
  automatic use of it as `RETIRED`. Enforced structurally, not by policy: `ai`'s context type is a
  closed three-key interface whose key set is asserted against a literal.

## journey

- **Responsibility**: customer beauty profile (preferred specialty/city/budget), goals, timeline — an independent bounded module per this task's explicit domain list (see status note above).
- **Own schema**: `journey` — `beauty_profiles`, `beauty_goals`.
- **Public API**: `GET /v1/journey/summary`, `GET/PATCH /v1/journey/profile`, `GET/POST /v1/journey/goals`, `GET /v1/journey/timeline`.
- **Internal API**: `inferAiDefaults(userId): {specialtyIds?, cityId?, budget?}` — the one seam into ai-service, preserved exactly from V2's `JourneyContextProvider` (the free-text `notes` field is never included in this call's return value).
- **Events produced**: none required at launch (a `JourneyGoalCreated`-class event is optional, evidence-gated, not required for parity).
- **Events consumed**: `BookingCompleted` (timeline composition).
- **Data ownership rules**: only-ever-own-data reads, session-derived, no cross-user path — preserved from V2's `infer_ai_defaults(int $userId)` contract exactly.

## admin / privacy / cross-cutting

- **Responsibility**: **not a data-owning service** (confirmed, `V3_ARCHITECTURE_PLAN.md` §3a/§3b). Admin = a capability model (`libs/ownership`, RBAC) + a structurally-mandatory shared audit-log contract (`libs/audit`) + an admin frontend (`apps/admin`) composing every other module's own admin-capable routes. Privacy = a thin orchestrator calling every module's own typed `exportSubjectData(userId)`/`eraseSubjectData(userId)` contract, self-registered (closes the `PRIV-06` hardcoded-call-list blind spot by construction).
- **Own schema**: `admin` — `admin_audit_log` (append-only, DB-role enforced, same mechanism as financial's ledger). `privacy` — `data_requests` (single table for both export and deletion request lifecycles, preserved from V2's proven shape).
- **Public API**: no domain routes of its own beyond `/v1/privacy/export/*`, `/v1/privacy/deletion/*`, `/v1/admin/audit-log`.
- **Internal API**: `AuditLog.record(actor, action, entityType, entityId, previousState, newState, reason)` — every `libs/http` mutation-capable controller must call this or fail to register (the structural fix for the 3×-recurring `GAP-02`-class bug).
- **Events produced/consumed**: none required — deliberately synchronous, in-process contracts (an admin action's audit trail must never be eventually-consistent).
- **Data ownership rules**: no admin route may ever download another user's private export file, only see request status (preserved exactly from V2).

---

## Cross-references
- `V3_EVENT_ARCHITECTURE.md` — full event catalog and mechanics for every "Events produced/consumed" row above.
- `V3_DATABASE_BLUEPRINT.md` — schema-per-module detail and entity list.
- `V3_API_CONTRACT_BLUEPRINT.md` — API conventions shared by every "Public/Internal API" row above.
- `V3_GAP_REGISTER.md` — `GAP-29` (Journey), `GAP-08` (ownership resolver), `GAP-02` (audit logging), `GAP-01`/`GAP-05` (financial), `GAP-03` (order idempotency), `GAP-12` (AI thread model).
