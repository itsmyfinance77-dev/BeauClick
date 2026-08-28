# BeauClick — Temporary Visual Mockup Asset Inventory

**Status: all assets below are TEMPORARY development/staging mockups.** None depict a real person, real salon/clinic, or real branded product. Every asset is a hand-authored, fully abstract/geometric SVG illustration — no photograph, no photorealistic AI generation, no facial features on any figure, no brand names or logos of any kind. This document is the authoritative record of what exists, why, and what should replace each asset once real content is available.

**Why SVG illustration rather than photography:** this environment has no photorealistic image-generation tool available, and — independently of that constraint — the product's own existing design system (`docs/design/DESIGN_HANDOFF.md`, `app/src/design-system/primitives/PlaceholderImage.tsx`) already states explicitly: *"No real photography/icons in the approved design — every image is a placeholder treatment."* Abstract, faceless illustration is not a workaround here; it is the more defensible choice on its own terms — it cannot be mistaken for a real identifiable person, place, or product, which directly serves the requirement that these mockups must never falsely represent real professionals, businesses, or products.

**Where the files live:**
- Theme (PHP-rendered pages): `wordpress/wp-content/themes/beauclick/assets/mockups/`
- React app-shell: `app/src/assets/mockups/` (only `empty-illustration.svg`, the one asset a React component consumes — mirrors the existing per-side-copy convention already used for the Vazirmatn font, see `app/src/design-system/base.css`'s own comment)

**How they reach the page — real vs. mock data stays distinguishable internally, never in the customer-facing UI:** a new `bc_mockup_image_url( int $post_id )` helper (`wordpress/wp-content/themes/beauclick/inc/helpers.php`) reads a `_bc_mockup_image` (and, for professional cover banners, `_bc_mockup_cover`) postmeta key — written **only** by the demo/dev seeders (`DemoProvidersSeed`, `DemoProductsSeed`), never by any real user action or admin UI. Priority order, every time: a real featured image (`has_post_thumbnail()`) always wins if one is ever set → the mockup meta, if present → the original honest gradient `.bc-placeholder-image` treatment, unchanged, for any organically-created post with neither. No visible "mockup"/"temporary" label appears on any customer-facing page — internal distinguishability comes entirely from the dedicated postmeta key and this document, not from on-page text, so the product still looks finished rather than like a labeled demo.

**Why not WordPress's Media Library / a real featured image for these:** WordPress does not allow `.svg` uploads by default (`upload_mimes` excludes it as a deliberate anti-XSS measure). Widening that allowlist site-wide just to store a handful of trusted, developer-authored files would be a real security-posture change with no relation to this task, so these mockups deliberately bypass the attachment pipeline entirely via the postmeta approach above.

---

## Professional portraits (5)

Abstract, faceless geometric bust illustrations — a soft gradient wash, a rounded head/shoulders silhouette, a distinct abstract hair/headscarf silhouette per figure, a small decorative accent. No facial features on any figure, by design — this is what makes it structurally impossible for any of these to be read as a specific identifiable person.

| Asset | Used for (demo account) | Aspect ratio | Used in |
|---|---|---|---|
| `professional-1.svg` | سارا احمدی (`bc_demo_sara_ahmadi`) | 1:1 (square viewBox, cropped via `object-fit:cover`) | Provider card (marketplace + homepage rail, 4:3 crop), profile avatar (96×96 crop) |
| `professional-2.svg` | نیلوفر کرمانی (`bc_demo_niloofar_kermani`) | 1:1 | Same as above |
| `professional-3.svg` | مهسا رضایی (`bc_demo_mahsa_rezaei`) | 1:1 | Same as above |
| `professional-4.svg` | پریسا حسینی (`bc_demo_parisa_hosseini`) | 1:1 | Same as above |
| `professional-5.svg` | عاطفه کریمی (`bc_demo_atefeh_karimi`) | 1:1 | Same as above |

**Real production replacement:** each professional's own real, uploaded profile photo, set as the post's real featured image (`has_post_thumbnail()`) — which already, automatically, takes priority over the mockup the moment it exists. No template change will be needed when that happens.

## Salon/environment illustrations (3)

Abstract interior compositions — a vanity mirror, a salon chair silhouette, a product shelf, plant accents — cycled across the 5 demo professionals' cover banners for variety (no 1:1 professional↔salon mapping; several professionals share a salon variant).

| Asset | Aspect ratio | Used in |
|---|---|---|
| `salon-1.svg` | 8:3 (wide) | Professional profile cover banner (16:5 crop) — سارا احمدی, پریسا حسینی |
| `salon-2.svg` | 8:3 | Same — نیلوفر کرمانی, عاطفه کریمی |
| `salon-3.svg` | 8:3 | Same — مهسا رضایی |

**Real production replacement:** a real photo of the professional's actual workspace/salon, once one exists to upload — currently no dedicated upload UI or postmeta field exists for a "cover photo" distinct from the CPT's own featured image, so this would need a small, separate field addition when real cover photography becomes available (out of this task's scope — a mockup-population task, not a new-feature task).

## Product mockups (6)

Generic, unbranded bottle/jar/tube illustrations — no text, no logo, no brand name anywhere on any label. Mapped 1:1 to the 6 real demo Shop products (`DemoProductsSeed`), matching each product's real category.

| Asset | Demo product (SKU) | Aspect ratio | Used in |
|---|---|---|---|
| `product-serum.svg` | سرم ویتامین C (`bc-demo-serum-c`) | 4:3 | Shop product card, product detail page |
| `product-moisturizer.svg` | مرطوب‌کننده روزانه (`bc-demo-moisturizer`) | 4:3 | Same |
| `product-hairmask.svg` | ماسک ترمیم‌کننده مو (`bc-demo-hair-mask`) | 4:3 | Same |
| `product-shampoo.svg` | شامپو ضدریزش (`bc-demo-shampoo`) | 4:3 | Same |
| `product-sunscreen.svg` | ضدآفتاب پوست چرب SPF50 (`bc-demo-sunscreen`) | 4:3 | Same |
| `product-lipstick.svg` | رژ لب مات (`bc-demo-lipstick`) | 4:3 | Same |

**Real production replacement:** real product photography, uploaded as each `WC_Product`'s real featured image (`_thumbnail_id`) — WooCommerce's own, already-functional image pipeline; the mockup meta only fires when no real product image exists.

## Decorative / illustrative (2)

| Asset | Purpose | Aspect ratio | Used in |
|---|---|---|---|
| `hero-illustration.svg` | Homepage hero visual — a richer abstract vanity-mirror/floral composition replacing the previous flat gradient block | 4:3 | `front-page.php` hero (`aria-hidden`, desktop-only ≥900px — unchanged, pre-existing responsive behavior) |
| `empty-illustration.svg` | Generic "nothing here yet" illustration — stacked photo-frame motif, reusable anywhere an empty state benefits from a soft visual rather than text alone | 5:4 | Professional profile Portfolio "coming soon" section (PHP); `EmptyState` component's new optional `illustration` prop (React) — applied to the cart's empty state and the Beauty Journey tab's top-level empty state |

**Real production replacement:** the hero illustration is pure decoration with no data dependency — replace directly with real campaign/lifestyle art whenever the brand has one. The empty-state illustration is intentionally generic/reusable and has no specific "real" replacement — it can remain indefinitely, or be replaced with a proper icon-library illustration if this product ever adopts one (it explicitly does not today, per the design handoff).

---

## Non-goals (explicitly not built, and why)

- **`bc_business` public profile page** — confirmed, during the UI audit, to not exist as a dedicated template at all (falls back to WordPress's default page rendering). This is a real, separate product gap outside a visual-mockup task's scope — flagged, not fixed here.
- **Booking modal, receipt, checkout, cart line items, Beauty Journey goal/timeline rows, chat avatars** — none of these have an existing image slot; adding one would be new UI, not a mockup fill-in, and none were judged to genuinely need one per "only use images where they improve the UX."
- **AI `RecommendationCard`'s provider/service image variants** — a real `image` field/fallback pattern already exists for the `product` variant; wiring the provider/service variants would require a backend `CatalogContext.php` change (returning an image URL) — a small but real backend change, deliberately left out to keep this task UI/asset-only.
- **Per-service imagery** — no image slot exists anywhere for individual services (only for professionals/products), and adding one with no UI surface to consume it would be exactly the "images everywhere for their own sake" this task explicitly warns against.
