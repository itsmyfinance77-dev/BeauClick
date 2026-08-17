# V3 Migration Matrix

Status: Phase 3 output. Synthesized from 10 parallel architecture-discovery passes over the V2.3.0 codebase (commit `c505c20`, tag `v2.3.0`), each of which read actual source + tests, not just documentation. Classifications follow the required taxonomy:

- **DIRECT REUSE** — port near-verbatim (pure logic/data with no framework coupling).
- **REFACTOR** — sound design, needs rework for the new stack/schema.
- **BUSINESS-RULE EXTRACTION** — the *rules* survive as a written spec/tests; the *code* does not (WordPress/WooCommerce-coupled).
- **TEST-SPEC REUSE** — the test suite itself is the valuable artifact (acceptance criteria), even where the implementation is discarded.
- **REIMPLEMENT** — new code needed; V2 has no reusable implementation, only (at most) a design lesson.
- **RETIRE** — do not carry forward, including as a pattern.

Every row cites the plugin(s) it was verified against. Where an agent's report is more nuanced than one label (nearly everywhere), the dominant classification is given with the split noted.

---

## Booking domain

| Component | Classification | Notes |
|---|---|---|
| Booking (hold/claim/cancel/confirm/no-show/expiry state machine) | **BUSINESS-RULE EXTRACTION** | Atomic-claim CAS discipline, hold/expiry semantics (15-min hold, 5 concurrent-hold cap), status-transition table are the core value. WordPress `$wpdb` plumbing is not. `beauclick-booking/src/Booking/BookingService.php`. |
| Availability (slot generation/overlap) | **DIRECT REUSE (rules) / REFACTOR (impl)** | Simple, well-tested rules (60-day bulk-gen bound, 10min–8hr slot range, idempotent re-run). Re-platform onto a real SQL backend with the same constraints. |
| Rescheduling | **BUSINESS-RULE EXTRACTION** | Max 2 reschedules, 6-hour minimum notice, same-provider/same-service-only scope, 4-step claim→move→release algorithm with rollback-on-failure. |
| Waitlist | **BUSINESS-RULE EXTRACTION** | "Offer, never reserve" invariant; FIFO batch-of-5, 30-min cooldown matching policy. Re-platform notification dispatch onto V3's own bus. |
| CRM notes | **REFACTOR** | Correct security model (dual ownership check) but in-PHP search/filter/pagination over a fully-fetched list is a scale ceiling — push into SQL/indexed search in V3. Currently embedded inside `beauclick-booking`, not a separate plugin. |
| Ranking (algorithm) | **DIRECT REUSE (algorithm)** | Bayesian-shrinkage rating average + cold-start blend + 7-signal weighted sum is pure, well-tested, framework-light logic (`beauclick-booking/src/Ranking/`). |
| Ranking (signal collection) | **REIMPLEMENT** | Reads 4 different tables including one with a confirmed schema inconsistency (`profile_view` event's `entity_type`) — rebuild cleanly, fix the inconsistency in the process. |
| Reminders / Rebooking / Retention schedulers | **BUSINESS-RULE EXTRACTION** (policy) + **RETIRE** (WP-Cron mechanism) | Window/interval/cap policies (23–25hr reminder window, 30-day rebooking interval, 60-day retention inactivity) are real, filterable, explicitly-provisional business rules. WP-Cron's request-triggered pseudo-cron must not carry forward — use a real job scheduler. |
| Booking REST contracts | **TEST-SPEC REUSE** | Ownership/ISS model (session-derived, double-checked at service layer) and error-code mapping are the right contract; tests are the executable spec. |
| BookingMailer | **RETIRE** | Direct `wp_mail()`, outside the unified notification-preference system by design. Revisit whether booking-lifecycle mail should join the unified notification service in V3. |

## Availability
See Booking domain above (same plugin, same agent pass).

## Rescheduling
See Booking domain above.

## Waitlist
See Booking domain above.

## Professional / Business (Marketplace)

| Component | Classification | Notes |
|---|---|---|
| Provider CPTs (`bc_professional`/`bc_business`/`bc_service`/`bc_portfolio_item`) | **REIMPLEMENT** | Entirely WP CPT/postmeta/taxonomy-based. Must become real domain tables with first-class columns (name, bio, owner_id, city_id, specialty_ids), not postmeta lookups. `beauclick-marketplace/src/PostTypes/Registrar.php`. |
| Verification state machine | **BUSINESS-RULE EXTRACTION** | 6-state machine (unverified/pending/verified/rejected/suspended/revoked), evidence-required-on-submit, reason-required-on-reject/suspend/revoke, mandatory audit trail. Deliberately made read-only via metabox in V2.1 after a bypass incident — carry that lesson forward too. |
| Verification schema (requests/evidence/history) | **REFACTOR** | Already a sound 3-table normalized design; repoint FKs at real tables, add real constraints (V2 omitted them only for WP cross-plugin-activation-order reasons that won't exist in V3). |
| Evidence storage | **BUSINESS-RULE EXTRACTION** (rules) + **REIMPLEMENT** (mechanism) | Randomized storage key (never derived from filename), content-sniffed MIME validation, per-request re-authorization on read. Filesystem+`.htaccess` becomes object storage + signed URL / authenticated stream in V3. |
| Search index (`wp_bc_provider_index`) | **BUSINESS-RULE EXTRACTION** (denormalization strategy) + **REIMPLEMENT** (mechanism) | The insight — flatten filterable/sortable attributes, resync on every relevant write — carries forward onto OpenSearch. The `$wpdb->replace()` implementation does not. |
| Text normalization (Persian/Arabic digit folding) | **DIRECT REUSE** | Pure function, zero WP dependency. |
| Business staff model | **REFACTOR** | Clean rules (owner-only management, upsert-on-re-add, single flat role) but deliberately narrow — wired into only 2 of 5+ ownership-gated surfaces today. V3 should design multi-role staff access from the start (see Gap Register PROF-07). |
| Reviews | **BUSINESS-RULE EXTRACTION** (rules) + **REFACTOR** (schema) | One review per completed booking (enforced twice — DB unique + app check), auto-approve-with-moderation, response-ownership-checked-against-target-not-author. Schema is already close to relational-clean. |
| Location hierarchy (province/city/district) | **DIRECT REUSE** | Already plain relational tables (`beauclick-locations`), zero CPT coupling — effectively already V3-shaped. |
| Portfolio management | **RETIRE** | Half-built: CPT registered and read, but **no write path exists anywhere** (no upload endpoint, no UI). Redesign from requirements in V3, don't port. |
| Admin verification review UI | **REIMPLEMENT** | Server-rendered wp-admin forms; the *workflow* is covered by the state-machine extraction above. |

## B2B

| Component | Classification | Notes |
|---|---|---|
| Business accounts (approval workflow) | **BUSINESS-RULE EXTRACTION** | Pending→approved/rejected state machine; "approval is a data fact queried at point-of-use, never a role/capability" principle. Recommend folding into V3's Identity/Accounts service, not Commerce. |
| Bulk price tiers | **BUSINESS-RULE EXTRACTION**, feeding Commerce's pricing engine | Quantity-break tier-matching is pure, well-tested logic; the WooCommerce cart-hook wiring is V2-specific. **Recommend becoming one pricing-rule provider inside Commerce's pricing engine**, not a separately-hooked bounded context — this is the single highest-recurrence architectural risk named repeatedly in V2's own docs (uncoordinated price-modifying hooks). |
| Quote request/accept workflow | **BUSINESS-RULE EXTRACTION** (state machine + ownership fix) + **REIMPLEMENT** (order conversion) | requested→quoted→accepted/expired lifecycle and the cross-business IDOR fix are real, tested value. `wc_create_order()` conversion must become a call through Commerce's single order-creation entry point — this also closes the "quotes bypass campaign discounts" gap by construction. |
| B2B test suite | **TEST-SPEC REUSE** | MOQ boundaries, tier-matching, double-accept prevention, cross-business IDOR — strong executable spec. |
| B2B admin pages | **REIMPLEMENT** | Classic wp-admin forms; functionally necessary workflow, not the code. |

## Commerce (replaces WooCommerce)

| Component | Classification | Notes |
|---|---|---|
| Booking→Order bridge | **BUSINESS-RULE EXTRACTION** | Pattern: booking creates a real Commerce order (never an ad-hoc fee), bidirectional FK, `pending` until payment. **Fix in V3**: V2 has no idempotency guard on order creation per booking_id — a real, confirmed gap (self-heals today only by accident via the auto-refund path). |
| Payment-status → booking-status glue | **BUSINESS-RULE EXTRACTION** | Canonical "payment succeeded" event distinct from generic status-changed noise; explicit dead-status set drives cancellation. |
| Paid-but-unconfirmable-booking auto-refund | **BUSINESS-RULE EXTRACTION** | A race between hold-expiry and payment completion must always auto-refund with an audit note — never silently keep the money. |
| Refund-on-cancel | **BUSINESS-RULE EXTRACTION** | Refund only the real "remaining" amount from the commerce system's own ledger, never independently computed; naturally idempotent via remaining-amount recheck. |
| Idempotency guard pattern for non-atomic webhooks | **DIRECT REUSE (pattern)** | `has_logged(event_type, entity_type, entity_id)` before acting — directly reusable design for any V3 payment-provider callback. |
| Receipt presentation | **BUSINESS-RULE EXTRACTION** | Read-only view over Commerce's authoritative order data, never a second price calculation; include discount/fee line items so totals self-explain. |
| My-orders listing | **BUSINESS-RULE EXTRACTION** | Always filter by session identity server-side, never accept a client-supplied customer id. |
| Currency/locale formatting (Toman, 0 decimals, Persian digits) | **BUSINESS-RULE EXTRACTION** | Real product requirements independent of framework. |
| WooCommerce-native pieces (WC_Order, coupons [unused], tax classes) | **RETIRE** | Must not be recreated under a different name per the release brief's own mandate. |
| Dev-only COD gateway | **REIMPLEMENT the safety pattern, not the gateway** | The `environment_type !== 'production'` fail-closed-by-default gate is the reusable invariant for any V3 mock/test payment provider. |

## Payment

| Component | Classification | Notes |
|---|---|---|
| Provider-agnostic gateway-swap property | **REIMPLEMENT as an explicit Payment provider abstraction** | V2's actual claim ("installing the gateway's own WooCommerce plugin is the entire integration surface") should become a literal `PaymentProvider` interface + factory, mirroring the SMS/AI provider pattern (see Security Model doc) — this is a direct architectural descendant, not a new invention. |
| Real Iranian gateway integration | **REIMPLEMENT — net new** | No real gateway was ever wired in V2 (ZarinPal merchant ID always empty). Nothing to port; only the target contract to honor. |

## Campaign

| Component | Classification | Notes |
|---|---|---|
| Eligibility rules (customer scope, usage caps, date range, targeting, min order value) | **BUSINESS-RULE EXTRACTION** | Well-specified, 44-test-covered, product-validated. Discount always computed server-side against the pre-discount subtotal — verified true in code, not just claimed. |
| Discount computation + no-compounding-with-Membership discipline | **BUSINESS-RULE EXTRACTION** | Both Campaign and Membership discounts compute independently against the same pre-discount base and stack additively as separate fee line items — never compound. This ordering (payments priority 10 → membership 20 → campaign 30) is a real, load-bearing contract. |
| Usage tracking / idempotency | **DIRECT REUSE (pattern)** | `UNIQUE(booking_id)` + insert-first is the correct shape; **fix CAMP-03** (a confirmed, open TOCTOU race on usage caps) in the V3 reimplementation rather than carrying it forward. |
| Campaign engine as a bounded context | **Recommend folding into Commerce's pricing engine** | Same reasoning as B2B tier pricing — one pricing-rule provider among several, not a separately-hooked service, to avoid re-introducing the uncoordinated-price-hook risk V2's own architecture doc flags repeatedly. |
| Admin UI | **REIMPLEMENT** | Workflow (draft→active→paused→archived lifecycle, admin form) is reasonable to reimplement against; code is not portable. |

## Financial

| Component | Classification | Notes |
|---|---|---|
| Commission ledger (computation, append-only log) | **DIRECT REUSE (business rules) / REFACTOR (implementation)** | Formula, exact-sum split discipline, refund-reverses-using-the-*original*-captured-rate (never live config) — all verified real in code, all must be preserved close to verbatim as business rules. |
| Ledger append-only guarantee | **REFACTOR — harden** | Confirmed **application-convention only today** (no DB trigger/permission lockout prevents UPDATE/DELETE). V3 must add real DB-level enforcement (e.g. a Postgres role with UPDATE/DELETE revoked, or an insert-only table + read model). |
| Idempotency (`UNIQUE(entry_type, reference_type, reference_id)`) | **DIRECT REUSE (pattern)** | Real DB constraint, not app-only — confirmed by a documented real double-fire bug it silently absorbed. |
| Settlement (batch/item recording, reversal, outstanding computation) | **DIRECT REUSE (business rules) / REFACTOR (implementation)** | Settle specific orders in full at system-computed amounts, non-destructive reversal, always-fresh-computed outstanding (never cached, can legitimately go negative post-refund and stays honest about it). Natural insertion point for the payout/disbursement integration V2 explicitly deferred. |
| Cross-professional isolation | **DIRECT REUSE (pattern), REFACTOR (enforcement point)** | Verified real at the REST boundary (adversarially tested), but **not enforced at the data-access-layer itself** — a future V3 caller that skips the gated controller would not be isolated by the service layer alone. Close this gap in V3. |
| Financial admin UI | **REIMPLEMENT** | wp-admin/admin-post specific. |

## Loyalty

| Component | Classification | Notes |
|---|---|---|
| Points ledger, tiers, benefits | **REFACTOR** | Clean, well-isolated, DB-idempotency-enforced (`UNIQUE(reference_type, reference_id, reason)`, NULL-safe). Strongest direct-reuse candidate of the three loyalty sub-domains; downgraded from DIRECT REUSE only for its two WooCommerce-order touchpoints and cross-plugin raw-table reads. |
| Point values / tier thresholds | **BUSINESS-RULE EXTRACTION** | Explicitly provisional (10pts/booking, 5pts/review, etc.) — needs real business sign-off, not blind porting. |
| Loyalty test suite | **TEST-SPEC REUSE** | The two named idempotency tests and tier-boundary tests encode subtle invariants worth porting as acceptance criteria. |

## Membership

| Component | Classification | Notes |
|---|---|---|
| Membership state (active/expired/cancelled) + tier-linked auto-activation | **REFACTOR** | **Recommend merging into one `loyalty-service`** with Loyalty proper — `TierMembershipSync` is a real, frequently-firing bidirectional dependency; splitting would turn an in-process call into a network call for no isolation benefit, since membership has no independent deploy/scaling need today. |
| Real recurring billing | **REIMPLEMENT — net new** | Never built in V2 (manual admin grant only); only the target `activate(user, plan, source, actor)` contract to preserve. |

## Referral

| Component | Classification | Notes |
|---|---|---|
| Attribution / qualification / reward | **BUSINESS-RULE EXTRACTION** | First-completed-booking-OR-first-completed-order qualification rule, 50/50 reward split (explicitly provisional), self-referral-prevented-by-construction. |
| Referral as a bounded service | **Recommend keeping separate from `loyalty-service`** | Unlike Membership, Referral has its own data model and lifecycle, and only *calls* Loyalty's ledger (`award()`/`has_awarded()`) — an already-decoupled, API-shaped boundary. |
| Cookie-based attribution mechanism | **REFACTOR** | Raw `$_COOKIE` read is fine for a WP monolith; V3's registration flow needs an explicit attribution-code parameter or first-party mechanism. |
| Referral test suite | **TEST-SPEC REUSE** | Self-referral-prevention, replay-prevention, idempotent-qualify tests are strong acceptance criteria. |

## CRM
See Booking domain (CRM notes are embedded in `beauclick-booking`, not a separate plugin). **Recommend keeping CRM as a bounded module within `booking-service` at V3 launch** — current scope (a provider's own booking-derived customer list) doesn't justify a separate service; revisit if scope grows beyond booking-linked customers.

## Notifications

| Component | Classification | Notes |
|---|---|---|
| Dispatch/idempotency core | **REFACTOR** | Insert-before-dispatch idempotency (`{template}:{entity_type}:{entity_id}:{user}:{channel}`), opt-out preference model, transient-vs-permanent retry classification — all worth preserving as rules. |
| Real channel delivery (SMS/email/push) | **REIMPLEMENT — net new** | SMS has **never been exercised against a real provider** in any environment (mock only); no push channel exists at all. Treat as genuinely new work. |
| Provider-abstraction pattern | **DIRECT REUSE (pattern)** | Reuses the identical `SmsProviderFactory`/`SmsProvider`/`SmsResult` shape as Auth's OTP delivery — confirmed literally the same classes, not a parallel implementation. |
| Notification dispatch model (synchronous, no queue) | **Revisit, don't blindly port** | Was right-sized for WP-Cron-era "real but low volume." A standalone V3 service is a natural point to introduce a real queue if reliability/volume requirements have changed. |
| In-app notification center (bell/unread count) | **REIMPLEMENT — net new** | Only a backend history list exists in V2; no UI. |

## Privacy

| Component | Classification | Notes |
|---|---|---|
| Data-subject-request lifecycle (export + deletion) | **DIRECT REUSE (state machine)** | pending→approved→processing→completed / blocked/rejected/cancelled, single-table-for-both-request-types shape — generic, portable "data subject request" plumbing independent of BeauClick's specific domains. |
| Domain-by-domain retain/anonymize/delete matrix | **BUSINESS-RULE EXTRACTION** | Genuine, hard-won product/legal reasoning (e.g. referral rows untouched to protect referrer rewards and close a delete-recreate-re-earn loophole; WooCommerce order billing snapshot retained pending legal review). Preserve verbatim. |
| "Thin orchestrator calling each domain's own contract" architecture | **DIRECT REUSE (pattern) — formalize** | Privacy already never touches another domain's tables directly in V2; it calls each domain's own `forget_user()`/`export_for_*()`. **V3 should make this a first-class typed contract every service implements and self-registers**, not a hardcoded call list — PRIV-06 (a real data domain silently missed until caught after the fact) is direct evidence the hardcoded-list approach has a structural blind spot. |
| OTP-gated deletion confirmation | **DIRECT REUSE (pattern)** | Reuses the exact same OTP service as login — no second re-authentication mechanism needed. |
| Admin review gate (no instant self-execution) | **BUSINESS-RULE EXTRACTION** | Real product decision to preserve, whatever V3's admin surface becomes. |

## Analytics

| Component | Classification | Notes |
|---|---|---|
| Metric definitions (funnel, commerce, search, retention, referral, per-provider) | **BUSINESS-RULE EXTRACTION** | Real, live-computed (not cached) definitions with a shared range-safety rule (366-day cap, reversed-range swap). |
| "One shared read-model, never two calculation engines" discipline | **DIRECT REUSE (pattern)** | AI insights and Analytics dashboards read the *same* `MetricsService` output in V2 — this discipline (a single source of truth for a given metric) must carry forward explicitly, not be allowed to drift into two engines in V3. |
| Underlying event log (`wp_bc_events`) | **REIMPLEMENT as a formal, versioned event store** | Confirmed today: free-text `event_type`, unvalidated `meta` JSON blob, no schema, no versioning — see Event Catalog doc. |

## AI

| Component | Classification | Notes |
|---|---|---|
| Provider abstraction (interface + factory + safe local fallback) | **DIRECT REUSE (pattern)** | Confirmed already replicated once in V2 (customer-mode → professional-mode) with zero interface changes — strong evidence it generalizes to a TS port with the same shape. |
| Two-stage authorization/curation (session-derived identity → curated read-model context, never raw DB access) | **DIRECT REUSE (pattern)** | The AI provider never sees more than a pre-aggregated, pre-authorized JSON slice assembled from already-scoped domain services. This is the concrete mechanism satisfying the "AI must never receive unrestricted database access" requirement — verified adversarially (forged provider_id params proven to have zero effect), not just claimed. |
| Output-validation-never-trust-the-model layer | **DIRECT REUSE (pattern)** | Every model-claimed recommendation ID is re-checked against real DB rows before rendering. |
| Rule-based (non-LLM) fallback | **BUSINESS-RULE EXTRACTION (concept)** | Deterministic, data-grounded fallback when no provider is configured is worth keeping as a concept; the Persian-keyword matching implementation itself is throwaway. |
| One-thread-per-tenant limitation | **Revisit, don't re-adopt** | A deliberate V2 scope-narrowing choice, not a design goal — V3 should decide fresh whether conversation history/multi-thread is in scope. |
| Safety guards (medical-concern gate, injection-phrase blocklist, length cap) | **BUSINESS-RULE EXTRACTION (concept)** | The gate types are real product/safety requirements; the hardcoded Persian phrase lists need re-auditing, not mechanical porting. |

## Search

| Component | Classification | Notes |
|---|---|---|
| Denormalized search-index strategy | **BUSINESS-RULE EXTRACTION** | Flatten filterable/sortable attributes into one resynced table — the *idea* carries forward onto OpenSearch. |
| Free-text matching (`LIKE '%term%'`) | **RETIRE** | No fuzzy/typo-tolerance; explicitly flagged as an accepted-but-real tradeoff in V2. V3's OpenSearch migration is a genuine improvement, not a port. |
| Ranking (see Booking domain) | **DIRECT REUSE (algorithm)** | Cross-referenced above. |

## SEO

**Not yet covered by this discovery pass.** None of the 10 domain agents were scoped to investigate SEO handling (meta tags, structured data/JSON-LD, sitemaps, canonical URLs, Persian-slug behavior). This is a real gap in Phase 2, not a finding that SEO doesn't matter — flagged in the Gap Register as a required follow-up before Phase 4 architecture is finalized for the storefront/marketplace-facing services.

## Frontend

| Component | Classification | Notes |
|---|---|---|
| Design tokens (`shared/design-tokens.json` + generator) | **DIRECT REUSE** | Already backend-agnostic plain JSON with zero WP coupling. |
| Design-system primitives (Button/Card/Chip/Badge/Modal/Input/etc.) | **DIRECT REUSE**, with **REFACTOR** to extend a11y coverage | Zero WP/REST coupling in the primitives themselves; only Modal has real axe-core a11y test coverage today — extend the pattern to the rest before calling the set "accessible." |
| Feature components (booking, cart, search, chat, notifications, dashboards) | **CASE-BY-CASE**, mostly REFACTOR at the data layer, DIRECT REUSE at UI/UX | Data-fetching is cleanly separated behind `api.ts`/`storeApi.ts`; swapping the API layer is the main surgery, not rewriting UI logic. |
| Mount-point architecture (`data-bc-*-trigger` + delegated click listeners) | **DROP** | Purpose-built solely for "React islands inside PHP pages that must work without React." A real SPA/Next.js app owns routing/composition and has no PHP template to signal into. Keep only the underlying idea (feature UI decoupled from its invocation site), re-expressed as router state or a shared UI store. |
| API client (`api.ts`) | **REFACTOR** | Envelope/`ApiError`/method-surface/error-message-hygiene patterns carry over; WP-permalink URL-quirk handling and nonce/`window.BeauClick`-global auth are replaced by JWT/session-token auth and a real base-URL config. `storeApi.ts` (WooCommerce Store API wrapper) is dropped wholesale. |

## Design System
See Frontend above.

## Persian / RTL / Jalali

| Component | Classification | Notes |
|---|---|---|
| Jalali calendar math (`jalali.ts`) | **DIRECT REUSE** | Pure integer y/m/d math, zero dependencies, verified against reference points + round-trip invariants. |
| Persian digit / date / currency formatting (`format.ts`) | **DIRECT REUSE** | Only import is `jalali.ts`; contains a documented, fixed real bug (digit-substitution ≠ calendar conversion) worth preserving as a regression test. |
| RTL enforcement (document-level `dir`, CSS logical properties, zero LTR branching) | **DIRECT REUSE (pattern)** | Correct approach for a Persian-only product; carries forward unchanged. |

## Authentication

| Component | Classification | Notes |
|---|---|---|
| OTP lifecycle (rate limits, cooldown, expiry, replay prevention, purpose-scoping) | **BUSINESS-RULE EXTRACTION** | All numeric constants are explicitly provisional but the *rules* (identical error for "expired" vs. "never requested," requester-scoping for sensitive purposes, immediate consumption on success) are the subtle, easy-to-regress part — extract with dedicated tests, not by memory. |
| Phone canonicalization | **DIRECT REUSE (near-verbatim)** | Pure function, zero WP dependency, trivially portable. |
| Phone-as-identity resolution (link-vs-create-vs-conflict) | **BUSINESS-RULE EXTRACTION** | The "never silently merge, always record and defer to a human on genuine ambiguity" invariant must be preserved explicitly even with a cleaner V3 schema. |
| Session/cookie auth mechanics | **REIMPLEMENT** | No token infrastructure exists in V2 at all (confirmed — no JWT library, nothing analogous). Build real session/refresh tokens per the release brief's Phase 12 mandate, using the business rules above as the contract to satisfy. |
| SMS provider abstraction | **DIRECT REUSE (pattern)** | See AI/Payment — same interface+factory+safe-fallback shape, confirmed reused 3× already (Auth OTP, AI, Notifications). |

## Authorization

| Component | Classification | Notes |
|---|---|---|
| RBAC/capability model (roles + granted capabilities) | **BUSINESS-RULE EXTRACTION** | The role set and capability grants are the real authorization model — extract as data. The "prefer capabilities over roles" and "operator tier below full admin" (`bc_platform_operator`, currently unused by any real account but present in code) principles carry forward. |
| "Never trust client-supplied ownership IDs" principle | **DIRECT REUSE (pattern) — confirmed pervasive** | Verified true everywhere checked (booking, financial, AI, B2B, verification) — always session-derived via a lookup, never a request parameter. |
| Shared ownership-check helper (`require_owner_or_capability`) | **REIMPLEMENT — fix, don't port** | Confirmed **dead code** — defined but never actually called; every domain reimplements its own inline ownership gate instead (often because ownership is indirect, e.g. booking→provider not booking→user, and the helper doesn't support that indirection). V3 needs one primitive flexible enough to actually get used. |

## Admin

| Component | Classification | Notes |
|---|---|---|
| Admin audit log (append-only, `previous_state`/`new_state`/`reason`) | **BUSINESS-RULE EXTRACTION** | Preserve the shape and the separation from the analytics event log. |
| Audit-logging enforcement model | **REIMPLEMENT — fix a confirmed recurring bug class** | The exact same bug (a REST-reachable admin mutation bypassing the audit call its wp-admin twin made) recurred **three independent times** across two plugins (B2B accounts, B2B quotes, Loyalty), with one instance (`B2BController::set_tiers`) still open as of V2.3.0. V3 should make audit-logging structurally mandatory for capability-gated mutations — the same way `permission_callback` is already enforced at route-registration time — not opt-in per handler. |
| Admin UI pages (wp-admin) | **REIMPLEMENT** | All 16 admin pages are WP-specific; the underlying capability model (13 gated on `bc_manage_platform`, 2 on narrower capabilities, 1 read-only metabox) is the real contract to reimplement against. |
