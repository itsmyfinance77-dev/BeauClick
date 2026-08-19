# BeauClick — Product Gap Register

**Document status:** Master discovery register — audit-only, no implementation.
**Audit date:** 2026-08-12.
**Commit audited:** `af4b8d7` (`master`), the latest V2.1 Step 5 (Professional CRM) commit.

---

## 1. Audit Scope

Every category listed in the audit brief (§5 A through §30), covering V1 (frozen at `v1.0.1`), V2.0 (frozen at `v2.0.0`), and the current V2.1 state (Step 5 CRM, `af4b8d7`) as they exist **today**, on the real running codebase and a real seeded database — not as the roadmap describes an eventual end state.

## 2. Versions Audited

| Line | Tag/commit | State |
|---|---|---|
| V1 | `v1.0.0` → `v1.0.1` | Frozen, immutable |
| V2.0 | `v2.0.0` (`67325b5`) | Frozen, immutable |
| V2.1 | `af4b8d7` (Step 5 — CRM) | Active development, `master` |

## 3. Methodology

Per §27's own required discipline — not source-reading alone:

1. **Code inspection** — every `beauclick-*` plugin's `src/`, the theme, the React app-shell.
2. **Database inspection** — direct `mysql` queries against the real dev database (`wp_options`, `wp_posts`, event-log coverage via source, not assumption).
3. **Live browser inspection** — reused verified state from this session's V1.0.1, V2.0, and V2.1-CRM live QA passes (real accounts, real bookings, real reviews, real chat history) rather than re-deriving from scratch.
4. **Error-path inspection** — reviewed what each REST controller returns for unauthenticated/unauthorized/invalid-input requests.
5. **Permission inspection** — `RestController::require_login/require_capability/require_owner_or_capability`, `ProviderLookup`, ownership boundaries already established across V1/V2.0/V2.1.
6. **Documentation comparison** — this register cross-checks the roadmap's own aspirational descriptions (§17–§21 of `BeauClick_Version_2_Roadmap.md`, the "Definition of Done") against what the live system actually does, not what a class name implies.

No fabricated flows. Every "MISSING" item below was confirmed by an actual absence (no matching code, no matching route, no matching DB row/option), not inferred from silence.

---

## 4. Executive Summary

BeauClick's core value loop — discovery → AI recommendation → booking → payment → review → loyalty → journey → CRM — is real, tested, and live-verified end to end, and V1/V2.0/V2.1-Step-5 are each individually solid within their own stated scope. This audit's job was to look *around* that loop for what nobody has had reason to look at yet.

The single most important, previously-unflagged discovery: **`users_can_register` is `0` and both WooCommerce self-registration switches are `no` — there is currently no way for a new customer to create an account on this platform at all.** Every account used in every prior verification session (`bc_qa_customer`, the demo professionals, etc.) was created directly via `wp-cli`, never through a real signup flow, because no real signup flow exists. This has been true since V1 and was never caught because every QA session already had accounts to log into.

Closely related: BeauClick has **no phone/OTP authentication, no dedicated branded login/register UI, and no SMS gateway integration at all** — every login (customer, professional, business, admin) goes through unmodified `wp-login.php`. It is correctly Persian (confirmed in the V1.0.1 audit) but is visually and structurally the default WordPress screen, not a BeauClick experience, and there is no path to it other than knowing the `/wp-login.php` URL.

A second, independently serious discovery: of the platform's legal/trust pages, **Privacy Policy and Refund/Cancellation Policy exist only as WordPress *drafts*** (never published, never linked from anywhere a user would see), and **no Terms of Service, FAQ, Contact, or About page exists at all.** A public commerce site is currently live with no reachable legal disclosure.

Beyond those two, this audit found real (not hypothetical) gaps in professional verification (status is a manual admin toggle with no supporting document/evidence upload), account privacy (no self-service data export or account deletion anywhere), SEO (no meta tags, sitemap, or structured data on any public page), operations (no backup, no health check, no error-monitoring integration), and one concrete UX-terminology inconsistency (`نوبت` and `رزرو` are both used for "booking" across the same feature set, twelve and nine times respectively, with no evident rule for which applies where).

None of this contradicts prior work — V1.0.1's Persian/Jalali audit, V2.0's four steps, and V2.1's CRM are all still correctly scoped and correctly built for what they set out to do. These are gaps in categories nobody had been asked to look at yet, which is exactly this audit's purpose.

---

## 5. Product Completeness Scorecard

| Area | Completeness | Notes |
|---|---|---|
| Marketplace discovery & booking | 90% | Core loop solid; no waitlist/reschedule UI yet (documented deferrals) |
| Commerce (WooCommerce) | 75% | Checkout/payment/refund-hook solid; no invoice PDF, no coupons configured, legal pages unpublished |
| **Authentication & account creation** | **25%** | **No registration path, no OTP, no branded UI — see §8 below** |
| AI discovery | 90% | Grounded, safety-gated, provider-agnostic; no cost/usage visibility |
| Ranking | 95% | Explainable, tested, privacy-safe |
| Beauty Journey | 90% | Real, isolated, Jalali-correct; no goal deletion |
| Professional CRM | 85% | Real, isolated, tested; no staff-permission model, no note editing |
| Persian/Jalali/RTL | 90% | Thoroughly audited twice already; two accepted minor exceptions |
| Admin experience | 55% | Functional moderation pages exist; no branded shell, no audit log, no verification-evidence flow |
| **Legal/trust pages** | **10%** | **Two pages drafted-not-published, three pages don't exist — see §22** |
| SEO | 15% | No meta tags, sitemap, or structured data on any public page |
| Accessibility | 70% | V1's dedicated audit fixed real issues; no automated tooling (axe/Lighthouse CI) in place |
| Privacy/data lifecycle | 30% | Strong *isolation* (verified repeatedly); no self-service deletion/export |
| Operations/observability | 20% | Environment separation is correct; no backup, health check, or error monitoring |
| Analytics | 40% | Real event log exists and is used for loyalty/ranking; no funnel (search/checkout) events, no dashboard |

---

## 6. Gap Register

ID format: `<AREA>-<NN>`. Every row has Status / Severity / Target version per §28.

