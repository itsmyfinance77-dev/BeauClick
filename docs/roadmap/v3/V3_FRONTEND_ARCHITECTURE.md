# V3 Frontend Architecture

Status: Phase 0 blueprint. **No UI code has been written, no frontend project initialized.** Decision basis: `docs/roadmap/v3/adr/ADR-012-frontend-architecture.md`.

---

## 1. Next.js architecture

App Router, TypeScript, one application per `apps/{web,admin}` (`V3_REPOSITORY_STRUCTURE.md`). Rendering strategy per route group:

| Route group | Rendering | Examples | Rationale |
|---|---|---|---|
| `(public)` | SSR (dynamic) / ISR (semi-static) | `/`, `/providers/[slug]`, `/marketplace`, `/shop`, `/shop/[product]` | SEO-critical, crawlable, per-request-varying content (`V3_ARCHITECTURE_DISCOVERY.md` §14) |
| `(reference)` | SSG/ISR (revalidate on schedule) | `/specialties`, legal/info pages | Low-change content, no need for per-request freshness |
| `(app)` | CSR (client components within a server-rendered shell) | `/dashboard/*`, `/booking/*`, `/journey/*` | Session-specific, stateful, non-SEO surfaces — the direct successor to V2's app-shell islands |
| `(admin)` | CSR, `apps/admin` (separate app or gated route group — open question, §7) | `/admin/*` | Internal-only, capability-gated |

## 2. SSR/SSG strategy detail

- **Marketplace listing**: SSR for the initial filtered result set (server has the request's query params — city/specialty/etc. — at render time, matches V2's proven city/specialty-aware metadata pattern exactly); client-side re-fetch on filter change without a full page reload (a real UX improvement over V2's query-string-triggered full reloads, achievable now that there's a real client router).
- **Provider profile pages**: SSR — content genuinely varies per profile, must be crawlable and fast (LCP-sensitive, per the original `ARCHITECTURE_PROPOSAL.md` §2's own SEO/LCP reasoning).
- **Reference pages** (specialty listing, static content): SSG with ISR revalidation (e.g. hourly) — no V2 evidence these ever need per-request freshness.
- **Thin/zero-result marketplace combinations**: server-side detection (port of `bc_get_meaningful_marketplace_filters()`'s logic) drives both the canonical-collapse behavior and a `noindex` meta tag via `generateMetadata` — preserving the exact discipline `V3_ARCHITECTURE_DISCOVERY.md` §14 documents, now as a Next.js data-fetching function instead of a WordPress filter chain.

## 3. App Router structure (illustrative — not scaffolded)

```
apps/web/app/
├── (public)/
│   ├── page.tsx                        # homepage — WebSite/Organization JSON-LD
│   ├── marketplace/page.tsx            # SSR, city/specialty query params
│   ├── providers/[slug]/page.tsx       # SSR, LocalBusiness/BreadcrumbList JSON-LD
│   ├── shop/page.tsx
│   └── shop/[product]/page.tsx
├── (reference)/
│   └── specialties/page.tsx            # SSG/ISR
├── (app)/
│   ├── dashboard/professional/page.tsx # CSR shell, client components
│   ├── dashboard/customer/page.tsx
│   ├── booking/[providerId]/page.tsx   # CSR booking flow
│   └── journey/page.tsx
├── sitemap.ts                          # replaces inc/sitemap.php's custom provider
├── robots.ts                           # replaces bc_filter_wp_robots()
└── layout.tsx                          # RTL dir="rtl", design-token CSS variables
```

## 4. Component library

- `packages/ui` — design-system primitives (Button, Card, Chip, Badge, Modal, Input, RatingStars, etc.), ported with **zero logic change** from `app/src/design-system/primitives` per `V3_MIGRATION_MATRIX.md`'s DIRECT REUSE classification. One extension required, not optional: only `Modal` has real axe-core a11y test coverage in V2 today — extend that coverage to the rest of the primitive set before calling it "accessible" (the same gap V2's own migration matrix flags).
- Feature components (booking flow, cart, chat, dashboards, search) — UI/UX mostly survives per `V3_MIGRATION_MATRIX.md`'s Frontend section; the data-fetching layer underneath is rewritten against `V3_API_CONTRACT_BLUEPRINT.md`'s envelope/JWT conventions, not the WP-nonce/cookie pattern.

## 5. Design system migration

`shared/design-tokens.json` → `packages/design-tokens`, same generator pattern (tokens → CSS custom properties + TS constants), consumed identically by both `apps/web` and `apps/admin` — zero drift risk, since there's now only one consumer language (TypeScript) instead of the PHP+TS split V2 had to keep manually in sync.

## 6. RTL strategy

Document-level `dir="rtl"` (Next.js `<html lang="fa" dir="rtl">` in the root layout), CSS logical properties throughout (`margin-inline-start`, `inset-inline-end`, …), zero LTR branching anywhere in component code — carried forward unchanged as a DIRECT-REUSE **pattern** (not specific CSS, since components themselves are being ported, but the discipline governing how new CSS is written).

## 7. Persian localization & Jalali handling

`packages/persian-utils` = `jalali.ts` (pure y/m/d integer math, zero dependencies) + `format.ts` (Persian digit/date/currency formatting) — ported verbatim, including the one documented, already-fixed real bug (digit-substitution ≠ calendar conversion) preserved as a regression test, not silently dropped. No new i18n/l10n framework adopted — this is a Persian-only product with no language switcher anywhere in the requirements, so a general-purpose i18n library (react-intl, next-intl) would be unused complexity; a shared formatting utility (the existing pattern) remains the right-sized solution.

## 8. Mobile-first approach

Carried forward as an existing design-system property, not re-derived — **flagged as an assumption, not independently re-verified in this pass**: confirm against the actual token/breakpoint values in `packages/design-tokens` during Phase 1 implementation, since this blueprint did not re-audit the CSS itself for mobile-first correctness (out of scope for a Phase 0 document review).

## 9. What is preserved vs. dropped (summary)

| | Preserved | Dropped, no V3 equivalent needed |
|---|---|---|
| Design tokens | ✅ verbatim | — |
| Design-system primitives | ✅ near-verbatim (+ a11y extension) | — |
| Jalali/Persian utilities | ✅ verbatim | — |
| RTL enforcement pattern | ✅ verbatim | — |
| Feature component UI/UX | ✅ mostly | Data-fetching layer (`api.ts` rewritten) |
| Mount-point architecture | — | ✅ dropped entirely — no PHP template to signal into |
| `storeApi.ts` (WooCommerce Store API wrapper) | — | ✅ dropped wholesale — WooCommerce retired (ADR-001) |
| SEO metadata/structured-data logic | ✅ rules ported | Mechanism rebuilt against Next.js APIs |

## 10. Open question, not decided here

Whether `apps/admin` is a fully separate Next.js application or a capability-gated route group within `apps/web` — both are workable; the decision depends on how separate the admin team's deploy cadence needs to be relative to the customer-facing app, which is a Phase 1-2 operational question, not an architectural one this blueprint needs to force now.

---

## Cross-references
- `ADR-012-frontend-architecture.md` — the decision this blueprint operationalizes.
- `V3_ARCHITECTURE_DISCOVERY.md` §14 — the SEO findings this document's rendering-strategy choices are built to satisfy.
- `V3_API_CONTRACT_BLUEPRINT.md` — the API conventions the frontend's data layer consumes.
- `V3_REPOSITORY_STRUCTURE.md` — where `apps/web`, `apps/admin`, and the `packages/*` this document references live.
