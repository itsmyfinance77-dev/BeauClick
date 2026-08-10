# BeauClick — Architecture Proposal (Phase 0 Discovery)

Status: **DRAFT — awaiting approval. No production code has been written.**
Sources reviewed: `ایده کسب و کار.pdf`, `طرح کسب و کار.pdf`, `BeauClick — Design Brief.md`, `Design requirements checklist (1).zip` → `BeauClick.dc.html` + `README.md` (approved handoff), `BeauClick - Standalone (3).html` (prototype bundle). Local environment probed on this machine (Windows 11, Node v22.20 + npm 10.9.3 + Git 2.50.1 present; **no PHP, Composer, MySQL, Docker, WP‑CLI, XAMPP/Laragon/Local found** — clean slate).

---

## 1. Executive Summary

BeauClick is not a store — it's a **Persian, nationwide beauty marketplace + booking + AI discovery layer**, with WooCommerce doing only the "buy a product" slice of it. The business docs are explicit that the competitive moat is the *AI-driven professional ranking* and the *unified experience* (marketplace + booking + AI + shop + B2B in one place) — none of the Iranian competitors (نوبتی, من‌آرای, پل‌نوین) combine these, and even Booksy/Fresha (closest global comps) don't do the AI ranking piece.

**Recommendation:** a **decoupled-capable classic WordPress architecture** — a custom PHP theme that server-renders all SEO-critical, public pages (Home, Marketplace, Professional Profile, Shop, Product, B2B) using the approved design system, plus a **shared React "app-shell"** (Vite + TypeScript) mounted into those same pages for everything stateful and interactive: booking flow, cart drawer, AI panel, chat, and both dashboards. WooCommerce stays the commerce/payment engine underneath — including for **bookings**, which are modeled as WooCommerce orders under the hood (see §14). Custom domains (marketplace, booking, B2B, chat, AI, reviews) live in dedicated WordPress plugins around a shared `beauclick-core`, not one giant plugin and not a full headless rewrite.

This gets you: native WooCommerce payment-gateway compatibility (important — Iranian gateways ship as classic WP plugins), full SEO control for the pages that need to rank in Google for queries like «میکاپ عروس در یزد», and the exact interactive UX from the approved prototype where it actually matters (booking, dashboards, AI, chat) — without paying for a full headless build (a second server, SSR infra, and re-implementing checkout/payment/tax logic that WooCommerce already has).

---

## 2. Why This Architecture (and what breaks the alternatives)

| Requirement from the docs | Consequence for architecture |
|---|---|
| WooCommerce is mandated as the commerce engine, but "must never surface its default theme/UI" (design README, line 11) | Rules out a stock Woo theme; needs full template override, not a child theme with light CSS |
| SEO matters — the business plan literally frames the product as "Google + Digikala + Snapp Food for beauty" and expects organic discovery of professionals/services | Public/discovery pages need server-side rendered HTML, not a client-only SPA shell (bad for crawlability/LCP) |
| The prototype is a single-page client-state React app (`screen` state, no reloads) — but the design README explicitly calls this out as a **prototyping shortcut**, not a requirement ("reimplement per target stack") | We are free to make top-level navigation real page loads (better for SEO, simpler caching) while keeping booking/cart/AI as true overlays exactly like the prototype |
| Iranian payment gateways (ZarinPal, Zibal, IDPay, NextPay…) ship as WooCommerce gateway plugins built against the classic checkout/order lifecycle | Reusing WooCommerce's order + gateway system (rather than rebuilding payments headless) avoids reinventing PCI-adjacent, gateway-callback-verification code |
| AI, chat, dashboards, B2B pricing are genuinely dynamic, session-specific, non-SEO surfaces | These are exactly where a React app-shell earns its keep — no benefit to server-rendering a dashboard |

### Alternatives considered

1. **Full headless (WordPress/Woo as pure API + Next.js frontend).**
   Pros: cleanest separation, best possible SSR/ISR control, closest 1:1 match to the prototype's SPA feel across *every* screen.
   Cons: two servers to run and deploy (Node + PHP) instead of one; WooCommerce checkout/payment/tax/coupons would need to be re-driven entirely through the Store API — doable, but it means re-implementing a lot of flow that "just works" in classic Woo, and Iranian gateway plugins that hook into classic checkout pages/templates don't cleanly work at all — you'd need to hand-roll gateway integrations. Higher hosting complexity for an Iran-hosting context where infra choices are already constrained (§29). **Rejected for v1**, but nothing in the recommended architecture blocks moving to this later (the REST API is being built either way).

2. **Stock WooCommerce theme (or a page-builder theme) with heavy CSS overrides.**
   Rejected outright by the design brief itself ("Do NOT make BeauClick look like a WooCommerce website"). Also can't produce the booking modal, AI panel, or dashboard interactions the design requires.

