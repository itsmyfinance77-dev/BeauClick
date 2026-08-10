# Handoff: BeauClick — Persian Beauty Marketplace, Booking, Ecommerce, B2B & AI Platform

## Overview
BeauClick is a Persian-first (RTL), nationwide Iranian platform combining a beauty-professional marketplace, online booking, ecommerce, B2B wholesale, professional/customer dashboards, chat, and an AI beauty assistant. Yazd is the initial launch city; the product and location model are designed to scale to all Iranian provinces and cities from day one.

This freeze is the **approved visual and UX direction**. Implementation should not deviate from the visual language documented here without a new design pass.

## About the Design Files
The file `BeauClick.dc.html` in this bundle is a **design reference prototype** — an interactive HTML/React mockup built to demonstrate layout, visual language, copy, and interaction flows. It is **not production code to copy directly**. The task is to **recreate this design in the target codebase's real environment** (WordPress/WooCommerce templates + a modern front-end layer, or whatever stack the team standardizes on) using that environment's own component/templating patterns — matching this prototype pixel-for-pixel in visual language, spacing, and interaction behavior.

WooCommerce is the commerce **engine** (products, cart, orders, checkout data, payments) — it must never surface its default theme/UI. All customer-facing screens must render through the BeauClick design system described below.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and component states below are final. Copy shown is realistic Persian example content (names, cities, prices) — implement with real data/CMS content later, following the same tone and format.

## Product Geography (critical)
- Iran is the market; **Yazd is the initial launch city**, not a hard limit.
- Location model: **Iran → Province → City → District/Neighborhood**.
- Never hardcode Tehran as a default. The marketplace location filter must support any city (Yazd, Tehran, Isfahan, Shiraz, Mashhad, Tabriz, Karaj, Ahvaz, Qom, Rasht, Kerman, …), and provider records must carry city + district data from the start.
- The prototype's marketplace screen demonstrates this with a city-filter chip row (currently: همه شهرها / یزد / تهران / اصفهان) sitting above the specialty-filter row — extend this list as new cities launch, it is not fixed to 3.

## Screens / Views

### 1. Home
**Purpose:** Communicate the core concept (find → book → pay → buy → ask AI) and route into every other surface.
**Sections (top to bottom):** Hero (kicker + H1 + subhead + search bar + 3 trust stats + visual placeholder + floating "appointment confirmed" card) → Category pill row (horizontal scroll) → "متخصصان پیشنهادی" provider rail (4 cards, horizontal grid) → AI promo banner (gradient) → "محصولات محبوب" product grid (4 cards) → B2B dark banner.
**Key components:** `HeroSearchBar`, `CategoryChip`, `ProviderCardCompact`, `AIPromoBanner`, `ProductCard`, `B2BBanner`.
**Responsive:** Hero grid is 2-col (1.1fr/0.9fr) on desktop, stacks to 1-col on mobile; hero visual column is hidden below 900px.

### 2. Marketplace (Beauty Professional Discovery)
**Purpose:** Search/filter/discover professionals nationwide.
**Sections:** Page title + result count with dynamic location label ("متخصص در سراسر ایران" or "متخصص در {city}") → City filter chip row → Specialty filter chip row → Responsive provider grid (`auto-fit, minmax(280px,1fr)`) → Empty state if a filter combination yields zero results.
**Provider card:** image placeholder, name + verified badge, specialty, ★ rating, review count, city+district, starting price, "رزرو نوبت" CTA (opens booking modal without leaving the grid).
**States:** default, hover (lift + shadow), empty ("متخصصی با این فیلتر پیدا نشد…").

### 3. Professional Profile
**Purpose:** A professional's full public identity — closer to a personal brand page than a listing.
**Sections:** Cover band (gradient placeholder) → header row (avatar, name, verified badge, specialty, rating/reviews/location, رزرو نوبت + پیام CTAs) → Tabs (درباره / نمونه‌کار / خدمات / نظرات) → tab content.
**Tabs:** About = bio paragraph. Portfolio = 6-box responsive image grid (before/after + work samples/video placeholders). Services = list rows (name, duration, price, "رزرو" CTA per service — opens booking pre-filled with that service). Reviews = list of rating+text+date cards.

### 4. Booking (modal overlay, 5 steps)
**Purpose:** Reserve a specific service with a specific professional.
**Flow:** ۱. انتخاب خدمت (radio-card list) → ۲. انتخاب تاریخ (7-day horizontal chip picker) → ۳. انتخاب ساعت (3-col time grid, disabled slots greyed) → ۴. بررسی و پرداخت (summary card + payment method radio + "پرداخت و تأیید نهایی") → ۵. Success state (checkmark, summary line, CTA back to home).
**Chrome:** progress dots (5, active one widens to 24px pill), close button, prev/next footer nav (hidden on steps 4-5 since those have their own primary action), Next disabled until the current step's required selection is made.
**Responsive:** Full-screen sheet on mobile; centered 520px modal with rounded corners on desktop.

