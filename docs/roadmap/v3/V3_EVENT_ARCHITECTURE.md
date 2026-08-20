# V3 Event Architecture

Status: Phase 0 blueprint. **No Kafka cluster, topic, producer, or consumer has been implemented.** Decision basis: `docs/roadmap/v3/adr/ADR-007-events.md`. This document adds the topic/naming/versioning/DLQ mechanics `ADR-007` didn't specify, and extends `V3_EVENT_CATALOG.md`'s existing 20+-event catalog with two events surfaced while finalizing `V3_DOMAIN_BOUNDARIES.md` that had no V2 precedent to draw from and were absent from the prior catalog.

---

## 1. Kafka topic strategy

**One topic per producing module, not one topic per event type.** `booking.events`, `commerce.events`, `payment.events`, `financial.events`, `provider.events`, `loyalty.events`, `referral.events`, `notification.events`, `identity.events`, `ai.events`, `journey.events` — each carries every event type that module produces, distinguished by an `eventType` field in the envelope (§2), not by topic name. Rationale: keeps the topic count matched to the module count (13, not 20+), preserves **per-aggregate ordering** (Kafka guarantees order only within a partition; partitioning by `aggregateId` within a module's single topic keeps, e.g., all of one booking's events in order, which a topic-per-event-type scheme would not naturally give you across `BookingCreated`→`BookingConfirmed`→`BookingCompleted` if those were three separate topics/partitions).

**Partitioning key**: `aggregateId` (e.g. `bookingId`, `orderId`, `userId`) — guarantees same-aggregate events land in the same partition, hence in order, without over-partitioning a low-volume topic.

**No compacted topics at launch** — every event here is a fact/history record (analytics-service is the system of record for "what happened," per `V3_DOMAIN_BOUNDARIES.md`), not a latest-state snapshot; compaction would be the wrong retention semantic. Revisit only if a genuine "latest state per key" consumer need emerges.

## 2. Event envelope & naming convention

```json
{
  "eventType": "BookingCreated",
  "eventVersion": 1,
  "aggregateType": "booking",
  "aggregateId": "uuid",
  "occurredAt": "2026-08-19T12:00:00Z",
  "producedBy": "booking-service",
  "payload": { }
}
```

- **Naming**: PascalCase, past-tense (`BookingCreated`, not `CreateBooking`) — matches `V3_EVENT_CATALOG.md`'s existing convention exactly, no change.
- **Module prefix lives in the topic, not the name** — `BookingCreated` is unambiguous once you know which topic it came from; this avoids `booking.BookingCreated` stutter.

## 3. Event versioning