3. **Fully custom app, no WordPress at all (Node/Postgres backend).**
   Rejected — explicitly against the brief's direction ("WooCommerce is the commerce engine"), and would mean rebuilding cart/checkout/orders/coupons/inventory from scratch for no product benefit.

4. **One monolithic "BeauClick" plugin containing everything.**
   Rejected per your own constraint (§6 of the brief) — a single plugin with marketplace + booking + B2B + chat + AI + reviews becomes untestable and un-owner-able. Split into bounded modules (§9).

---

## 3. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| CMS / commerce core | WordPress (latest LTS-ish, self-hosted) + WooCommerce | Commerce engine only — never renders its own templates on the frontend |
| Language (backend) | PHP 8.2+ | Matches current WP/Woo minimums with headroom |
| Custom backend modules | Composer-autoloaded WP plugins, namespaced `BeauClick\{Domain}` | See §9 |
| Frontend design system + interactive app-shell | React 18 + TypeScript, built with **Vite** | Same React major version as the approved prototype — team already has working muscle memory in it |
| Styling | CSS custom properties generated from the design token table (§ design README) + a small utility layer (Tailwind, configured to those exact tokens rather than default palette) | Avoids hand-rolling utilities; keeps tokens as the single source of truth |
| State (app-shell) | Zustand or React Context per surface (booking, cart, AI, dashboard) — no Redux; the prototype's state shape (§ README "State Management") is small and maps directly | Simplicity over ceremony |
| Server-rendered templates | Plain PHP templates in the custom theme (not Twig) | One fewer templating layer to learn/debug; WP's own template hierarchy already does the routing |
| Database | MySQL 8 / MariaDB 10.6+ | WP default; custom tables (§14) use InnoDB with explicit indexes |
| Search (MVP) | Indexed MySQL tables + `$wpdb` queries | See §19 — no Elasticsearch/Meilisearch until justified by real query-quality problems |
| Realtime (chat, MVP) | REST + short-interval polling | See §17 |
| AI | Provider-agnostic PHP interface, proxied server-side | See §18 |
| Payments | WooCommerce native gateways (ZarinPal etc. as plugins) | See §16 |
| Build/deploy tooling | Composer (PHP deps), npm (JS deps), Vite build → enqueued assets | |
| Local dev (Windows) | **Laragon** | See §25 |

---

## 4. Repository Structure

```
beauclick/
├── docs/
│   ├── business/            ← ایده کسب‌وکار.pdf, طرح کسب‌وکار.pdf (source of truth for product)
│   ├── design/               ← Design Brief.md, handoff README.md, BeauClick.dc.html (source of truth for UX/visual)
│   └── architecture/         ← this document + future ADRs (docs/architecture/adr/NNNN-title.md)
├── wordpress/
│   ├── wp-content/
│   │   ├── plugins/
│   │   │   ├── beauclick-core/            (shared kernel — see §9)
│   │   │   ├── beauclick-locations/
│   │   │   ├── beauclick-marketplace/
│   │   │   ├── beauclick-booking/
│   │   │   ├── beauclick-b2b/
│   │   │   ├── beauclick-payments/
│   │   │   ├── beauclick-chat/
│   │   │   ├── beauclick-ai/
│   │   │   ├── beauclick-reviews/
│   │   │   └── beauclick-loyalty/          (stub only — §13)
│   │   └── themes/
│   │       └── beauclick/                  (PHP templates + enqueues the app-shell build)
│   └── (WP core itself is NOT committed — see below)
├── app/                                     (React app-shell, Vite + TS)
│   ├── packages/
│   │   ├── design-system/                  (tokens, primitives — Button, Card, Chip, Modal…)
│   │   ├── booking-flow/
│   │   ├── cart-drawer/
│   │   ├── ai-assistant/
│   │   ├── chat/
│   │   ├── dashboard-professional/
│   │   └── dashboard-customer/
│   └── vite.config.ts
├── .env.example
├── .gitignore
├── composer.json                            (root — dev tooling: phpcs, phpunit, WP coding standards)
└── README.md
```

**WordPress core is not committed.** It's installed via Composer (`johnpbloch/wordpress` or WPackagist) or documented as a scaffold step (`wp core download`). Only `wp-content/{plugins,themes}` that we author are version-controlled — this is standard practice and keeps the diff to *our* code.

---

## 5. WordPress Strategy

- WordPress serves as: routing/permalinks, admin/CMS for content editors (professionals editing their own profile through a restricted admin or a custom-built front-end editor — TBD, see Open Questions), user/role system, media library, and the template layer for SEO pages.
- Custom post types for content that benefits from WP's native editing/revision/media tooling: `bc_professional`, `bc_business`, `bc_service`, `bc_portfolio_item`.
- Custom taxonomies: `bc_specialty` (میکاپ، ناخن، پوست و مو، …), hierarchical.
- **Not** used for: location data, availability/slots, bookings, chat, reviews, search index, AI conversations — these get dedicated custom tables (§14) because they're relational/high-write/query-heavy in ways WP's post-meta model handles poorly at scale.
- Admin UX: default wp-admin is fine for internal/ops use (support, moderation, catalog management). It is never customer-facing.

