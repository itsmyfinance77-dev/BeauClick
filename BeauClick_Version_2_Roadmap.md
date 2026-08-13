# BeauClick — Version 2 Roadmap

**Document status:** Master strategic roadmap — the top-level release ladder. For implementation detail, capability-by-capability analysis, and step-by-step build notes, see `docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md`. For the full discovered-gap inventory, see `docs/roadmap/PRODUCT_GAP_REGISTER.md`. This file exists to keep the three in agreement at a glance; it is not a substitute for either.

---

## Release ladder

| Version | Status | Tag | Notes |
|---|---|---|---|
| V1 | **FROZEN** | `v1.0.0` → `v1.0.1` | Marketplace + booking + AI discovery + shop + B2B core loop. |
| V2.0 | **RELEASED, FROZEN** | `v2.0.0` | Event instrumentation, AI discovery upgrade, advanced ranking, Beauty Journey. |
| V2.1 | **RELEASED, FROZEN** | `v2.1.0` (commit `d1445092977ab6a9f95bd50221e43ef761ac2b91`) | Professional CRM, Authentication & Registration, Legal & Trust Foundation, Professional Verification Evidence & Trust, Loyalty Tiers + Membership, Waitlist + Smart Rebooking + Retention Automation. |
| V2.2 | **PLANNED** | — (not tagged) | Growth & Discovery, Analytics, Admin Platform Maturity, Account Privacy & Data Control, Booking Evolution, Professional/Business Platform Completion. See the "V2.2 Strategic Roadmap & Architecture Plan" section of `VERSION_2_ARCHITECTURE_PLAN.md` for the full Step-by-Step plan. |
| V2.3 | **FUTURE** | — | Central pricing/discount orchestration + Campaign/Promotion Engine, AI for Professionals & Businesses, Financial/Payout infrastructure. |
| V2.4 | **FUTURE** | — | Realtime Communication, Multi-Sided Marketplace evolution, Native Mobile Application — each explicitly evidence-gated, not scheduled by default. |

---

## Why the sequence looks different from the original plan

The very first version of this document (superseded by this file) proposed a four-wave V2.0–V2.3 sequence. Two things changed it, both documented in full in `VERSION_2_ARCHITECTURE_PLAN.md`:

1. **The V2.1 Product Gap Discovery Audit** (`PRODUCT_GAP_REGISTER.md`, 2026-08-12) found that BeauClick had no customer self-registration path and no published legal pages at all — silent, `BLOCKING`-severity gaps nobody had gone looking for. This pulled Authentication & Registration and Legal & Trust Foundation into V2.1 ahead of Membership, and pulled Professional Verification Evidence forward once registration made unvetted-professional growth possible for the first time.
2. **What the original plan called "V2.2" (a central Notifications service + Waitlist + Smart Rebooking + Retention automation) was delivered inside V2.1 as Step 10**, once the actual dependency chain was worked through — it turned out to share no meaningful gap with the other V2.1 steps that would have justified a separate release. Only Referral (originally bundled with Loyalty) was deliberately left out and remains open.

The net effect: V2.1 ended up completing almost the entire original V2.0–V2.2 arc, plus three capabilities the original plan never named at all (Authentication, Legal, Verification Evidence). **V2.2, as defined below, is therefore a genuinely new plan** — built from what the Product Gap Register still shows open today, not a renumbering of the old "V2.2."

---

## V2.2 at a glance

**Strategic theme: Growth, Trust Operations & Platform Maturity.** V2.1 built the trust and retention *engine* (real accounts, real legal disclosure, real verification, real loyalty, real automated retention). V2.2's job is to let that engine actually be measured, operated, and grown — not to add another large net-new product surface.

| Step | Capability | One-line objective |
|---|---|---|
| 11 | Analytics & Business Intelligence Foundation | Instrument the funnel and give the team real visibility into what V2.1 actually produced. |
| 12 | Growth & Public Discovery (SEO + Referral) | Turn on organic and referral acquisition, both structurally blocked until real registration/legal pages existed. |
| 13 | Admin Platform & Operations Maturity | Give operations real cross-cutting tools for the operational load V2.1's five new subsystems now generate. |
| 14 | Account Privacy & Data Control | Close the gap between what the (now-published) Privacy Policy promises and what the product actually lets a user do. |
| 15 | Booking Evolution: Rescheduling + Receipts | The one remaining low-risk, well-scoped booking gap, plus a small commerce-completeness item. |
| 16 | Professional/Business Platform Completion | Multi-staff permissions, CRM polish, the profile/portfolio sections reserved since V1 but never finished, and a role-scoped Professional/Business Analytics Dashboard consuming Step 11's analytics foundation. |

Full detail — dependencies, database/API/UI impact, risk, complexity, definition of done for each step — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.2 Strategic Roadmap & Architecture Plan" section.

**Explicitly not in V2.2** (see that same section for the full rationale): Campaign/Promotion Engine, Financial/Payout, AI for Professionals (all V2.3 — real-money and audience-targeting risk, each needs a business decision or real usage data V2.2 will help produce); Realtime Communication, Multi-Sided Marketplace, Native Mobile (all V2.4+, evidence-gated, unchanged from the original plan's own reasoning).

---

## Cross-cutting standard (applies to every future version)

Persian-first, RTL-first, Jalali-first, Persian-error-first, Persian-number-aware. Every new user-facing surface reuses the existing shared Jalali/localization infrastructure — no second date system, no unnecessary English string where a Persian equivalent exists. This has applied unchanged since V1 and is restated as part of V2.2's own Definition of Done in `VERSION_2_ARCHITECTURE_PLAN.md`.

---

*This document is intentionally short. For the reasoning behind every decision above, read `docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md` and `docs/roadmap/PRODUCT_GAP_REGISTER.md` — this file only has to stay in agreement with them, not repeat them.*
