# V3 Global UI/UX Audit

**Pass:** Global UI/UX audit, post-v3.0.0
**Date:** 2026-08-24
**Baseline:** `v3.0.0` → `cfecfdf`
**Companion:** `V3_GLOBAL_QA_REPORT.md` (functional/security findings; shares the `QA-nn` IDs)
**Method:** real browser against a **production build** (`next build` + `next start`),
plus full source review of all 15 routes and 4 shared components

---

## 1. What this audit covered

Fifteen routes, one shared shell, one 6-primitive UI kit, one design-token package:

```
/  /auth  /search  /providers  /providers/[id]  /bookings  /waitlist
/journey  /loyalty  /notifications  /business  /dashboard
/checkout/result  /sandbox-gateway  (+ /_not-found)
```

**Surfaces the brief asks about that do not exist to audit:** admin pages, AI interface,
wishlist, reviews, referrals, professional dashboard/profile/services/availability,
business services/bookings/analytics/quotes, service cards as a distinct component,
search modal, footer. See `V3_GLOBAL_QA_REPORT.md` §3. They are product gaps, and
reporting UI findings against them would be fiction.

---

## 2. Headline judgement

The V3 frontend is **small, internally consistent, and unusually disciplined about
accessibility and RTL** — and it is **visually unfinished**. Those are both true, and
the second is not a defect list so much as a scope statement.

What is genuinely good, and should not be "fixed":

- **RTL is structural, not bolted on.** `dir="rtl"`/`lang="fa"` at the document root,
  CSS **logical properties** throughout (`marginBlockEnd`, `inset-inline-start`,
  `borderBlockEnd`) — no `left`/`right` branching anywhere in the codebase.
- **Persian formatting is centralised and correct.** One `persian-utils` package does
  digits, Toman grouping, ratings, and **real Jalali conversion** (2820-year cycle via
  Julian Day Numbers), with a regression test pinning the V2 bug where digit
  substitution was mistaken for calendar conversion.
- **Numeral-system asymmetry is deliberate and right**: output always Persian, input
  accepts anything. (Auth was the one place that had not adopted it — QA-01/02.)
- **Identifiers are exempted from Persian digits on purpose.** The sandbox transaction
  reference renders verbatim in LTR monospace, with a comment explaining that
  `SBX-966D…` becoming `SBX-۹۶۶D…` would make it harder to read back to support.
  That is a genuinely thoughtful call.
- **Touch targets are treated as a real baseline** (44px), enforced in `Button`, and
  measured in real viewports rather than eyeballed.
- **Accessibility is designed in, not retrofitted**: labelled inputs with
  `aria-describedby` wiring hints *and* errors, `role="alert"` on messages,
  `role="status" aria-live="polite"` on loading, combobox ARIA on autocomplete, a
  semantic receipt `<table>` with `<caption>` and `scope="row"`, unread counts in the
  accessible *name* rather than as a bare adjacent number, `:focus-visible` rings, a
  working skip link, and `prefers-reduced-motion` honoured.

What is unfinished:

- The **homepage** shipped as a Phase 1 scaffold (fixed this pass — QA-16 — but only
  to remove the developer-facing copy; it is still not a designed landing page).
- **No footer exists** anywhere (QA-23).
- **The named Persian font is never actually loaded** (QA-17) — the single highest-impact
  visual finding in this audit.
- **Zero images or media** in the entire product.
- The UI kit is 6 primitives; everything else is inline `style={{}}` objects.

---

## 3. Findings

### QA-17 — the product's Persian typeface is named but never shipped · **MEDIUM · UX**

`--bc-font-family: 'Vazirmatn', -apple-system, BlinkMacSystemFont, sans-serif`

Vazirmatn is the correct choice for a Persian product. It is also **never loaded**:
searched the whole repo for `@font-face`, `next/font`, a Google Fonts link, and any
`.woff/.woff2/.ttf/.otf` file — **none exist**, and there is no `public/` directory.

So the first stack entry silently fails for every user who does not already have
Vazirmatn installed, i.e. essentially all of them, and rendering falls through to
`-apple-system`/`BlinkMacSystemFont`/`sans-serif`. On Windows that resolves to a
Latin-first UI font; Persian text renders in whatever the system substitutes. This
undermines every other typographic decision on every screen — it is the one finding here
that affects literally every pixel of Persian text in the product.