## 6. WooCommerce Strategy

**Use natively, unmodified in its data layer:** products, variations, cart, orders, order line items, coupons, checkout, inventory, customer accounts, payment gateways, refunds.

**Override entirely at the template/rendering layer:** every WooCommerce template (`archive-product.php`, `single-product.php`, cart, checkout, my-account) is overridden in the `beauclick` theme to render the approved design system. WooCommerce Blocks' Store API is used where it simplifies the cart drawer (fetching/mutating cart state without a full page reload).

**Customization needed:**
- Bookable "services" as a WooCommerce product type is *not* used (WooCommerce's own booking concept doesn't fit a multi-vendor marketplace of independent professionals — see §14/§15 for why bookings are a parallel custom entity that *produces* a Woo order for payment).
- B2B tiered/wholesale pricing is not native to WooCommerce — custom pricing rules (§16), applied via `woocommerce_product_get_price` and cart-item price filters, gated by a `bc_b2b_buyer` role/capability check.
- Reviews: WooCommerce's native product reviews (built on `wp_comments`) are reused for **product** reviews only, since that's exactly what they're for. **Provider/service reviews are a separate custom table** (§14) because they need "verified booking" linkage and feed the ranking signal (§21), which product-review comments don't support cleanly.

---

## 7. Custom BeauClick Modules

One plugin per bounded domain, each independently testable, each with its own `composer.json`/PSR-4 namespace, coordinated through `beauclick-core`:

| Plugin | Owns | Depends on |
|---|---|---|
| `beauclick-core` | DB migration runner, REST base controller, role/capability registration, shared service container, design-token PHP constants (mirrors the frontend token file) | — |
| `beauclick-locations` | Province/City/District tables, lookup REST endpoints | core |
| `beauclick-marketplace` | Professional/business profiles, specialties, portfolio, verification workflow, search-index table | core, locations |
| `beauclick-booking` | Availability/slots, booking lifecycle, reschedule/cancel | core, marketplace, payments |
| `beauclick-b2b` | Business accounts, tier pricing, MOQ, quotes | core, WooCommerce |
| `beauclick-payments` | Thin glue: booking↔order linkage, refund wiring, payment-status mirroring | core, WooCommerce, booking |
| `beauclick-reviews` | Provider/service review table, moderation, rating aggregation feeding search-index | core, marketplace, booking, WooCommerce |
| `beauclick-chat` | Conversations/messages tables, REST send/list, participant types (pro/business/support/AI) | core |
| `beauclick-ai` | Provider-agnostic AI interface, conversation storage, recommendation validation | core, marketplace, WooCommerce (product lookups) |
| `beauclick-loyalty` | Stub: points ledger table + hook points only (no UI/logic yet) | core |

No plugin reaches into another plugin's database tables directly — cross-domain reads go through a small internal PHP API (a handful of static service classes or actions/filters), so modules stay swappable/testable in isolation. This is the "modular, not microservices" middle ground the brief asks for: process and deploy as one app, but code as separate, bounded modules.

---

## 8. Data Model

Custom tables use `wp_bc_` prefix. All FKs to WP users use `wp_users.ID`; all FKs to WooCommerce use `wp_posts.ID` (orders/products are posts) or `wc_order_id` per Woo's own schema (HPOS-aware — see note below).

