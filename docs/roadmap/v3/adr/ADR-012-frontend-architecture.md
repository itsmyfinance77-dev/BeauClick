# ADR-012: Frontend Architecture

**Status:** Proposed — Phase 0 blueprint only, not decided/approved. No frontend project has been initialized.
**Date:** 2026-08-20.

## Context

V2's frontend is already React 18 + TypeScript + Vite, with a proven, zero-WP-coupling design-token/primitive layer (`app/src/design-system`) and pure, well-tested Jalali/Persian utilities (`app/src/lib/jalali.ts`/`format.ts`) — all classified DIRECT REUSE in `V3_MIGRATION_MATRIX.md`. The one V2-specific mechanism with no V3 equivalent is the mount-point architecture (`data-bc-*-trigger` + delegated listeners, `app/src/mounts/`, 11 files) — purpose-built for "React islands inside PHP pages," which has nothing to mount into once WordPress is retired (ADR-001). SEO-critical pages (marketplace, profile, shop) currently depend on WordPress server-rendering their HTML shell (`V3_ARCHITECTURE_DISCOVERY.md` §14) — a real, proven requirement (the architecture proposal's own flagship SEO query, «میکاپ عروس در یزد», was confirmed unable to rank before V2.2 Step 12's dynamic per-page metadata existed), not a nice-to-have.

## Decision

**Next.js (App Router)**, replacing both the WordPress-rendered PHP shell and the mount-point React-islands mechanism with one real application.

- **SSR** for pages where content genuinely varies per-request and must be crawlable: professional/business profile pages, the marketplace listing (server-rendered for the initial filtered result set, matching V2's proven city/specialty-aware metadata discipline).
- **SSG/ISR** for low-change reference content: specialty listing pages, static legal/informational pages (revalidated on a schedule, not per-request — no V2 precedent for these needing real-time freshness).
- **CSR** (client components) for everything stateful/session-specific: booking flow, cart, AI panel, chat, both dashboards — the direct successor to V2's "React app-shell islands," now as ordinary Next.js client components within one real app instead of DOM-mount-point-signaled islands bolted onto PHP pages.
- **App Router structure**: route groups separating `(public)` (SSR/SSG, unauthenticated-reachable — marketplace, profiles, shop) from `(app)` (CSR-heavy, session-required — dashboards, booking flow) from `(admin)` (the `apps/admin` application, per `V3_REPOSITORY_STRUCTURE.md`, gated on platform capabilities).
- **Preserve, not rebuild**: design tokens (`packages/design-tokens`), design-system primitives (`packages/ui`), Jalali/Persian formatting (`packages/persian-utils`) — ported with zero logic changes, only their build/consumption wiring changes (Vite → Next.js's own bundler). RTL is enforced identically (document-level `dir="rtl"`, CSS logical properties throughout, zero LTR branching) — a Persian-only product, no new i18n framework needed for a language switcher this product doesn't have.
- **Mobile-first**: carried forward as an existing design-system property (V2's tokens/primitives were already built mobile-first per the approved design brief) — not independently re-verified as new in this pass; flagged as an assumption to confirm against the actual token/primitive CSS during Phase 1, not re-decided here.

## Consequences

- **Positive:** closes the real, proven SEO requirement without WordPress — Next.js's SSR/ISR replaces exactly the capability WordPress's PHP template layer provided, and does so within the same TypeScript codebase as the rest of the design-system/component work (no framework split). The mount-point mechanism's entire complexity (DOM signaling, delegated click listeners, `window.BeauClick` global) disappears — a real router replaces it, not a patch.
- **Negative:** every SEO-bearing page's metadata/structured-data/sitemap logic (`inc/seo.php`, `inc/sitemap.php` — `V3_ARCHITECTURE_DISCOVERY.md` §14) must be rebuilt against Next.js's `generateMetadata`/`sitemap.ts` APIs — the *rules* (thin-page canonical collapse, never-fabricate structured data) port directly as extracted business logic, but the *code* does not.
- **Risk:** none specific found beyond the general new-framework ramp-up; Next.js's App Router is a mature, well-documented target for exactly this SSR/CSR-hybrid shape.

## Alternatives considered

- **Continue Vite + client-side-only SPA, add a separate lightweight SSR/prerender step only for SEO pages.** Rejected — this reinvents a narrower, worse-supported version of what Next.js already provides as a coherent whole, for no offsetting benefit once WordPress (the thing that made "keep Vite, let WP render the shell" attractive in V2) is gone.
- **Remix**: a reasonable alternative SSR React framework; not chosen because no V2 evidence distinguishes a need Remix serves better than Next.js for this product, and Next.js's ecosystem maturity for the ISR/ISR-revalidation pattern this product's ~launched-city-count-scale reference pages need is the deciding factor.
- **Full SPA (no SSR at all), accept an SEO regression.** Rejected outright — SEO is a named, evidenced, product-critical requirement (`ARCHITECTURE_PROPOSAL.md` §1's own framing: "Google + Digikala + Snapp Food for beauty," organic discovery is core to the business model), not a feature to trade away for frontend simplicity.
