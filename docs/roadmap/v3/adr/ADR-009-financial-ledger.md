# ADR-009: Financial Ledger Architecture

**Status:** Proposed — discovery only, not decided/approved.
**Date:** 2026-08-19.

## Context

Financial is explicitly named, in every existing V3 doc, as "the highest-stakes, most sensitive domain found in the whole discovery pass" (`V3_ARCHITECTURE_PLAN.md` §1, row 7). V2's real, verified strengths: commission computation and the append-only log discipline are correct in code (not just documented); refunds reverse using the *original* captured commission rate, never live config (so a later rate change never retroactively alters historical refund math); idempotency is enforced by a real DB constraint (`UNIQUE(entry_type, reference_type, reference_id)`), confirmed to have actually absorbed a real double-fire bug in production-equivalent testing; cross-professional isolation was recently hardened to the data-access layer itself (`GAP-05`, resolved post-v2.4.0 — verified in this pass's own re-audit of `LedgerService::receivable_net_for_current_session()`/`SettlementService::my_party_summary()`, confirmed present and matching the documented fix exactly).

The one confirmed, still-partial gap: **append-only enforcement is application-convention only** — no mutating method exists in `LedgerService`, but nothing at the schema layer prevents an `UPDATE`/`DELETE` (`GAP-01`). A V2.4 migration attempted DB triggers but requires `SUPER`/`log_bin_trust_function_creators=1` grants this project's own dev/test DB users were confirmed to lack — the trigger silently fails to install on such hosts, logged but not fatal, so **code-level immutability remains the only guarantee that's always true today.**

## Decision

**Single-entry, append-only commission ledger — not double-entry accounting** — confirming V2's existing model rather than adding double-entry bookkeeping complexity BeauClick has no evidenced need for (no multi-currency, no complex intercompany settlement, no accounting-standard compliance requirement surfaced anywhere in the discovery pass). Specifically:

1. **Preserve, near-verbatim, as business rules** (per `V3_MIGRATION_MATRIX.md` Financial section): the commission formula and exact-sum split discipline; refund-reverses-at-original-rate; idempotency via a real DB unique constraint on `(entry_type, reference_type, reference_id)`; settlement's non-destructive reversal and always-fresh-computed (never cached) outstanding balance, which can legitimately go negative post-refund and must stay honest about that rather than clamping to zero.
2. **Close `GAP-01` for real, on infrastructure V3 controls**: a Postgres role with `UPDATE`/`DELETE` privileges revoked on the ledger table (or an insert-only table + a separately-computed read model) is a **hard requirement for financial-service's database, not optional** — V3 is a fresh deployment with control over its own DB hosting/grants, so the precondition that blocked V2's trigger approach (missing `SUPER` grants on a shared/managed MySQL host) does not need to recur; confirm the target Postgres hosting grants this before considering the requirement met, not merely specifying it and assuming success.
3. **Data-access-layer isolation is now the pattern to replicate everywhere, not just fix once**: `GAP-05`'s resolution (party identity resolved entirely internally by the service method itself, zero caller-supplied party argument, never a fabricated default) is the concrete shape every V3 financial-service and payment-service method must follow from day one — not a pattern to rediscover after a future audit.
4. **Settlement is the natural integration point for the payout/disbursement functionality V2 explicitly deferred** (`GAP-18` — no automated payout, no B2B/shop-order settlement) — scope this as new functionality within the existing settlement model, not a parallel system.

## Consequences

- **Positive:** the hard-won business logic (commission math, idempotency, non-destructive settlement reversal) transfers with high confidence — it's already proven correct under real double-fire and concurrent-load conditions in V2. Closing `GAP-01` on V3's own infrastructure removes the one open structural weakness in an otherwise-strong domain.
- **Negative:** none specific — this is the domain with the most "port with confidence" evidence in the entire discovery pass.
- **Risk:** if V3's chosen Postgres hosting also lacks the grants needed for role-based immutability enforcement (a real possibility depending on hosting choice, echoing V2's own hosting-constraint discovery), the same fallback (code-level-only guarantee, explicitly disclosed as such) must be stated honestly rather than silently claimed resolved — exactly the discipline `PRODUCT_GAP_REGISTER.md` §53 already modeled for GAP-01's V2.4 partial fix.

## Alternatives considered

- **Double-entry bookkeeping.** Considered per the discovery brief's own prompt ("single vs double entry, choose based on actual need") and rejected — no evidence anywhere in the codebase or product docs of a requirement (multi-currency, external accounting-system integration, regulatory double-entry mandate) that would justify the added complexity over the single-entry commission-ledger model V2 already validated works for this product's actual scope.
