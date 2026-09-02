# ADR-006: Payment Architecture

**Status:** Accepted for the verified sandbox lifecycle — real-provider activation remains externally gated.
**Date:** 2026-08-19.

## Context

**No real payment gateway has ever been integrated in V2, in any environment** (`GAP-06`, confirmed) — `ZARINPAL_MERCHANT_ID` is always empty in `.env.example`; only a dev-only, environment-gated Cash-on-Delivery stand-in has ever been exercised. There is therefore no V2 payment *code* to port — `V3_MIGRATION_MATRIX.md`'s Payment section correctly classifies both the abstraction and the real integration as REIMPLEMENT/net-new. What *does* carry forward: V2's own architecture doc describes the target shape precisely ("installing the gateway's own WooCommerce plugin is the entire integration surface" — i.e., gateway swap should require zero bridge-code changes), and the provider-abstraction pattern (interface + factory + safe fallback) is independently proven three times elsewhere in V2 (SMS, AI, Professional-AI — `V3_ARCHITECTURE_PLAN.md` §4).

## Decision

**A literal `PaymentProvider` interface + factory, mirroring the SMS/AI provider-abstraction shape exactly** (ADR-003), decoupled from `commerce-service` per the release brief's own mandate and confirmed V2 discipline (Financial listens to payment *events*, never calls into payment code — `V3_ARCHITECTURE_PLAN.md` §1 row 6). Concretely:
- `payment-service` owns payment intent/initiation/callback/verification/refund, as its own module (ADR-002).
- Every gateway integration implements the shared provider interface; adding a second Iranian gateway (ZarinPal, Zibal, IDPay, etc.) is a new adapter, not a commerce-service change.
- **Idempotency is required by construction**, not by convention: `OrderCreated` must be idempotent on `(sourceType, sourceId)` (closing `GAP-03`, the confirmed booking→order double-creation gap — self-healed only by accident in V2), and every payment-provider callback must be idempotent on the provider's own transaction reference (`V3_EVENT_CATALOG.md` `PaymentInitiated`/`PaymentSucceeded`/`PaymentFailed`).
- **Callback verification is always server-to-gateway, never trusted from redirect query params alone** — this was already V2's stated design intent (`ARCHITECTURE_PROPOSAL.md` §20) even though never implemented against a real gateway; V3 must actually build and test this path, not merely restate the intent.
- The **fail-safe-when-unconfigured, production-gate-closed-by-default** pattern (`environment_type !== 'production'`, defaulting closed) carries forward as the shape for any V3 dev/mock payment provider (`V3_ARCHITECTURE_PLAN.md` §4, `V3_SECURITY_MODEL.md` §6) — centralized as one shared gate function this time, not duplicated ad hoc.

## Consequences

- **Positive:** the payment integration gap (`GAP-06`) becomes a scoped, well-specified build (one real Iranian gateway adapter against a known-good interface) rather than an open-ended unknown; the idempotency work required here directly closes `GAP-03` as a side effect, since both are the same "unify order creation behind one entry point" fix.
- **Negative:** this is **net-new engineering, not a migration** — unlike most of the migration matrix, there is no V2 test suite, no proven edge-case handling, no live-QA history to lean on for the actual gateway integration. Budget it as new-feature work, not port work.
- **Risk:** real Iranian payment gateway callback reachability from V3's chosen hosting is an infrastructure precondition (`ARCHITECTURE_PROPOSAL.md` §27 risk #2), not something this ADR resolves — flagged in the risk register, not decided here.

## Alternatives considered

- **A payment aggregator/PSP that abstracts multiple Iranian gateways** (reduces the number of adapters BeauClick must build/maintain). Worth evaluating as a build-vs-buy question before implementation starts, analogous to the B2B pricing-engine build-vs-buy question V2 flagged and never fully resolved (`ARCHITECTURE_PROPOSAL.md` §13/§28) — not decided here, listed as an open question for Phase 1.