### A. Authentication & Account

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| AUTH-01 | No way for a new customer to self-register | **Resolved in V2.1 Step 6** — `beauclick-auth`'s phone/OTP flow creates a real `customer`-role account on first verified login; live-verified end to end | **IMPLEMENTED** | — | V2.1 Step 6 ✅ | Closed by commit implementing Step 6 (see `VERSION_2_ARCHITECTURE_PLAN.md`'s Step 6 notes) |
| AUTH-02 | No dedicated BeauClick-branded auth UI | **Resolved in V2.1 Step 6** — `AuthFlow.tsx`, served at `/auth/`, replaces every normal-user-facing link to `wp-login.php` | **IMPLEMENTED** | — | V2.1 Step 6 ✅ | Closed |
| AUTH-03 | No phone-number/OTP authentication | **Resolved in V2.1 Step 6** — full OTP lifecycle (generate/hash/expire/verify/rate-limit), live-verified for both new and existing accounts | **IMPLEMENTED** | — | V2.1 Step 6 ✅ | Closed |
| AUTH-04 | No SMS gateway integration | Still no real provider connected — `MockSmsProvider` remains the only path exercised in any environment; `SmsProviderFactory` is ready to select a real gateway the moment credentials exist | EXTERNAL_CONFIGURATION | HIGH | Production setup | Unchanged — a business/credentials decision, not something Step 6's engineering could resolve unilaterally |
| AUTH-05 | No login rate limiting / brute-force protection | **Resolved in V2.1 Step 6** — OTP requests are rate-limited per-phone and per-IP (transient-based, mirroring AI/chat's existing pattern); `wp-login.php` itself (the administrator-only path) is intentionally unchanged, per this step's own "do not break WordPress's underlying authentication system" instruction | **IMPLEMENTED** (for the normal-user path this step replaces) | — | V2.1 Step 6 ✅ | Closed for the path that matters (normal users no longer touch `wp-login.php` at all); admin brute-force protection remains WordPress core's own responsibility, unchanged by this project |
| AUTH-06 | No email verification on signup | Not applicable in the shipped design — phone verification via OTP **is** the account-creation verification step; email is optional and unverified, matching "keep initial registration friction low" | **IMPLEMENTED** (via phone, not email) | — | V2.1 Step 6 ✅ | Closed — the original gap assumed an email-based flow; the phone-first design makes a separate email-verification step unnecessary |
| AUTH-07 | No self-service account deletion | **Resolved in V2.2 Step 14** — a real, OTP-confirmed, admin-reviewed deletion request flow (`beauclick-privacy`), processed by a resumable WP-Cron sweep across every domain that holds customer data | **IMPLEMENTED** | — | V2.2 Step 14 ✅ | Closed |
| AUTH-08 | No self-service data export | **Resolved in V2.2 Step 14** — a real, self-scoped, synchronously-generated ZIP export covering every domain's own customer-owned data | **IMPLEMENTED** | — | V2.2 Step 14 ✅ | Closed |
| AUTH-09 | Password reset uses unmodified WP flow | **Superseded** — passwords are no longer part of the normal customer/professional/business UX at all (OTP re-verification is the recovery path); WordPress's own password reset remains available for administrators only, which is correct and unchanged | **IMPLEMENTED** (superseded by the OTP design) | — | V2.1 Step 6 ✅ | Closed |
| AUTH-10 | No duplicate-phone / account-merge handling | **Resolved in V2.1 Step 6** — `AccountResolver` detects genuine multi-account phone collisions, records them in `wp_bc_phone_conflicts`, and never silently merges; live-verified with a real pre-existing account being linked (not duplicated) on first OTP login | **IMPLEMENTED** | — | V2.1 Step 6 ✅ | Closed. No admin UI for reviewing a recorded conflict yet — noted as a small future addition in the Step 6 implementation notes, not tracked as a separate open gap here |
| AUTH-11 | Admin/wp-admin authentication is fully exposed default WordPress | Unchanged and correct — re-verified live after Step 6's activation (a real admin login via `wp-login.php` still reaches a genuine wp-admin dashboard) | IMPLEMENTED (as intended) | LOW | — | No action |

### B. Profile & Personal Information

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| PROF-01 | Customer address/profile editing | WooCommerce's native My Account pages — verified fully Persian, functional, correctly isolated per-user (V1.0.1 audit) | IMPLEMENTED | — | — | |
| PROF-02 | Customer notification preferences | **Resolved in V2.1 Step 10** — `wp_bc_notification_preferences` (4 togglable categories: reminder/waitlist/rebooking/retention), opt-out model, real UI in the Account tab, live-verified toggle → persists → suppresses delivery end to end | **IMPLEMENTED** | — | V2.1 Step 10 ✅ | Closed by commit implementing Step 10 |
| PROF-03 | Professional profile/portfolio | CPT-backed, editable via `MyProfileController`; portfolio *section* exists in UI but explicitly reads "این بخش در نسخه بعدی محصول تکمیل می‌شود" (V2.0 audit confirmed this live) | PARTIALLY_IMPLEMENTED | MEDIUM | V2.1/V2.2 | |
| PROF-04 | Professional verification evidence | **Resolved in V2.1 Step 8** — a real request→evidence→review→decision lifecycle (`VerificationService`, `wp_bc_verification_requests`/`_evidence`/`_history`) now backs `_bc_verification_status`; evidence is securely stored and only ever readable through an ownership/moderator-checked download endpoint | **IMPLEMENTED** | — | V2.1 Step 8 ✅ | Closed by commit implementing Step 8 (see `VERSION_2_ARCHITECTURE_PLAN.md`'s Step 8 notes) |
| PROF-05 | Business staff/permissions | Confirmed (Step 5 CRM audit) — a "business" account is 1:1 with one WP user; no multi-staff model exists anywhere | MISSING | MEDIUM | V2.1/V2.2 | Already documented as a known limitation in the CRM implementation notes; repeated here since it affects more than CRM |
| PROF-06 | Profile image handling | Uses WordPress's native media library (no custom upload code needed or written) | IMPLEMENTED | — | — | |

### C. Iran/Persian Localization

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| LOC-01 | Persian/RTL/Jalali across V1+V2.0+V2.1 | Two dedicated audits already performed (V1.0.1, V2.0 final); re-verified again during this pass (terminology check, live CRM Jalali dates) | IMPLEMENTED | — | — | |
| LOC-02 | Footer copyright year is Gregorian | Pre-existing, deliberately accepted (documented twice already) | DEFERRED | LOW | — | No change recommended |
| LOC-03 | WooCommerce's incorrect-password error string has no Persian entry in the installed language pack | Confirmed in the V2.0 audit — a real, narrow gap in the *external* community translation file | EXTERNAL_CONFIGURATION | LOW | Production setup | Optional narrow `gettext` override if desired, not required |
| LOC-04 | Terminology inconsistency: `نوبت` vs `رزرو` | Both used for "booking" across the same dashboard/booking feature set (12 vs 9 occurrences, no apparent rule) | MISSING (consistency) | MEDIUM | V2.1/V2.2 | Recommend standardizing on `نوبت` for the customer-facing appointment concept and `رزرو` only for the verb "to book" — see §26 |
| LOC-05 | No SMS templates | Because no SMS system exists at all (AUTH-03/AUTH-04) | MISSING | Tied to AUTH-03 | V2.1 | |
| LOC-06 | Transactional email coverage is narrow | Only `BookingMailer`/`ReviewMailer` exist; no dedicated OTP, welcome, password-changed, CRM-note, or journey-related email | PARTIALLY_IMPLEMENTED | MEDIUM | V2.2 | Matches the architecture plan's own already-flagged "central Notifications service" prerequisite |

### D. Date/Time/Jalali

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| DATE-01 | Every user-facing date across V1/V2.0/V2.1 | Confirmed Jalali via three separate audits (V1.0.1, V2.0, V2.1-CRM), live-verified with real round-trip data each time | IMPLEMENTED | — | — | |
| DATE-02 | B2B quote `expires_at` has no frontend UI | No UI exists to display it at all yet (not a Jalali bug — nothing to convert) | DEFERRED | LOW | V2.1/V2.2 | Already noted in the cross-cutting standard doc; repeated for completeness |
| DATE-03 | Notification/reminder scheduling | **Resolved in V2.1 Step 10** — `ReminderScheduler` (hourly WP-Cron, 23–25h window), `RebookingScheduler` and `RetentionScheduler` (daily), all idempotent via `NotificationService`'s own key, all Jalali on the customer-facing side, canonical `current_time('mysql')` internally | **IMPLEMENTED** | — | V2.1 Step 10 ✅ | Closed by commit implementing Step 10 |

### E. Commerce/WooCommerce

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| COM-01 | Checkout → payment → order → confirmation | Fully live-verified twice (V1.0.1, and indirectly reused in V2.0/V2.1 sessions); Persian, Jalali-correct | IMPLEMENTED | — | — | |
| COM-02 | Refund/cancellation hook correctness | `order_refunded` event wired, tested (V2.0 Step 1) | IMPLEMENTED | — | — | |
| COM-03 | No coupons currently configured | `wp_posts` query confirms zero `shop_coupon` rows | NEEDS_BUSINESS_DECISION | LOW | Post-launch | Not a defect — matches the V1 audit's own "no rates specified" finding, still true |
| COM-04 | No order invoice/receipt PDF | No matching code; only WooCommerce's own HTML order-received page | MISSING | MEDIUM | V2.2 | |
| COM-05 | Future price-hook stacking risk | **Addressed in V2.1 Step 9** for the Loyalty/Membership case specifically — resolved by structural separation rather than a shared hook-ordering contract: booking orders never touch the WooCommerce cart at all (`BookingOrderBridge` calls `wc_create_order()`+`add_product()` directly), so the new membership discount (an order-level fee) and B2B's `TierPricingEngine` (a cart filter) are structurally disjoint, verified live and by test that neither can ever fire against the other's order/cart. The underlying general risk (a *third* price-modifying feature, e.g. Campaigns, wanting the cart too) is not fully closed — still needs the "one deliberate hook-ordering contract" design if/when that happens | **PARTIALLY_IMPLEMENTED** (Loyalty/Membership case resolved; Campaigns case remains open) | MEDIUM | V2.1 Step 9 (Loyalty) ✅ / V2.2-V2.3 (Campaigns, if it also needs the cart) | Design a shared contract only if/when a feature actually needs to modify the WooCommerce cart itself — Step 9 avoided needing one by not using the cart at all |
| COM-06 | Legal commerce pages (refund policy) | See LEGAL-02 below — drafted, not published | NEEDS_LEGAL_REVIEW | **BLOCKING** | Pre-launch | |

### F. Booking

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| BOOK-01 | Full discovery→hold→checkout→confirm→complete→review lifecycle | Live-verified repeatedly across three separate audit passes; atomic hold/expiry, no double-booking (existing concurrency-safe `UPDATE ... WHERE status='open'`) | IMPLEMENTED | — | — | |
| BOOK-02 | Cancellation | Implemented, tested, Persian | IMPLEMENTED | — | — | |
| BOOK-03 | Rescheduling | Still not built — Step 10 deliberately scoped to Waitlist/Rebooking/Reminders/Retention/No-show only, per its own task boundary; a true reschedule action (vs. cancel-and-rebook) remains a distinct feature | MISSING | MEDIUM | V2.2 | Not pulled into Step 10 — no shared infrastructure need was found; waitlist/rebooking do not require a reschedule primitive |
| BOOK-04 | No-show handling | **Resolved in V2.1 Step 10** — `BookingService::mark_no_show()` (confirmed→no_show, only after `slot_end` has passed), owning-professional-only REST route reusing the existing `/confirm` ownership gate, event logged, deliberately no customer notification (internal bookkeeping only) | **IMPLEMENTED** | — | V2.1 Step 10 ✅ | Closed by commit implementing Step 10 |
| BOOK-05 | Booking reminders | **Resolved in V2.1 Step 10** — see DATE-03 | **IMPLEMENTED** | — | V2.1 Step 10 ✅ | Closed by commit implementing Step 10 |
| BOOK-06 | Waitlist | **Resolved in V2.1 Step 10** — real waitlist domain (`wp_bc_waitlist_entries`), server-validated against real published providers/services, owner-only REST (create/list-own/cancel), FIFO matching on the authoritative `slot_opened` event (fired from both `cancel_booking()` and `expire_stale_holds()`), booking's own atomic claim remains the sole source of truth — a waitlisted customer still has to win the real race, live-verified | **IMPLEMENTED** | — | V2.1 Step 10 ✅ | Closed by commit implementing Step 10 |

### G. Marketplace

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| MKT-01 | Search/filter/sort/ranking | Live-verified (V2.0 audit) — real ranking, honest empty states, no hardcoded city | IMPLEMENTED | — | — | |
| MKT-02 | Search typo tolerance / fuzzy matching | Search is plain SQL `LIKE`-based (confirmed via CRM's own search implementation this session, and marketplace's own filtering) — no fuzzy/typo-tolerant matching anywhere | MISSING | MEDIUM | V2.2 | Matches roadmap §20's own "no Elasticsearch without evidence" — a lighter normalization pass (already applied for Persian digits in CRM search) could partially help without new infrastructure |
| MKT-03 | Cold-start / new-professional visibility | Verified live (V2.0 Step 3 audit) — new professionals land mid-pack (~55/100), never buried at 0 | IMPLEMENTED | — | — | |
| MKT-04 | Multi-city scalability | No hardcoded city found anywhere in ranking/marketplace code (verified by inspection twice); location data is real DB rows (`wp_bc_provinces/cities/districts`), not hardcoded | IMPLEMENTED | — | — | |

### H. Professional/Business Experience

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| PRO-01 | Dashboard: Overview/Bookings/Services/Reviews/Messages/Customers | All six real and data-backed as of this commit | IMPLEMENTED | — | — | |
| PRO-02 | Revenue (`درآمد`) tab | Still `ready: false`, placeholder copy only — confirmed unchanged this session | MISSING | HIGH | V2.3 (Financial/Payout) | Matches the existing, already-documented sequencing decision — not a new finding, re-confirmed |
| PRO-03 | Calendar (`تقویم`) tab | Still `ready: false` | MISSING | MEDIUM | V2.1/V2.2 | |
| PRO-04 | Profile/Settings tabs | Still `ready: false` | PARTIALLY_IMPLEMENTED | MEDIUM | V2.1/V2.2 | |
| PRO-05 | B2B business dashboard | Functional account/quote flow exists (`beauclick-b2b`), admin-side approval page exists | IMPLEMENTED | — | — | |

### I. Admin Experience

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| ADMIN-01 | BeauClick-branded admin shell | **Resolved in V2.2 Step 13** — a real `AdminShell` component (consistent header/breadcrumb/stat-cards/table wrapper, one dedicated stylesheet built from the existing design tokens, loaded only on BeauClick's own admin screens) now wraps every one of the eleven BeauClick admin pages, in a deliberately ordered, correctly Persian-labeled menu | **IMPLEMENTED** | — | V2.2 Step 13 ✅ | Closed |
| ADMIN-02 | Admin audit log | **Fully resolved in V2.2 Step 13** — a new general-purpose, append-only `wp_bc_admin_audit_log` table + `AuditLogger` service records every B2B approval/rejection, review moderation decision, and loyalty tier/plan/benefit/membership change (actor, entity, previous/new state, reason); a new Audit Log admin page merges it with verification's own existing history (V2.1 Step 8, left untouched) into one read-only feed | **IMPLEMENTED** | — | V2.2 Step 13 ✅ | Closed |
| ADMIN-03 | Professional verification workflow | **Resolved in V2.1 Step 8** — a dedicated `VerificationReviewPage` admin screen (queue, evidence links, approve/reject/suspend/revoke/reinstate) replaces the old raw-postmeta-editing metabox, gated on the `bc_moderate_verification` capability | **IMPLEMENTED** | — | V2.1 Step 8 ✅ | Closed by commit implementing Step 8 |
| ADMIN-04 | Booking/order administration | **Partially addressed in V2.2 Step 13** — WooCommerce's own native order admin remains authoritative (deliberately not duplicated, per this step's own scope boundary); the new Overview/Operations pages now surface cross-cutting operational signals (bookings this month, active waitlist backlog, failed notifications) a WooCommerce-only view wouldn't show. No dedicated BeauClick bookings/orders admin *screen* was built — a documented, deliberate boundary, not an oversight | PARTIALLY_IMPLEMENTED | LOW | V2.2 Step 13 (partial) | A full BeauClick-specific booking-operations screen remains a future candidate only if real operator usage shows the Overview/Operations cards aren't enough |

### J. Notifications & Communication

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| NOTIF-01 | Booking confirmation/cancellation email | Real, Jalali-correct, Persian (`BookingMailer`) | IMPLEMENTED | — | — | |
| NOTIF-02 | Review notification email | Real (`ReviewMailer`) | IMPLEMENTED | — | — | |
| NOTIF-03 | Central notification service | **Resolved in V2.1 Step 10** — new `beauclick-notifications` plugin: single `NotificationService::notify()` dispatch point (Event/Trigger → Template → Recipient → Channel → Delivery → Delivery status), reused by Waitlist/Reminders/Rebooking/Retention rather than each building its own logic; insert-then-dispatch idempotency via a UNIQUE `idempotency_key`, honest delivery states (pending/sent/failed/suppressed/duplicate), bounded transient-only retry | **IMPLEMENTED** | — | V2.1 Step 10 ✅ | Closed by commit implementing Step 10 |
| NOTIF-04 | In-app notification center/bell | Deliberately **not** built as a full bell/center in Step 10 — only a lean backend history (`NotificationService::for_user()`) and a simple read-only "اعلان‌های اخیر" list in the Account tab exist; per the task's own scoping guidance, a full notification center belongs in a later step if needed | PARTIALLY_IMPLEMENTED | MEDIUM | V2.2 (if a full center is needed) | The reusable backend history already exists; a real bell/unread-count UI can be layered on later without new backend work |
| NOTIF-05 | SMS notifications | **Resolved in V2.1 Step 10** for the transactional-notification consumer side — Step 10 reuses Step 6's existing `SmsProvider`/`SmsProviderFactory`/`MockSmsProvider` abstraction verbatim (no second SMS interface built); still gated on a real SMS provider being configured in production (`BC_SMS_PROVIDER`/`BC_SMS_API_KEY`), same `EXTERNAL_CONFIGURATION` dependency already tracked under AUTH-04 | **IMPLEMENTED** (consumer) / EXTERNAL_CONFIGURATION (real provider) | — | V2.1 Step 10 ✅ (consumer) | Provider credentials remain an operational/production setup task, not a code gap |
| NOTIF-06 | Notification preferences/opt-out | **Resolved in V2.1 Step 10** — see PROF-02; transactional-vs-promotional distinction preserved (`retention` is the only promotional category; booking confirm/cancel stays outside the preference system entirely, never disableable) | **IMPLEMENTED** | — | V2.1 Step 10 ✅ | Closed by commit implementing Step 10 |

### K. AI

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| AI-01 | Grounding/validation/medical safety/provider-agnostic | Thoroughly audited and live-verified twice (V2.0 Step 2 build, V2.0 final audit) | IMPLEMENTED | — | — | |
| AI-02 | Real AI provider (Anthropic) live path | Adapter code exists and is tested via HTTP mocking; **never exercised against the real API in this environment** (no key configured) — unchanged, already-documented limitation from Step 1/Step 2 | EXTERNAL_CONFIGURATION | MEDIUM | Production setup | Requires a real `BC_AI_API_KEY`/provider decision before launch if AI is meant to run on a real model rather than the deterministic rule-based fallback |
| AI-03 | AI cost/usage visibility | No logging of token usage, cost, or per-provider call volume anywhere | MISSING | MEDIUM | V2.2 | Matters once a real (paid) provider is configured |
| AI-04 | Rate limiting | Real, transient-based (15/min), confirmed | IMPLEMENTED | — | — | |
| AI-05 | AI-for-professionals | Confirmed still not built, correctly out of scope per this project's own sequencing | DEFERRED | LOW | V2.3 (per existing plan) | |

### L. Security

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| SEC-01 | Authorization/ownership boundaries (booking, reviews, journey, CRM, B2B) | Verified live, repeatedly, across every audit this session and prior ones — including a real B2B IDOR fix already shipped in V1 | IMPLEMENTED | — | — | |
| SEC-02 | Login brute-force protection | See AUTH-05 — **resolved in V2.1 Step 6** for the normal-user OTP path (rate-limited); `wp-login.php` itself is administrator-only and intentionally untouched | **IMPLEMENTED** (for the path this project controls) | — | V2.1 Step 6 ✅ | Closed |
| SEC-03 | REST permission_callback discipline | **Amended by the V2.1 Final Release Audit** — the guard's actual logic never fired for the flat-array route shape every one of the ~90 real routes uses (a real, confirmed bug), so the "throws if missing" claim was previously inaccurate; every real route already declared `permission_callback` independently regardless (verified by direct inspection of every call site), so this was a dead safety net, not a live hole. Fixed, with 2 new regression tests, during the audit — the guard now genuinely works for the shape this codebase actually uses | **IMPLEMENTED** (now genuinely, not just by claim) | — | V2.1 Final Audit ✅ | Closed by the audit's own fix commit |
| SEC-04 | File upload validation | **Resolved in V2.1 Step 8** — `EvidenceStorage::store()` validates real, content-sniffed MIME type (`finfo`, never the client-supplied type or extension) against an explicit whitelist, enforces an 8MB size cap, uses `is_uploaded_file()`/`move_uploaded_file()`, and stores under a cryptographically randomized filename in a directory never linked from any public/predictable URL | **IMPLEMENTED** | — | V2.1 Step 8 ✅ | Closed by commit implementing Step 8 |
| SEC-05 | Secrets/API keys | Confirmed `.env`-based, gitignored, never committed (verified across every phase of this project) | IMPLEMENTED | — | — | |
| SEC-06 | Leftover default WordPress content | A "Sample Page" (default WP install content) is still `publish`-ed and live | MISSING (cleanup) | LOW | V2.1 | Trivial to remove; flagged because a stray default page on a production commerce site looks unfinished |

### M. Privacy & Data Lifecycle

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| PRIV-01 | Cross-user data isolation | Verified repeatedly and directly (Journey, CRM, AI context, B2B) — this is BeauClick's strongest area | IMPLEMENTED | — | — | |
| PRIV-02 | Self-service account deletion | See AUTH-07 — **Resolved in V2.2 Step 14** | **IMPLEMENTED** | — | V2.2 Step 14 ✅ | Closed |
| PRIV-03 | Self-service data export | See AUTH-08 — **Resolved in V2.2 Step 14** | **IMPLEMENTED** | — | V2.2 Step 14 ✅ | Closed |
| PRIV-04 | Data retention policy (CRM notes, journey, chat, AI context) | **V2.2 Step 14 built the anonymization/deletion mechanism and a real delete-vs-anonymize-vs-retain matrix per domain** (see that step's own implementation notes) — but the actual retention *duration* for anonymized-and-retained records (bookings, reviews, loyalty ledger, referrals, retained chat/CRM data), and whether historical WooCommerce order-level billing PII should ever be purged, remain undecided | NEEDS_BUSINESS_DECISION / NEEDS_LEGAL_REVIEW (mechanism now real; policy still open) | MEDIUM | Pre-launch | The engineering mechanism this policy would need to enforce now exists; only the actual duration/threshold values remain a business/legal call |
| PRIV-05 | AI data boundaries | CRM notes and journey `notes` field confirmed never sent to any AI provider (verified by inspection in the Step 5 audit) | IMPLEMENTED | — | — | |

### N. Operations/Observability

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| OPS-01 | Environment separation (local/staging/production) | Real, correct — `WP_ENV` → `WP_ENVIRONMENT_TYPE`, defaults safely to `production` when unset | IMPLEMENTED | — | — | |
| OPS-02 | Automated backup (database + media) | No backup code/cron/script exists anywhere in this repository | MISSING | **BLOCKING** (pre-launch) | Production setup | Standard infrastructure requirement, not a BeauClick-code gap — needs a hosting-level decision |
| OPS-03 | Health-check endpoint | None exists | MISSING | MEDIUM | Production setup | |
| OPS-04 | Error monitoring (e.g., Sentry-class tooling) | None integrated; errors currently only surface in PHP/server logs | MISSING | HIGH | Production setup | |
| OPS-05 | WP-Cron reliability at scale | Existing pattern (`HoldExpiryScheduler`, `RankingScheduler`) is sound for current scale; real WP-Cron (not the request-triggered pseudo-cron) requires a real system cron entry in production, which is a hosting-config item, not a code gap | EXTERNAL_CONFIGURATION | MEDIUM | Production setup | |

### O. SEO/Public Website

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| SEO-01 | Meta description/OG tags on marketplace/profile/product pages | **Resolved in V2.2 Step 12** — `inc/seo.php` extended: the real `<title>` tag (previously left completely static — a genuine bug caught during this step's live verification, since only `og:title` was ever dynamic) and meta description are now city/specialty-aware for the marketplace and content-aware for professional/business profiles | **IMPLEMENTED** | — | V2.2 Step 12 ✅ | Closed |
| SEO-02 | XML sitemap | **Resolved in V2.2 Step 12** — WP core's own `wp-sitemap.xml` already covers `bc_professional`/`bc_business` (public CPTs); a new custom provider (`inc/sitemap.php`) adds the city/specialty marketplace URLs core can't discover on its own, bounded to launched cities and real-content combinations only | **IMPLEMENTED** | — | V2.2 Step 12 ✅ | Closed |
| SEO-03 | Structured data (LocalBusiness/Service/Product schema for professional profiles) | **Resolved in V2.2 Step 12** — real `LocalBusiness`/`Service`/`BreadcrumbList` JSON-LD on professional/business profiles (only fields with real data — no fabricated ratings/hours/prices), `WebSite`/`Organization` on the homepage; WooCommerce's own Product/BreadcrumbList JSON-LD on shop pages is unchanged, not duplicated | **IMPLEMENTED** | — | V2.2 Step 12 ✅ | Closed |
| SEO-04 | Canonical URLs | **Resolved in V2.2 Step 12** — explicit canonical for every page type (WP core only auto-adds one on singular views); marketplace canonical is self-referencing for a real city/specialty combination, collapses to the plain root for a thin/zero-result one | **IMPLEMENTED** | — | V2.2 Step 12 ✅ | Closed. Deliberately kept the existing `?city_id=`/`?specialty_id=` query-string URL scheme rather than introducing new pretty paths — see the architecture plan's own reasoning (avoids a rewrite-rule flush/activation-timing risk for a URL-structure change this task's own instructions warned against doing "casually") |

### P. Accessibility

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| A11Y-01 | Modal focus trap/Escape/labeled close | Real, already built and reused by every new feature (Journey, CRM) without modification | IMPLEMENTED | — | — | |
| A11Y-02 | V1 Production Readiness accessibility fixes | Real fixes already shipped (per the architecture doc's own "What Should NOT Be Changed" list, §17) | IMPLEMENTED | — | — | |
| A11Y-03 | Automated accessibility testing (axe-core/Lighthouse CI) | **Partially resolved in V2.2 Step 13** — `axe-core` wired directly into the existing Vitest pipeline (`src/test/axe.ts`), with a first real test on `Modal` (the component with the widest reuse across the app-shell). Covers the React app-shell only — BeauClick's own PHP-rendered admin pages have no automated a11y coverage, since that would require new browser-automation tooling this project doesn't otherwise have | PARTIALLY_IMPLEMENTED | LOW | V2.2 Step 13 (frontend) | Extend to more app-shell components opportunistically as they're touched; admin-page automated coverage remains a future candidate only if a real regression makes the case for the new tooling it would require |
| A11Y-04 | Date-picker (`JalaliDateInput`) keyboard/screen-reader behavior | Native `<select>` elements — inherits full native accessibility for free (this was in fact the explicit reason it was built as three selects rather than a custom calendar-grid widget) | IMPLEMENTED | — | — | |

### Q. Analytics/Business Metrics

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| ANLYT-01 | Booking/AI/loyalty/journey event logging | Real, append-only, used for real ranking/loyalty computation (confirmed both by source and live DB inspection this session) | IMPLEMENTED | — | — | |
| ANLYT-02 | Search events | **Resolved in V2.2 Step 11** — `search_performed` logged directly inside `MarketplaceController::browse()` (the platform's real search/discovery entry point), with result count and filter-usage metadata; live-verified against real requests | **IMPLEMENTED** | — | V2.2 Step 11 ✅ | Closed |
| ANLYT-03 | Checkout-funnel events (cart add, checkout started) | **Resolved in V2.2 Step 11** — `product_view`/`cart_add`/`checkout_started` added via `beauclick-analytics`'s `CommerceTracker`, hooked to genuine WooCommerce cart-lifecycle actions; explicitly scoped to shop/B2B purchases only (booking orders bypass the cart entirely, so they were never in scope for these specific events — the booking funnel already had its own events since V2.0 Step 1) | **IMPLEMENTED** | — | V2.2 Step 11 ✅ | Closed |
| ANLYT-04 | Admin-facing (platform-wide) analytics dashboard | **Resolved in V2.2 Step 11** — a real platform-admin dashboard (`AnalyticsDashboardPage`) computing funnel/commerce/search/AI/retention/usage/marketplace metrics live from `wp_bc_events` and existing domain tables, with Jalali date-range presets; live-verified against real seeded data | **IMPLEMENTED** | — | V2.2 Step 11 ✅ | Closed. Platform-wide/admin scope only — see ANLYT-06 for the professional/business-scoped view |
| ANLYT-05 | CRM/Journey usage measurement | **Resolved in V2.2 Step 11** — `crm_opened`/`journey_opened` UI-visibility pings (via `POST /analytics/track`, strictly allow-listed, actor always the current user) | **IMPLEMENTED** | — | V2.2 Step 11 ✅ | Closed |
| ANLYT-06 | Professional/business-facing analytics dashboard ("my own performance") | No self-service analytics view exists for an individual professional or business — the only way to see performance data today is a direct database query (ANLYT-04's platform-admin dashboard is platform-wide, not scoped to one professional/business) | MISSING | MEDIUM | **V2.2 Step 16** | Reuse Step 11's `Metrics\MetricsService` with an added ownership filter, exposed through a role-scoped endpoint and a new dashboard tab in the existing professional/business dashboard shell — not a second analytics engine. See `VERSION_2_ARCHITECTURE_PLAN.md`'s "Step 11 vs. Step 16 — analytics ownership boundary" subsection for the full architectural split. Revenue/financial figures explicitly excluded until Financial/Payout (V2.3, see PRO-02) exists |

---

## 7. P0/P1/P2/P3 Prioritization

### P0 — Blocking before public production
1. **AUTH-01** — No customer self-registration path exists at all.
2. **LEGAL-01/LEGAL-02/LEGAL-03** — No published Terms of Service; Privacy Policy and Refund Policy exist only as drafts.
3. **OPS-02** — No automated backup.
4. **PROF-04 / ADMIN-03** — Professional verification has no evidence trail.

### P1 — High-value / important
5. AUTH-02, AUTH-03, AUTH-04 — Branded auth UI + phone/OTP + SMS gateway.
6. AUTH-05 / SEC-02 — Login rate limiting.
7. OPS-04 — Error monitoring.
8. NOTIF-03 / NOTIF-05 — Central notification service + SMS notifications.
9. PRO-02 — Revenue/Financial visibility for professionals (already sequenced as V2.3, re-confirmed still absent).
10. LOC-04 — `نوبت`/`رزرو` terminology consistency pass.

### P2 — Useful but non-blocking
11. SEO-01/02/03/04, ANLYT-02/03/04, COM-04 (invoices), BOOK-03/04/05 (reschedule/no-show/reminders), ADMIN-01/02, PRIV-02/03/04, PROF-02, A11Y-03.

### P3 — Future enhancement
12. AI-03 (cost visibility), MKT-02 (fuzzy search), COM-05 (price-hook design, needed only once a second price-modifying feature ships), everything already explicitly deferred in the existing V2 architecture plan (Waitlist, Realtime, Multi-vendor, Native Mobile, Referral, Membership, Campaigns, Financial ledger).

---

## 8–21. Category Deep-Dives

Each category's findings are fully captured in the tables in §6 above (Authentication → A, Localization → C, Booking → F, Commerce → E, Marketplace → G, CRM → H/existing Step 5 notes, AI → K, Admin → I, Security → L, Privacy → M, Operations → N, SEO → O, Accessibility → P, Analytics → Q). Not duplicated here to avoid drift between two copies of the same finding.

---

## 22. Legal/Business Decision Items — `NEEDS_BUSINESS_DECISION` / `NEEDS_LEGAL_REVIEW`

| ID | Item | Current state |
|---|---|---|
| LEGAL-01 | Terms of Service | **Does not exist as a page at all.** `NEEDS_BUSINESS_DECISION` + `NEEDS_LEGAL_REVIEW`. |
| LEGAL-02 | Privacy Policy | Exists as a WordPress page titled `حریم خصوصی`, status **draft** — never published, not linked anywhere a real user would see it. `NEEDS_LEGAL_REVIEW`. |
| LEGAL-03 | Refund/Cancellation Policy | Exists as `بازگشت و استرداد وجه`, status **draft** — same issue. `NEEDS_LEGAL_REVIEW`. |
| LEGAL-04 | Cookie/consent notice | None found. `NEEDS_LEGAL_REVIEW`. |
| LEGAL-05 | FAQ / Contact / About pages | None exist. `NEEDS_BUSINESS_DECISION` (content ownership, not engineering). |
| LEGAL-06 | Commission/payout terms for professionals | No commission structure exists yet (Financial/Payout is correctly deferred to V2.3) — the terms question is moot until that system exists, but worth flagging now so legal review isn't a late surprise. `NEEDS_BUSINESS_DECISION`. |
| LEGAL-07 | Review moderation policy | A moderation admin page exists (functional), but no published, user-facing policy describing what gets moderated or why. `NEEDS_BUSINESS_DECISION`. |
| LEGAL-08 | Data retention policy | See PRIV-04. `NEEDS_BUSINESS_DECISION`. |

---

## 23. External Configuration Requirements

| Dependency | Purpose | Current state | Production dependency |
|---|---|---|---|
| SMS gateway (e.g., Kavenegar/IPPanel) | OTP + transactional SMS | Not integrated at all | Required before AUTH-03/NOTIF-05 can ship |
| AI provider (Anthropic) | `AnthropicProvider` adapter | Code exists, untested against the real API, no key configured | Optional — `RuleBasedProvider` is a genuine, working fallback; only needed if real-model AI is desired |
| Payment gateway (Zarinpal, per `.env`) | Real Iranian payment processing | `ZARINPAL_MERCHANT_ID` empty; only the dev-only Cash-on-Delivery gateway is exercised (already documented, gated behind non-production environment) | **Required before launch** — no real payment path exists today |
| Object storage (`BC_STORAGE_DRIVER`) | Production media offload | Set to `local` | Fine for current scale; revisit if media volume grows |
| Backup service | Database + media backup | None configured | Required before launch (OPS-02) |
| Error monitoring (Sentry-class) | Production error visibility | None integrated | Required before launch (OPS-04) |
| SMTP | Transactional email delivery | Uses WordPress's default `wp_mail()`/PHP `mail()` — no dedicated SMTP configured in `.env` | Needs a real SMTP/transactional-email provider before launch, or deliverability will be unreliable |

---

## 24. Dependencies

- AUTH-02/03 depend on AUTH-04 (SMS gateway) and a business decision on which provider.
- NOTIF-03 (central notification service) is a prerequisite for Waitlist/Retention automation — already identified in the existing architecture plan, re-confirmed still true and still not built.
- PROF-04 (verification evidence) needs SEC-04 (file upload validation) designed alongside it, not after.
- COM-05 (price-hook design) must land *before*, not after, the second cart-total-modifying feature (Loyalty discounts, Membership, or Campaigns — whichever ships first).
- LEGAL-01/02/03 block nothing technically but should land before any real user signs up for real (which AUTH-01 currently prevents anyway — a rare case where two blocking gaps currently mask each other).

---

## 25. Recommended Next Steps

1. Treat **AUTH-01** (no registration path) and **LEGAL-01/02/03** (no live legal pages) as immediate priorities — both are silent, high-consequence gaps that no amount of feature work elsewhere fixes.
2. Resolve **PROF-04/ADMIN-03** (verification evidence) before actively growing the professional base — trust infrastructure is cheaper to build early than to retrofit onto an active marketplace.
3. Stand up **OPS-02/OPS-04** (backup + error monitoring) as an infrastructure task, independent of the next feature step — this is not blocked by any product decision.
4. Run a short, focused **LOC-04** terminology pass (`نوبت` vs `رزرو`) as a cheap, high-visibility consistency fix.

## 26. Recommended V2.1 Sequence After Step 5

Given this register, the existing V2.1 sequence (CRM → Loyalty tiers/Membership per the original architecture plan) should be **revisited, not blindly continued** — several items discovered here (AUTH-01, LEGAL pages, PROF-04) are more consequential than the next roadmap-listed feature and were simply never on anyone's list before this audit. Recommendation, in order:

1. **Authentication & Registration** (AUTH-01, AUTH-02, AUTH-05 at minimum) — nothing else matters if customers can't sign up.
2. **Legal pages** (LEGAL-01/02/03 — publish + author the missing one) — largely a content/business task, not engineering, and can run in parallel with #1.
3. **Professional verification evidence** (PROF-04/ADMIN-03/SEC-04 together).
4. Then resume the previously-planned sequence (Loyalty tiers/Membership, per the existing architecture plan), now with real registered users to actually validate it against.

This is a recommendation for the product owner to weigh, not a decision made unilaterally by this audit — per the task's own instruction, the next implementation step is chosen only after this register is reviewed.

---

## 27. Closing Note

Per the audit's own explicit instruction not to hide or minimize discoveries: the registration gap (AUTH-01) and the unpublished/missing legal pages (LEGAL-01/02/03) are both more significant than anything else in this register, and both went unnoticed through V1, V2.0, and V2.1 Step 5 because every prior verification session already had test accounts to work with and never needed to use the pages a real first-time visitor would need. This is not a criticism of any prior step's own scope — each was correctly and thoroughly delivered against what it was asked to do — it is exactly the kind of gap this audit exists to surface.

---

## 28. V2.1 Step Assignments (Post-Roadmap-Update)

Following the roadmap/architecture-plan reprioritization (`docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md`'s "Post-Audit V2.1 Reprioritization" section, and the corresponding update to `BeauClick_Version_2_Roadmap.md`), every gap with genuine, assignable product-development scope now has a concrete home. This section is the authoritative mapping; the `Target` column values inside the §6 tables above remain as originally written (mostly generic `V2.1`/`V2.2` labels) and should be read together with this table rather than edited row-by-row, to avoid the two ever silently drifting apart.

| ID | Item | Assigned to | Disposition |
|---|---|---|---|
| AUTH-01 | No customer self-registration path | **V2.1 Step 6** | Product development |
| AUTH-02 | No branded BeauClick auth UI | **V2.1 Step 6** | Product development |
| AUTH-03 | No phone/OTP authentication | **V2.1 Step 6** | Product development |
| AUTH-04 | No SMS gateway integration | **V2.1 Step 6** (consumer) | `EXTERNAL_CONFIGURATION` — provider/credentials decision precedes the integration layer Step 6 builds against it |
| AUTH-05 / SEC-02 | No login rate limiting/brute-force protection | **V2.1 Step 6** | Product development |
| AUTH-06 | No email verification on signup | **V2.1 Step 6** | Product development |
| AUTH-07 / PRIV-02 | No self-service account deletion | V2.2 | Product development (unchanged) |
| AUTH-08 / PRIV-03 | No self-service data export | V2.2 | Product development (unchanged) |
| AUTH-09 | Password reset not BeauClick-branded | **V2.1 Step 6** | Product development (bundled with AUTH-02) |
| AUTH-10 | No duplicate-phone/account-merge handling | **V2.1 Step 6** (design), implementation may extend into V2.2 if complexity warrants | Product development |
| LEGAL-01 | Terms of Service doesn't exist | **V2.1 Step 7** (page framework); content is `NEEDS_BUSINESS_DECISION` + `NEEDS_LEGAL_REVIEW` | Split: engineering + business/legal |
| LEGAL-02 | Privacy Policy unpublished draft | **V2.1 Step 7** (publish + link); content review is `NEEDS_LEGAL_REVIEW` | Split |
| LEGAL-03 | Refund Policy unpublished draft | **V2.1 Step 7** (publish + link); content review is `NEEDS_LEGAL_REVIEW` | Split |
| LEGAL-04 | No cookie/consent notice | **V2.1 Step 7** (consent-hook framework); the policy itself is `NEEDS_LEGAL_REVIEW` | Split |
| LEGAL-05 | No FAQ/Contact/About pages | **V2.1 Step 7** (page framework); content ownership is `NEEDS_BUSINESS_DECISION` | Split |
| LEGAL-06 | Commission/payout terms undefined | Deferred alongside Financial/Payout (V2.3) | `NEEDS_BUSINESS_DECISION` |
| LEGAL-07 | No published review-moderation policy | **V2.1 Step 7** | `NEEDS_BUSINESS_DECISION` |
| LEGAL-08 / PRIV-04 | Data retention policy undefined | **V2.1 Step 7** (preference storage); the policy itself is `NEEDS_BUSINESS_DECISION` | Split |
| COM-06 | Refund policy publication (commerce-facing) | **V2.1 Step 7** | Same item as LEGAL-03, cross-referenced |
| PROF-04 | No professional-verification evidence trail | **V2.1 Step 8** | Product development |
| ADMIN-03 | Verification workflow has no audit trail | **V2.1 Step 8** | Product development |
| SEC-04 | File upload validation (needed once evidence upload exists) | **V2.1 Step 8** | Product development |
| ADMIN-02 | No admin audit log | **V2.1 Step 8** (scoped to verification actions), broader admin audit logging remains V2.2 | Product development |
| PROF-05 | No multi-staff business permission model | V2.2 (unchanged — explicitly documented as a limitation, not solved by CRM or by Step 8) | Product development |
| Loyalty tiers, Membership benefits/entitlements | Not individually ID'd in §6 (predates this register; carried from the original architecture plan §4.6) | **V2.1 Step 9** | Product development |
| BOOK-06 | Waitlist | **V2.1 Step 10 ✅ Done** | Product development |
| BOOK-03 | Rescheduling | Not pulled into Step 10 — no shared infrastructure need was found during implementation; remains V2.2 | Product development |
| BOOK-04 | No-show state transition never triggered | **V2.1 Step 10 ✅ Done** — landed alongside Waitlist, not Step 8 | Product development |
| BOOK-05 / DATE-03 | No booking reminders | **V2.1 Step 10 ✅ Done** | Product development |
| NOTIF-03 | Central notification service | **V2.1 Step 10 ✅ Done** (prerequisite work within the step, per the architecture plan's own already-identified dependency) | Product development |
| NOTIF-04 | In-app notification center | Deliberately deferred — Step 10 built the reusable backend history only, not a full bell/center UI; remains V2.2 if a full center is needed | Product development |
| NOTIF-05 | SMS notifications | **V2.1 Step 10 ✅ Done** (consumer), same `EXTERNAL_CONFIGURATION` SMS-provider dependency as AUTH-04 | Split |
| NOTIF-06 / PROF-02 | Notification preferences/opt-out | **V2.1 Step 10 ✅ Done** | Product development |
| SEC-01, SEC-03, SEC-05, SEC-06, PRIV-01, PRIV-05, OPS-01, LOC-01/02, DATE-01, MKT-01/03/04, COM-01/02, BOOK-01/02, AI-01/04, A11Y-01/02/04, ANLYT-01 | Already `IMPLEMENTED` | — | No action; unaffected by this reprioritization |
| LOC-04 | `نوبت`/`رزرو` terminology inconsistency | V2.1 (opportunistic — recommend folding into Step 6/7's own UI work rather than a standalone pass) | Product development |
| OPS-02, OPS-03, OPS-04, OPS-05 | Backup, health check, error monitoring, real system cron | Production setup, ahead of public launch | `EXTERNAL_CONFIGURATION` — not assigned to any V2.1 step; these are hosting/infrastructure decisions independent of feature sequencing |
| SEO-01–04, ANLYT-02–05, COM-03/04/05, A11Y-03, ADMIN-01, ADMIN-04, PRO-02/03/04, AI-02/03/05, MKT-02 | Various | **Superseded — see §35 "V2.2 Roadmap Assignments" for the concrete, per-Step assignment of every one of these** | This placeholder row is intentionally left in place as the historical record of what this table said before §35 existed; §35 is now authoritative for these IDs |

**Note on external configuration:** per this task's explicit instruction, SMS/SMTP/monitoring/backup are deliberately **not** turned into their own product-development steps. Where a step's functionality depends on one (Step 6 and Step 10 both depend on an SMS provider decision; every step depends on SMTP for any email it sends), the dependency is named inline above, but the external service itself remains an operational/business decision to make before or alongside the relevant step, not a line item inside it.

---

## 29. V2.1 Step 6 Completion Note

**Step 6 — BeauClick Authentication & Registration is complete.** AUTH-01, AUTH-02, AUTH-03, AUTH-05 (and its SEC-02 duplicate reference), AUTH-06, AUTH-09, and AUTH-10 are now **IMPLEMENTED** — see the updated §A table above for each item's specific resolution and the corresponding "V2.1 Step 6 — Authentication & Registration Implementation Notes" section of `docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md` for the full technical account (architecture, security decisions, existing-user migration handling, 44 new tests, live verification results).

Two items in this category remain open, unchanged by Step 6, exactly as this register originally classified them:
- **AUTH-04** (SMS gateway) remains `EXTERNAL_CONFIGURATION` — Step 6 built the abstraction (`SmsProviderFactory`) a real gateway plugs into, but connecting one is a business/credentials decision this register never expected engineering to resolve on its own.
- **AUTH-07/AUTH-08** (self-service account deletion/data export) remain `MISSING`, still targeted at V2.2 — genuinely out of Step 6's scope, not overlooked.

This is the first entry in this register to move from a discovered gap to a shipped, tested, live-verified resolution. The rest of §7 (Prioritization), §22–§26 (recommendations), and §27 (Closing Note) above are preserved exactly as originally written — they are the accurate historical record of the audit that made Step 6 P0 in the first place, and remain the correct account of why the work happened in this order, even though AUTH-01 itself is no longer open today.

---

## 30. V2.1 Step 7 Completion Note

**Step 7 — Legal & Trust Foundation is complete**, with each item's disposition split precisely into engineering-complete versus content/legal-review-pending, per this task's own explicit instruction not to conflate the two:

| ID | Item | Engineering | Content/legal disposition |
|---|---|---|---|
| LEGAL-01 | Terms of Service | **IMPLEMENTED** (page framework, template, routing all real and working) | Page deliberately **kept unpublished** — `NEEDS_LEGAL_REVIEW` unchanged. A logged-out visitor gets a correct Persian 404, not the draft content. |
| LEGAL-02 | Privacy Policy | **IMPLEMENTED** — published, with real, factually-grounded content (verified against this codebase's actual data flows, not invented) | The specific data-retention duration is still absent from the page (not fabricated) — `NEEDS_BUSINESS_DECISION` for that one detail only; everything else on the page is final |
| LEGAL-03 | Refund/Cancellation Policy | **IMPLEMENTED** — published, describing real, verified `BookingService` cancellation behavior | Specific refund timeframes/fees remain undecided and are not stated on the page — `NEEDS_BUSINESS_DECISION` for those specifics only |
| LEGAL-04 | Cookie/consent notice | **IMPLEMENTED** as an honest disclosure inside the Privacy Policy, after directly verifying this site sets no non-essential/tracking cookies today | No separate consent-gating banner was built — investigated and found genuinely unnecessary at this site's current, real cookie usage; revisit only if that changes |
| LEGAL-05 | FAQ/Contact/About | **IMPLEMENTED** — all three published with real, product-verified content; Contact delivers to the site's real `admin_email`, no fabricated phone/address | Phone number and physical office address remain unlisted — `NEEDS_BUSINESS_DECISION`, simply omitted rather than invented |
| LEGAL-07 | Review moderation policy | **IMPLEMENTED** as a real FAQ entry ("چطور می‌توانم نوبت خود را لغو کنم؟" and the CRM-privacy FAQ entry cover the adjacent trust questions the audit named) | A dedicated, fuller moderation policy page was not built — the roadmap's own instruction that this "remains a business/product decision" still holds for anything beyond the FAQ-level disclosure now live |
| LEGAL-08 | Data retention policy | Consent/preference **storage seam exists** implicitly via the Privacy Policy's own "دسترسی و ویرایش اطلاعات" section pointing to Contact for deletion/export requests | The actual retention duration is still `NEEDS_BUSINESS_DECISION`, unchanged |
| COM-06 | Refund policy publication (commerce-facing) | **IMPLEMENTED** — same item as LEGAL-03; now linked directly from checkout via `render_refund_policy_link()` | Same content caveat as LEGAL-03 |

AUTH-09 (password reset / auth-page trust link) also received its planned "bundled with AUTH-02" trust-link addition as part of this step's auth-page integration.

No other gap in this register changed status. §7 (Prioritization), §22–§27 (recommendations, closing note), and §29 (Step 6 completion) above remain the accurate historical record and are preserved exactly as written.

---

## 31. V2.1 Step 8 Completion Note

**Step 8 — Professional Verification Evidence & Trust is complete.** PROF-04, ADMIN-03, and SEC-04 are now **IMPLEMENTED**; ADMIN-02 is **PARTIALLY_IMPLEMENTED**, scoped precisely to verification actions only, per this task's own explicit instruction not to build a general admin audit system in this step:

| ID | Item | Disposition |
|---|---|---|
| PROF-04 | Verification evidence trail | **IMPLEMENTED** — full request→evidence→review→decision lifecycle with a real state machine (`unverified→pending→verified/rejected`, `verified↔suspended`, `verified/suspended→revoked`, `revoked→pending`), backed by three new tables (`wp_bc_verification_requests`/`_evidence`/`_history`). `_bc_verification_status` postmeta stays the single source of truth every existing consumer (marketplace listing, own-profile, ranking index) already reads — no second, competing status field was introduced. |
| ADMIN-03 | Verification workflow | **IMPLEMENTED** — `VerificationReviewPage` (a real admin screen under the existing `beauclick` menu, not a raw metabox) gives admins a review queue, evidence links, and approve/reject/suspend/revoke/reinstate actions, each requiring a recorded reason where the state machine calls for one. Gated on `bc_moderate_verification` — a capability that existed in `RoleManager` but had zero usages anywhere before this step. |
| SEC-04 | File upload validation | **IMPLEMENTED** — `EvidenceStorage::store()` validates the real, content-sniffed MIME type (never the client-supplied type or a bare extension), enforces an 8MB cap, checks `is_uploaded_file()` before `move_uploaded_file()`, and writes under a `bin2hex(random_bytes(24))` filename never derived from the original — verified live that a PHP file renamed to `.jpg` is rejected. |
| ADMIN-02 | Admin audit log | **PARTIALLY_IMPLEMENTED**, scoped to verification only — `wp_bc_verification_history` is append-only (application code never updates or deletes a row) and records actor, from/to status, reason, and timestamp for every transition. General admin-action audit logging (B2B approvals, review moderation) remains unbuilt and stays targeted at V2.2, exactly as this register already classified it before this step. |

**Evidence storage — the decision this step had to make, not just implement:** the existing WordPress Media Library (already correctly used for public profile *images*) was deliberately **not** reused for verification evidence, since Media Library attachments get predictable, indexable, hotlinkable public URLs — inappropriate for identity documents/licenses. Evidence instead lives in a protected `wp-content/uploads/bc-verification-evidence/` directory (with `index.php`/`.htaccess` defense-in-depth) whose files are never referenced by a predictable URL anywhere in the codebase; the actual, environment-independent security boundary is `VerificationController::download_evidence()`, which re-checks ownership-or-moderator-capability on every request before streaming a byte — live-verified: a second professional's REST request for another professional's evidence returns `403 bc_forbidden`, while the owner's own request and an authorized moderator's request both succeed.

**Ranking/AI integration required zero code changes** — `Indexer::sync()`'s existing `'verified' === get_post_meta(...)` check already correctly stops treating a suspended/revoked provider as verified, and `beauclick-ai`'s `CatalogContext.php` was confirmed (by direct inspection) to contain no reference to verification status at all, so the AI structurally cannot describe a professional as verified and never receives evidence.

**Known limitation, not a Step 8 regression:** a handful of pre-existing demo-seed professionals (`DemoProvidersSeed`, predating this step) have `_bc_verification_status` set directly via raw postmeta (e.g. one demo professional seeded as `pending`) with no corresponding `wp_bc_verification_requests` row, since they were never submitted through the new workflow. Such a record does not appear in the new admin review queue (which queries the requests table) — there is nothing to review, since no evidence was ever attached. This is a data-provenance artifact of legacy demo seeding, not a defect in the Step 8 code path; every professional created going forward starts `unverified` with no such gap.

The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), and §29–§30 (Step 6/7 completion) above remain the accurate historical record and are preserved exactly as written.

---

## 32. V2.1 Step 9 Completion Note

**Step 9 — Loyalty Tiers + Membership is complete.** The "Loyalty tiers, Membership benefits/entitlements" line item (§28) now has a real, tested, live-verified implementation; COM-05's price-hook stacking risk is **partially resolved** — closed specifically for the Loyalty/Membership case, still open for a hypothetical future Campaigns-needs-the-cart-too scenario:

| Item | Disposition |
|---|---|
| Loyalty tiers | **IMPLEMENTED** — configurable tiers (`wp_bc_loyalty_tiers`), deterministic lifetime-points qualification (never cached, never a second balance), live-verified crossing two real thresholds via 12 real bookings. |
| Membership | **IMPLEMENTED** — plans, active/expired/cancelled state, tier-linked auto-activation, admin manual grant/cancel. Real recurring **billing** is explicitly **not** implemented (no payment/subscription gateway connected) — manual admin grant is the only activation path today, documented on the admin screen itself, not hidden. |
| Benefits/entitlements | **IMPLEMENTED** — a real, typed model (`wp_bc_loyalty_benefits`), two functional types (bonus points multiplier, booking-order discount) plus a descriptive type; live-verified both applying correctly. |
| COM-05 (price-hook stacking risk) | **PARTIALLY_IMPLEMENTED** — see the updated §6 row above. Resolved for Loyalty vs. B2B by structural separation (booking orders never touch the WooCommerce cart), not by building the general "shared hook-ordering contract" originally recommended; that general contract remains a real, open design question only if a *future* feature (e.g. Campaigns) also needs to modify the cart. |

**Business decisions this step deliberately left open, not silently invented:** tier thresholds and names, benefit values (multiplier/discount size), membership pricing and billing period, points expiration policy, and redemption rules. Every value used during this step's own live verification is explicitly test/demo configuration entered through the real admin screen, not a shipped default — see `docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md`'s Step 9 notes for the full list.

The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), and §29–§32 (Step 6/7/8/9 completion) above remain the accurate historical record and are preserved exactly as written.

---

## 33. V2.1 Step 10 Completion Note

**Step 10 — Waitlist + Smart Rebooking + Retention Automation is complete.** BOOK-06, BOOK-04, BOOK-05, DATE-03, NOTIF-03, NOTIF-05 (consumer side), NOTIF-06, and PROF-02 (§6/§28 rows updated above) all now have real, tested, live-verified implementations:

| Item | Disposition |
|---|---|
| NOTIF-03 — Central notification service | **IMPLEMENTED** — new `beauclick-notifications` plugin; every notification-producing feature this step built (Waitlist, Reminders, Rebooking, Retention) goes through one `NotificationService::notify()` dispatch point instead of independent per-feature logic, exactly as the architecture plan's own prerequisite required. Reuses Step 6's SMS abstraction and existing `wp_mail()`/mailer infrastructure verbatim — no second SMS or email system was built. |
| BOOK-06 — Waitlist | **IMPLEMENTED** — `wp_bc_waitlist_entries`, server-validated against real published providers/services, owner-scoped REST (create/list-own/cancel, never trusting a client-supplied id), FIFO deterministic matching (no AI), reacting to a new `beauclick/booking/slot_opened` event fired from the two authoritative "slot became newly available" moments (`cancel_booking()`, `expire_stale_holds()`). The existing atomic `create_booking()` claim remains the sole source of truth — waitlist only ever offers, never reserves; live-verified with a real third, non-waitlisted customer winning a reopened slot ahead of the waitlisted one. |
| BOOK-05 / DATE-03 — Booking reminders | **IMPLEMENTED** — hourly `ReminderScheduler`, 23–25h matching window, no new table (relies entirely on `NotificationService`'s own idempotency), structurally excludes cancelled/completed/pending bookings via its own `status='confirmed'` filter. Live-verified: correct recipient, correct channel, correct Jalali-displayed timing, no duplicate on a second sweep. |
| Smart rebooking | **IMPLEMENTED** — daily `RebookingScheduler`, deterministic eligibility (days since last completed visit vs. a configurable interval, no upcoming booking with that provider), per-service interval override via postmeta/filter, platform default clearly marked `NEEDS_BUSINESS_DECISION`. Live-verified: eligible customer notified, ineligible/has-upcoming-booking customer correctly skipped, no duplicate across repeated sweeps. |
| Retention automation | **IMPLEMENTED** — daily `RetentionScheduler`, one bounded aggregate query (not a per-customer scan), configurable inactivity window (`NEEDS_BUSINESS_DECISION` default), capped to at most once per calendar month per customer via the idempotency key itself. Live-verified: genuinely inactive customer nudged, customer with any upcoming booking never a false positive, preference-disabled customer's notification correctly suppressed (row created as `suppressed`, never actually delivered). |
| BOOK-04 — No-show handling | **IMPLEMENTED** — `BookingService::mark_no_show()`, confirmed→no_show only after the slot has genuinely ended, reuses the exact same owning-professional-or-admin gate `/confirm` already established, event logged, deliberately zero customer notification (internal bookkeeping, not customer-facing). Live-verified end to end through the real REST controller as the owning professional. |
| NOTIF-05 / NOTIF-06 / PROF-02 — SMS + preferences | **IMPLEMENTED** — 4 togglable categories (reminder/waitlist/rebooking/retention), opt-out model, transactional-vs-promotional distinction preserved (`retention` is the only promotional category; real booking confirm/cancel mail stays outside the preference system entirely, never disableable). Live-verified: toggling a category off in the real Account-tab UI persists across reload and provably suppresses delivery (`PreferenceService::is_enabled()` confirmed `false` server-side). |
| Race-condition safety | **Verified, not just designed** — a dedicated live test proved a non-waitlisted customer can still claim a reopened slot ahead of a waitlisted one; the waitlist system never introduces a second locking model alongside the booking engine's existing atomic claim. |
| Notification idempotency | **Verified, not just designed** — every scheduler re-run (reminder, rebooking, retention) produced zero duplicate rows, backed by a real `UNIQUE (idempotency_key)` constraint (insert-before-dispatch, not dispatch-then-record). |

**A real, self-caught bug fixed during this step (not present in the shipped final state):** `sent_at` was briefly stored as MySQL's zero-date (`0000-00-00 00:00:00`) instead of a genuine SQL `NULL` for failed deliveries — passing PHP `null` through a `%s` `$wpdb->prepare()` placeholder for a nullable `DATETIME` column does not reliably produce a real `NULL`. Fixed by only including `sent_at` in the `UPDATE` at all on an actual `'sent'` status; verified both by the notifications test suite and a fresh live `notify()` call.

**A second polish fix, caught live during QA:** the idempotency mechanism's expected, frequent "duplicate — already handled" path (a `$wpdb->insert()` hitting the `UNIQUE (idempotency_key)` constraint on purpose) was printing raw MySQL duplicate-key errors on every hit, since this is a routine, successfully-handled outcome rather than a real error. Fixed by wrapping that specific insert in `$wpdb->suppress_errors()`/restore; re-verified the full 533-test backend suite still passes and a repeated scheduler run remains silent and correctly duplicate-free.

**Business decisions this step deliberately left open, not silently invented:** rebooking interval (default 30 days, `NEEDS_BUSINESS_DECISION`, overridable per-service and globally via filter), retention inactivity window (default 60 days, same status), waitlist notification batch size/cooldown (5 entries, 30 minutes — engineering defaults chosen for a testable, bounded policy, not commercial policy), and notification category set/wording. Every value is clearly marked in code and documented here, not presented as final policy.

**Deliberately deferred, per the task's own scoping instructions:** a full in-app notification bell/center (only the reusable backend history was built — NOTIF-04 stays open); real rescheduling (BOOK-03 — no shared-infrastructure need with Waitlist was found, so it was not pulled forward); Campaign Engine, Financial/Payout, Realtime Communication, Native Mobile, AI-for-Professionals, and Multi-vendor Marketplace — none started, matching the explicit stop condition for this step.

The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), and §29–§32 (Step 6/7/8/9 completion) above remain the accurate historical record and are preserved exactly as written.

---

## 34. V2.1 Final Release Audit Note

A complete release-candidate audit of all six V2.1 steps (5–10) was performed at commit `6796f4230d26b539aaa0204b6d42aa0a54432506`, ahead of a planned `v2.1.0` tag. Full detail lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.1 Final Release Audit" section; this note records only what materially changed in this register as a result:

| Item | Change |
|---|---|
| SEC-03 | **Amended, not newly broken** — see the updated §6 row above. The audit found `RestController::route()`'s permission-callback guard never actually fired for the route shape every real controller uses; every real route already had `permission_callback` regardless, so this was a dead safety net, not a live gap. Fixed and regression-tested during the audit. |
| Steps 5, 6, 7, 8 | Independently re-audited (not just re-read) against real code/tests/live data. **No release blocker found in any of the four.** One real, low-severity, non-blocking gap was found in Step 6 (AI panel's logged-out CTA still linked to `wp-login.php` instead of `/auth/`) and fixed same-pass. |
| Test suite | 533/533 → **535/535** (2 new regression tests for the SEC-03 fix). Frontend 27/27, TypeScript, and build all remained clean. |

**No other item in this register changed status as a result of this audit** — every other `IMPLEMENTED`/`MISSING`/`EXTERNAL_CONFIGURATION`/`NEEDS_BUSINESS_DECISION` classification already in this document was independently re-confirmed accurate, not altered.

**Release decision: V2.1 READY FOR RELEASE.** Per the audit's own explicit instruction, no `v2.1.0` tag was created — this is a recommendation pending explicit approval, not a unilateral action.

**Post-report update:** `v2.1.0` was subsequently tagged and released on GitHub, pointing to commit `d1445092977ab6a9f95bd50221e43ef761ac2b91`, after explicit approval.

---

## 35. V2.2 Roadmap Assignments

Full rationale for every decision below lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Strategic Roadmap & Architecture Plan" section. This table is the authoritative per-ID assignment, following the same convention §28 established for V2.1: the `Target` column inside the §6 tables above stays as originally written and should be read together with this table, not edited row-by-row.

**Important context this table depends on:** the original V2 planning document's own "V2.2" (a central Notifications service + Waitlist + Smart Rebooking + Retention automation) was actually delivered inside **V2.1 Step 10**, not V2.2 — see that document's own "Post-Audit V2.1 Reprioritization" and new "V2.2 Strategic Roadmap" sections for why. Every ID below reflects the *real* remaining gap set, not a renumbering of the original plan.

| ID | Item | Assigned to | Disposition |
|---|---|---|---|
| ANLYT-02 | Search events not logged | **V2.2 Step 11** (Analytics & BI Foundation) | Product development |
| ANLYT-03 | Checkout-funnel events not logged | **V2.2 Step 11** | Product development |
| ANLYT-04 | No admin-facing analytics dashboard | **V2.2 Step 11** | Product development |
| ANLYT-05 | No CRM/Journey usage measurement | **V2.2 Step 11** | Product development |
| SEO-01 | No meta description/OG tags on marketplace/profile/product pages | **V2.2 Step 12 ✅ Done** | Product development |
| SEO-02 | No XML sitemap | **V2.2 Step 12 ✅ Done** | Product development |
| SEO-03 | No structured data (LocalBusiness/Service schema) | **V2.2 Step 12 ✅ Done** | Product development |
| SEO-04 | No canonical URLs | **V2.2 Step 12 ✅ Done** | Product development |
| Referral | No referral code/reward mechanism (deferred from V2.1 Step 9, not previously its own register ID) | **V2.2 Step 12 ✅ Done** | Product development — reward structure itself remains `NEEDS_BUSINESS_DECISION` (see §37); a provisional, filterable engineering default was used, not a final policy |
| ADMIN-01 | General admin shell/branding polish | **V2.2 Step 13** (Admin Platform & Operations Maturity) | Product development |
| ADMIN-02 | Admin audit log scoped to verification only | **V2.2 Step 13** (extend to general-purpose) | Product development |
| ADMIN-04 | (Referenced in §7 P2 alongside ADMIN-01; no dedicated §6 row exists — folded into the general admin-platform assessment) | **V2.2 Step 13** | Product development |
| A11Y-03 | No automated accessibility testing (axe-core/Lighthouse CI) | **V2.2 Step 13** (opportunistic, folded into tooling maturity work) | Product development |
| AUTH-07 / PRIV-02 | No self-service account deletion | **V2.2 Step 14** (Account Privacy & Data Control) | Product development |
| AUTH-08 / PRIV-03 | No self-service data export | **V2.2 Step 14** | Product development |
| PRIV-04 / LEGAL-08 | Data retention/anonymization policy undefined | **V2.2 Step 14 builds the mechanism**; the policy itself remains `NEEDS_BUSINESS_DECISION` | Split |
| BOOK-03 | Rescheduling — no reschedule action exists | **V2.2 Step 15 ✅ Done** (Booking Evolution: Rescheduling + Receipts) | Product development |
| COM-04 | No order/booking invoice or receipt PDF | **V2.2 Step 15 ✅ Done** | Product development |
| PROF-05 | No multi-staff business permission model | **V2.2 Step 16 ✅ Done (minimal model)** — a single flat "staff" role, owner-only management, wired into CRM + own-analytics only; a real capability matrix remains `NEEDS_BUSINESS_DECISION` | Product development |
| PROF-03 | Professional portfolio section still a V1-era placeholder | **Still MISSING — not resolved by Step 16.** Not named in Step 16's actual task text (unlike the older architecture-plan draft); per that task's own "do not implement a feature just because its name exists in an old document" instruction, deliberately not built. Remains open, target V2.3+ | Product development |
| — (deferred from V2.1 Step 5, no dedicated register ID) | CRM note edit/delete, frontend pagination UI | **V2.2 Step 16 ✅ Done** | Product development |
| ANLYT-06 | No professional/business-facing analytics dashboard | **V2.2 Step 16 ✅ Done** — `MyAnalyticsController`/`MetricsService::for_provider()`, ownership-scoped via `ProviderLookup`/`StaffService`, zero second analytics engine | Product development |
| — (found during V2.2 Step 16's own research, no prior register ID) | No way for a real professional to create their own availability slots (`wp_bc_availability_slots` had exactly one writer in the codebase — a dev-only demo seed) | **V2.2 Step 16 ✅ Done** — `AvailabilityService`/`AvailabilityController`, a real self-service slot manager, single + bulk-generate | Product development |
| — (found during V2.2 Step 16's own research, no prior register ID) | B2B quote-request/accept flow has no UI anywhere (backend complete since V2.1, `/b2b/` page only has the wholesale-catalog direct-purchase flow) | **MISSING, deliberately deferred** — a real, confirmed, but out-of-scope gap for Step 16; target V2.3+ | Product development |
| NOTIF-04 | In-app notification center (full bell/unread UI) | **Evidence-gated — not assigned to V2.2.** Backend history already exists (V2.1 Step 10); revisit once V2.2 Step 11's analytics can show whether the existing simple list already serves the real need | Deferred pending evidence |
| MKT-02 | Search typo tolerance / fuzzy matching | **Deferred past V2.2** — no evidence of a real query-quality problem; matches the architecture plan's own "no Elasticsearch/Meilisearch without measured evidence" stance | Deferred pending evidence |
| AI-03 | AI cost/usage visibility | **V2.3** — only matters once a real paid AI provider is configured; bundle with whichever V2.3 step first does that | Deferred to V2.3 |
| COM-05 | Price-hook stacking risk for a future third price-modifying feature | **Addressed as the first sub-step of V2.3's Campaign Engine work**, not a standalone V2.2 step — see the architecture plan's "Pricing Orchestration" analysis for why building it in V2.2 would be premature (nothing in V2.2 touches pricing) | Deferred to V2.3, scoped |
| Campaign/Promotion Engine, AI-for-Professionals (AI-05), Financial/Payout | Zero-to-weak foundation, real business/gateway decisions pending | **V2.3**, unchanged from the original architecture assessment's own risk analysis | Product development, V2.3 |
| Realtime Communication, Multi-Sided Marketplace, Native Mobile | No evidence of real need | **V2.4+, evidence-gated** — unchanged | Deferred pending evidence |

**No item in this table was pulled into V2.2 merely because an old document listed it there** — every assignment above traces to either a still-open, currently-verified gap-register row or a genuinely new item discovered during this planning pass (Referral, the CRM polish items), per this task's own explicit "challenge the existing roadmap" instruction.

**Business decisions this table deliberately leaves open, not silently resolved:** referral reward structure, exact data-retention windows/anonymization policy, rescheduling limits/cutoff windows, and multi-staff permission granularity. All are named explicitly in the architecture plan's own V2.2 section, not invented as engineering defaults.

---

## 36. V2.2 Step 11 Completion Note

**Step 11 — Analytics & BI Foundation is complete.** ANLYT-02, ANLYT-03, ANLYT-04, and ANLYT-05 (§6/§35 rows updated above) now have real, tested, live-verified implementations. Full technical detail — event/metric definitions and sources, database decision (deliberately zero new tables), API shape, admin dashboard, security, performance, tests, live verification, and the one real bug found and fixed (a mobile horizontal-overflow issue in the date-range picker) — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Step 11 — Analytics & BI Foundation Implementation Notes" section.

**What this step deliberately did not build, and why:** a professional/business-facing "my own analytics" view (out of this step's own scope per its task's §21 — a platform-admin foundation, not a full BI product; **now formally assigned to V2.2 Step 16 as ANLYT-06**, rather than left as an undated "later step" — see that step's row in §35 and the architecture plan's "Step 11 vs. Step 16" subsection), a pre-aggregated daily-metrics cache table (current event volume doesn't justify one — see the architecture plan's own reasoning), and any new infrastructure (no Redis/Kafka/Elasticsearch/data warehouse — matching this task's own explicit "no infrastructure overreach" instruction and the architecture plan's pre-existing "no architecture evolution required for V2.2" conclusion).

**A genuinely new, pre-existing documentation-drift finding, not a Step 11 defect:** `waitlist_joined` and `membership_activated` were found already logged as real events in the live database (Steps 9/10), despite not being listed in `EventLogger`'s own docblock comment. Not fixed here — out of this step's own scope — but recorded so it isn't mistaken for something Step 11 broke or missed.

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§35 (V2.1/V2.2 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 37. V2.2 Step 12 Completion Note

**Step 12 — Growth & Public Discovery (SEO + Referral) is complete.** SEO-01, SEO-02, SEO-03, SEO-04, and the Referral line item (§6/§35 rows updated above) now have real, tested, live-verified implementations. Full technical detail lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Step 12 — Growth & Public Discovery Implementation Notes" section — including three real bugs found and fixed during this step's own live verification (a duplicate `<link rel="canonical">` tag, the real `<title>` tag never actually being dynamic despite `og:title` already being correct, and a marketplace-canonical branch-ordering bug that silently discarded every city/specialty combination's own canonical) and two WordPress-core sitemap-routing gotchas (the correct registration hook is `wp_sitemaps_init`, not `init`; a provider name may not contain a hyphen under core's own single-segment sitemap rewrite rule).

**Business decision still required, not silently invented:** the referral reward amount (`ReferralConfig::DEFAULT_REFERRER_REWARD_POINTS` / `DEFAULT_REFEREE_REWARD_POINTS`, both 50 points, both filterable via `beauclick/referral/referrer_reward_points`/`referee_reward_points`) is an explicitly provisional engineering default in the same style as `beauclick-loyalty`'s own `EarningRules::POINTS_*` constants — `NEEDS_BUSINESS_DECISION`, unchanged from how this register already classified "referral reward structure" since V2.1 Step 9 first deferred it.

**What this step deliberately did not build, and why:** new pretty URLs for city/specialty pages (the existing query-string marketplace filtering already supports correct canonical/sitemap/structured-data treatment; adding rewrite rules would add an activation-flush-timing risk for a URL-structure change with no functional SEO benefit over what was actually built — see the architecture plan's own reasoning), a referral reward-amount decision (provisional default only, per above), a hard cap on referral volume per user or any additional anti-fraud heuristics beyond self-referral prevention (structural) and single-attribution-ever (`UNIQUE` constraint) — the task's own "do not build a sophisticated fraud platform" instruction, and reward-on-genuine-qualifying-transaction-only already limits low-effort abuse — and automatic reward clawback on a later refund of the qualifying order (documented as a known limitation, not attempted).

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§36 (V2.1/V2.2 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 38. V2.2 Step 13 Completion Note

**Step 13 — Admin Platform & Operations Maturity is complete.** ADMIN-01 and ADMIN-02 (§6/§35 rows updated above) are now **IMPLEMENTED**; ADMIN-04 is **PARTIALLY_IMPLEMENTED** by deliberate scope decision (WooCommerce's own order admin stays authoritative); A11Y-03 is **PARTIALLY_IMPLEMENTED** (the React app-shell's own Vitest pipeline, not BeauClick's PHP-rendered admin pages). Full technical detail lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Step 13 — Admin Platform & Operations Maturity Implementation Notes" section — including a real WordPress-core bug found and fixed during this step's own live verification (`add_submenu_page()`'s `$position` argument is not a stable global sort key; the actual fix was controlling each page's `admin_menu` hook priority instead), a missing audit-log action label (`verification_pending`), and a pre-existing `NotificationsAdminPage` Jalali-formatting inconsistency (the one admin page not already using the shared `JalaliDate` formatter).

**A new role, not a new capability:** per this register's own repeated "prefer a small, understandable capability model" standard, this step added zero new fine-grained capabilities — every page still checks the same `bc_manage_platform`/`bc_moderate_reviews`/`bc_moderate_verification` set. What it added is `RoleManager::ROLE_PLATFORM_OPERATOR` (`bc_platform_operator`, holding only `read` + `bc_manage_platform`), so BeauClick operations staff no longer need to be full WordPress Administrators (who can also install plugins and edit theme/plugin files) just to reach the BeauClick admin surface. `bc_moderator`/`bc_support` also gained the `read` capability they were both genuinely missing, re-using the exact `ensure_role()`/`maybe_register()` safety pattern this register has tracked since the original stale-role discovery.

**What this step deliberately did not build, and why:** a dedicated BeauClick Bookings/Orders admin screen and a dedicated Professional/Business admin list page (WooCommerce's native order admin and the existing CPT list tables/Verification page already cover this — building either would duplicate an existing subsystem, which this step's own task instructions explicitly warned against); any new REST API surface (every new/modified page is classic wp-admin + `admin-post.php`, matching every existing BeauClick admin page's own established convention for low-frequency internal tooling); automated accessibility testing for admin (PHP-rendered) pages specifically (would require new browser-automation infrastructure this project doesn't otherwise have — an opportunistic tooling addition is not sufficient justification to introduce it); and any live external-service reachability probing on the new Operations & Health page (would mean real outbound API calls on every admin page load, and still wouldn't be trustworthy "healthy" evidence for a payment/SMS/AI provider — the page instead honestly distinguishes "configured" from "verified," never claiming the latter).

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§37 (V2.1/V2.2 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 39. V2.2 Step 14 Completion Note

**Step 14 — Account Privacy & Data Control is complete.** AUTH-07, AUTH-08, PRIV-02, and PRIV-03 (§6 rows updated above) are now **IMPLEMENTED**; PRIV-04 (and its LEGAL-08 duplicate) moves from "no mechanism, no policy" to "real mechanism built, policy specifics still `NEEDS_BUSINESS_DECISION`/`NEEDS_LEGAL_REVIEW`" — the meaningful distinction this register has drawn since the original Legal audit between engineering-complete and policy-pending. Full technical detail — the delete/anonymize/retain matrix for all nine data-holding domains, the admin-reviewed deletion state machine, export packaging/security, and two real bugs found and fixed during this step's own live verification — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Step 14 — Account Privacy & Data Control Implementation Notes" section.

**The core architectural decision, worth restating here since it's why this step didn't balloon into touching every domain's schema:** the customer's WP user row is anonymized in place (`AccountEraser::forget()`), never hard-deleted. Because every domain's existing display code already resolves identity through `get_userdata()` and already tolerates a missing/placeholder user gracefully, retained records (bookings, reviews, CRM notes about the customer, referral history) needed **zero code changes** to correctly display "کاربر حذف‌شده" afterward — the anonymization propagates for free everywhere a user id is the only link.

**Two real bugs found only through actual browser click-throughs, not code review or the (necessarily mocked) test suite:** (1) the new OTP purpose value silently exceeded `wp_bc_otp_requests.purpose`'s `VARCHAR(20)` width, and `OtpService::request_otp()`'s unchecked `$wpdb->insert()` return value let the failure pass completely unnoticed — a real SMS sent, `ok: true` returned, and no row for `verify_otp()` to ever find, permanently breaking the confirmation flow behind an apparently-successful response; (2) the export download link, built without a REST nonce, hit WordPress core's own cookie-auth CSRF guard and 401'd for the legitimate owner too. Both are documented as a caution for future steps: a synthetic/mocked test can prove a code path is *reachable* without proving it's *reachable correctly* — only clicking the real, rendered link in a real browser surfaced either bug.

**What this step deliberately did not build, and why:** any self-service path for a professional/business account (§7's own explicit customer-only scope — a future step's concern if the product ever needs it); automatic time-based purging of anonymized-but-retained records or historical WooCommerce order billing PII (the retention *policy* remains undecided, per PRIV-04 above — this step built the mechanism a policy would use, not the policy itself); and any queue/job-runner infrastructure beyond the WP-Cron sweep pattern every other scheduler in this codebase already uses (deletion processing is resumable and bounded without needing one).

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§38 (V2.1/V2.2 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 40. V2.2 Step 15 Completion Note

**Step 15 — Booking Evolution: Rescheduling + Receipts is complete.** BOOK-03 and COM-04 (§6/§35 rows updated above) now have real, tested, live-verified implementations. Full technical detail — the atomic reschedule algorithm, the receipt architecture and its WooCommerce-order-as-source-of-truth discipline, a real reminder-idempotency fragility found and fixed before any live bug occurred, database/API/UI changes, security, performance, tests, and live verification results — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Step 15 — Booking Evolution: Rescheduling + Receipts Implementation Notes" section.

**Scope decision, worth restating here:** rescheduling is deliberately limited to same booking + same provider + same service + a different slot only, per this task's own explicitly named "minimum safe scope" (§10 of the task). Service change, provider change, and any resulting price/payment interaction are **not built** — `NEEDS_BUSINESS_DECISION`, not invented. Because price never changes in this scope, no new payment/refund logic was needed and the existing linked WooCommerce order is simply carried over untouched.

**A real fragility found and fixed before it ever caused a live bug, not discovered by accident:** `ReminderScheduler`'s notification idempotency key has no time component, confirmed by reading `NotificationService::dispatch_one()`'s key construction during this step's own research pass (before any reschedule code was written) — left alone, a reminder already sent for a booking's old appointment time would have silently suppressed the new reminder its new time genuinely needs, as a false "duplicate". Fixed with a new, narrowly-scoped `NotificationService::invalidate()` method (deletes only the exact, already-known idempotency key, never a wildcard scan), called on every successful reschedule; verified by a dedicated test that a fresh reminder does fire for the new time after the old one already fired for the old time.

**What this step deliberately did not build, and why:** service/provider change support (out of the named minimum-safe-scope); any cancellation-fee logic (none exists anywhere in this codebase to interact with — confirmed by research, not assumed); a visual drag-and-drop professional calendar (Step 16/professional-platform territory, if ever pursued); PDF receipt generation (printable HTML is the task's own named "first safe scope"); and a reschedule-specific admin analytics dashboard (the three new event types are logged and queryable, but `MetricsService`'s dashboard UI was not extended — "do not build a dedicated BI dashboard in this step unless genuinely necessary," per the task's own §15).

**One pre-existing, unrelated finding, not a Step 15 defect:** `composer lint` (`phpcs.xml.dist`) fails on short-array-syntax style across essentially the entire existing codebase, confirmed by running it against a completely untouched file (`BookingService.php`) with identical results — this project has apparently never had a clean `composer lint` run. Not fixed here (a large, unrelated diff, out of this step's own scope); `php -l` and the full PHPUnit suite (680/680) are unaffected.

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§39 (V2.1/V2.2 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 41. V2.2 Step 16 Completion Note — and V2.2 Complete

**Step 16 — Professional/Business Platform Completion is complete.** ANLYT-06, PROF-05 (minimal model), and the CRM note edit/delete item (§6/§35 rows updated above) now have real, tested, live-verified implementations. Two genuinely new items were discovered during this step's own research (not present anywhere in this register before now, since no prior audit had reason to look): a real, severe operational gap where no professional could create their own bookable availability slot at all, now resolved; and a real, confirmed B2B quote-request/accept UI gap, deliberately left open. Full technical detail — the availability/calendar architecture, the ownership-scoped analytics extension to `MetricsService`, the minimal staff model and its explicit, bounded blast radius, a real dashboard-routing bug found and fixed during live verification, and full live-verification results — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Step 16 — Professional/Business Platform Completion Implementation Notes" section.

**This is also the final step of the V2.2 release plan.** `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Completion Summary" section (immediately following Step 16's own notes) is the authoritative rollup of all six steps' status, test results, known limitations, and remaining business/legal/external-configuration items — not duplicated here to avoid two copies of the same summary drifting apart. No `v2.2.0` tag was created — per every step's own standing instruction, that remains a separate, explicit decision for the product owner, not something any implementation step takes unilaterally.

**Scope decision worth restating here:** portfolio upload — named in the *original*, pre-audit architecture-planning document's own sketch of a future "Step 16" — was **not** built, because it is not named anywhere in the actual Step 16 task this register tracks. Per this register's own repeated standard ("do not implement a feature just because its name exists in an old document," restated explicitly in the real Step 16 task), the register defers to the real, current task text over an earlier planning draft. PROF-03 (portfolio) therefore remains open, unchanged, target V2.3+.

**A real bug found and fixed during this step's own live verification, not by code review:** the theme's dashboard-routing check (`page-dashboard.php`) decided which React bundle to mount based on WordPress role alone — but this step's new staff model deliberately never changes a staff member's role, so a real authorized staff member's session was tested end to end and landed on the customer dashboard despite the backend correctly authorizing them. Fixed by extending the same check to also query the new `StaffService`.

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§40 (V2.1/V2.2 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 42. V2.2 Final Release Audit

**Audit date:** 2026-08-15. **Baseline:** `744d29e`, verified as true `HEAD` matching `origin/master`, clean working tree. Full detail lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Final Release Audit" section — not duplicated here; this entry only records the register-relevant outcome.

**One release-blocking defect found and fixed, not previously caught by this register or any prior step's own completion note:** AUTH-07's "Closed" status (§6/§39) accurately describes that self-service deletion is real and `IMPLEMENTED` — but the underlying `AccountEraser::forget()` had a real gap in *how completely* it freed the deleted identity: it freed the `wp_bc_phone_index` row (confirmed by existing tests) but never the deterministic `wp_users.user_login` (`bc_<digits>`) `AccountResolver::create_customer()` assigns, which WordPress core has no supported API to rename post-creation. A genuine future owner of a previously-deleted account's phone number would have been unable to register at all. Fixed (direct `$wpdb->update()` rename + cache clear), with a new regression test reproducing the real `bc_<digits>` login scheme rather than a factory-random one. AUTH-07/PRIV-02's `IMPLEMENTED` status is unchanged (the feature was and remains real) — this is recorded as a fixed defect within an already-correctly-scoped feature, not a status change.

**Two new follow-up items opened, discovered during this audit's Step 16 re-review, neither release-blocking:**

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| NOTIF-07 | No professional-facing notification-preferences UI | `PreferenceService`/`NotificationsController` is generic (keyed by `user_id`), but the only frontend consumer is the customer dashboard's `AccountTab.tsx` — no equivalent surface exists under `app/src/features/dashboard/professional/` | MISSING | LOW | V2.3 | Reuse the existing generic backend; only a new dashboard tab/section is needed |
| PROF-07 | Staff model is real but narrow (PROF-05 follow-up) | `StaffService`/`wp_bc_business_staff` links real accounts with owner-only add/remove, but only one flat `staff` role and only two wired surfaces (CRM, Analytics) — not booking confirm/cancel/reschedule, not reviews, not services | PARTIALLY_IMPLEMENTED | LOW | V2.3 | Acceptable if the current two-surface scope is a deliberate product decision; expand surface coverage or add role granularity only if real usage shows a need |

**Everything else re-audited (Steps 11–13, 15; cross-cutting security/authorization; database/migrations; Persian/Jalali; V2.3 boundary) confirmed clean — no new gap-register entries required.** Test suite at this audit's completion: backend **725/725** (724 baseline + 1 new regression test for the AUTH-07 fix), frontend **38/38**, unchanged otherwise from the Step 16 completion baseline.

**Final decision: `V2.2 READY FOR RELEASE`** (no `v2.2.0` tag created — a separate, explicit next step).

---

## 43. V2.3 Discovery + Gap Audit — New and Re-Confirmed Findings

**Audit date:** 2026-08-15. **Baseline:** `9c980ab` (`v2.2.0`, `master`, matching `origin/master`, clean tree). Full rationale and codebase citations for every row below live in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.3 Discovery, Gap Audit & Roadmap Definition" section — not duplicated here. This section records only the register-relevant outcome: new IDs assigned, and status changes to existing IDs.

### New findings, not present in any prior version of this register

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| FIN-01 | No commission/payout/settlement/earning-for-professional concept exists anywhere in the codebase | Confirmed by exhaustive search — zero hits for `commission\|payout\|earning\|settlement` (professional-payout sense) across every plugin | MISSING | HIGH | V2.3 Step 18 | Build the Financial Ledger + manual Settlement workflow described in the architecture plan's Financial Truth table — no payment-gateway dependency for this part |
| FIN-02 | Booking cancellation triggers no refund logic of any kind | `BookingService::cancel_booking()` only updates status and sends mail; the only `wc_create_refund()` call anywhere is one narrow paid-but-unconfirmable-hold edge case | MISSING | HIGH | V2.3 Step 18 | Wire real refund logic into cancellation, gated on the order actually being paid; a real financial-correctness gap, not previously named in this register |
| FIN-03 | `MembershipDiscount` computes its percentage discount in float with `round(...,2)`, despite the platform's otherwise-consistent integer-Toman convention | Small, real, pre-existing inconsistency | MISSING (cleanup) | LOW | V2.3 Step 17/18 | Fix alongside Step 17's own discount-fee logic so the same float-money pattern isn't propagated a second time |
| CAMP-01 | WooCommerce's native coupon system is completely unused — zero code references anywhere in beauclick-* | Not previously characterized this precisely (prior audits said "no coupons configured," implying dormant wiring; there is in fact no wiring at all) | INFORMATIONAL | — | — | A genuine blank slate — no entanglement risk for a future campaign engine to design around |
| CAMP-02 | B2B quote acceptance (`QuoteService::accept()`) is a third order-creation path that bypasses the WooCommerce cart entirely, like bookings — but unlike bookings, it has zero discount-hook integration today | Confirmed by code trace; not named in any prior planning document | INFORMATIONAL / MISSING | LOW | V2.3 Step 17 | Include B2B quote orders as a target for Step 17's order-level campaign fee, alongside booking orders |
| CAMP-03 | No audience-segmentation/cohort service exists anywhere; `MetricsService` is aggregate-only (counts/sums), never a queryable user-id set | Confirmed by code inspection | INFORMATIONAL | — | — | Scopes Step 17's campaign eligibility rules to simple, direct-query predicates (first booking, returning customer, active tier) rather than requiring new segmentation infrastructure |
| AI-06 | `wp_bc_ai_conversations` has `UNIQUE KEY (user_id)` with no `provider_id`/mode dimension — a professional-mode AI feature cannot safely reuse this table without risking context bleed with the user's own customer-mode AI history | Confirmed by reading the actual migration | MISSING (architectural prerequisite) | MEDIUM | V2.3 Step 19 | Build a new, separate `wp_bc_ai_professional_conversations` table rather than modifying the existing, live, working customer table |
| B2B-01 | B2B quote-request/accept UI still completely missing on the frontend, despite the backend (`/b2b/quotes*`, `QuoteService`) being complete and live since V2.1 | Confirmed unchanged — `page-b2b.php` has zero quote-related UI, only the direct wholesale-purchase flow | MISSING | MEDIUM | V2.3 Step 20 | Pure frontend work against an already-complete backend — cheap, contained, high value |
| ADMIN-05 | `POST /b2b/accounts/{id}/approve` and `/reject` REST endpoints bypass `AuditLogger` entirely — a second, reachable path to an already wp-admin-audited action that isn't logged when reached via REST | Confirmed by code trace; not previously flagged | MISSING (audit gap) | LOW | V2.3 Step 20 | Add the missing `AuditLogger::record()` call; verify no equivalent gap exists elsewhere before considering the fix complete |
| UX-01 | Customer dashboard has its own `ready: false` placeholder — a "wishlist" tab (`dashboard-customer.tsx:18`) — not previously named in this register | Confirmed real, low severity | MISSING | LOW | V2.4 | Real but unrelated to V2.3's monetization/growth theme; bundle opportunistically with Portfolio (PROF-03) in V2.4 |
| ANLYT-07 | ~10 real event types (`membership_cancelled/expired`, `response_time_seconds`, `message_sent`, `review_submitted`, `b2b_account_applied/*`, `b2b_quote_requested/accepted`, `booking_confirm_after_expiry_conflict`, `goal_created`, plus `booking_reschedule_requested/failed`) are logged via `EventLogger` but never read by `MetricsService` | Confirmed by call-site inventory; extends the two cases (`waitlist_joined`, `membership_activated`) already flagged in §36 | MISSING (instrumentation drift, informational) | LOW | Opportunistic | No action required now; pick up cheaply whenever a step already touches the relevant plugin (e.g., Step 17/20's B2B work could add `b2b_quote_*` to analytics at near-zero cost) |

### Status changes to existing IDs

| ID | Prior status | New status | Why |
|---|---|---|---|
| MKT-02 | "Search is plain SQL LIKE-based... no fuzzy/typo-tolerant matching" | **Reframed, more severe**: `MarketplaceController::browse()` has **no free-text query parameter of any kind** — only structured filters (city/specialty/price/rating) exist. Fuzzy matching remains correctly deferred past V2.3, but basic text search is a real, materially larger, and cheaper-to-fix gap than previously characterized | V2.3 Step 20 adds basic `LIKE`-based search; fuzzy/typo-tolerance remains evidence-gated beyond that |
| PROF-03 | "Portfolio section... still reads placeholder copy" | **Confirmed worse than a placeholder string**: no upload endpoint, no upload UI, no portfolio tab in the professional dashboard nav at all — only an admin-facing CPT and a public empty-state template | Recommended **V2.4** (not V2.3) — real, but not core to V2.3's monetization theme |
| PROF-07 | "Staff model real but narrow... V2.3" | Remains open, still narrow (one flat role, CRM+Analytics only); **new consideration** — Step 18's Financial Ledger must default staff visibility to owner-only, not silently extend staff scope to financial data | Remains evidence-gated / deferred; the new consideration is a constraint on Step 18, not a reason to build PROF-07 itself in V2.3 |
| NOTIF-04 | "Evidence-gated... revisit once Step 11's analytics can show whether the existing simple list already serves the real need" | Unchanged — still just a plain list, still no bell/unread-count UI anywhere; Step 11's analytics foundation now exists and *could* answer the engagement question with real data, but doing so is a measurement task, not something this planning-only audit performed | Remains evidence-gated, unchanged |
| COM-05 | "Partially resolved... addressed as the first sub-step of V2.3's Campaign Engine work" | **Resolved by this planning pass** — the Pricing Orchestration Decision (order-level fee only, never the cart, fixed Membership→Campaign fee order) is made explicitly in `VERSION_2_ARCHITECTURE_PLAN.md`'s new V2.3 section | Closed as a planning decision; Step 17 implements it |

**No other item in this register changed status as a result of this audit** — every other classification already in this document (including every `IMPLEMENTED`, `EXTERNAL_CONFIGURATION`, and `NEEDS_BUSINESS_DECISION`/`NEEDS_LEGAL_REVIEW` row) was independently re-confirmed accurate by the parallel codebase audits, not altered. Per the task's own explicit instruction: **this is a planning/audit document only — no application code, migration, REST endpoint, or frontend feature was implemented as part of producing this section.**

---

## 44. V2.3 Step 17 Completion Note

**Step 17 — Pricing Orchestration + Campaign Engine (Phase 1) is complete.** COM-05 (already closed as a planning decision, §43) is now backed by a real implementation. FIN-03 is **IMPLEMENTED** (fixed). CAMP-01 and CAMP-03 are unchanged, informational findings — both correctly shaped Step 17's design exactly as recommended (no coupon integration attempted; eligibility limited to simple, direct-query predicates, no segmentation infrastructure built). Full technical detail — schema, the no-compounding pricing math, idempotency, usage-release semantics, the two small in-scope fixes to `MembershipDiscount`/`ReceiptPresenter`, tests, and live QA results — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.3 Step 17 — Campaign & Promotion Engine (Phase 1) Implementation Notes" section.

| ID | Item | Disposition |
|---|---|---|
| COM-05 | Pricing-hook stacking risk for a future third price-modifying feature | **IMPLEMENTED** — Campaign Phase 1 ships as an order-level fee only, fixed Membership→Campaign application order, both computed independently against the pre-discount subtotal, a final clamp preventing a negative total regardless of configuration. Live-verified with a real stacked booking (10% membership + 15% campaign → correct 750,000 from a 1,000,000 base, not a compounded 76,500 or similar) and a deliberately aggressive 60%+60% clamp test. |
| FIN-03 | `MembershipDiscount` float-money percentage calculation | **IMPLEMENTED** — fixed to integer math against `get_subtotal()`, matching Campaign's own convention, as this register's own §43 recommendation specified. |
| CAMP-01 | WooCommerce coupons unused | Unchanged, informational — confirmed still true; Step 17 does not integrate with coupons, per the original recommendation. |
| CAMP-02 | B2B quote acceptance has zero discount-hook integration | **Deliberately NOT resolved in Step 17 — a documented deviation from this register's own §43 recommendation.** That recommendation ("include B2B quote orders as a target for Step 17's order-level campaign fee") assumed a hook seam existed or would be added; implementation found `QuoteService::accept()` fires no filter/action hook of any kind, and adding one would require modifying `beauclick-b2b` itself — a real scope expansion beyond "smallest real campaign mechanism," and the task's own §12 explicitly permits excluding B2B when support isn't strictly required. B2B quote orders remain untouched by any campaign logic; `TierPricingEngine` wholesale pricing confirmed unaffected by a live test. Remains open — a real, contained candidate for a future Campaign Phase 2 or a dedicated small step, if B2B promotional demand is ever evidenced. |
| CAMP-03 | No segmentation/cohort service | Unchanged, informational — confirmed still true; Step 17's `customer_scope` (`all`/`first_booking`/`returning`) is implemented as two direct, cheap `wp_bc_bookings` queries, exactly as recommended, no new infrastructure. |

**A real, newly-discovered fact about `beauclick-payments`, not a Step 17 defect:** `Payments\Plugin::attach_order_to_booking_result()` (priority 10 on `beauclick/booking/after_create`) has no idempotency of its own — every filter fire unconditionally creates a new WooCommerce order via `wc_create_order()`. This was not previously named as a gap anywhere in this register (no prior step needed to re-fire this filter for the same booking to notice). Not a defect Step 17 needed to fix — booking creation is a normal, single-fire REST request in real usage, and Step 17's own `UNIQUE(booking_id)` usage constraint already guarantees a campaign discount is granted at most once per booking regardless. Recorded here as a documented, informational finding only, in case a future step's own retry/idempotency assumptions about this filter need it.

**What this step deliberately did not build, and why:** any REST API surface (classic wp-admin + `admin-post.php` instead, matching `LoyaltyAdminPage`'s own precedent for admin-authored promotional-economics configuration — no customer-facing surface ever needs a campaign id); discount stacking beyond exactly one campaign per booking; any cart-based/Shop-browsing promotion (Phase 2, still evidence-gated); a `campaign_qualified`-style analytics event distinct from `campaign_applied` (would be a hollow signal with no stacking model to make it meaningful); any new capability beyond reusing `bc_manage_platform` (per `RoleManager`'s own "prefer a small model" precedent).

**Known, disclosed limitation in this step's own verification:** a dedicated 375px mobile-viewport live check of the admin campaign page could not be completed — the browser automation tool became unresponsive after desktop verification (admin lifecycle, audit log, and the full real booking → checkout → order-received → receipt flow) was already captured successfully. Not claimed as verified; the admin table reuses the same `overflow-x:auto` pattern already mobile-audited in V2.2 Step 13, and the customer-facing changes introduce no new CSS, but this remains a real, named gap rather than a fabricated pass.

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§43 (V2.1/V2.2/V2.3 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 45. V2.3 Step 18 Completion Note

**Step 18 — Financial Ledger & Manual Settlement is complete.** FIN-01 and FIN-02 are now **IMPLEMENTED**. FIN-03 was already closed in Step 17 (§44), unchanged here. Full technical detail — schema, the double-entry decision, commission basis/rate, the FIN-02 refund wiring, settlement integrity, and live QA results — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.3 Step 18 — Financial Ledger & Manual Settlement Implementation Notes" section.

| ID | Item | Disposition |
|---|---|---|
| FIN-01 | No commission/payout/settlement/earning-for-professional concept exists anywhere in the codebase | **IMPLEMENTED** — a real, auditable `wp_bc_ledger_entries` (commission + receivable, append-only) and `wp_bc_settlement_batches`/`_items` (admin-recorded manual settlement) now exist, scoped to booking orders only (Shop/B2B orders confirmed, by test, to correctly produce zero ledger entries — they are direct platform sales with no party to split revenue with). The professional/business `درآمد` tab is real for the first time; the platform admin has a real Financial overview + per-party settlement workflow. Automated payout/disbursement remains correctly out of scope, per the task's own explicit instruction and this register's own Financial Truth table. |
| FIN-02 | Booking cancellation triggers no refund logic of any kind | **IMPLEMENTED** — `BookingService::cancel_booking()` now fires a new `beauclick/booking/cancelled` hook; `beauclick-payments\Plugin::on_booking_cancelled()` issues a real `wc_create_refund()` for the order's own real remaining amount, but only when the order was genuinely paid. Live-verified: cancelling a real, paid, already-settled booking issued a genuine refund and correctly produced a negative (honestly displayed, never silently corrected) outstanding balance. |
| FIN-03 | `MembershipDiscount` float-money percentage calculation | Unchanged — already **IMPLEMENTED** in Step 17 (§44). |

**A genuinely new, previously-unflagged finding, discovered and confirmed correct during this step's own test-writing, not a defect:** re-firing `beauclick/booking/after_create` for the same real booking (the pre-existing `beauclick-payments` order-creation idempotency gap Step 17's own register entry already named) causes the second, spurious order's `payment_complete()` to hit the *pre-existing*, Step-18-independent `handle_paid_but_unconfirmable_booking()` auto-refund path. Step 18's own `RefundRecorder` correctly reacts to that real refund and nets the second order's ledger rows to exactly zero, entirely as a side effect of correctly reacting to real WooCommerce hooks — not something this step specifically designed around, but confirmed correct by a dedicated test. Recorded here as a documented, informational finding, matching Step 17's own precedent for this exact class of discovery.

**What this step deliberately did not build, and why:** any automated payout/disbursement, a real payment gateway, full double-entry accounting, any B2B/Shop financial settlement, a CSV export or general-ledger browser — all explicitly out of scope per the task's own instructions and this register's own standing Financial Truth table.

**Known, disclosed limitation in this step's own verification:** the browser automation tool became unresponsive again near the end of this session (the same category of issue Step 17's own live QA already disclosed) before a dedicated mobile-viewport pass on the admin Financial page specifically, and before a live-browser (as opposed to automated-test) cross-professional adversarial check, could be captured. The professional-facing Revenue tab's own mobile/RTL check (no overflow at 375px) was captured; cross-party isolation is adversarially covered by `MyFinanceControllerTest`. Neither is claimed as live-browser-verified beyond what is disclosed here.

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§44 (V2.1/V2.2/V2.3 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 46. V2.3 Step 19 Completion Note

**Step 19 — AI for Professionals & Businesses (Read-Only Insights) is complete.** AI-06 is now **IMPLEMENTED**. Full technical detail — the new table schema, the provider/route separation decision, context scope and its deliberate exclusions, the security/isolation adversarial testing, and live QA results — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.3 Step 19 — AI for Professionals & Businesses (Read-Only Insights) Implementation Notes" section.

| ID | Item | Disposition |
|---|---|---|
| AI-06 | `wp_bc_ai_conversations` has `UNIQUE KEY (user_id)` with no `provider_id`/mode dimension — a professional-mode AI feature cannot safely reuse this table without risking context bleed with the user's own customer-mode AI history | **IMPLEMENTED** — a new, separate `wp_bc_ai_professional_conversations`/`wp_bc_ai_professional_messages` table pair, exactly as this register's own recommendation specified, with one refinement: keyed on `provider_id` (the owned CPT post id — matching every other Step 17/18-era table's own identity convention) rather than `user_id`, and carrying no `ai_context` column at all, since a professional's data is always rebuilt fresh from real services on every turn rather than accumulated across turns. The existing `wp_bc_ai_conversations` table, its `UNIQUE(user_id)` constraint, and every existing customer-AI test pass completely unmodified. |

**A genuinely new, previously-unflagged finding, confirmed by this step's own live QA:** no real `bc_business` CPT post exists in the local dev database at all (confirmed by direct query, matching this register's own prior findings from the authentication/QA-credential audit earlier in this session) — the professional-AI code path for a business party (`party_type` resolution, `SettlementService`'s business branch) is implemented and unit-tested against a synthetic `bc_business` post, but could not be live-QA'd against a real business account, since none exists to test against. Not a defect in this step — the same architectural gap this register has already named for other business-side features — recorded here so a future step doesn't assume business-side AI was live-verified when it was only unit-tested.

**What this step deliberately did not build, and why:** any autonomous action through the AI surface (booking/campaign/settlement/CRM/verification mutation) — the task's own explicit, structurally-enforced read-only boundary; CRM notes or raw review text in the AI context, per the task's own "if too sensitive, exclude" instruction — every Phase 1 question this feature promises to answer is already fully answerable from existing aggregate analytics/financial/campaign data alone; staff access to professional AI, per the task's own explicit owner-only default and this codebase's existing owner-only financial-data precedent; a second AI provider abstraction (the existing `ProviderInterface` is reused; only new concrete implementations were added); any change to the existing customer-mode AI conversation model.

**Known, disclosed limitation in this step's own verification:** business-party live QA could not be performed (see finding above) — the professional-party path was live-verified end to end with two distinct real QA accounts showing correct, non-overlapping real data; the business-party path is unit-tested only.

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§45 (V2.1/V2.2/V2.3 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 47. V2.3 Step 20 Completion Note

**Step 20 — Growth & Professional Platform Quick Wins is complete.** B2B-01, MKT-02 (the basic-search portion), NOTIF-07, and ADMIN-05 are now **IMPLEMENTED**. Full technical detail — schema, the search-text normalization/backfill design, the customer/admin quote-UI split (and why it lives on `page-b2b.php` rather than a new dashboard), the notification-preferences reuse, and live QA results — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.3 Step 20 — Growth & Professional Platform Quick Wins Implementation Notes" section.

| ID | Item | Disposition |
|---|---|---|
| B2B-01 | B2B quote-request/accept UI still completely missing on the frontend | **IMPLEMENTED** — a real customer-facing quote request/list/accept flow on `page-b2b.php` (the only page a pure wholesale buyer without a marketplace listing can reach), and a real admin quote-pricing page (`QuotesAdminPage`, previously the one step of this flow with no UI anywhere, not even wp-admin). Live-verified end to end: request → admin pricing → accept → a real WooCommerce payment page at the exact quoted total (623,000 تومان), confirming displayed price equals charged price for a real order. |
| MKT-02 | No free-text search parameter exists on `MarketplaceController::browse()` at all | **Basic search IMPLEMENTED** — a real `q` parameter, plain `LIKE`-based against a new, indexed, digit-normalized `search_text` column (name + bio), reusing CRM's own normalization idea. Fuzzy/typo-tolerant matching remains correctly **deferred, evidence-gated**, unchanged — this step closes only the "no search box at all" gap, exactly as scoped. Live-verified: name match, bio-only match, and cross-digit-system match (Persian-digit bio content matched by an ASCII-digit query) all confirmed against the real local database. |
| NOTIF-07 | No professional-facing notification-preferences UI | **IMPLEMENTED** — a new "اعلان‌ها" tab in the professional/business dashboard, literally reusing the existing customer `NotificationPreferences`/`NotificationsList` components (not a reimplementation) against the already-generic backend. Live-verified: a real toggle produced a real `PATCH` request and was confirmed persisted in `wp_bc_notification_preferences` for the professional's own account. |
| ADMIN-05 | `POST /b2b/accounts/{id}/approve`/`/reject` REST endpoints bypass `AuditLogger` | **IMPLEMENTED** — both REST handlers now call `AuditLogger::record()` with the same action-type/entity shape the wp-admin path already used, preserving the REST caller's own supplied rejection reason rather than substituting the wp-admin form's hardcoded default. |

**A second, real instance of the same audit-log-gap class as ADMIN-05 was found during this step's own broader search (as this register's own prior entry for ADMIN-05 anticipated it might not be the only one) and deliberately NOT fixed here, per this task's own bug-discipline instruction not to silently expand scope to unrelated pre-existing issues:** `beauclick-loyalty\LoyaltyController`'s REST admin routes (tier/plan/benefit CRUD, membership grant/cancel — all `bc_manage_platform`-gated, all currently unused by any frontend) call their services directly with no `AuditLogger` call, while `LoyaltyAdminPage`'s wp-admin handlers for the identical actions do log. Recorded here as a new, open finding for a future step to pick up, not assigned an ID or a target version by this document (that is this register's own convention — new IDs are assigned by whichever step's planning pass first scopes the fix, not by the step that merely discovers it).

**What this step deliberately did not build, and why:** fuzzy/typo-tolerant search (still evidence-gated); a dedicated business-only dashboard shell (Item 1's UI intentionally lives on the existing `page-b2b.php` instead); new professional-specific notification categories beyond the five existing customer-framed ones (Item 3 reuses them verbatim, per the task's own "mirror AccountTab.tsx exactly" instruction); a fix for the newly-found `beauclick-loyalty` audit-log gap (flagged above, not in scope).

**Known, disclosed limitation in this step's own verification:** a handful of unattributed `403 Forbidden` console errors were observed during live QA, most plausibly a stale admin-bar heartbeat nonce from switching between three different QA sessions in the same browser tab — every actual feature request in this step (search, quote request/price/accept, notification-preference toggle) returned `200 OK` and was independently confirmed correct against the live database. Not confirmed as a real defect; disclosed rather than either ignored or silently investigated away.

**No other item in this register changed status as a result of this step** — every other classification already in this document was left exactly as written. The rest of §7 (Prioritization), §22–§27 (recommendations, closing note), §28–§46 (V2.1/V2.2/V2.3 assignment tables and completion notes) above remain the accurate historical record and are preserved exactly as written.

---

## 48. V2.3 Final Release Audit Findings

Independent re-audit of all four V2.3 steps at `c6c6e5f`, per the audit's own instruction to treat prior Step completion notes as evidence, not authority. Full detail in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.3 Final Release Audit" section; this entry records only the register-relevant disposition of every finding.

**Fixed (release blockers, closed by this audit's own commit):**

| ID | Item | Disposition |
|---|---|---|
| ADMIN-06 | `beauclick-loyalty\LoyaltyController` REST admin routes (tier/plan/benefit CRUD, membership grant/cancel) bypassed `AuditLogger` — the exact gap §47 above disclosed and deliberately left open | **FIXED** — every mutating method now calls `AuditLogger::record()` directly, matching `LoyaltyAdminPage`'s own action-type naming. 6 new regression tests. Escalated from "flagged, deferred" to a release blocker because the V2.3 Definition of Done explicitly requires complete audit-log coverage on every reachable action path, and this release had already fixed the identical bug class twice elsewhere (B2B). |
| PRIV-06 | Step 19's `wp_bc_ai_professional_conversations`/`_messages` tables had no export/deletion coverage in `beauclick-privacy` — a professional's business-AI chat history was an orphaned data domain | **FIXED** — `ProfessionalAssistantService::export_for_user()`/`forget_user()` added, wired into `ExportService`/`DeletionService` alongside the existing customer-mode calls. 5 new regression tests across `beauclick-ai` and `beauclick-privacy`. |
| ADMIN-05 (extension) | `B2BController::submit_quote_prices()` (REST) still bypassed `AuditLogger` after §47's own fix only covered account approve/reject | **FIXED** — now writes the identical `b2b_quote_priced` entry `QuotesAdminPage::price_and_log()` already does. 2 new regression tests. |

**Open, logged, not fixed (non-blocking severity or pre-existing, not a V2.3 regression):**

| ID | Item | Classification |
|---|---|---|
| CAMP-03 | `EligibilityResolver::is_eligible()`'s usage-count check and `CampaignService::record_usage()`'s insert are not atomic across different bookings — a narrow TOCTOU race can overrun `usage_limit_total`/`usage_limit_per_customer` by a small margin under real concurrent load | MEDIUM / DATA INTEGRITY / V2.3 regression, not fixed (needs a locking or atomic-`UPDATE...WHERE` redesign — future step) |
| ADMIN-07 | `B2BController::set_tiers` (pricing-tier admin mutation) has no audit logging anywhere and no wp-admin twin | MEDIUM / SECURITY / PRE-EXISTING, not V2.3-introduced |
| — | No structural mechanism ties a `bc_manage_platform`-gated REST mutation to mandatory audit logging — this exact bug class (REST bypasses the wp-admin path's audit call) has now recurred three times across two plugins (B2B accounts, B2B quotes, Loyalty) | MEDIUM / SECURITY (architecture) — recommend a base-class or registry-based enforcement design, not another one-off patch, as a future step |
| B2B-02 | `QuoteService::accept()` has no DB-level state guard against a concurrent double-accept race (no `WHERE status='quoted'` on the UPDATE, no unique constraint on `wc_order_id`) | MEDIUM / DATA INTEGRITY / PRE-EXISTING (predates V2.3), not fixed |
| AI-06 | `ProfessionalContext` does not call `CrmService::is_customer_of()` as `VERSION_2_ARCHITECTURE_PLAN.md`'s Step 19 design describes — it excludes individual CRM records from context entirely instead, which is safe but is a spec deviation worth tracking | LOW / PRODUCT GAP (documentation-vs-implementation drift, currently benign) |
| AI-07 | `AssistantService::validate_recommendations()`'s ownership check (named "the crux" in the Step 19 design) was never added because professional-mode AI never emits a `recommendations` array in this phase | LOW / PRODUCT GAP — will need real attention the moment a future phase lets professional AI reference a CRM-scoped entity |

**Business decisions / explicitly non-blocking, re-confirmed not bugs:**

- Step 18's negative-outstanding-after-refund-post-settlement (no automated clawback) — explicit, documented business decision, not a defect.
- `search_text LIKE '%term%'` full-scans on every free-text marketplace search — explicitly acknowledged/accepted tradeoff in the migration's own docblock, evidence-gated the same way MKT-02's fuzzy-search deferral already is.

**External configuration:** unchanged since the V2.2 Final Release Audit — SMS gateway, SMTP, real Zarinpal credentials, backup, and error monitoring all remain required before any real production launch, independent of this audit's code-level findings.

**No other item in this register changed status as a result of this audit.** The rest of this document above remains the accurate historical record and is preserved exactly as written.

## 49. Global UI/UX & Product-Wide Audit Findings

Product-wide UI/UX audit at `v2.3.0` (`c505c20`) plus one intervening documentation-only commit, run against the real local stack (PHP built-in server, real MySQL, real seeded QA accounts, real browser) rather than source-reading alone — the specific gap the prior V2.3 Final Release Audit itself disclosed (§48/`VERSION_2_ARCHITECTURE_PLAN.md`: "no local WordPress dev server was started"). Full narrative, method, and scope disclosure in `VERSION_2_ARCHITECTURE_PLAN.md`'s "Global UI/UX & Product-Wide Audit" section; this entry records only the register-relevant disposition.

**Fixed (found and closed by this audit's own commit):**

| ID | Item | Disposition |
|---|---|---|
| UI-01 | OTP resend (`AuthFlow.tsx`'s shared `requestOtp()`) never cleared the `code` field — a stale/expired code silently blocked correct re-entry via the input's `maxLength`, producing a confusing "کد تأیید نادرست است" on the genuinely-new code | **FIXED** — `setCode('')` added on a successful resend, mirroring the existing `setStep`/`setCooldown` reset. |
| NAV-01 | A logged-out visit to any `/my-account/*` WooCommerce endpoint showed WooCommerce's own default password-login form — the exact UX AUTH-09 (§78/A above) documents as superseded; `/dashboard/` already redirects logged-out visitors to `/auth/`, `/my-account/*` had no equivalent | **FIXED** — new `template_redirect` hook (`inc/account-redirect.php`) sends any logged-out `is_account_page()` visit to `/auth/`; verified not to affect guest checkout. |
| LOC-07 | AI assistant narration (`beauclick-ai\RuleBasedProvider` and `\Professional\ProfessionalRuleBasedProvider`) rendered numbers in raw Latin digits + English commas ("9 رزرو", "1,700,000 تومان"), inconsistent with the Persian-digit convention every other number in the product uses (dates, prices, receipts, even the OTP SMS text) | **FIXED** — both providers now convert their narrated output to Persian digits/`٬` separator at the single return point, mirroring `beauclick-auth\Otp\OtpService`'s own existing local-helper pattern. 3 existing tests updated to assert the corrected output (not weakened). |

**Open, logged, not fixed (cosmetic / requires a backend change beyond this pass's UI-polish scope):**

| ID | Item | Classification |
|---|---|---|
| COM-07 | A booking-flow order's receipt (`order-received`) shows `آدرس صورتحساب: نامعلوم` even when the customer has a real saved billing address, because `BookingOrderBridge` creates the order directly (bypassing the cart, by design — see COM-05) without copying the customer's billing address onto the order | LOW / PRODUCT GAP (cosmetic — a service booking needs no delivery address; the receipt just reads as incomplete). Not fixed here: the change is to order-construction logic in `BookingOrderBridge`, not a UI template, so it's left for a deliberate, separately-reviewed change. |

**Confirmed clean (re-verified live, not re-litigated):** the header search icon overlay and its city/specialty/free-text search — the specific regression this audit exists because of (`35746b3`) — is correctly wired end-to-end with no recurrence. The full 5-step booking flow, WooCommerce payment bridge, live campaign discount, and order-received receipt all produced correct real data. The customer account area (`/dashboard/` + `/my-account/*`) is fully Persian, fully RTL, and a real edit→save→reload→persist round trip on a real address field was verified and then reverted, leaving QA data unchanged.

**Scope disclosed as not reached this pass, not claimed as audited clean:** the wp-admin-side BeauClick admin pages (source-reviewed only — no live click-through, since setting a temporary password on `bc_qa_admin` was correctly refused by this session's own auto-mode safety classifier as a credential-modification action); a full B2B quote-acceptance round trip; the professional CRM/staff/calendar tabs in depth; an automated accessibility (axe-core) pass; and a systematic 6-breakpoint sweep of every page (only the account/dashboard surfaces got a full mobile-viewport pass, at 375px).

**Tests:** backend PHPUnit 857/857 (3 tests updated, not skipped), frontend Vitest 48/48, TypeScript clean, ESLint clean, `php -l` clean — before and after this audit's fixes, no regressions.

**No other item in this register changed status as a result of this audit.**

## 50. V2.4 Step 21 — Search & Discovery Evolution Completion Note

| ID | Item | Disposition |
|---|---|---|
| MKT-02 (partial) / GAP-14 (partial) | Search was plain, unbounded `LIKE '%term%'` with no fuzzy/typo tolerance and no synonym handling; two independent, hand-duplicated query implementations existed (REST `MarketplaceController::browse()`, SSR `bc_get_providers()`) | **PARTIALLY_IMPLEMENTED** — a shared `SearchProviderInterface`/`SqlSearchProvider` now backs both real entry points (no more duplication); `TextNormalizer` extended with Persian/Arabic letter + ZWNJ normalization; a curated `SynonymExpander` closes the specific typo/alternate-phrasing examples named in this step's own brief. Still plain `LIKE`, still no fuzzy/typo-*distance* algorithm — **MKT-02/GAP-14 remain open** for that part, deliberately not claimed closed. |
| — (new, found during this step's own pre-implementation audit) | `search_performed` — the event `MetricsService::search()` reads — was only ever logged from the REST `browse()` endpoint, which has zero live frontend consumers; the platform's actual live search path (`bc_get_providers()`/`page-marketplace.php`) never logged it, so the Search analytics dashboard was silently zero for all real production search traffic | **FIXED** — `page-marketplace.php` now logs `search_performed` on every real page view; `matchedResultCount`/`zeroResult`/`searchSource` fields added (renamed from the old single `resultCount`, safe — confirmed exactly 2 references codebase-wide before renaming). Live-verified: real search requests now write real events with the new shape. |

**Tests:** backend PHPUnit grew 857 → **882** (25 new tests, zero regressions). Frontend Vitest unchanged **48/48** (no frontend code touched — UI was explicitly out of scope for this step beyond one optional server-rendered hint). TypeScript/ESLint/`php -l` clean, production build succeeds.

**Live QA:** all 10 scenarios in this step's own brief verified against the real running site — exact-name match, the specific synonym/typo examples named in the brief ("خدمات ناخن", "کاشت ناحن"/"ناحن"), a genuine zero-result query, the homepage hero form, and the header search modal's fallback path, all confirmed producing correct real results and (where applicable) the synonym hint. `search_performed` events confirmed writing live with the new field shape. 375/390/412px: zero overflow, RTL correct, no console errors.

**Not claimed:** OpenSearch readiness beyond a single swappable interface; fuzzy/typo-distance matching (MKT-02/GAP-14 remain open); relevance-ranking of matches (unchanged `RankingPresenter::ORDER_BY`).

## 51. V2.4 Step 26 (part 1) — GAP-02, GAP-08 Completion Note

| ID | Item | Disposition |
|---|---|---|
| ADMIN-07 / GAP-02 | `B2BController::set_tiers` — the one confirmed, still-open instance of the audit-logging-bypass bug class as of `v2.3.1` | **FIXED** — now writes a `b2b_tiers_set` audit entry (before/after tier state). A new, opt-in, boot-time `RestController::route()` enforcement (`'adminGated' => true` requires `'auditAction'` or `'auditExempt'`, mirroring the existing missing-`permission_callback` guard exactly) now also declared on all 5 confirmed B2B and 8 confirmed Loyalty admin mutations, so this specific bug class cannot recur silently on any route that opts in going forward. |
| GAP-08 | `RestController::require_owner_or_capability()` couldn't express indirect ownership (booking→provider→user) | **FIXED** — a re-audit first found this project's own prior claim that the method was "dead code, called nowhere" (repeated in `V3_GAP_REGISTER.md` and this project's own V2.4 roadmap doc) to be **stale/incorrect** — 4 real call sites exist, all direct-ownership. A new optional `?callable $owner_resolver` parameter (default `null` = unchanged direct-comparison behavior, zero risk to the 4 existing call sites) adds the missing indirect case; `BookingController::can_confirm()`/`can_manage_booking()` now use it instead of their own inline duplicate of the same logic. |

**Tests:** 882 → **891** backend (9 new, zero regressions); the pre-existing `BookingControllerTest` ownership assertions passed unchanged through the refactor. `php -l` clean.

**Live QA:** site boot and REST API confirmed unaffected after modifying the shared `RestController` base class (a real risk, since a registration-time throw there would fatal every plugin, not just one). `can_manage_booking()`'s fix live-verified with a real professional session against real bookings: owner → `200`, non-owner → `403`. `set_tiers`'s audit fix verified via real-database `WP_UnitTestCase` integration test; live wp-admin click-through not performed (same credential-access constraint as the V2.3.1 audit).

## 52. V2.4 Step 24 — Notification Center Completion Note

| ID | Item | Disposition |
|---|---|---|
| — (new; recurring product gap, not a pre-numbered register entry) | `wp_bc_notifications` recorded every dispatched notification, but nothing surfaced them inside the product — a recipient could only ever learn a notification existed via the actual SMS, not via any in-app UI | **IMPLEMENTED** — additive `read_at` migration + `unread_count()`/`mark_read()`/`mark_all_read()` on the existing `NotificationService`; three new REST routes (`GET /notifications/unread-count`, `POST /notifications/{id}/read`, `POST /notifications/mark-all-read}`), the single-notification route ownership-gated via the same `require_owner_or_capability()` helper [[GAP-08]] generalized; a new header bell (`NotificationBell.tsx`, reusing the existing drawer-end `Modal` variant `CartDrawer` already established) with a live unread badge. |

**Tests:** backend PHPUnit grew 891 → **901** (10 new, zero regressions). Frontend Vitest grew 48 → **55** (7 new `NotificationBell.test.tsx` cases). `php -l`/TypeScript/ESLint clean, production build succeeds (required adding the new `notification-bell` entry to `vite.config.ts`'s `rollupOptions.input` — caught only by grepping the full build output, since the build otherwise succeeds silently without the bundle).

**Live QA:** real `GET /notifications/mine` fetch and render verified against `bc_qa_customer`'s real data; a real mark-read click verified, via direct database query (not just UI state), to have written `read_at` on the real row. 375/390/412px: zero horizontal overflow, panel and close button remain usable, state survives resize. Console errors observed earlier in the same browser tab (`ERR_CONNECTION_REFUSED`, `401`, `403`) were investigated and confirmed pre-existing/unrelated — a fresh network log captured during the actual interaction shows 100% successful requests, so this step introduces no new console errors.

**Not claimed:** real-time/push delivery of the unread badge — it refreshes on window focus and a same-tab custom event only, the same boundary `CartDrawer`'s own badge already accepts, not a new limitation introduced here.

## 53. V2.4 Step 26 (part 2) — GAP-01, GAP-03, GAP-04 Completion Note

| ID | Item | Disposition |
|---|---|---|
| GAP-01 | `wp_bc_ledger_entries` had no database-layer immutability enforcement — code-level discipline only (`LedgerService` has no update/delete method) | **PARTIALLY_IMPLEMENTED** — a migration adds `BEFORE UPDATE`/`BEFORE DELETE` triggers that reject any mutation outright. **Disclosed, not hidden:** `CREATE TRIGGER` requires `SUPER` or `log_bin_trust_function_creators=1` (binary logging is on); this local dev database's and the PHPUnit test database's own DB users were both confirmed, via `SHOW GRANTS`, to lack that privilege — the same category of precondition as the SMS/SMTP/payment-gateway credentials already documented as required-before-production. The migration fails gracefully and logs an actionable message rather than silently claiming success; code-level immutability is unaffected and remains the real guarantee on this host today. |
| GAP-03 | `BookingOrderBridge::create_order_for_booking()` had no idempotency guard — a retried call would silently create a second, orphaned order and overwrite `wc_order_id` | **FIXED** — the method now returns the existing order when the booking already has one, unchanged behavior for the first call. Fixing this surfaced that `BookingService::cancel_booking()`'s existing FIN-02 refund safety net (V2.3 Step 18) now correctly reaches a booking's real linked order in a two-order edge case where it previously didn't (masked by the very bug being fixed) — a stronger correctness guarantee, confirmed via two updated pre-existing tests, not a regression. |
| GAP-04 | `EligibilityResolver`'s usage-cap check and `CampaignService::record_usage()`'s insert were separate, non-atomic steps — a real TOCTOU race could let concurrent bookings overshoot `usageLimitTotal`/`usageLimitPerCustomer` | **FIXED** — `record_usage_within_cap()`, a single atomic `INSERT ... SELECT ... WHERE` statement (cap re-check + insert as one unit of work), wired into `CampaignDiscount::apply()`. An initial transaction-based implementation was built, found via the full test suite to corrupt `WP_UnitTestCase`'s own test isolation for every test touching the real booking-creation hook (20+ cascading failures), root-caused, and replaced with the current transaction-free design before being shipped — not discovered after the fact. Empirically verified under genuine multi-process concurrent load: a cap of 2 raced by 3 real, separate connections consistently yields exactly 2 rows, never more, across repeated runs. |

**Tests:** backend PHPUnit grew 891 → **910** (19 new, zero regressions; 2 of the new tests self-skip on this host for the disclosed GAP-01 precondition rather than falsely passing/failing). Frontend unchanged **55/55**. `php -l` clean. The 2 pre-existing `CatalogContextTest` failures observed during this step's own test runs were confirmed, by running the identical filter against unmodified `master`, to be pre-existing and unrelated to this step.

**Live QA:** a real booking against a real active campaign was created via the live REST API on the local dev site — correct order line items, exactly one `wp_bc_campaign_usages` row via the new atomic guard, and a completed payment recording correct real ledger entries with the booking confirmed. GAP-03 verified directly against that same real booking: a second `create_order_for_booking()` call returned the identical order, `wc_order_id` unchanged. No new console/network errors.

## 54. V2.4 Step 23 — Wishlist, Receipt, Terminology Completion Note

| ID | Item | Disposition |
|---|---|---|
| — (dashboard's own `ready: false` wishlist placeholder) | No backend or frontend wishlist code existed anywhere — confirmed by a fresh, full-codebase grep before any implementation began | **IMPLEMENTED** — `wp_bc_wishlist_items` table + `WishlistService` (`beauclick-marketplace`), login-gated `WishlistController` (GET/POST/DELETE, scoped to the current user, never a request param), a real `WishlistTab.tsx`, and a heart-toggle button on the provider profile page. An unpublished-but-still-wishlisted provider is reported as unavailable rather than silently dropped from the list — tested. |
| — (roadmap's own "order receipt PDF generation" wording) | Assumed unbuilt by the earlier V2.4 roadmap | **ALREADY_IMPLEMENTED, found not built** — `ReceiptView.tsx` already has a scoped `@media print` stylesheet and a real print button, with its own docblock recording `window.print()` as the deliberate "first safe scope" decision, not a placeholder. No PDF library dependency exists anywhere in this codebase, confirming no second attempt was ever started. Nothing changed here — the earlier roadmap wording was stale. |
| — (roadmap's own "نوبت/رزرو terminology consistency pass" wording) | Assumed confusingly inconsistent by the earlier V2.4 roadmap | **AUDITED, NOT AN INCONSISTENCY** — reading all 70 real uses in context found a real, mostly-consistent split already in place: نوبت for the temporal/appointment concept, رزرو for the transactional/booking-record concept (comparable to English "appointment" vs. "booking"). No rename made — forcing one term everywhere would have removed a real distinction, not fixed a genuine bug. Same "verify before acting on an assumed premise" correction already applied to GAP-08 and GAP-01/03/04's own original scope earlier in this phase. |

**Tests:** backend PHPUnit grew 910 → **922** (12 new, zero regressions). Frontend Vitest grew 55 → **63** (8 new). TypeScript/ESLint/`php -l` clean, production build succeeds with the new `wishlist-button` bundle present.

**Live QA:** a real add-to-wishlist from a real provider profile page persisted a real row (confirmed via direct database query); the dashboard tab fetched and correctly rendered it; removal updated both the UI and the database. 375/390/412px: zero overflow with real content rendered. No new console/network errors during the actual interaction.

**Not claimed:** an "add to wishlist" affordance on marketplace search-result cards (only the single-provider profile page has the toggle) — a small, deliberately deferred follow-up, not an oversight.

## 55. V2.4 Step 22 — Professional Profile, Portfolio, Settings Completion Note

| ID | Item | Disposition |
|---|---|---|
| — (dashboard's own `ready: false` Profile/Settings placeholders, explicitly named as unbuilt in V2.3 Step 19's own docblock) | Profile-editing backend (`MyProfileController`) already existed; specialty editing and portfolio management (write side) did not | **IMPLEMENTED** — specialty_ids added to the existing profile endpoint; new `PortfolioController` (real WordPress Media Library uploads, 24-item cap, ownership-checked); `ProfileTab.tsx` and `SettingsTab.tsx` (mirrors customer `AccountTab.tsx`'s privacy cards). |
| — (found during this step's own Live QA, not its initial audit) | The public profile page's "نمونه‌کار" section never actually read `bc_portfolio_item` posts — it unconditionally showed a static "not built yet" placeholder regardless of real data, invisible to a code-only read since the placeholder looked like an intentional boundary | **FIXED** — `single-bc_professional.php` now queries and renders real portfolio items the same way the REST API already did; the fallback empty state now says "not yet added" (true) instead of "not built yet" (now false). |

**Tests:** backend PHPUnit grew 922 → **931** (9 new, zero regressions). Frontend Vitest grew 63 → **69** (6 new). The full real-upload-success path is deliberately not unit-tested — PHP's own `is_uploaded_file()` anti-spoofing check cannot be satisfied outside a genuine HTTP multipart request, confirmed by reading WordPress core's own upload internals; proven instead via Live QA. TypeScript/ESLint/`php -l` clean, production build succeeds.

**Live QA:** a real bio/specialty edit persisted to the database; a real browser file upload (genuine `File`/`DataTransfer`, not a mock) created a real WordPress attachment and portfolio post, visible on the dashboard, deletable, and — after the template fix above — visible on the real public profile page. Settings tab confirmed rendering real data. 375/390/412px: zero overflow. Zero console/network errors on a freshly-loaded tab.

**Not claimed:** city/district editing (no cascading picker exists anywhere in this codebase yet) or avatar/cover-photo editing (a separate, pre-existing "temporary mockup" image system, out of this step's scope).