### Locations (`beauclick-locations`)
| Table | Purpose | Key fields |
|---|---|---|
| `wp_bc_provinces` | Iran's 31 provinces, static reference data | id, name_fa, slug |
| `wp_bc_cities` | Cities per province | id, province_id, name_fa, slug, lat, lng, is_launched (bool — controls which cities show as "active" in filters, per README's extend-the-3-cities note) |
| `wp_bc_districts` | Neighborhoods per city | id, city_id, name_fa, slug |

Lifecycle: seeded once via a migration/seed script (Iran's province/city list is stable), districts added incrementally by ops as coverage grows. Indexed on `province_id`, `city_id` for fast filter joins.

### Marketplace (`beauclick-marketplace`)
| Entity | Storage | Purpose / key fields |
|---|---|---|
| Professional / Business profile | CPT `bc_professional` / `bc_business` + postmeta | bio, cover image, verification_status, linked `wp_users.ID` (owner) |
| Portfolio items | CPT `bc_portfolio_item` | media, before/after pair flag, parent professional |
| Services | CPT `bc_service` | name, duration_minutes, price, parent professional/business, specialty taxonomy term |
| **Search index** | `wp_bc_provider_index` (custom table, denormalized, rebuilt on relevant save hooks) | provider_id, city_id, district_id, specialty_ids (JSON or a junction table), price_from, rating_avg, review_count, verified (bool), last_active_at, ranking_score (nullable — §21) |

Why a search-index table: marketplace filtering (city + specialty + price range + rating, sorted) is the single highest-traffic query in the product. WP meta queries don't index combinations well; a flat, indexed table keeps this fast without introducing a search engine. It's rebuilt (not queried live against CPT meta) whenever a profile/service/review changes — a standard denormalization pattern, not a new architectural concept.

Ownership: a professional/business owns and edits their own profile via a scoped capability (`edit_own_bc_professional`); admins/moderators can edit any.

### Booking (`beauclick-booking`)
| Table | Purpose | Key fields |
|---|---|---|
| `wp_bc_availability_slots` | A provider's bookable windows | provider_id, service_id (nullable = applies to all services), start_at, end_at, is_recurring_rule (for weekly patterns) or materialized per-slot rows (recommendation: materialize concrete slots for a rolling N-week window via cron, rather than computing recurrence on every read — simpler queries, easy to spot conflicts) |
| `wp_bc_bookings` | The reservation itself | id, customer_id, provider_id, service_id, slot_start, slot_end, status (`pending, confirmed, completed, cancelled, no_show, rescheduled`), wc_order_id (FK, nullable until payment step), created_at, cancelled_reason |

Lifecycle: `pending` → (payment succeeds via linked Woo order) → `confirmed` → `completed` (marked by provider or auto after slot end + grace period) → eligible for review. Reschedule creates a status trail rather than mutating history away (needed later for the ranking signal's cancellation-rate calculation).

Concurrency note: booking a slot must be a single atomic `UPDATE ... WHERE status='open'` (or unique constraint on `provider_id+slot_start`) to prevent double-booking under concurrent requests — flagged explicitly for the implementation phase and for test coverage (§24).

### B2B (`beauclick-b2b`)
| Table | Purpose | Key fields |
|---|---|---|
| `wp_bc_business_accounts` | Wholesale buyer accounts | user_id, business_name, business_license_doc, approval_status |
| `wp_bc_b2b_price_tiers` | Qty-break pricing per product | product_id, min_qty, max_qty (nullable = "and up"), price or discount_percent |
| `wp_bc_quotes` | Quote requests | business_id, status (`requested, quoted, accepted, expired`), line items (JSON or child table), expires_at |

Quotes on acceptance generate a standard WooCommerce order (reusing checkout/payment/invoice machinery) rather than a parallel invoicing system.

### Payments (`beauclick-payments`)
No new tables — this module is glue logic (hooks) linking `wp_bc_bookings.wc_order_id` to WooCommerce's own `wc_order`/`wc_order_items` (HPOS: WooCommerce's High-Performance Order Storage, the current default — our code targets the `WC_Order` object API, never raw `wp_posts` order queries, so it's storage-mode agnostic).

### Chat (`beauclick-chat`)
| Table | Purpose | Key fields |
|---|---|---|
| `wp_bc_conversations` | One thread | id, type (`pro, business, support, ai`), participant_ids (customer + counterpart), last_message_at |
| `wp_bc_messages` | Messages in a thread | id, conversation_id, sender_id (nullable for AI/system), body, created_at, read_at |

Indexed on `conversation_id + created_at` for fast "load recent messages" and on `participant + last_message_at` for the conversation list.

### Reviews (`beauclick-reviews`)
| Table | Purpose | Key fields |
|---|---|---|
| `wp_bc_reviews` | Provider/service reviews | id, author_id, target_type (`provider`/`product`... though product stays on native Woo reviews, see §6), target_id, booking_id or order_id (FK — enforces "verified booking"), rating, body, images (JSON of media IDs), status (`pending, approved, rejected, flagged`) |

A review insert is only permitted server-side if the referenced `booking_id` belongs to the author and has `status = completed` — this is the "verified booking indicator" from the design README, enforced at the data layer, not just a UI badge.

### AI (`beauclick-ai`)
| Table | Purpose | Key fields |
|---|---|---|
| `wp_bc_ai_conversations` | Reuses the chat schema (`type='ai'`) or a dedicated table if AI context needs diverge (recommendation: reuse `wp_bc_conversations`/`wp_bc_messages`, add an `ai_context` JSON column for structured profile signals used in the prompt — skin type, hair type, budget, location) | |
| `wp_bc_ai_recommendation_events` | Logs which product/service/provider IDs the AI actually recommended and whether the user clicked/converted | conversation_id, message_id, recommended_type, recommended_id, clicked (bool) | 

The recommendation-events table matters twice: it lets you validate AI output against real catalog IDs before rendering (never trust the model's IDs blindly), and it's the seed data for measuring whether AI recommendations are actually driving bookings/purchases later.

### Analytics / ranking signal (supports §21, not a separate plugin — lives in `beauclick-core`)
| Table | Purpose |
|---|---|
| `wp_bc_events` | Append-only event log: `profile_view`, `booking_created`, `booking_cancelled`, `message_sent`, `response_time_seconds`, etc. — entity_type, entity_id, actor_id, meta (JSON), created_at |

This is the one genuinely forward-looking table in the schema: the AI/ranking system described in the business plan (booking count, cancellation rate, response time, profile views, sentiment) cannot be computed retroactively if the raw events weren't captured from day one. We log the events now; the *scoring algorithm* is explicitly a later phase (§13/§24).

---

## 9. User Roles

WordPress custom roles + granular capabilities (not just role string checks — capabilities let dashboards/REST endpoints check `current_user_can('edit_own_bc_booking')` rather than `current_user_can('bc_professional')`, which stays correct even if the role model changes later):

| Role | Key capabilities | Notes |
|---|---|---|
| Customer | `book_service`, `write_review` (booking-gated), `use_ai_assistant` | Default `subscriber`-equivalent, custom role for clarity |
| Beauty Professional | `manage_own_profile`, `manage_own_services`, `manage_own_availability`, `view_own_bookings`, `respond_to_reviews` | 1:1 with a `bc_professional` CPT they own |
| Business (salon/clinic) | Same as Professional + `manage_business_staff` (future multi-staff) | 1:1 with `bc_business` CPT |
| B2B Buyer | `view_wholesale_pricing`, `request_quote`, `place_bulk_order` | Granted after `bc_business_accounts.approval_status = approved` |
| Support | `view_all_conversations`, `moderate_reviews` (limited) | Internal, wp-admin only |
| Moderator | `moderate_reviews`, `moderate_professional_verification` | Internal |
| Administrator | Everything | Standard WP admin |

No separate "B2B Seller" role for v1 — the business docs don't describe multiple sellers beyond BeauClick itself running the wholesale catalog; flagged as an open question if that changes (§29).

---

## 10. Location Architecture

`Province → City → District` as first-class relational data (§8), not a WP taxonomy — chosen because it needs lat/lng, an `is_launched` flag to control the rollout (Yazd first, per README's "extend this list as new cities launch, it is not fixed to 3"), and fast filter joins that taxonomy term-meta handles poorly at scale. Every provider/business profile and every marketplace search-index row carries `city_id` (+ optional `district_id`). URLs are location-aware and SEO-friendly (`/yazd/makeup-artist`, matching the query pattern from the business plan «میکاپ عروس در یزد»). Nothing in code hardcodes Tehran or Yazd — city list is data-driven from `wp_bc_cities.is_launched`.

## 11. Marketplace Architecture
Covered in §8. Discovery (search/filter) reads from `wp_bc_provider_index`; profile detail pages read the CPT + related tables directly (lower traffic per-page, freshness matters more than raw speed there).

## 12. Booking Architecture
Covered in §8/§14. Five-step flow from the prototype (service → date → time → review & pay → confirmation) is preserved as a React overlay; step 4's payment action creates (or reuses) a WooCommerce order for the service "product" and redirects into the normal Woo payment-gateway flow, returning to step 5 on the `woocommerce_order_status_changed` webhook/hook.

## 13. B2B Architecture
Covered in §8. **Build-vs-buy flag:** WooCommerce doesn't natively support tiered wholesale pricing; there are reputable paid extensions (Wholesale Suite, B2B for WooCommerce, WholesaleX) that solve 80% of this off the shelf. Given tier pricing + MOQ + quotes is real engineering effort to build and test correctly, I recommend **evaluating one of these before building `beauclick-b2b`'s pricing engine from scratch** — this is a budget/licensing decision, not a technical one, so it's listed as an open question (§29) rather than decided here.

## 14. Payment Architecture
No parallel abstraction — WooCommerce's `WC_Payment_Gateway` system *is* the abstraction (already decouples the app from any single provider). `beauclick-payments` only bridges booking lifecycle ↔ order lifecycle and mirrors payment status onto `wp_bc_bookings` for fast dashboard reads without querying Woo objects on every dashboard load. Refunds go through Woo's native refund API, triggered by booking cancellation logic.

## 15. Chat Architecture
Custom tables + REST + client polling for v1 (§8) — deliberately not WebSockets/a realtime service at launch: PHP-FPM hosting doesn't hold long-lived connections cheaply, and a single-city launch doesn't need sub-second delivery to justify standing up Node/WebSocket infra or a third-party realtime vendor. The message-send endpoint fires a standard WP action hook (`bc_message_sent`) on every insert — that's the seam a future realtime layer (small Node/WebSocket relay, or a hosted service like Pusher, or Mercure) would subscribe to, so upgrading later is additive, not a rewrite. AI conversations don't need polling — they're synchronous request/response.

## 16. AI Architecture
`BeauClick\AI\ProviderInterface` (methods roughly: `chat(messages, context): Response`, `recommend(context): RecommendationSet`) with swappable concrete adapters selected by config — no vendor is hardcoded into calling code (chat panel, dashboards, homepage promo). All calls are server-side proxied (the frontend never holds an AI API key). Recommendation cards are only rendered after validating the model's referenced product/service/provider IDs against real DB rows (§8) — prevents dead links/hallucinated cards. Structured user context (skin type, budget, location, history) feeds the prompt as data, not free text, so it stays swappable across providers/prompt versions.

**Iran-specific risk, flagged prominently in §29:** major AI providers (Anthropic, OpenAI) generally restrict direct API access from Iranian IPs. This doesn't change the *code* architecture above (it's still provider-agnostic and server-proxied either way) but it does mean the AI module's outbound calls likely need to originate from non-Iran-restricted infrastructure (e.g., the AI relay/module deployed on a reachable region, or a compliant relay/proxy in front of the provider) — this is an infra/hosting decision that needs to be made before AI implementation starts, not a code-level one.

## 17. Search Architecture
MVP: indexed MySQL (`wp_bc_provider_index`, §8) covers filtered browse (location + specialty + price + rating) well at launch and multi-city scale. Free-text relevance (typo tolerance, Persian normalization) is the one area plain MySQL is weak at — if that becomes a real problem, the recommended upgrade path is **Meilisearch** (lightweight, fast to self-host, good typo-tolerance) rather than Elasticsearch/OpenSearch, which is disproportionate infra for this scale. This is a Phase 2+ decision, gated on actual query-quality complaints, not built speculatively.

## 18. Frontend Architecture
Hybrid, matching §1-2: server-rendered PHP templates (theme) for SEO pages, React app-shell islands for interactive surfaces, both consuming the same design-token source of truth. Concretely:
- **Server-rendered:** Home, Marketplace listing, Professional Profile (tabs can be client-hydrated for the interactive portfolio/reviews tabs, but initial content is in the HTML), Shop, Product, B2B catalog.
- **React app-shell:** Booking modal, Cart drawer, AI panel, Chat, Professional Dashboard, Customer Dashboard — i.e. exactly the surfaces the design README calls out as stateful overlays, mounted onto the server-rendered pages via a small number of DOM mount points the theme provides.
- **RTL correctness:** CSS logical properties (`margin-inline-start`, `inset-inline-end`, …) throughout, not manual left/right — the design README already talks in these terms ("bottom-inline-start corner" for the AI FAB), so this isn't a new requirement, just making sure implementation actually follows it rather than the prototype's likely physical-property shortcuts.
- Persian digits (`۰–۹`) and `tabular-nums` for prices/ratings per the token spec — implemented as a shared formatting utility used by both PHP (for server-rendered prices) and the React app-shell, so the two never drift.

## 19. API Architecture
Custom REST namespace `beauclick/v1`, alongside `wp/v2` (core) and WooCommerce's own `wc/store/v1`/`wc/v3` used as-is for cart/checkout/products. Every custom route has an explicit `permission_callback` (never left open) and a typed `args` schema for input validation. Consistent response envelope (`data` / `meta.pagination` / `error`). Auth for the app-shell: cookie + REST nonce (same-origin, avoids token-storage/XSS exposure of a separate JWT scheme) — revisit only if/when a native mobile app needs external, cross-origin API access.

## 20. Security
- Custom capabilities per §9, checked at both REST `permission_callback` and PHP template level — never role-string checks alone.
- Nonces on every state-mutating server-rendered form; capability + ownership check on every REST write (a professional can only mutate *their own* bookings/services/profile).
- Input sanitization (`sanitize_text_field`/typed REST `args`) and output escaping (`esc_html`/`esc_attr`/`wp_kses`) at every boundary — no exceptions for "internal" admin screens either.
- File uploads (portfolio media, B2B business-license docs, verification docs): strict MIME/size checks; verification/license docs stored behind a capability-gated download endpoint, not a guessable public media URL.
- Payment: redirect-based Iranian gateways keep card data off our servers entirely (PCI scope stays with the gateway); payment callbacks are verified server-side against the gateway's verify API, never trusted from redirect query params alone.
- Rate limiting on `beauclick-ai` and `beauclick-chat` send endpoints (transient-based counter is enough at launch; move to a reverse-proxy/CDN rule if abuse grows) — this is a gap WordPress doesn't cover natively and would otherwise be a real abuse vector (AI API cost, chat spam).
- AI input: basic prompt-injection/profanity guard before forwarding user text to the provider; output validated against real catalog IDs before rendering (§16) doubles as a light moderation gate.

## 21. Performance
- Composite indexes on the search-index table (`city_id, district_id, price_from, rating_avg`) — this is the query that matters most.
- Object caching: not needed for local dev; recommend a Redis object-cache drop-in once production traffic justifies it (measure first).
- Page cache for the server-rendered public pages (marketplace/profile/shop), invalidated on the relevant save hooks — biggest win-per-effort for SEO pages.
- Frontend: the app-shell bundle is code-split per surface (booking / dashboard / chat / AI) so, e.g., visiting the marketplace never downloads the dashboard bundle; AI panel bundle lazy-loads on first open.
- Images: responsive `srcset`, WebP/AVIF; explicitly deferred is any image CDN/offload — added when real media volume from professionals' portfolios justifies it.
- Deliberately **not** doing upfront: Elasticsearch, Redis, CDN, query result caching beyond page cache — these are called out as "add when data says so," not built speculatively, per your own instruction to avoid premature optimization.

## 22. Testing Strategy
| Layer | Tool | Priority coverage |
|---|---|---|
| PHP unit | PHPUnit | Booking slot-conflict logic, B2B tier-price calculation, review eligibility (booking must be completed & owned by author), ranking-event logging |
| WP/Woo integration | PHPUnit + WP core test suite, WooCommerce test helpers | Order creation from a booking, price calc with B2B tiers applied, refund-on-cancel wiring |
| REST API | `WP_REST_*` test cases | Every custom endpoint's permission boundaries (a professional cannot read another professional's bookings; a non-approved B2B account cannot see wholesale prices) |
| Frontend unit | Vitest + React Testing Library | Booking flow state machine, cart drawer state transitions |
| E2E | Playwright | Critical paths: search → book → pay → confirmation; shop → cart → checkout → order; B2B quote request → accept → order. Run in RTL/Persian locale explicitly, not just LTR-default |

Priority order matches business risk: double-booking, incorrect payment/pricing, and permission leaks (seeing someone else's data) are the failure modes that actually hurt the business — those get tests first, polish/visual regression later.

## 23. Local Windows Setup
No PHP/MySQL/Composer/Docker found on this machine — Node v22.20/npm 10.9.3/Git are already present and sufficient for the frontend half.

**Recommendation: Laragon.** Windows-native, portable, single installer, includes PHP (version-switchable), MySQL/MariaDB, Apache/Nginx, auto virtual hosts (`beauclick.test` with zero Apache config), and bundled Composer — this is the simplest reliable option for solo WP development on Windows, lighter and more scriptable than XAMPP, and less GUI-locked/opinionated than Local (WP Engine's tool), which fights custom git-based workflows. **Docker is explicitly not recommended for local dev** here — nothing in this stack needs container parity yet, and Docker Desktop's WSL2 overhead on Windows is real cost for no current benefit; it can be introduced later for CI/staging parity if the team grows, without changing the app architecture at all.

Setup outline (for the approval step, not executed yet): install Laragon → `wp core download` (or Composer-managed core) into `wordpress/` → point Laragon's virtual host at that folder → `composer install` in each plugin → `npm install && npm run build` in `app/` → import a seed DB (provinces/cities, a handful of demo professionals) via a WP-CLI script.

## 24. GitHub Workflow
- **`.gitignore`:** WordPress core files, `wp-content/uploads/`, `vendor/`, `node_modules/`, `.env`, any `*.log`.
- **Never commit:** DB credentials, payment gateway keys (test or live), AI provider API keys, WP salts — all via `.env` read into `wp-config.php` constants, with `.env.example` committed as the template.
- **Branches:** `main` (deployable), `develop` optional once multiple people are contributing, feature branches per module (`feature/booking-slot-locking`, `feature/b2b-tier-pricing`).
- **Commits:** conventional-ish prefixes (`feat:`, `fix:`, `refactor:`, `docs:`) scoped to a plugin where possible (`feat(booking): prevent double-booking on concurrent requests`).
- **README.md:** setup steps (Laragon install → clone → composer/npm install → seed DB → `npm run dev`), plus a link to this architecture doc and the design handoff as the two sources of truth.

## 25. Deployment Strategy
- Environment config via `.env` per environment (local/staging/production) — DB creds, gateway keys (test vs live), AI keys, storage keys — never hardcoded.
- Media: local disk in dev; recommend object storage offload (an Iran-reachable S3-compatible provider — e.g. ArvanCloud or Liara object storage) once production media volume grows, via a standard WP offload plugin — not built custom.
- Cron: **disable WP-Cron's default page-load trigger** and drive it from a real system cron hitting `wp cron event run` on a schedule — WP-Cron firing only on page views is unreliable for booking reminders and scheduled jobs (slot materialization, AI usage-cap resets) at real traffic levels.
- SSL via the host (Let's Encrypt); irrelevant for local dev unless a feature genuinely needs HTTPS locally (e.g., testing service workers).
- Backups: scheduled DB dump + media backup with a retention policy — an infra/ops task to schedule once hosting is chosen, not an architecture blocker.
- **Hosting location is a decision with real technical consequences, not just a business one** — see §29.

---

## 26. Development Phases

Broadly the sequence you proposed is sound; two adjustments: the search-index table build belongs inside Phase 4 (it's part of "marketplace," not a separate concern), and B2B's build-vs-buy decision (§13) needs resolving *before* Phase 7 starts, not during it.

| Phase | Scope |
|---|---|
| 0 | Environment (Laragon) + repo scaffold + this architecture doc reviewed/approved |
| 1 | WordPress + WooCommerce foundation, `beauclick-core`, custom roles/capabilities |
| 2 | Design-system package (`app/packages/design-system`) + theme shell, token parity between PHP and React |
| 3 | Locations module + auth/user flows for all roles |
| 4 | Marketplace (profiles, services, portfolio, search index, marketplace/profile pages) |
| 5 | Booking (availability, slot locking, 5-step flow, booking↔order linkage) |
| 6 | Ecommerce + checkout + payment gateway integration |
| 7 | B2B (after the build-vs-buy call is made) |
| 8 | Dashboards (professional + customer) |
| 9 | Chat |
| 10 | AI (contingent on the Iran-access infra decision, §29, being resolved) |
| 11 | Reviews + ranking-signal event logging + loyalty stub |
| 12 | Testing hardening, performance pass, deployment |

---

## 27. Risks

1. **AI provider access from Iran** — highest-severity open risk; see §16/§29. Blocks Phase 10 until resolved, and ideally resolved before Phase 1 so hosting topology isn't retrofitted.
2. **Payment gateway callback reachability** — Iranian gateway webhooks/callbacks need to reliably reach wherever the app is hosted; interacts with the same hosting-location decision.
3. **B2B pricing engine scope creep** — tier pricing + MOQ + quotes is easy to underestimate; the build-vs-buy call (§13) should happen early, not get discovered mid-Phase-7.
4. **Search-index staleness** — the denormalized `wp_bc_provider_index` table must be kept in sync via hooks on every profile/service/review change; a missed hook is a silent bug (stale ratings/prices in search results) — needs test coverage, not just code review.
5. **Booking double-booking under concurrency** — needs an atomic DB operation, not an application-level check-then-write race.
6. **Content quality (Persian copy, real photography)** — the prototype's placeholder imagery/copy needs a real content pipeline before launch; not an engineering risk, but a launch-blocking one worth tracking.

## 28. Open Questions (need your decision before or during the relevant phase)

1. **AI infra:** given Iran-access restrictions on major AI providers, where does the AI relay/module get hosted, and which provider(s) are actually reachable/compliant for this use case? This materially affects Phase 10 timing and possibly overall hosting topology.
2. **B2B pricing:** build `beauclick-b2b`'s tier-pricing engine from scratch, or evaluate/license an existing WooCommerce B2B extension first? (Budget decision — flagged, not decided, in §13.)
3. **Professional/business content editing:** do professionals edit their own profile through a restricted wp-admin view, or a purpose-built front-end editor in the React dashboard? (The design brief's dashboard mockup implies the latter; confirming before Phase 8.)
4. **Hosting provider/region:** domestic Iranian hosting (ArvanCloud/Liara/ParsPack) vs. international — affects payment callback latency, media offload choice, and the AI relay question above. These are coupled, not independent decisions.
5. **B2B seller model:** is BeauClick the only wholesale seller for v1, or do other sellers need onboarding later? (Assumed single-seller per §9 based on current docs; flag if wrong.)
6. **Native mobile app:** any near-term plan? Doesn't change v1 architecture (REST API is being built regardless) but would justify token-based auth sooner rather than cookie+nonce.

## 29. Recommended Decisions (my defaults if you don't override them)

- Classic WP theme + React app-shell hybrid (not full headless) — §1/§2.
- Bookings modeled as WooCommerce orders under the hood, not a parallel payment system — §14.
- One plugin per domain around `beauclick-core`, no monolith plugin — §9.
- Custom relational tables for locations/bookings/chat/reviews/AI/search-index; CPTs only for editorial content (profiles, portfolio, services) — §10.
- MySQL-indexed search for v1; Meilisearch only if/when free-text relevance actually becomes a problem — §19.
- Polling-based chat for v1; realtime deferred behind an additive hook seam — §17.
- Laragon for local Windows dev, no Docker yet — §25.
- Redis/CDN/page-cache/image-offload all deferred until traffic data justifies them — §21/§27.

---

**Next step:** confirm or override the open questions in §28 (AI hosting/provider and B2B build-vs-buy are the two that materially change early-phase work), then I'll begin Phase 0/1 scaffolding — repo init, Laragon-based local environment, WordPress + WooCommerce + `beauclick-core` — with no design or business-logic deviation from what's documented above without flagging it first.