- `eventVersion` is a required envelope field, starting at `1` for every event.
- **Additive changes** (a new optional payload field) do **not** bump the version — consumers must already tolerate unknown fields (forward-compatible parsing, matching standard practice, not a new invention).
- **Breaking changes** (a field removed, a field's meaning changed, a required field added) bump `eventVersion` and the producer **dual-publishes both versions** for a defined deprecation window (minimum one full deploy cycle of every known consumer) before retiring the old version — never a hard cutover.
- `packages/event-contracts` holds the generated TypeScript types for every `(eventType, eventVersion)` pair — the wire contract every producer and consumer imports, so a payload-shape mismatch is a compile error, not a runtime surprise.

## 4. Producer/consumer ownership

A registry (maintained in this document — §6 — and mirrored as `packages/event-contracts`'s own type-export manifest) is the single source of truth for who produces and who consumes each event. **A module may only consume an event it's listed against here** — adding a new consumer to an existing event is a change to this document (and the corresponding Kafka consumer-group registration), not a silent runtime subscription. This prevents the exact ungoverned-hook-proliferation problem `GAP-07` describes in V2 (a hook with zero documented subscribers, discovered only by grep).

## 5. Idempotency requirements

**Every event in the catalog (§6) carries an explicit idempotency strategy — no event ships without one.** Three strategies in use, matching the strongest patterns already proven in V2 (per `V3_EVENT_CATALOG.md`'s own per-event analysis):

1. **Natural-key dedupe**: consumer checks a DB unique constraint before acting (e.g. loyalty's `UNIQUE(reference_type, reference_id, reason)` — "the strongest, DB-enforced idempotency pattern found anywhere in V2").
2. **Status-transition CAS**: the event only fires as a side effect of a transition that itself can't double-apply (e.g. `BookingConfirmed` only fires on a `pending→confirmed` CAS).
3. **Recheck-before-acting**: consumer recomputes the real current state and only acts if still applicable (e.g. refund logic rechecking "remaining amount > 0" before acting on a redelivered `BookingCancelled`).

Every consumer implementation must be reviewed against "what happens if this event is delivered twice" before merge — not assumed safe by default, given the outbox pattern (`V3_DATABASE_BLUEPRINT.md` §7) guarantees at-least-once, never exactly-once, delivery.

## 6. Initial event catalog

Full existing catalog (20+ events across booking, commerce/payment, provider, loyalty/referral, notification/AI/search domains): `V3_EVENT_CATALOG.md` — not reproduced here. **Two additions, surfaced while finalizing `V3_DOMAIN_BOUNDARIES.md`, with no V2 precedent and previously absent from that catalog:**

### `UserCreated` v1
- **Producer**: identity-service
- **Topic**: `identity.events`
- **Payload**: `{ userId, phone, registeredVia: "otp", referralCode? }`
- **Consumers**: referral-service (attribution), analytics-service, loyalty-service (welcome-bonus eligibility, if ever adopted)
- **Idempotency**: `userId` is the natural key; a redelivery is a safe no-op for every listed consumer (each keys its own side effect off `userId`, not off "an event arrived").
- **V2 precedent**: closest analog is `beauclick/auth/account_registered` (`WORDPRESS_EXIT_MATRIX.md` §6) — fired, but only ever consumed synchronously in-process for referral attribution, never as a real event with multiple independent consumers. This is a formalization, not a straight port.

### `LedgerEntryCreated` v1
- **Producer**: financial-service
- **Topic**: `financial.events`
- **Payload**: `{ ledgerEntryId, partyType, partyId, entryType, referenceType, referenceId, amount, commissionRate, occurredAt }`
- **Consumers**: analytics-service (financial metrics), notification-service (optional — e.g. a future "your commission was recorded" professional-facing notification, not built at launch)
- **Idempotency**: `UNIQUE(entry_type, reference_type, reference_id)` — the exact DB constraint already proven in V2 to have absorbed a real double-fire bug; the event is emitted from the same outbox transaction as the ledger insert (`V3_DATABASE_BLUEPRINT.md` §7), so a duplicate event can only occur on relay-level redelivery, never on a duplicate underlying ledger write.
- **V2 precedent**: **none** — V2's ledger writes (`LedgerService::record_commission()`) were always direct synchronous calls, never event-driven; nothing else in the codebase reacted to a ledger write as a fact. This is genuinely new instrumentation, not a formalization of an existing hook, and exists specifically because `V3_DOMAIN_BOUNDARIES.md`'s financial module needed a documented "events produced" row and none existed to cite.

## 7. Dead-letter strategy

- Every consumer group gets a matching `{topic}.dlq` topic.
- **Retry policy**: exponential backoff, 3 attempts (1s, 5s, 25s) within the consumer process before a message is published to its DLQ — transient failures (a momentary DB connection blip) resolve without operator involvement; a message that fails 3 times almost certainly needs one.
- **DLQ messages are never silently dropped** — a DLQ depth alert (`V3_INFRASTRUCTURE_PLAN.md` §6, monitoring) fires on any non-zero, non-transient DLQ depth. A DLQ message carries the original envelope plus a `failureReason`/`attemptCount`/`lastAttemptAt` wrapper.
- **Replay**: a DLQ message can be manually replayed (re-published to the original topic) once the underlying cause is fixed — a documented runbook action, not an automated retry-forever loop (which would mask a persistent bug behind infinite retries).
- **No DLQ for events with a "recheck-before-acting" idempotency strategy where the recheck itself would naturally no-op a stale event** — e.g. an ancient redelivered `CampaignUsageReleased` for a usage record already released fails its own recheck harmlessly; still logged, not silently swallowed, but doesn't need the full retry/DLQ ceremony.

---

## Cross-references
- `ADR-007-events.md` — the decision this blueprint operationalizes.
- `V3_EVENT_CATALOG.md` — the full 20+-event catalog this document extends by two.
- `V3_DATABASE_BLUEPRINT.md` §7 — the transactional-outbox mechanism producing these events reliably.
- `V3_DOMAIN_BOUNDARIES.md` — per-module "events produced/consumed" rows this catalog backs.
