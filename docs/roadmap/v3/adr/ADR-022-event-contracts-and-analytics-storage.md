# ADR-022: Executable Event Contracts, and Analytics on PostgreSQL

**Status:** Accepted — implemented in Phase 3.
**Date:** 2026-08-21.
**Refines:** ADR-007 (which adopted the catalog and named Kafka).

## Part 1 — The event catalog becomes executable

### Context

Phase 2 gave every event a name and an integer version, but the payload was `Record<string, unknown>` from producer to consumer. So "the producer changed shape" and "the consumer reads a field that no longer exists" were both silent at compile time *and* at run time. The catalog said what a payload should contain; nothing checked that it did.

ADR-007 also asked for a producer/consumer registry that is "a real, queryable artifact, not tribal knowledge". Phase 2 had no such artifact.

### Decision

A contract is the single declaration of an event: name, version, aggregate type, the one service allowed to produce it, a runtime schema, and the documented idempotency strategy. **The TypeScript type is derived from the schema** (`z.infer`) rather than declared beside it — a hand-written interface next to a hand-written validator is two declarations of one truth, and they diverge the first time somebody edits only one.

Three things this makes impossible rather than merely discouraged:

1. **Emitting an undeclared or malformed event.** Validation runs on the way into the outbox, *inside the producing transaction*, so a bad payload fails the business write.
2. **Publishing a field nobody declared.** Validation returns the *parsed* value, and unknown keys are stripped. That is a safety property, not tidiness: an accidental entity spread is exactly how a `phone` or a private note reaches a consumer that should never have seen it. Phase 2's credential deny-list still runs underneath as an independent second layer — it catches a secret in a field the contract genuinely declares, which stripping by definition cannot.
3. **Consuming an event nobody produces.** Every wired handler is registered as a consumer at boot and `assertConsumersHaveProducers()` fails startup on a typo'd name or an unpublished version. V2's `beauclick/auth/otp_generated` — a real hook with zero subscribers, found only by grepping the whole codebase — is the mirror image of that blind spot.

Privacy is enforced by contract *shape*. `SearchPerformed` has **no field capable of holding query text**: it carries `queryClass` and `queryTermCount` instead. V2 achieved the same redaction by remembering not to log the query; here a future author would have to edit the contract and bump the version, which is a reviewable act.

### Transport: still in-process, deliberately

ADR-007 names Kafka. Phase 3 **keeps the in-process relay** and states why plainly: the correctness-bearing parts — transactional outbox, versioned envelopes, idempotent consumers — are built and now contract-validated. No producer writes to a broker and no consumer knows how an envelope arrived, so adopting Kafka changes one file.

What has changed since Phase 2 is the fan-out: `OrderPaid` now reaches the ledger, loyalty, the journey timeline, a notification, and analytics. That is five consumers on one event, all independently idempotent, and it runs correctly on the in-process relay. **Nothing in the observed load argues for a broker**, and §24 asks for exactly this evaluation rather than an automatic adoption. Deploying Kafka now would be infrastructure with no measured problem behind it, and a real operational burden (topic provisioning, consumer-lag monitoring, dead-letter handling) from day one.

## Part 2 — Analytics on PostgreSQL, not ClickHouse

### Context

The roadmap names ClickHouse. V2's analytics ran every metric as a live aggregate over `wp_bc_events` at a confirmed volume in the low thousands of rows, and its own docblock argues — correctly — that a pre-aggregation layer at that scale means maintaining a second source of truth, a backfill path, and a staleness story for a performance problem that does not exist.

### Decision

**PostgreSQL.** V3 does not have more data than V2 did; it has the same domain with a better schema. §25 explicitly warns against over-engineering, and standing up a columnar cluster now would be infrastructure with no measured problem behind it.

What *is* taken from the columnar design, because it costs almost nothing and is what actually makes dashboards cheap:

- **An append-only fact table with a typed, indexed subject**, replacing V2's free-text `event_type` and unvalidated JSON blob.
- **Ingestion keyed on the producing event's id.** Not a fresh id — that is what makes ingestion idempotent. An inflated analytics number is uniquely bad: wrong, plausible, and with nothing to compare against.
- **A daily rollup table** — the exact table V2's own docblock names as the natural next step — recomputed over an overlapping window so late-arriving facts are picked up, and upserted so a re-run replaces rather than doubles.
- **A `metric_kind` column** carried with every figure: `event_derived`, `domain_derived`, or `correlation_derived`.

That last one is a product decision, not a schema detail. A "conversion rate" computed by dividing two independently-collected counters is a **correlation** — nothing links a particular profile view to a particular booking. Presenting it as tracked conversion is the kind of quiet dishonesty that survives for years because the number looks reasonable. The kind travels *with the number* into any report, and `viewToBookingRate` ships with an explicit Persian caveat.

The migration path stays real: the fact table is append-only and partitionable by `occurred_on`, so moving it to a columnar store later is a copy, not a redesign.

### GAP-15, closed structurally

V2's `profile_view` logged `entity_type` as the raw CPT post type (`bc_professional`) while every other provider-scoped event logged `provider`, making the two uncomparable. In V3 the normalized value is the only one the contract permits, and a `CHECK` constraint makes the un-normalized value **unstorable**.

## Consequences

- **Positive:** a malformed or undeclared event now fails at the producing transaction rather than in a log aggregator.
- **Positive:** the producer/consumer registry describes the system that is actually running, because it is populated from the wired handler list at boot rather than hand-maintained.
- **Negative:** a new runtime dependency (`zod`) on the write path of every event. It is small, and the validation is O(payload).
- **Negative:** contract validation makes a producer/consumer version mismatch a hard failure. That is the intent, but it means a rolling deploy that introduces a v2 must add the v2 contract before any producer emits it.
- **Risk:** the in-process relay remains a single point of processing. It is idempotent and restart-safe, but a long outage means a growing outbox rather than a buffered queue. Accepted at current volume, revisited on evidence.
