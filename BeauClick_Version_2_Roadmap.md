# BeauClick — Version 2 Roadmap

**Document status:** Master strategic roadmap — the top-level release ladder. For implementation detail, capability-by-capability analysis, and step-by-step build notes, see `docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md`. For the full discovered-gap inventory, see `docs/roadmap/PRODUCT_GAP_REGISTER.md`. This file exists to keep the three in agreement at a glance; it is not a substitute for either.

---

## Release ladder

| Version | Status | Tag | Notes |
|---|---|---|---|
| V1 | **FROZEN** | `v1.0.0` → `v1.0.1` | Marketplace + booking + AI discovery + shop + B2B core loop. |
| V2.0 | **RELEASED, FROZEN** | `v2.0.0` | Event instrumentation, AI discovery upgrade, advanced ranking, Beauty Journey. |
| V2.1 | **RELEASED, FROZEN** | `v2.1.0` (commit `d1445092977ab6a9f95bd50221e43ef761ac2b91`) | Professional CRM, Authentication & Registration, Legal & Trust Foundation, Professional Verification Evidence & Trust, Loyalty Tiers + Membership, Waitlist + Smart Rebooking + Retention Automation. |
| V2.2 | **RELEASED, FROZEN** | `v2.2.0` (commit `9c980aba3f7f061db3f27e1af98bbfb544031fbe`) | Analytics & BI Foundation, Growth & Public Discovery (SEO + Referral), Admin Platform & Operations Maturity, Account Privacy & Data Control, Booking Evolution (Rescheduling + Receipts), Professional/Business Platform Completion. |
| V2.3 | **PLANNED** | — (not tagged) | Pricing Orchestration + Campaign Engine (order-level promotions), Financial Ledger & Manual Settlement, AI for Professionals & Businesses (read-only insights), Growth & Professional Platform Quick Wins (B2B quote UI, basic marketplace search, professional notification preferences). See the "V2.3 Discovery, Gap Audit & Roadmap Definition" section of `VERSION_2_ARCHITECTURE_PLAN.md` for the full Step-by-Step plan. **Implementation not started — awaiting explicit approval.** |
| V2.4 | **FUTURE** | — | Realtime Communication, Multi-Sided Marketplace evolution, Native Mobile Application, Professional Portfolio Upload, automated payout/disbursement — each explicitly evidence-gated or externally blocked, not scheduled by default. |

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

## V2.3 at a glance

**Strategic theme: Monetization Foundations & Professional Tools.** V2.2 gave the platform real visibility and operational maturity. V2.3's job is to turn that into real business value — a real campaign/promotion mechanism, a real professional earnings figure (replacing the `درآمد` placeholder reserved since V1), a first AI-generated insight for professionals/businesses, and closing a handful of small, high-value gaps in already-built backends nobody can reach yet.

A dedicated discovery/gap-audit pass (2026-08-15, baseline `v2.2.0`) deliberately did **not** blindly carry forward the original V2.3 sketch — it re-measured Campaign, Financial/Payout, and AI-for-Professionals against the real, current codebase first. All three remain correctly assigned to V2.3, but each turned out smaller and more separable than the original risk-based sequencing assumed — see `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.3 Discovery, Gap Audit & Roadmap Definition" section for the full evidence and reasoning.

| Step | Capability | One-line objective |
|---|---|---|
| 17 | Pricing Orchestration + Campaign Engine (Phase 1) | A real, admin-authorable promotion mechanism, applied only as an order-level fee on booking and B2B-quote orders — never the WooCommerce cart, never WooCommerce's own (unused) coupon system. |
| 18 | Financial Ledger & Manual Settlement | A real, commission-adjusted earnings figure for professionals/businesses, and an admin-executed, audit-logged settlement workflow — built with **zero payment-gateway dependency** (only fully-automated disbursement remains gateway-gated). |
| 19 | AI for Professionals & Businesses (Read-Only Insights) | A first, strictly read-only AI-generated insight into a professional/business's own CRM and analytics data — never an autonomous action. |
| 20 | Growth & Professional Platform Quick Wins | B2B quote request/accept UI, basic marketplace text search, professional/business notification-preferences UI, and an admin audit-log completeness fix — four small, independent, high-value-per-effort gaps in already-built backends. |

**Structural note, unlike every prior version:** none of these four steps blocks another — each has only a small, self-contained internal prerequisite (a decision or a schema fix), not a cross-step dependency. All four can run in parallel if resourced that way; Step 20 is recommended first purely because it is cheapest and unlocks value already built.

Full detail — dependencies, database/API/UI impact, the Financial Truth concept table, the Pricing Orchestration decision, risk, complexity, definition of done for each step — lives in `VERSION_2_ARCHITECTURE_PLAN.md`'s "V2.3 Discovery, Gap Audit & Roadmap Definition" section.

**Explicitly not in V2.3** (see that section for the full rationale): automated payout/disbursement API integration (genuinely gateway-gated, unlike the ledger/settlement work that precedes it); Campaign Engine Phase 2 (cart-based Shop/B2B-wholesale promotions — evidence-gated); Professional Portfolio Upload (real gap, but not core to this version's monetization theme — V2.4 candidate); fuzzy/typo-tolerant search (evidence-gated past Step 20's basic search); expanded staff-permission granularity (evidence-gated); Realtime Communication, Multi-Sided Marketplace, Native Mobile (all V2.4+, unchanged).

**Implementation has not started.** This section defines the plan; a separate, explicit approval begins Step 17.

---

## Cross-cutting standard (applies to every future version)

Persian-first, RTL-first, Jalali-first, Persian-error-first, Persian-number-aware. Every new user-facing surface reuses the existing shared Jalali/localization infrastructure — no second date system, no unnecessary English string where a Persian equivalent exists. This has applied unchanged since V1 and is restated as part of V2.2's own Definition of Done in `VERSION_2_ARCHITECTURE_PLAN.md`.

---

*This document is intentionally short. For the reasoning behind every decision above, read `docs/roadmap/VERSION_2_ARCHITECTURE_PLAN.md` and `docs/roadmap/PRODUCT_GAP_REGISTER.md` — this file only has to stay in agreement with them, not repeat them.*
