# ADR-002: Target Architecture Style

**Status:** Accepted in part — modular monolith implemented; day-one separate deployables superseded by ADR-040.
**Date:** 2026-08-19.

## Context

`V3_ARCHITECTURE_PLAN.md` §1 already did the hard evidence-gathering work: cross-referencing 10 domain-discovery reports against V2.3.0's real coupling (not the release brief's illustrative ~20-service list) yields **12 logical service boundaries** (identity, provider, search, booking, commerce, payment, financial, loyalty, referral, notification, analytics, ai), with privacy and admin explicitly *not* separate services (cross-cutting contracts instead — §3a/3b), and this discovery pass's own finding that Beauty Journey (`beauclick-journey` — beauty profile, goals, timeline; own DB tables; sole consumer is `ai-service`) was never assigned a boundary at all in that plan (new finding, this pass — see `V3_GAP_REGISTER.md` GAP-29). Those 12 (plus Journey folded in per this pass's recommendation) are **logical/domain boundaries** — this ADR is about **physical/deployment topology**: how many independently-deployable units those boundaries become on day one.

Facts specific to BeauClick's actual situation, not a generic scaling decision:
- **No production dataset exists yet** (stated in the V3 discovery brief) — there is no real traffic pattern, no per-domain load profile, and no evidence any one domain needs independent scaling today.
- V2's entire team-scale signature (single-author commit history, one `BeauClick Dev` author across 50+ commits, no multi-team ownership boundaries anywhere in the codebase) indicates a **small team**, not an organization with 12 separately-staffed service teams.
- Iran-specific hosting is already a flagged, real constraint (`ARCHITECTURE_PROPOSAL.md` §29): domestic hosting options, AI-provider reachability, and payment-gateway callback latency are all coupled infrastructure decisions. More independently-deployed services means more cross-service network hops inside a hosting environment that is *already* the most constrained part of this stack.
- The two domains with genuinely distinct security/compliance stakes — **financial-service** (append-only ledger, the domain `V3_ARCHITECTURE_PLAN.md` §6 calls "the one service where DB-level immutability enforcement is a hard requirement, not optional") and **payment-service** (PCI-adjacent, gateway-callback-verified) — are the only two domains where the discovery pass found a structural, not merely aspirational, reason to isolate blast radius.

## Decision

**Option D — Hybrid**, not full microservices, not a single undifferentiated monolith:

1. **Ship V3 as a modular monolith at launch**, organized into the same 12 (13, including Journey) logical modules `V3_ARCHITECTURE_PLAN.md` §1 already defined — each module owns its own Postgres schema (not shared tables), communicates with other modules only through the typed interfaces/events already specified in `V3_EVENT_CATALOG.md`, and has zero direct cross-module table access. This is not a weaker version of the service-boundary work already done — it is the *same* boundaries, deployed as one process instead of twelve, exactly the "process and deploy as one app, code as separate bounded modules" pattern V2's own `ARCHITECTURE_PROPOSAL.md` §7 already validated once (the "modular, not microservices middle ground").
2. **financial-service and payment-service are physically separate deployables from day one** — the one deviation from "everything starts as one process," justified by the distinct DB-permission-boundary requirement (ADR-009) and PCI-adjacent isolation need, not by an anticipated scaling need.
3. **Extraction path, not a redesign later**: because module boundaries already imply schema-per-module and event-driven cross-module calls (no shared transactions), promoting any module to its own service later is an infrastructure change (new deployable, new network call where an in-process call was) — not a data-model or code-boundary change. This is the direct payoff of having done the boundary work evidence-first rather than deploying-topology-first.

## Consequences

- **Positive:** one deployable (plus financial/payment) matches actual team size and operational maturity; no distributed-transaction complexity for the 90% of interactions that are same-process; Iran hosting stays simpler (fewer services needing independent reachability/callback endpoints); faster iteration pre-launch, when requirements are still moving.
- **Negative:** a bug in one module can still crash the whole process (mitigated, not eliminated, by module isolation and typed interfaces); a genuinely hot module (e.g. search or booking under real load) can't scale independently until it's extracted — acceptable given there is no current evidence any module needs that yet.
- **Trigger for re-evaluating**: real production traffic showing one module's load profile diverging sharply from the rest, or the team genuinely growing to a size where independent deploy cadence per module has value — not a scheduled "phase 2 microservices migration" done on a calendar.

## Alternatives considered

- **Option A (pure modular monolith, no exceptions):** rejected only insofar as it would also monolith financial/payment — the isolation reasons for those two are structural (DB-permission boundary, PCI scope), not just "nice to have," so a pure single-process design was not adopted as-is.
- **Option B (12 independent domain services from day one):** rejected as disproportionate to current team size and the "no production dataset yet" fact — this is what the release brief's illustrative list implies, but nothing in the V2 evidence base argues for paying that operational cost before there's real load to justify it.
- **Option C (full microservices, one per capability, finer-grained than even the 12):** rejected outright — no evidence anywhere in the 10-domain discovery pass supports splitting finer than the already-evidence-based 12/13 boundaries; this would be complexity added without a cited reason, which `V3_ARCHITECTURE_PLAN.md`'s own methodology (every recommendation cites V2 evidence) explicitly argues against.