### 5. Shop (Ecommerce listing)
**Purpose:** Browse/buy beauty products.
**Sections:** Title → category filter chip row → responsive product grid.
**Product card:** image placeholder (discount badge top-start when on sale, wishlist heart top-end), brand, name, ★ rating, price row (current + strikethrough old price), "افزودن به سبد" outlined button (fills on hover) — adds to cart and opens the cart drawer.

### 6. B2B (Wholesale)
**Purpose:** A distinct, more operational experience for salons/clinics/independent pros buying in bulk. Must never look like a discounted B2C store.
**Sections:** Dark hero (INK background, white text, kicker "BeauClick Business", 2 CTAs, 3 trust stats) → Tiered-discount table (۱-۹ / ۱۰-۴۹ / ۵۰-۹۹ highlighted as "پیشنهادی" / ۱۰۰+) → Wholesale catalog grid (MOQ label + wholesale price vs. list price + "افزودن به سفارش عمده").

### 7. Professional Dashboard
**Purpose:** Day-to-day business management for a professional.
**Layout:** Left sidebar nav (10 items; horizontal scroll strip on mobile) + main content.
**Overview tab (built):** Greeting + date → 4 stat cards (today's bookings, month revenue, new clients, overall rating) → 2-col row: weekly bookings bar chart (7 bars) + "today's upcoming" list → recent-bookings table with color-coded status pills (تأیید‌شده / در انتظار / لغو‌شده).
**Other 9 nav items:** placeholder state ("این بخش در نسخه بعدی محصول تکمیل می‌شود") — reserved IA, not yet designed in depth.

### 8. Cart drawer / Checkout (mini-flow)
**Purpose:** Right-side drawer, 3 states: list → review → success.
**List:** line items with qty +/− and remove, subtotal, "تکمیل خرید".
**Review:** address card (defaults to a Yazd address), payment-method radio (reused from booking), order summary (subtotal + free shipping + total), "پرداخت و ثبت سفارش" + back-to-cart link.
**Success:** checkmark, order code, "بازگشت به فروشگاه".
**Empty:** "سبد خرید شما خالی است."

### 9. AI Beauty Assistant (global panel)
**Purpose:** Native, conversational recommendation surface — not a generic chatbot skin.
**Chrome:** right-side panel (full-screen on mobile), gradient header strip, avatar dot (violet→rose gradient) per AI message, user bubbles right-aligned/filled, AI bubbles left-aligned/tinted, animated 3-dot "typing" indicator while a response is pending (700ms simulated latency), 4 quick-suggestion chips, free-text input with focus ring.
**Recommendation cards:** AI responses can attach 2 product or provider cards inline (image, name, price/rating+location) that route straight into add-to-cart or profile view.
**Global launch point:** floating gradient "AI" button, bottom-inline-start corner, present on every screen (repositions above the mobile bottom nav).

### Global chrome
- **Desktop header:** logo mark + wordmark, primary nav (خانه / متخصصان / فروشگاه / همکاری تجاری / داشبورد من), search chip, cart chip with badge, avatar.
- **Mobile header:** logo + search icon + cart chip; **mobile bottom nav:** same 4 primary destinations (B2B omitted) with active-dot indicator, 48px min-height touch targets.
- **Overlays:** all modals/drawers/AI panel share a blurred dark backdrop (`blur(3px)`, semi-transparent ink) that closes on click.

## Interactions & Behavior
- Client-side "routing" is a single `screen` state (`home|marketplace|profile|shop|b2b|dashboard`) swapped via nav handlers — no page reloads.
- `isMobile` is derived from viewport width (<900px) via a resize listener, not CSS breakpoints — drives header/nav swap and several 1-col/2-col layout switches.
- Add-to-cart always opens the cart drawer; booking CTAs always open the booking modal (optionally pre-selecting a service).
- Hover states (desktop): cards lift 3px with a soft shadow; primary buttons darken; outline buttons tint; the AI FAB scales up 6%.
- Focus states: hero search input and AI input get a 2px soft violet ring on focus.
- AI responses are simulated with a 700ms delay + typing indicator, then the response bubble (with any recommendation cards) appears — backend integration is out of scope here.

## State Management (reference only — reimplement per target stack)
- `screen`, `isMobile`
- `selectedProviderId`, `profileTab`
- `marketplaceSpecialty`, `marketplaceCity`, `shopCat`
- `cart[]`, `cartOpen`, `cartReviewing`, `cartCheckedOut`, `wishlist{}`
- `aiOpen`, `aiInput`, `aiTyping`, `aiMessages[]`
- `bookingOpen`, `bookingStep` (1–5), `bookingServiceId`, `bookingDateIdx`, `bookingTime`, `bookingPayment`
- `dashTab`

## Design Tokens

### Colors (OKLCH)
| Token | Value | Use |
|---|---|---|
| Ink | `oklch(0.2 0.02 290)` | primary text |
| Ink Soft | `oklch(0.48 0.02 290)` | secondary text |
| Ink Faint | `oklch(0.6 0.02 290)` | meta/labels |
| Line | `oklch(0.9 0.012 290)` | borders |
| Background | `oklch(0.985 0.006 280)` | page bg |
| Surface | `oklch(1 0 0)` | cards/panels |
| Surface Tint | `oklch(0.965 0.014 290)` | subtle panel bg, AI bubbles |
| Primary (violet) | `oklch(0.4 0.16 290)` | brand, CTAs, active nav |
| Primary Hover | `oklch(0.34 0.16 290)` | button hover |
| Primary Soft | `oklch(0.94 0.03 290)` | chips, badges |
| Accent (rose, AI) | `oklch(0.66 0.16 335)` | AI identity, wishlist active, discount badge |
| Accent Soft | `oklch(0.95 0.035 335)` | AI chip active bg |
| Success | `oklch(0.5 0.13 150)` / soft `oklch(0.94 0.04 150)` | confirmed states |
| Warning | `oklch(0.55 0.13 70)` / soft `oklch(0.95 0.045 80)` | pending states |
| Error | `oklch(0.55 0.19 25)` / soft `oklch(0.95 0.05 25)` | cancelled/remove |

Brand gradient (logo mark, AI avatar/FAB/header strip): `linear-gradient(135deg, Primary, Accent)`. Use violet/rose **with restraint** — reserved for brand mark, AI surfaces, and discount/verification badges, not general chrome.

### Typography
- Font: **Vazirmatn** (400/500/600/700/800), RTL, `direction: rtl` on the document root.
- Scale: Hero H1 34px (mobile) / 52px (desktop), weight 800, line-height 1.25. Page title 24/32px weight 800. Section title 20/24px weight 800. Body 14–16px weight 400–500, line-height 1.8–1.9. Meta/caption 11–12px. Prices/stat numbers use `font-variant-numeric: tabular-nums` and render in **Persian digits** (۰–۹) everywhere, including prices, ratings, and counts.

### Spacing & Radius
- Section padding: 24–40px horizontal (mobile/desktop), content max-width 1280px, centered.
- Card radius 18px (provider/product), 14–16px (rows/panels), 20–28px (avatars/hero visuals/banners), pill radius for chips/badges (20px+).
- Grid gaps: 16–20px between cards, 8–10px between chips.

### Shadows
- Card hover: `0 14px 34px oklch(0.3 0.06 290 / 0.14)`.
- Floating elements (search box, floating confirmation card, drawers/modals): `0 8-10px 30-40px oklch(0.2 0.05 290 / 0.1-0.2)`.
- AI FAB: `0 10px 26px oklch(0.4 0.14 300 / 0.35)`, intensifies on hover.

### Components (states to preserve)
- **Buttons:** primary (filled violet, hover darkens), outline (bordered, hover tints bg), light variants for dark surfaces (B2B hero). All 12px radius, 700 weight.
- **Badges:** verified (violet-soft pill), discount (rose-filled pill, top-start of image), recommended tier (violet-filled pill inline with text), status pills (success/warning/error soft-bg + colored text).
- **Chips/filters:** pill, bordered, active = filled soft bg + colored border/text (violet for specialty, rose for city — a deliberate secondary-accent use to visually separate the two filter axes).
- **Inputs:** no visible border on hero search (sits in a shadowed white box), bordered elsewhere; focus = 2px soft violet ring.
- **Empty states:** centered, muted text, bordered card (marketplace no-results, empty cart).
- **Success states:** centered column, colored circular checkmark, title + muted detail line, single CTA.
- **Loading/pending state:** AI typing indicator = 3 staggered pulsing dots in a tinted bubble (only implemented loading pattern in the prototype — reuse this pattern for any future async action rather than inventing a new spinner style).

## Assets
No real photography/icons are used. All imagery is a **placeholder treatment**: a soft two-tone diagonal gradient wash (hue varies per entity for visual variety) with a small monospace Persian caption (e.g. "تصویر متخصص", "تصویر محصول", "نمونه‌کار") — deliberately subdued so the caption never dominates the card. Replace these containers with real photography using the same aspect ratios/radii; no icon library was used (all icons are typographic — ★, ✓, ×, ♡ — or plain color swatches).

## Files
- `BeauClick.dc.html` — the full interactive prototype (all 8 screens + booking/cart/AI overlays), included in this handoff folder for reference.
