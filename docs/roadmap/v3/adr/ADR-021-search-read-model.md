# ADR-021: Search as a Two-Layer Read Model

**Status:** Accepted — implemented in Phase 3.
**Date:** 2026-08-21.
**Refines:** ADR-005 (which chose OpenSearch but did not specify the indexing pipeline).
**Closes:** GAP-14, GAP-15; supersedes the coupling described in GAP-16's neighbourhood.

## Context

ADR-005 chose OpenSearch and required Persian/digit normalization, event-driven reindexing, and reuse of V2's ranking math. It did not say **how** documents get into the index, and that is where the correctness lives.

Two V2 facts shape the answer:

1. **The coupling that has to go.** A provider's verification status reached V2's search index only because `VerificationService::transition()` synchronously called `Indexer::sync()` in the same request. Any code path that changed a profile without going through that one method left the index silently stale, and provider-service could not run without search being up.
2. **Delivery is at-least-once.** Phase 2's outbox dispatches before marking published, deliberately, because the opposite order loses events. So redelivery and reordering are the *expected steady state*, not exceptional.

## Decision

Search is a read model in **two layers**: a PostgreSQL projection owned by search-service, and OpenSearch derived from it.

```
provider-service --(outbox events)--> search.provider_documents --(flush)--> OpenSearch
                                      search.ranking_signals
```

### Why a PostgreSQL projection exists at all

- **Rebuild without replaying history.** OpenSearch is a derived store that can be lost or need a mapping change. Rebuilding from the projection is a bounded scan; rebuilding from the event log would mean replaying every event ever produced and depending on outbox rows nobody promised to retain.
- **Counters cannot be accumulated in a search engine.** "How many bookings has this professional completed" is a running total incremented by an event. A read-modify-write against OpenSearch has no transaction, so two concurrent events lose an increment. In PostgreSQL it is one `UPDATE ... SET n = n + 1`.
- **Ordering needs a version to compare against**, and that version should live with the data it guards.

### Write order: PostgreSQL first, always

If the engine is down when an event arrives, the projection still commits and the row stays marked dirty. The outcome is a **stale index that self-heals on the next sweep** — never a lost update. Pushing to the engine first would make an engine outage into permanent data loss, because the projection would never learn what it failed to write.

The consequence is stated rather than hidden: **search is eventually consistent with provider data, bounded by the sweep interval.** What is *not* eventually consistent is correctness under redelivery or reordering — those are exact.

### Ordering: a per-professional `revision`

provider-service increments `professionals.revision` in the same transaction as every indexable change, and the new value travels in the payload. The consumer applies a document only when `stored.revision < incoming.revision`, in a single guarded upsert:

```sql
INSERT INTO search.provider_documents (...) VALUES (...)
ON CONFLICT (professional_id) DO UPDATE SET ...
WHERE search.provider_documents.revision < EXCLUDED.revision
```

This matters because a redelivered *older* event is individually valid: nothing in its payload says it is stale. Without a revision, at-least-once delivery silently reverts newer data and nothing downstream can detect it.

A service edit bumps the **owning professional's** revision rather than having its own counter, because the search document is per-professional — that is the thing whose versions must be comparable.

### Signals: idempotent by source event id

A counter increment is the one projection operation that is *not* naturally idempotent — applying it twice leaves a permanently wrong number with nothing able to detect it afterwards. Every increment first inserts into `search.signal_applications` keyed on the **outbox row's id**, which is stable across redeliveries and distinct between events. A redelivery loses that insert and skips the increment.

### Ranking: V2's math, unchanged

`V3_MIGRATION_MATRIX.md` classifies the scoring algorithm as DIRECT REUSE, and that is honoured literally — every weight, the Bayesian shrinkage, the cold-start blend, and the log-scaled activity curve are V2's values. OpenSearch changes storage and retrieval, not arithmetic. Relevance is a `function_score` that blends the stored score in multiplicatively with `log1p`, so text relevance decides *who* matches and quality decides the order among them.

Ratings have **no V3 producer** — there is no review domain as of Phase 3 — so `ratingAvg`/`reviewCount` arrive as 0/0. That is handled correctly rather than specially: the Bayesian term already collapses to the platform mean at zero reviews, and cold-start blending already pulls a no-evidence provider toward neutral. Nothing is faked.

### Recovery, in two levels

| Lost | Recovery |
|---|---|
| OpenSearch | `fullReindex()` — builds a **new** physical index and swaps the alias atomically, so the old index answers every query until the new one is complete |
| The projection itself | `rebuildProjectionFromSource()` — reads provider-service through a port the composition root implements, then reindexes |

Both are capability-gated admin routes, and both were exercised live.

## Consequences

- **Positive:** provider-service no longer knows a search index exists, and cannot be blocked by it.
- **Positive:** an OpenSearch outage degrades search to a plain, honest database query — no fuzzy matching, no relevance — and **says so** via a `degraded` flag the UI surfaces. Silently serving worse results would make "search got worse" indistinguishable from "there is nothing to find".
- **Negative:** three stores now describe one professional (provider tables, projection, index). The projection is authoritative for neither — it is rebuildable from provider-service, and the index from it — but it is still a thing that can be stale.
- **Negative:** the degraded path is a second, much simpler query path that only runs when the primary one is broken. It is deliberately *not* an attempt to reproduce relevance in SQL: reimplementing fuzzy Persian matching in PostgreSQL would be a second untested search engine running at the worst possible moment.

## A finding that shaped the analyzer

Probed directly against a real OpenSearch 2.19.1 with `_analyze`:

**Lucene's `persian_normalization` does NOT strip ZWNJ.** `می‌کاپ` (with U+200C) analyses to a token that still contains it, while `میکاپ` does not — so the two spellings of one word **do not match** under the built-in Persian chain alone. ZWNJ placement in real Persian text is genuinely inconsistent, so this is not an edge case; it is the single most likely way a correct query misses a correct document. The mapping char_filter that removes ZWNJ/ZWJ/LRM/RLM is therefore load-bearing, not belt-and-braces.

By contrast, `arabic_normalization` already folds Arabic kaf/yeh and teh-marbuta — verified, and the explicit mappings are kept anyway so the autocomplete field does not depend on another filter's internals.