**Not fixed in this pass, deliberately.** The two options are self-hosting (~100KB+ of
binaries per weight, added to the repo and the build) or a CDN link. For an Iranian
audience the CDN option has real availability implications, and Google Fonts specifically
is an unreliable dependency in that market. That is a deployment and network-policy
decision, not a mechanical fix, and it is the team's to make. **Recommendation:
self-host a subset (Latin + Arabic ranges, 400/600/700) via `next/font/local`**, which
keeps it inside the build, avoids an external origin entirely, and gives automatic
`font-display` handling.

### QA-23 — there is no footer, anywhere · **MEDIUM · UX**

`AppShell` is `<header>` + `<main>`. There is no `<footer>`, no `contentinfo` landmark
(confirmed live: landmarks are exactly `HEADER, NAV, MAIN`).

Consequences beyond aesthetics: no route to terms, privacy policy, contact, support, or
"about" from anywhere in the product; nothing to anchor the legal and trust signals a
marketplace handling payments normally carries; and one fewer landmark for assistive
navigation. For a platform that takes money and holds personal data, absent
terms/privacy links is a commercial and possibly regulatory gap, not just a design one.

Not fixed: the footer's *content* is a legal/content deliverable, and shipping an empty
footer shell would be worse than none.

### QA-16 — the homepage introduced the product as unfinished · **MEDIUM · UX · FIXED**

The released landing page's second of three sentences read:

> این صفحه بخشی از بنیان فنی فاز ۱ است؛ صفحات محصول در فازهای بعدی ساخته می‌شوند.
> *(This page is part of the Phase 1 technical foundation; product pages will be built in later phases.)*

An internal engineering status note, written for this team, rendered on the product's
front door to every visitor. Confirmed live on the running site before fixing.

**Fixed** by replacing it with a plain description of what BeauClick is, plus the two
things a signed-out visitor can actually do today (search, browse professionals)
alongside signing in. Deliberately **not** invented marketing copy.

**Still open as a product gap:** this is now an honest placeholder, not a designed
landing page. There is no hero, no value proposition, no category entry points, no
social proof, no imagery — nothing that would make a first-time visitor understand or
trust a beauty marketplace. A real homepage is a design deliverable.

### QA-24 — no current-page indication anywhere · **LOW · ACCESSIBILITY · FIXED**

`aria-current` appeared **nowhere** in the codebase. Every nav destination rendered
identically on every page, so neither a screen-reader user nor a sighted user could tell
where they were. Fixed with a `NavLink` that sets `aria-current="page"` and shifts weight
*and* colour — not colour alone, since that is not a distinction every reader can make.
Verified live on `/search`.

### QA-03/04/05, QA-06/07/08/09 — the loading / error / empty state system · **FIXED**

The single largest *class* of UI defect found. Full detail in
`V3_GLOBAL_QA_REPORT.md` §4; the UX principle is worth stating on its own:

> An **empty state asserts something** — "the server answered, and the answer is that you
> have nothing." A **failed request asserts nothing.** Both leave the same empty array.

Five surfaces conflated them, so a network failure produced "هنوز اعلانی ندارید",
"در حال حاضر در هیچ لیست انتظاری قرار ندارید", "نتیجه‌ای یافت نشد" — several inside
`aria-live` regions, so the wrong thing was *announced*, not merely displayed. These call
for opposite user responses: one says stop looking, the other says try again.

Two were worse than cosmetic: **journey** rendered a blank profile editor over data that
still existed (submitting destroyed it), and **business** offered to create a second
business to someone who already had one.

There was also **no retry affordance anywhere in the product** — every failed load was a
dead end whose only escape was a manual browser reload.

Fixed with a shared `ErrorState` (Alert + retry) so the distinction has one
implementation rather than five, plus a `loaded` flag distinguishing "never answered"
from "answered empty". `dashboard`'s bare-`Card` error — no `role="alert"`, no retry, off
the design system — now uses the same component.

### QA-13 — 18px touch targets on the post-payment screen · **MEDIUM · A11Y · FIXED**

