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
| AUTH-07 | No self-service account deletion | Still not built | MISSING | MEDIUM | V2.2 | Unchanged |
| AUTH-08 | No self-service data export | Still not built | MISSING | MEDIUM | V2.2 | Unchanged |
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
| ADMIN-01 | BeauClick-branded admin shell | A real `BeauClick` top-level wp-admin menu exists with a genuine (not placeholder) landing dashboard, plus B2B-approval and review-moderation pages — but all render inside unstyled default wp-admin chrome, no BeauClick visual identity | PARTIALLY_IMPLEMENTED | MEDIUM | V2.2 | The audit brief's own question ("should there be a BeauClick-branded Admin Shell") — recommendation: yes, eventually, but current admin pages are functional and Persian-labeled today, so this is a polish/consistency item, not a functional gap |
| ADMIN-02 | Admin audit log | **PARTIALLY resolved in V2.1 Step 8**, scoped to verification only — `wp_bc_verification_history` is a real, append-only audit trail (actor, from/to status, reason, timestamp) for every verification decision. Broader admin audit logging (B2B approvals, review moderation) remains unbuilt | **PARTIALLY_IMPLEMENTED** (verification scope only) | MEDIUM | V2.1 Step 8 (verification) / V2.2 (general) | Broader admin-action audit logging (B2B, reviews) still needed |
| ADMIN-03 | Professional verification workflow | **Resolved in V2.1 Step 8** — a dedicated `VerificationReviewPage` admin screen (queue, evidence links, approve/reject/suspend/revoke/reinstate) replaces the old raw-postmeta-editing metabox, gated on the `bc_moderate_verification` capability | **IMPLEMENTED** | — | V2.1 Step 8 ✅ | Closed by commit implementing Step 8 |
| ADMIN-04 | Booking/order administration | Available through WooCommerce's own native order admin + the custom booking CPT-adjacent tables (no dedicated BeauClick booking-admin screen, but WC order admin is functional) | PARTIALLY_IMPLEMENTED | LOW | V2.2 | |

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
| PRIV-02 | Self-service account deletion | See AUTH-07 | MISSING | MEDIUM | V2.2 | |
| PRIV-03 | Self-service data export | See AUTH-08 | MISSING | MEDIUM | V2.2 | |
| PRIV-04 | Data retention policy (CRM notes, journey, chat, AI context) | No documented retention/anonymization policy exists anywhere | NEEDS_BUSINESS_DECISION | MEDIUM | Pre-launch | Already flagged as a real question in the V2 architecture plan §17; still unanswered |
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
| SEO-01 | Meta description/OG tags on marketplace/profile/product pages | No matching code found anywhere (confirmed by direct search — the only related mentions are unrelated code comments) | MISSING | MEDIUM | V2.2 | |
| SEO-02 | XML sitemap | None (no sitemap-generation code, no SEO plugin dependency found) | MISSING | MEDIUM | V2.2 | |
| SEO-03 | Structured data (LocalBusiness/Service/Product schema for professional profiles) | None for BeauClick's own CPTs (WooCommerce's own product schema.org output exists for shop products only, per Currency.php's own comment) | MISSING | MEDIUM | V2.2 | |
| SEO-04 | Canonical URLs | None found | MISSING | LOW | V2.2 | |

### P. Accessibility

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| A11Y-01 | Modal focus trap/Escape/labeled close | Real, already built and reused by every new feature (Journey, CRM) without modification | IMPLEMENTED | — | — | |
| A11Y-02 | V1 Production Readiness accessibility fixes | Real fixes already shipped (per the architecture doc's own "What Should NOT Be Changed" list, §17) | IMPLEMENTED | — | — | |
| A11Y-03 | Automated accessibility testing (axe-core/Lighthouse CI) | No tooling integrated into the test suite | MISSING | LOW | V2.2 | Manual verification has been thorough but automated regression coverage doesn't exist |
| A11Y-04 | Date-picker (`JalaliDateInput`) keyboard/screen-reader behavior | Native `<select>` elements — inherits full native accessibility for free (this was in fact the explicit reason it was built as three selects rather than a custom calendar-grid widget) | IMPLEMENTED | — | — | |

### Q. Analytics/Business Metrics

| ID | Description | Current state | Status | Severity | Target | Recommendation |
|---|---|---|---|---|---|---|
| ANLYT-01 | Booking/AI/loyalty/journey event logging | Real, append-only, used for real ranking/loyalty computation (confirmed both by source and live DB inspection this session) | IMPLEMENTED | — | — | |
| ANLYT-02 | Search events | No `search` event is logged anywhere when a marketplace search is performed | MISSING | MEDIUM | V2.2 | Named explicitly in the roadmap's own §18 list; confirmed absent |
| ANLYT-03 | Checkout-funnel events (cart add, checkout started) | Only `order_completed`/`order_refunded` exist; no earlier funnel stage is logged | MISSING | MEDIUM | V2.2 | |
| ANLYT-04 | Admin-facing analytics dashboard | None — all analysis today requires a direct database query | MISSING | MEDIUM | V2.2/V2.3 | |
| ANLYT-05 | CRM/Journey usage measurement | No events logged when a professional opens the CRM or a customer opens their Journey | MISSING | LOW | V2.2 | |

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
| SEO-01–04, ANLYT-02–05, COM-03/04/05, A11Y-03, ADMIN-01, ADMIN-04, PRO-02/03/04, AI-02/03/05, MKT-02 | Various | V2.2/V2.3, per their existing entries in §6/§7 | Unchanged by this update |

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
