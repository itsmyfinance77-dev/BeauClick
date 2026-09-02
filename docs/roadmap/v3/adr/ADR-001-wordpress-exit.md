# ADR-001: WordPress/WooCommerce Exit Strategy

**Status:** Accepted — implemented by the V3 replacement. Historical discovery rationale retained.
**Date:** 2026-08-19.
**Deciders:** Product/engineering owner (pending).

## Context

V2.4.1 is a classic WordPress + WooCommerce monolith (per `docs/architecture/ARCHITECTURE_PROPOSAL.md`, approved 2026-08-10) with 18 custom `beauclick-*` plugins around a shared `beauclick-core`, and a React "app-shell" mounted into server-rendered PHP pages. This was the *correct* v1 decision — Iranian payment gateways ship as classic WooCommerce plugins, and a from-scratch commerce/payment/tax engine would have been wasted effort pre-launch. `V3_MIGRATION_MATRIX.md` (10-domain discovery pass) found that WordPress is used for exactly three things: (1) the user/session/role table, (2) four content-editing CPTs (`bc_professional`/`bc_business`/`bc_service`/`bc_portfolio_item`), and (3) the plugin/hook loading mechanism. Every domain that actually matters for the product (bookings, financial ledger, campaigns, loyalty, chat, AI conversations, locations) **already lives in dedicated `wp_bc_*` relational tables, not WordPress's post/postmeta model** — confirmed by migration-file inspection, not assumption.

WooCommerce is used natively for orders/cart/checkout/payment-gateway plumbing only; three independent, uncoordinated WooCommerce price-modifying hooks (Campaign, Membership, B2B tier pricing) are V2's own most-frequently-named integration risk (`V3_ARCHITECTURE_PLAN.md` §2).

## Decision

**Exit WordPress and WooCommerce entirely in V3.** Do not retain WordPress as a CMS/admin shell, do not retain WooCommerate as the commerce engine. Every `wp_bc_*` custom table's schema and business rules (not its `$wpdb` implementation) carry forward per `V3_MIGRATION_MATRIX.md`'s classification (DIRECT REUSE / BUSINESS-RULE EXTRACTION / REFACTOR, as appropriate per component). WooCommerce is replaced by a native `commerce-service` (ADR-002, `V3_ARCHITECTURE_PLAN.md` §2) built with one unified pricing-rule-provider chain, closing the recurring uncoordinated-hook risk by construction.

The one category with real re-platforming cost, not just schema translation: **the four CPTs** (`bc_professional`/`bc_business`/`bc_service`/`bc_portfolio_item`) become real relational tables with first-class columns instead of post/postmeta lookups (`V3_MIGRATION_MATRIX.md`, Professional/Business row). This is the single largest "REIMPLEMENT" item in the whole matrix, not a lift-and-shift.

See `WORDPRESS_EXIT_MATRIX.md` for the full category-by-category dependency inventory (CPTs, wpdb tables, cron, hooks, roles, REST, admin pages, media) that this decision is grounded in.

## Consequences

- **Positive:** removes the single-server PHP-FPM constraint, removes WordPress core-upgrade/plugin-compatibility maintenance burden, removes the uncoordinated-price-hook risk class by construction, enables the target stack's language/tooling uniformity (TypeScript throughout).
- **Negative:** every server-rendered SEO page (marketplace, profile, shop) must be re-built for SSR/SSG in the new frontend stack — this is real, non-trivial work, not a copy. WordPress's admin/media-library/role system, used today for zero-cost content editing and file storage, needs a genuine V3 replacement (a real admin app + object storage), not a "keep wp-admin around" shortcut. Every WooCommerce-native piece (coupons [unused], tax classes, payment-gateway plugins) has **zero portable code** — `V3_MIGRATION_MATRIX.md` marks WooCommerce-native pieces **RETIRE**, explicitly "must not be recreated under a different name."
- **Risk:** the CPT→relational-table re-platform (professional/business/service/portfolio) touches the most business-critical, highest-traffic read path (marketplace search/profile) — sequenced first in `V3_MIGRATION_PLAN.md`'s roadmap precisely because it's the riskiest, not left for later.

## Alternatives considered

1. **Keep WordPress/WooCommerce indefinitely, add services alongside it (strangler around, not through).** Rejected — the brief explicitly mandates NestJS/TypeScript/Postgres as the target stack, and the discovery pass found nothing in WordPress's own value (CMS, admin, media) that isn't cheaply replaceable; keeping it would mean maintaining two stacks' operational surface (PHP+Node) with no compounding benefit.
2. **Headless WordPress (WP as pure REST API behind a new frontend).** Considered and rejected already in `ARCHITECTURE_PROPOSAL.md` §2 for v1 (Iranian gateway plugins don't work headless); the same objection no longer applies once WooCommerce itself is retired in V3, so this option collapses into "exit entirely" once payments move to ADR-006's native abstraction anyway — there is no longer a reason to keep WordPress as an API layer once its content model is also being replaced.