The payment result page's two links (رزروهای من, بازگشت به فهرست متخصص‌ها) measured
**18px** in a real 375px viewport, against this project's own 44px baseline. They are the
*only* ways forward from the screen a customer lands on immediately after paying, on a
phone.

This is the **fifth** instance of this exact bug class: 25px nav links (Phase 2), 43px
logout (Phase 3), 21px homepage CTA (`PHASE5-01`), 24px search-result link, now 18px
here. The previous four fixes did not regress — the class simply recurs on each new
surface, because 44px is enforced inside `Button` and nothing enforces it for a `Link`.

**Recommendation (not implemented):** give the UI kit a `TextLink`/`NavLink` primitive
carrying the baseline, so new link surfaces inherit it instead of each one re-learning
the lesson. `NavLink` (QA-24) is a partial step; the pattern should be generalised.

### QA-12 — copy that contradicted the customer's bank statement · **HIGH · UX · FIXED**

Detailed in the QA report §5.3. Called out here because it is a **microcopy** failure
with financial consequences: a missing map entry meant a double-charged customer was
told "no amount was deducted from your account".

### QA-19 — the OTP screen has no way to resend · **LOW · UX**

After requesting a code the only affordances are the code field and "تغییر شماره موبایل".
There is **no resend button and no expiry countdown**, though the server enforces both a
300s expiry and a resend cooldown. A user whose SMS does not arrive must change their
number and change it back. Not fixed: doing it properly means surfacing the cooldown in
the API response so the button can show remaining time rather than failing with a
`RATE_LIMITED` the user cannot anticipate.

### QA-21 — cancel and decline look identical to the customer · **LOW · UX**

The backend deliberately distinguishes `cancelled_by_user` from `declined` — that
distinction was an explicit `GAP-06a` deliverable, and the sandbox page offers them as
separate buttons. The result page then collapses both into "پرداخت انجام نشد". A customer
who *chose* to abandon payment is told their payment failed. Not fixed: needs
`failureCode` threaded through the redirect contract.

### QA-25 — the business nav link shows to everyone · **LOW · UX**

"کسب‌وکار" renders for every authenticated user regardless of whether they own or staff a
business. Most users click into a create-a-business form they have no use for.

### QA-22 — label maps fall back to raw English · **INFORMATIONAL**

`BADGE_LABELS[badge] ?? badge` and equivalents would render `recent_activity` or
`over_2m` into a Persian UI. Verified **not currently reachable**: all five ranking
signal keys and all four price bands are covered by the frontend maps. Latent only — a
new backend key would leak English. Worth a lint rule or a shared enum rather than a fix.

---

## 4. Systematic UI observations (no individual defect)

**Visual hierarchy.** Every page follows the same skeleton: `<h1>` at 24px, a muted
14px subtitle, then `Card`s. Legible and consistent, but flat — there is no size,
weight, or colour escalation to make a primary action dominant. `Button`'s
`width: '100%'` means the primary CTA and a secondary "ghost" action are the same size
and shape, differing only in fill.

**Consistency vs. the design system.** Tokens are genuinely used — no hardcoded colours
or radii were found in any page. But **almost all layout is inline `style={{}}`**:
`chipStyle()` in search, `NAV_LINK_STYLE` in the shell, and repeated ad-hoc flex/grid
objects. The token layer is disciplined; the component layer is thin, so spacing and
composition decisions are re-made per page rather than inherited. This is why the
44px-link bug keeps recurring and why the empty-state bug appeared five times
independently.

**Does it feel like one product?** Within the customer surfaces, yes — same shell, same
card rhythm, same Persian voice. But there is no visual distinction between customer,
business, and (absent) professional contexts, and `/business` mixes invitation
management, staff management, and business creation in one undifferentiated stack.

**Whitespace and density.** `Card` is a fixed `padding: 24` at every breakpoint, which
is generous on a 375px screen where content width is already ~327px. Section padding
does step correctly via `clamp()`.

**Forms.** Consistently good: real `<label>` elements, `aria-describedby` wiring both
hint and error, `aria-invalid`, `role="alert"` on errors, `noValidate` with
server-authored messages, `autoComplete="tel"`/`"one-time-code"`, and numeric inputs
forced LTR + centred so `0912…` does not visually reverse inside an RTL document.

