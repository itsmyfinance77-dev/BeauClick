# V3 Implementation Roadmap

> **Current-status note (2026-09-02):** This document is the preserved Phase 0
> sequencing plan. V3.0 and V3.1 were subsequently implemented, and V3.2-A through
> V3.2-C are engineering-complete. See the root README and version-specific roadmaps for
> current programme, release and production-enablement status.

Status: Phase 0 blueprint. **No implementation has started.** This document supersedes `V3_MIGRATION_PLAN.md` §5's phase grouping with this task's explicit phase structure (Phase 0-5) — the two are consistent in content and sequencing logic; this version is the authoritative one going forward. Where they differ (Journey's placement — see Phase 3 below), this document reflects the settled decision.

---

## Phase 0 — Architecture Foundation

**Goal**: produce and get explicit sign-off on the complete architecture/blueprint corpus before any code is written.

**Deliverables**: this entire document set — `V3_ARCHITECTURE_DISCOVERY.md`, `V3_MIGRATION_PLAN.md`, `V3_GAP_REGISTER.md`, `WORDPRESS_EXIT_MATRIX.md`, `V3_REPOSITORY_STRUCTURE.md`, `V3_DOMAIN_BOUNDARIES.md`, `V3_DATABASE_BLUEPRINT.md`, `V3_API_CONTRACT_BLUEPRINT.md`, `V3_EVENT_ARCHITECTURE.md`, `V3_FRONTEND_ARCHITECTURE.md`, `V3_INFRASTRUCTURE_PLAN.md`, this roadmap, and 16 ADRs (`ADR-001` through `ADR-016`).

**Dependencies**: none — this phase is self-contained discovery/design work.

**Risks**: stakeholder review surfaces a disagreement with a foundational decision (e.g. ADR-002's modular-monolith choice, or Journey's domain placement) late enough to require re-touching downstream documents — mitigated by this phase existing precisely to catch that before Phase 1 code depends on it.

**Acceptance criteria**: explicit sign-off recorded on every ADR; every `REQUIRED`-severity item in `V3_GAP_REGISTER.md` either resolved or explicitly deferred with an owner and date (not silently carried forward); the hosting-region decision (`V3_INFRASTRUCTURE_PLAN.md` §1) made; `GAP-10`'s provisional numeric policies given a real business sign-off pass or an explicit deferral decision.

---

## Phase 1 — Identity + Provider

**Goal**: the two highest-risk, most-depended-upon domains stood up on the target stack, with real authentication working end to end.

**Deliverables**:
- Repository scaffolded per `V3_REPOSITORY_STRUCTURE.md` (Nx + pnpm workspace, `apps/api` bootstrap, `libs/{auth,ownership,audit,http,events,testing}`, `packages/{design-tokens,persian-utils,provider-abstraction,event-contracts}`).
- `services/identity` — OTP lifecycle (rules extracted per `ADR-008`), JWT/refresh-token issuance, RBAC/capability model, device management, session revocation.
- `services/provider` — the CPT→relational re-platform (professional/business/service/portfolio as real tables), verification workflow, business staff, reviews, wishlist.
- Object storage wired for portfolio media + verification evidence (`WORDPRESS_EXIT_MATRIX.md` §10 — already cloud-storage-shaped, lowest-friction part of this phase).
- Locations + specialty reference data reseeded (`ADR-010` §2).
- `apps/web`'s `(public)` route group for provider profile pages (SSR, per `ADR-012`) — enough frontend to prove the loop end to end, not the full frontend.

**Dependencies**: Phase 0 sign-off; target Postgres hosting's role-grant capabilities confirmed (blocks Phase 2's financial-service prep, but should be verified now since it's cheap to check early).

**Risks**: the CPT re-platform is `V3_MIGRATION_PLAN.md`'s #1-ranked migration-difficulty item — highest-traffic read path, largest schema-shape change, WP's `map_meta_cap`/ownership machinery has no direct equivalent (`WORDPRESS_EXIT_MATRIX.md` §2). Mitigation: this is exactly why it's sequenced first, while the team's full attention is available, not discovered as a blocker mid-Phase-2.

**Acceptance criteria**: a real user can register via OTP, get a session (access + refresh token, revocable, device-listed), create a provider profile, get verified through the real workflow, and have that profile render on a real SSR page — live-tested end to end, not merely unit-tested. Adversarial ownership tests (`ADR-015`) pass for every identity/provider tenant-scoped endpoint.

---

## Phase 2 — Booking + Commerce + Payment + Financial

**Goal**: the core value loop — search→book→pay→confirm→complete→review — live end to end against a real (even sandbox) payment gateway, with the financial ledger correctly recording commission.

**Deliverables**:
- `services/booking` — hold/claim/cancel/confirm/no-show/complete state machine, rescheduling, waitlist, CRM notes, ranking signal collection (extracted rules per `V3_MIGRATION_MATRIX.md`).
- `services/commerce` — the single unified pricing-rule-provider chain (Campaign + Membership + B2B tiers, closing the uncoordinated-hook risk by construction, `ADR-001`/`V3_ARCHITECTURE_PLAN.md` §2), idempotent order creation on `(sourceType, sourceId)` (closes `GAP-03`).
- `apps/payment-service` — provider-abstracted gateway integration (`ADR-006`), one real Iranian gateway adapter, idempotent callback handling.
- `apps/financial-service` — commission ledger with real DB-level append-only enforcement (closes `GAP-01` for real, contingent on the Phase-1-verified hosting grants), `GAP-05`'s internal-identity-resolution pattern applied to every method from day one.
- `V3_EVENT_ARCHITECTURE.md`'s Booking/Commerce/Payment/Financial events wired through the transactional outbox (`V3_DATABASE_BLUEPRINT.md` §7).
- `apps/web`'s `(app)` route group for the booking flow and receipt/order-history views.

**Dependencies**: Phase 1 (provider identity must exist for a booking to reference; identity's JWT/ownership-resolver infrastructure is reused directly, not rebuilt).

**Risks**: (1) `beauclick/booking/after_create`'s implicit priority-ordering not translating cleanly to an explicit pricing chain — mitigation: port the 44-test Campaign suite + Membership/Campaign no-compounding tests as the acceptance spec, per `ADR-015`, before considering the new engine done. (2) Payment gateway integration has zero V2 precedent — first real-money code path in the project's history; budget it as new-feature engineering with its own sandbox-test cycle, not migration effort.

**Acceptance criteria**: a real booking flows through hold→confirm→pay (sandbox gateway)→complete→review; a forged cross-tenant `provider_id`/`orderId` parameter test suite passes for every endpoint in this phase (`ADR-015`); the ledger's append-only guarantee is verified at the database-role level, not merely application-level; a duplicate webhook delivery produces no duplicate order/payment/ledger entry.

---

## Phase 3 — Search + Loyalty + Journey

**Goal**: the marketplace's real discovery experience (OpenSearch-backed, typo-tolerant) plus the retention/engagement domains.

**Deliverables**:
- `services/search` — OpenSearch index, reindex triggers wired to `ProfessionalVerified`/`ReviewCreated`/`BookingCompleted`/`AvailabilityPublished` events, Persian/Arabic-Indic digit normalization, the `profile_view` `entity_type` schema-inconsistency fix applied before data enters the new index (closes `GAP-14`/`GAP-15`).
- `services/loyalty` — points/tiers/membership (merged, per `V3_ARCHITECTURE_PLAN.md` §1), mandatory audit-logging on every admin mutation from day one (the domain with V2's still-open `GAP-02` instance — must not recur).
- `services/referral` — attribution/qualification/reward, kept separate from loyalty per its own decoupled boundary.
- `services/journey` — **its own independent module**, per this task's explicit domain list, settling `GAP-29` (see the updated Gap Register). Beauty profile, goals, timeline, and the one-way `inferAiDefaults()` seam into `services/ai` (built in Phase 5, but the seam's contract is fixed now so Phase 5 doesn't need to renegotiate it).
- `apps/web`'s marketplace search UI (replacing the Phase-1 placeholder listing) and journey/loyalty dashboard tabs.

**Dependencies**: Phase 1 (provider-service data to index), Phase 2 (booking/order-paid events to react to).

**Risks**: Persian-specific search relevance/typo-tolerance needs explicit QA time, not assumed correct out of OpenSearch's default configuration (`V3_MIGRATION_PLAN.md` §6). Journey's boundary, now settled by this task's explicit direction rather than an independent evidence review, should still get a lightweight sanity check during this phase's design (does the "own module, thin AI seam" shape actually hold once real implementation starts) — not reopened as a live question, but not assumed risk-free either.

**Acceptance criteria**: marketplace search returns typo-tolerant, Persian-normalized results with correct faceting; loyalty tier/plan/benefit admin mutations are 100% audit-logged (verified by a structural test, not spot-checked); journey's profile/goals feed AI-discovery defaults correctly once Phase 5 lands (contract-tested now, integration-tested then).

---

## Phase 4 — Notification + Analytics + Admin

**Goal**: real multi-channel notification delivery (net-new — V2 never exercised a real SMS/email/push provider), the formal event-store-backed analytics platform, and the admin application.

**Deliverables**:
- `services/notification` — real SMS/email/push channel adapters (provider-abstracted, `ADR-003`'s shared package), in-app notification center (net-new), preferences/opt-out model preserved.
- `services/analytics` — the formal, versioned event store (`analytics.event_store`, replacing `wp_bc_events`), `MetricsService` as the one shared computation every dashboard/AI call reads (never two engines — the discipline V2 already got right, preserved not regressed).
- `admin`/`privacy` cross-cutting — `libs/audit`'s structural enforcement live for every module by this point (retroactively verified against Phases 1-3's already-shipped mutations, not just new ones going forward), `apps/admin` composing every module's admin routes (the 16-screen wp-admin equivalent), privacy's self-registering `exportSubjectData`/`eraseSubjectData` contract implemented by every module that owns user data.

**Dependencies**: every event this phase's analytics consumes was defined in Phases 1-3; notification-service's `NotificationRequested` producers already exist from Phase 2 onward (they were calling a stub/direct-call path until this phase's real channels land).

**Risks**: real SMS/email/push provider integration is, like payment, net-new engineering with no V2 precedent to lean on — budget accordingly, sandbox/test-account-test extensively before any real message sends. Admin app scope (16 screens' worth) is real UI effort; sequence the highest-operational-value screens first (verification queue, financial settlement, audit log) if time pressure forces a partial launch.

**Acceptance criteria**: a real SMS/email/push notification is delivered end to end in at least one sandbox/test environment per channel; the admin app can perform every `bc_manage_platform`-equivalent action V2's wp-admin could; a self-service data export/deletion request completes end to end across every module that owns user data (verified by checking no module was missed — the exact `PRIV-06` blind-spot class this phase's self-registering contract exists to prevent).

---

## Phase 5 — AI + Advanced Capabilities

**Goal**: the customer and professional AI assistants, live against a real provider, with the two-stage authorization/curation model proven adversarially.

**Deliverables**:
- `services/ai` — provider abstraction (`ADR-003`'s shared package, the third implementation of the same proven shape), two-stage authorization/curation (session-derived identity → curated context assembly, never raw DB access), output-validation-before-render, safety guards (medical-concern gate, injection blocklist, length cap) re-audited fresh rather than mechanically ported.
- `journey.inferAiDefaults()` seam wired live (contract fixed since Phase 3).
- `GAP-12`'s one-thread-per-tenant limitation explicitly revisited — a real product decision (keep single-thread, or support conversation history) made and implemented, not silently re-adopted.
- Advanced capabilities not yet scoped elsewhere in this roadmap (e.g. availability-aware ranking if adopted, per `V3_EVENT_CATALOG.md`'s `AvailabilityPublished` optional-consumer note) — evidence-gated, not built speculatively.

**Dependencies**: Phase 1 (identity/provider for context), Phase 3 (journey, analytics for usage tracking), Phase 4 (analytics's `MetricsService` as the one source of truth AI insights must read, never a second engine).

**Risks**: real AI-provider reachability from the chosen hosting region (`V3_INFRASTRUCTURE_PLAN.md` §10) is a precondition, not something this phase resolves — if `V3_INFRASTRUCTURE_PLAN.md` §1's hosting decision left this unresolved, it blocks this phase specifically, exactly as `ARCHITECTURE_PROPOSAL.md` §27 originally flagged for V1/V2.

**Acceptance criteria**: a real AI conversation (against a real provider, not only the rule-based fallback) completes end to end for both customer and professional modes; adversarial forged-`providerId` tests (`ADR-015`) prove zero cross-tenant leakage, matching V2's own proven bar; every AI-claimed recommendation ID is independently re-verified against real data before rendering.

---

## Cross-references
- `V3_MIGRATION_PLAN.md` §5 — the prior phase grouping this document supersedes (content-consistent, different phase boundaries).
- `V3_GAP_REGISTER.md` — every gap cited above.
- All 16 ADRs (`docs/roadmap/v3/adr/`) — the decisions each phase's deliverables implement.
