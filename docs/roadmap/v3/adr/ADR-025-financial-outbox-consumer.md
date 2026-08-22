# ADR-025: A Second Relay for the Financial Outbox, Not a New Mechanism

**Status:** Accepted — implemented in Phase 4.
**Date:** 2026-08-22.
**Relates to:** ADR-007 (events), ADR-017 (financial isolation and money).
**Closes:** "Financial outbox consumer" — deferred explicitly in both the Phase 2 and Phase 3 reports.

## Context

`financial.outbox_events` has existed since Phase 2, and every prior phase recorded the same honest reason it was never drained: "financial-service runs on a different DataSource, and the relay's constructor takes exactly one." That DataSource separation is not incidental — it is ADR-017's entire mechanism. `financial.ledger_entries` and `financial.settlement_*` are owned by `beauclick_financial_owner`; the main application role has `REVOKE ALL ON SCHEMA financial` and **cannot even `SELECT` the ledger**. This means a financial fact has exactly one way to ever leave `services/financial`: through its own outbox, read by a connection that is actually allowed to read it.

## Decision

**A second `OutboxRelay` instance, the same class, constructed with `FINANCIAL_DATA_SOURCE` instead of the main pool.** Not a parallel implementation — `financial-outbox-relay.provider.ts` calls `new OutboxRelay(financialDataSource, [{name:'financial', entity: FinancialOutboxEntity}], handlers)`, the identical constructor every other consumer of the class already uses.

```
financial.outbox_events (written by LedgerService/SettlementService,
                          on the FINANCIAL_DATA_SOURCE writer connection)
        |
        v  (periodic sweep -- see below for why this one is not a backstop)
financial-outbox-relay  --  drains via the SAME writer connection
        |
        +--> AnalyticsIngestionHandler (LedgerEntriesRecorded, SettlementRecorded, SettlementReversed)
        +--> NotificationDispatchHandler (SettlementRecorded -> the seller who was paid)
```

### Why this relay has no synchronous post-commit drain

Every other relay drain in this codebase is triggered two ways: synchronously right after the causing transaction commits (`CheckoutService.drainQuietly()`), and periodically as a backstop for when the process died in between. Financial writes have no equivalent synchronous trigger point: `LedgerService.recordPayment()` runs as a *reaction* dispatched by the **main** relay (in response to `OrderPaid`), which has no handle on a second DataSource's relay to call afterward without financial-service reaching back into the main relay — exactly the kind of cross-domain coupling ADR-011 forbids. The periodic sweep (`outbox-sweep.scheduler.ts`'s `sweepFinancialOutbox`) is therefore not a latency optimization's backstop here; it is the only mechanism, and is documented as such rather than left to look like every other sweep in the file.

### What financial facts carry into the shared analytics table, and what does not

`SettlementRecorded`/`SettlementReversed` have no natural `AnalyticsSubjectType` — there is no `'settlement'` or `'business'` entry in that union, and adding one is a schema `CHECK`-constraint change this phase did not need for a dimension-only question ("total settled/reversed amount over time"). Rather than force a subject onto a fact that does not have a clean one, these two ingest with `subjectType: null, subjectOf: () => null` — a legitimate, precedented shape the ingestion service already supports.

`sellerPartyId` is deliberately **not** carried into any analytics dimension. A seller's own earnings are already visible to them through `MyFinanceService`; copying their party id into a table every operator with analytics access can query would be a real identity leak with no product question it answers. Only the aggregate `sellerPartyType` (`'professional'` vs `'business'`) is kept.

### The seller notification resolves a party, not a userId

`SettlementRecorded`'s payload carries `partyType`/`partyId` (a `professional.id` or `business.id`), never an identity user id — financial-service does not know about identity users, by design. `NotificationEnricher.sellerUserId()` (composition root) is the one new lookup this phase adds: `professional` resolves through `ProfessionalEntity.ownerId`, `business` through `BusinessEntity.ownerId`, mirroring exactly how `ProviderBackedFinancialPartyResolver` already resolves the same relationship in the opposite direction.

## Consequences

- **Positive:** closes a gap two prior phases left open on record, without weakening ADR-017's isolation guarantee at all — the financial schema's grants are completely unchanged; this relay reads through the SAME writer role's existing `SELECT` grant on its own outbox table.
- **Positive:** the first real notification a seller ever receives about money moving on this platform. Previously, a settlement was recorded and the seller found out only by checking `GET /v1/me/finance/summary` themselves.
- **Positive, proven not asserted:** `financial-outbox-consumer.pg-spec.ts` records a real payment and a real settlement against real PostgreSQL, drains the financial relay, and asserts the resulting `analytics.events` row and `notification.notifications` row directly — including that a redelivery does not double-count (the same idempotent-insert-by-event-id guarantee every other analytics consumer relies on).
- **Negative, disclosed:** `LedgerEntriesRecorded`'s payload shape is inconsistent between its two producers — `recordPayment()` includes `sellerPartyType`/`sellerPartyId`, `recordRefund()` does not (pre-existing, not introduced by this phase). The analytics mapping tolerates the missing fields gracefully (`str()` returns `null`) rather than assuming they are always present; fixing the producer inconsistency itself is out of this phase's scope, since `ledger.service.ts` is otherwise untouched.