**Modals / tabs.** **None exist.** No dialog, no focus trap, no tab component anywhere
in V3 — so the brief's modal-sizing and focus-trap questions have no subject. Worth
noting because the first modal added will need focus management that has no precedent
here.

**Tables.** One table exists (the receipt) and it is correct: `<caption>`, `scope="row"`,
logical `textAlign: 'start'/'end'`.

---

## 5. Image / media audit

**There are zero images in the entire V3 product.** No `<img>`, no `next/image`, no
avatars, no cover photos, no portfolio images, no logo mark (the wordmark is text), no
`public/` directory, no placeholder assets.

- **Broken images:** none possible.
- **Aspect-ratio / layout-shift risk from images:** none.
- **Missing avatars and cover images:** *everywhere* — provider and business profiles,
  search results, and booking cards are entirely text.

For a **beauty marketplace**, this is the most consequential product gap in this audit
after the font. The category is inherently visual: customers choose a professional by
looking at their work. `GAP-23` already records that portfolio management was left
half-built in V2 and should be **redesigned rather than ported** — this audit confirms
the frontend consequence is total, not partial.

No fabricated imagery of real people was added, per the brief.

**Related:** no `favicon`, no `apple-touch-icon`, and no OpenGraph/Twitter metadata —
`layout.tsx` sets only `title` and `description`, so any link shared to social or
messaging apps renders bare. Combined with the absent `robots`/`sitemap`, this is the
frontend half of `GAP-09` (SEO was never covered by any discovery pass).

---

## 6. Responsive audit

Measured in a real browser against a production build, at **375 / 390 / 412 / 1280**.

| Check | Result |
|---|---|
| Horizontal overflow | **None**, any route, any width |
| Vertical clipping | None observed |
| Touch targets < 44px | **None remaining** (QA-13 was the last, now fixed) |
| `dir="rtl"` / `lang="fa"` | Correct on every route at every width |
| Sticky / floating elements | None exist |
| Modal sizing | N/A — no modals exist |
| Tables | Single receipt table; fits at 375px |
| Nav wrapping | Correct — `flexWrap: 'wrap'` with a reduced chip gap, added in Phase 3 after a signed-in nav measured 606px against a 375px viewport |

Coverage totals: 32 route×width combinations swept mid-pass, plus 24 re-swept after the
final commit. **Zero problems in either sweep.**

**Honest caveat:** protected routes (`/bookings`, `/notifications`, `/journey`,
`/loyalty`, `/waitlist`, `/business`) were swept **unauthenticated**, so they measured
their redirect/loading state, not their populated layout. Their populated layouts were
reviewed by source only. Populated-state responsive verification requires the
authenticated runtime this environment cannot provide (QA report §8).

---

## 7. RTL / Persian audit

| Check | Result |
|---|---|
| `dir="rtl"`, `lang="fa"` | Correct, document root, every route |
| Logical CSS properties | Used exclusively — no physical `left`/`right` found |
| Raw user-facing English | **None.** Scanned all JSX text, `placeholder`, `aria-label`, and `title` — every match was an identifier or CSS value |
| Persian digits in output | Consistent via `toPersianDigits` / `formatToman` / `formatCount` |
| Persian digits on input | Correct in search; **was broken in auth** (QA-01/02), now fixed |
| Jalali dates | Real conversion, not digit substitution; golden-reference and round-trip tested |
| Weekday names | Correct mapping from `getDay()` (0=یکشنبه) |
| Mixed LTR/RTL strings | Handled deliberately — numeric inputs and the gateway reference are LTR-embedded inside the RTL document |
| Icon / arrow direction | N/A — **no icons or directional glyphs exist** in the product |
| Toman separator | Persian thousands separator `٬`, not `,` |

The only RTL/Persian defects found in the entire product were QA-01/02 — and they were
in the *input* direction, at the one place that had not adopted the codebase's own
existing normalizer.

---

## 8. Accessibility

**No certification is claimed.** No automated axe/Lighthouse run was possible against
authenticated pages, and none was run against the unauthenticated ones — findings below
are from manual inspection plus real-browser measurement.

