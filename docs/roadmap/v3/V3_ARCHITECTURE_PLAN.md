# V3 Architecture Plan

Status: Phase 4–6 output (service boundaries, database ownership) grounded in Phase 2–3 discovery (see `V3_MIGRATION_MATRIX.md`). This document proposes REQUIRED / RECOMMENDED / OPTIONAL / DEFERRED decisions — it is a plan to review, not a decided spec. Every recommendation cites the V2.3.0 evidence it's based on.

The baseline stack from the release brief (NestJS/TypeScript, PostgreSQL, Redis, OpenSearch, Kafka, S3-compatible storage, Docker/Kubernetes/Terraform, OpenTelemetry/Prometheus/Grafana) is treated as the default and not re-litigated here except where V2 evidence argues for a specific deviation.

---

## 1. Service boundaries — evidence-based, not the brief's list verbatim

The brief lists ~20 candidate services and explicitly invites merging or splitting where evidence supports it. Cross-referencing all 10 domain reports, the real coupling found argues for **12 services**, not 20:

| # | Service | Folds in | Why |
|---|---|---|---|
| 1 | **identity-service** | Auth (OTP, phone identity, RBAC, sessions), Business-account approval status | Phone-as-identity resolution, OTP, and RBAC are one cohesive concern in V2 (`beauclick-auth`). B2B's own agent recommended folding "business account approval" here rather than into Commerce, since it's a single approval-status *fact* other domains query, with no pricing/order logic of its own. |
| 2 | **provider-service** | Professional profiles, Business profiles, Verification, Business staff | These are one plugin in V2 (`beauclick-marketplace`) sharing one verification state machine across both professional and business provider types, plus a staff sub-feature scoped to business providers only. No evidence found of a boundary that would benefit from splitting professional vs. business. |
| 3 | **search-service** | Search index (OpenSearch), Ranking read-side | V2's `wp_bc_provider_index` + `RankingPresenter` is a read-model fed by domain events (provider edited, review submitted, booking completed) — exactly the shape a dedicated search service should have. Ranking's *scoring algorithm* is DIRECT-REUSE-classified; only its trigger/storage mechanism needs replacing. |
| 4 | **booking-service** | Booking, Availability, Rescheduling, Waitlist, CRM notes, Reminders/Rebooking/Retention scheduling, Ranking signal collection | All one plugin in V2 (`beauclick-booking`) with real internal coupling (e.g. rescheduling reuses booking's exact claim/CAS logic; ranking signal collection deliberately lives here because it joins events back through `provider_id`). CRM notes stay here at launch — narrow scope (a provider's own booking-derived customers) doesn't justify a separate service; revisit if that scope grows. |
| 5 | **commerce-service** | Cart, Order, Pricing engine (Campaign discount + Membership discount + B2B tier pricing as pricing-rule providers), B2B quote-to-order conversion | See §2 below — this is the single most consequential merge decision in this plan. |
| 6 | **payment-service** | Payment intent/initiation/callback/verification, refunds | Provider-abstracted per the SMS/AI pattern (§4). Explicitly decoupled from Financial (the brief's own Phase 8 mandate, and V2 evidence: Financial listens to payment *events*, never calls into payment code). |
| 7 | **financial-service** | Ledger, Settlement | Kept maximally isolated — this is the highest-stakes, most sensitive domain found in the whole discovery pass (money, cross-professional isolation). Does not share a service with Commerce or Payment despite reading their events, precisely so its append-only/audit properties can be enforced at the database-role level without any other service's write path sharing that boundary. |
| 8 | **loyalty-service** | Loyalty ledger, Tiers, Benefits, Membership | Loyalty's own agent found `TierMembershipSync` and `BenefitService` to be real, frequently-firing, in-process couplings between tiers/benefits and membership state — splitting Membership out would turn a same-transaction operation into a network call for zero isolation benefit, since Membership has no independent billing/scaling need yet. |
| 9 | **referral-service** | Referral codes, attribution, qualification | Kept separate from Loyalty — it has its own data model and lifecycle, and only *calls* Loyalty's ledger through an already-decoupled `award()`/`has_awarded()` boundary. This is the one case where V2's existing plugin boundary is already correctly drawn for V3. |
| 10 | **notification-service** | Dispatch, preferences, delivery log, (new) in-app center | Provider-abstracted (SMS/email/push) per §4. |
| 11 | **analytics-service** | Metrics computation, event ingestion | Owns the *formal* event store (see `V3_EVENT_CATALOG.md`) that V2 never had. Single source of truth for a given metric — both AI insights and dashboards must read the same computation, never two engines (a discipline V2 already got right and V3 must not regress on). |
| 12 | **ai-service** | Customer discovery assistant, Professional insights assistant | Provider-abstracted per §4, with a strict two-stage authorization model (§5) — never given direct database access to any other service's data. |

**privacy** is deliberately **not** a service with its own domain data — see §3.
**admin** is deliberately **not** a service — see §3.
**SEO** has no service recommendation yet; Phase 2 didn't cover it (flagged in Gap Register and Migration Matrix). Needs a dedicated discovery pass before this plan can make a real recommendation — likely a thin concern spread across `provider-service` (structured data) and the frontend (meta tags/sitemaps), not a standalone service.

### What this rejects, and why
The brief's illustrative list separately named `professional-service`/`business-service`, `crm-service`, `membership-service`, and an implicit `b2b-service`. Each is evidence-based REJECTED as its own service:
- **professional-service + business-service → merged** (provider-service): one plugin, one verification state machine, shared CPT infrastructure in V2.
- **crm-service → folded into booking-service**: CRM notes' only consumer is a provider's own booking-derived customer list; no independent lifecycle.
- **membership-service → folded into loyalty-service**: real, frequent, in-process coupling found (`TierMembershipSync`).
- **b2b-service → split**: business-account approval → identity-service; tier pricing + quotes → commerce-service (pricing-rule providers). No B2B-specific data survives as an independent bounded context once approval and pricing are pulled out — what's left (the quote *request* record itself) is thin enough to live inside commerce-service's own order-adjacent tables.

---

## 2. Commerce pricing engine — the highest-leverage design decision

**REQUIRED.** V2's own architecture documentation flags "uncoordinated WooCommerce price-modifying hooks" as its single most-recurring integration risk, named independently by three different domain agents (B2B, Campaigns/Financial, Loyalty/Referral) without prompting each other. The concrete evidence:

- Campaign discount and Membership discount both hook the exact same extension point (`beauclick/booking/after_create`) at explicit, coordinated priorities (payments' order creation at 10, Membership at 20, Campaign at 30), both compute independently against the *same* pre-discount subtotal, and deliberately never compound.
- B2B's tier pricing hooks two *different* WooCommerce cart filters (`woocommerce_add_to_cart_validation`, `woocommerce_before_calculate_totals`) with no coordination contract with Campaign/Membership at all — they only don't collide today because B2B orders and booking orders are structurally different code paths.
- The B2B quote-acceptance path bypasses all of this entirely (creates an order via `wc_create_order()` directly), which is exactly why B2B quotes get **zero** campaign/discount integration today (a confirmed, named gap).

**Decision**: V3's `commerce-service` owns one pricing engine with a single, ordered chain of pricing-rule providers (Campaign, Membership discount, B2B tier pricing, and any future rule) evaluated against one canonical order/cart representation, not three independently-hooked WordPress plugins each assuming they're the only thing touching the total. This closes the B2B-quotes-bypass-campaigns gap by construction (all order creation — booking, B2B quote acceptance, direct shop purchase — goes through the same entry point) and gives V3 a single place to enforce a coordination contract (ordering, compounding rules, minimum-floor clamping) instead of three ad hoc hook registrations.

---

## 3. Cross-cutting concerns that are NOT separate services

### 3a. Privacy — a thin orchestrator, not a data owner
**REQUIRED**, evidence-based directly from V2's own design, which the notifications/privacy discovery pass confirmed is *already* structured this way: `beauclick-privacy` never touches another domain's tables directly — it calls each domain's own `forget_user()`/`export_for_*()` method. Its only genuinely-owned data is a request-lifecycle table (pending→approved→processing→completed/blocked/rejected/cancelled) plus export artifacts.

V3 should formalize this as a **typed contract every service must implement and self-register** (`ExportSubjectData(userId)`, `EraseSubjectData(userId)` — both idempotent), with `privacy-service` iterating a registry rather than hardcoding a call list. This directly closes a real V2 incident: the AI service's professional-mode conversation tables had **zero** export/deletion coverage until caught in a follow-up audit (`PRIV-06`) — a hardcoded call list has a structural blind spot every time a new data-owning service ships; a self-registering contract does not.

The retain/anonymize/delete decision matrix per domain (e.g., referral rows are deliberately never touched on deletion, to protect the referrer's earned reward and close a delete→recreate→re-earn loophole; WooCommerce order billing snapshots are retained pending legal review) is real, hard-won product/legal reasoning — carry it forward verbatim as business rules, re-validated against V3's actual data model.

### 3b. Admin — a capability model + a shared audit contract, not a service
**REQUIRED.** No V2 evidence supports a standalone admin service — `bc_manage_platform` (and two narrower capabilities, `bc_moderate_verification`/`bc_moderate_reviews`) gates pages *across* every domain, not a separate admin domain's own data. What V3 needs instead:

1. **A shared RBAC/capability check**, callable from every service (see `V3_SECURITY_MODEL.md`).
2. **A shared, structurally-mandatory audit-logging contract.** This is not a nice-to-have: the identical bug — a REST-reachable, capability-gated mutation silently skipping the audit-log call its admin-UI equivalent made — was found and fixed **three separate times** across two different V2 plugins (B2B account approval, B2B quote pricing, Loyalty tier/plan/benefit CRUD), with one instance (`B2BController::set_tiers`) still open and unfixed as of `v2.3.0`. V2 already solved the *analogous* problem for authorization (`RestController::route()` throws at registration time if a route lacks a `permission_callback`) — V3 should apply the identical enforcement shape to audit logging: a capability-gated mutation that doesn't emit an audit record should fail to register, not silently ship.
3. **One append-only audit log**, deliberately separate from the analytics event store (mixing private administrative actions into analytics aggregates would either leak them or force every analytics query to filter them back out — V2 already made this separation correctly; preserve it).

### 3c. SEO — deferred pending its own discovery pass
Not investigated in Phase 2. Flagged in `V3_GAP_REGISTER.md` as a required follow-up before this plan's service boundaries can be considered final for provider-service and the frontend.

---

## 4. The provider-abstraction pattern — one shape, reused everywhere

**REQUIRED**, and the single clearest "this generalizes" signal across the entire discovery pass: V2 independently built the *identical* shape — a one-method interface (`send()`/`chat()`), an immutable result value object, and an env-gated factory that falls through to a safe local/mock implementation when no real credentials are configured — **three separate times**, for SMS (`SmsProviderFactory`), AI (`ProviderFactory`, explicitly documented as "mirrors `SmsProviderFactory` exactly"), and again for the professional-AI variant (reusing the *same* env vars as customer AI, differing only in concrete provider class). The Payment domain's own gap register entry describes exactly this same target shape for a future gateway integration, just never built.

**Decision**: V3 ships one shared `Provider<TRequest, TResult>` abstraction (interface + factory + safe fallback) in a common package, and Payment, AI, and Notification-channel providers all implement it — rather than three independent implementations of the same idea, which is what V2 did by convention rather than by shared code. The **fail-safe-when-unconfigured** default (never error, never fabricate success with fake data, always degrade to a real, honest, clearly-labeled local implementation) is the specific property to preserve — it's what let this V2 environment's booking, payment, and AI flows all be genuinely live-QA'd with zero external credentials.

The **production-safety gate** pattern (`environment_type !== 'production'` before enabling any dev-only stand-in, defaulting closed) was found applied ad hoc in exactly two places in V2 (mock SMS logging, dev-only COD gateway) with no shared helper — **RECOMMENDED**: centralize this as one gate function every dev/mock provider implementation calls, rather than reinventing the check a third and fourth time.

---

## 5. Authorization pattern — session-derived ownership, verified pervasive

**REQUIRED**, confirmed true (not just claimed) across every domain checked: booking, financial, verification, B2B quotes, professional AI. Ownership is *always* resolved from the authenticated session (`current_user_id → owned-resource lookup`), *never* accepted as a client-supplied parameter — and where a route does accept a resource ID (e.g. cancel booking #41), the service layer re-checks real ownership independent of the route-level permission check. Two domains have adversarial tests proving forged parameters have zero effect (financial: forged `provider_id` never leaks another professional's ledger; AI: forged `provider_id` never leaks another professional's context) — this is exactly Phase 12's "never trust client-supplied ownership IDs" requirement, already largely satisfied in V2's *design*, just not in its *token mechanism* (see below).

**One real, confirmed gap to fix, not repeat**: V2 built a shared ownership-check helper (`RestController::require_owner_or_capability()`) specifically to centralize this pattern — and it is **dead code**, called nowhere in the entire codebase, because most real ownership in V2 is *indirect* (a booking is owned by a provider, which is owned by a user — not "a booking is owned by a user" directly) and the helper doesn't support that indirection. Every domain reimplements its own inline ownership gate instead. **Decision**: V3's shared ownership primitive must accept an owner-resolver (not just a raw owner ID), so indirect-ownership domains (booking→provider, quote→business-account, AI conversation→provider) can actually use the shared mechanism instead of each reinventing it.

Session/token mechanics themselves are pure **REIMPLEMENT** — V2 has no token infrastructure at all (plain WordPress cookie auth); only the authorization *rules* above are the contract V3's real JWT/refresh-token implementation must satisfy.

---

## 6. Database ownership

Per-service, no shared database, following the brief's mandate. Ownership assignments below map V2's tables (verified via migration files, not assumption) onto the 12 services from §1:

| Service | Owns (V2 equivalent → V3 target) |
|---|---|
| identity-service | `wp_bc_otp_requests`, `wp_bc_phone_index`, `wp_bc_phone_conflicts`, `wp_bc_business_accounts` (approval status only), RBAC role/capability assignments |
| provider-service | Professional/Business/Service/Portfolio entities (currently CPT/postmeta — becomes real tables), `wp_bc_verification_requests/_evidence/_history`, `wp_bc_business_staff`, `wp_bc_reviews` |
| search-service | Read-model only — `wp_bc_provider_index`-equivalent, rebuilt from provider-service + booking-service + reviews events, never a system of record |
| booking-service | `wp_bc_bookings`, `wp_bc_availability_slots`, `wp_bc_booking_reschedules`, `wp_bc_waitlist_entries`, `wp_bc_crm_notes` |
| commerce-service | Cart, Order, OrderItem, Pricing-rule application records, `wp_bc_b2b_price_tiers`, `wp_bc_quotes` (request/quote/accept lifecycle) |
| payment-service | Payment intents, provider callbacks/idempotency keys, refund records |
| financial-service | `wp_bc_ledger_entries`, `wp_bc_settlement_batches`, `wp_bc_settlement_items` — **the one service where DB-level immutability enforcement (revoked UPDATE/DELETE grants) is a hard requirement, not optional**, per the confirmed V2 gap that this guarantee is application-convention-only today |
| loyalty-service | `wp_bc_loyalty_points`, `wp_bc_loyalty_tiers`, `wp_bc_membership_plans`, `wp_bc_memberships`, `wp_bc_loyalty_benefits` |
| referral-service | `wp_bc_referral_codes`, `wp_bc_referrals` |
| notification-service | `wp_bc_notifications`, `wp_bc_notification_preferences` |
| analytics-service | The formal event store (replaces `wp_bc_events`) — see `V3_EVENT_CATALOG.md` |
| ai-service | `wp_bc_ai_conversations/_messages/_recommendation_events`, `wp_bc_ai_professional_conversations/_messages` — schema should resolve the confirmed "one thread per tenant, no history" limitation rather than re-adopting it unexamined |

`wp_bc_admin_audit_log` and privacy's request-lifecycle table are cross-cutting, per §3 — not owned by a domain service; likely a small shared platform service or a library every service links against, to be decided once V3's infra layer (Phase 16) is scoped.

**Cross-service reference discipline**: V2 deliberately never used foreign keys across plugin-owned tables (WordPress doesn't guarantee plugin activation order) — every reference is a plain indexed column. V3, as a single deployable set of services with a real migration order, **should** add real foreign keys *within* a service's own database, but cross-service references remain event-driven/ID-reference-only (no cross-database FKs), consistent with the brief's "avoid distributed transactions unless absolutely necessary" mandate.

---

## 7. What V2 got right and V3 must not regress on

Worth stating explicitly, since it's easy for a rewrite to "improve" something that was already correct:

1. **Discount/pricing is always computed server-side**, verified true in code (not just documented) across Campaign, Membership, and Financial's commission calculation — no client-supplied amount is ever trusted.
2. **A single source of truth per metric** — AI insights and analytics dashboards read the *same* computation, never two.
3. **Idempotency via real DB constraints**, not just application checks, for every financially-relevant write (ledger entries, campaign usage, loyalty points, waitlist entries) — confirmed to have actually absorbed real double-fire bugs in production-equivalent testing.
4. **The AI service has no direct database access** — only a curated, pre-authorized read-model context, output-validated before rendering.
5. **Ownership is always session-derived**, verified pervasive.

## 8. What V2 got wrong and V3 must fix, not port

1. Ledger append-only guarantee is convention-only (no DB enforcement).
2. Audit logging recurred as a missed-in-3-places bug class — needs structural (registration-time) enforcement.
3. `require_owner_or_capability()` — the shared ownership helper — is dead code because it can't express indirect ownership.
4. Booking→Order creation has no idempotency guard (self-heals today only by accident).
5. Campaign usage-cap enforcement has a confirmed, open TOCTOU race (`CAMP-03`).
6. No formal event contract exists — see `V3_EVENT_CATALOG.md`.