**Verified working:** skip link (focus CSS correct; measured 1×1 hidden, `clip:
rect(0,0,0,0)`), `:focus-visible` rings on all interactive elements, landmark structure
(`header`/`nav[aria-label]`/`main`), exactly one `<h1>` per page, labelled form controls
with `aria-describedby`, `aria-invalid`, `role="alert"` on errors, `role="status"
aria-live="polite"` on loading, combobox ARIA on autocomplete, unread count in the
accessible name, semantic receipt table, `prefers-reduced-motion` honoured, 44px targets
throughout, `aria-busy` on loading buttons.

**Fixed this pass:** `aria-current` (QA-24); wrong live-region announcements on failed
loads (QA-03/08).

**Not verified / open:**

- **Colour contrast was not measured.** The palette is authored in `oklch` with
  plausible lightness separation, but no contrast ratio was computed. This is the most
  significant unverified accessibility dimension.
- **Keyboard traversal was not walked end to end** in the authenticated app.
- **No focus management precedent** exists, because no modal/dialog exists.
- **Screen-reader testing was not performed** with an actual screen reader.

---

## 9. Performance

Measured from a real production build.

| Route | Page JS | First Load JS |
|---|---|---|
| shared baseline | — | **87.1 kB** |
| `/` | 1.2 kB | 95.1 kB |
| `/auth` | 2.06 kB | 92.1 kB |
| `/search` | 4.4 kB | **101 kB** (largest) |
| `/notifications` | 4.02 kB | 101 kB |
| `/checkout/result` | 3.39 kB | 100 kB |

**This is genuinely good** — a ~87 kB shared baseline and no route above ~101 kB First
Load JS is well inside reasonable budgets, with no bloated dependency. 14 of 16 routes
prerender statically.

- **Total CSS: 2.6 kB** for the entire application.
- **Images: none**, so no image-weight or layout-shift cost (and no imagery — §5).
- **Duplicate API calls:** none found. Search debounces autocomplete at 250ms and guards
  out-of-order responses with a sequence ref; notifications share one unread count via
  context so the badge and list cannot disagree; the auth refresh is single-flight
  specifically to prevent a rotation-replay race.
- **Layout shift:** low risk — no images, no web font swap *currently* (because the font
  never loads; adding it per QA-17 will introduce a swap that should use
  `font-display: swap` and a matched fallback metric).
- **Search responsiveness:** not measurable without the API.

No infrastructure was added, per the brief.

---

## 10. Prioritised recommendations

Not implemented in this pass — these are product/design decisions.

| # | Recommendation | Why |
|---|---|---|
| 1 | **Ship the Vazirmatn font** (self-hosted subset via `next/font/local`) | QA-17. Affects every Persian character in the product. Highest visual impact per unit of work. |
| 2 | **Design a real homepage** | QA-16. Currently an honest placeholder; it is the product's front door. |
| 3 | **Introduce provider imagery** (avatar + portfolio) | §5. A beauty marketplace with zero images cannot do its core job — customers choose by looking. Depends on `GAP-23`. |
| 4 | **Add a footer** with terms, privacy, contact, support | QA-23. Trust and likely legal necessity for a payment-handling marketplace. |
| 5 | **Grow the UI kit** — `TextLink`, `Badge`, `EmptyState`, `PageHeader` | Five independent empty-state bugs and five touch-target bugs are symptoms of a thin component layer, not of carelessness. |
| 6 | **Measure colour contrast** and record the ratios | §8. The one substantive unverified a11y dimension. |
| 7 | **Add favicon, OG/Twitter metadata, robots, sitemap** | §5. Frontend half of `GAP-09`. |
| 8 | **Resend-OTP with visible cooldown** | QA-19. The auth screen's only real dead end. |
| 9 | **Distinguish cancel from decline** on the result page | QA-21. The backend already does the hard part. |
| 10 | **Hide the business nav link** unless relevant | QA-25. |

---

## 11. Verdict

**V3 GLOBAL QA + UI/UX AUDIT — FIXES REQUIRED**, with all fixes identified in this pass
already landed (7 commits, §10 of the QA report).

The remaining items are **product and design work, not defects**: a font to ship, a
homepage to design, imagery to introduce, a footer to write, a component layer to grow.
None blocks a `v3.0.1` patch release. All of them stand between V3 and something a
customer would recognise as a finished beauty marketplace.
