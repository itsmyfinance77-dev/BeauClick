# ADR-007: Event Architecture

**Status:** Proposed — discovery only, not decided/approved.
**Date:** 2026-08-19.

## Context

V2 has **no formal event contract anywhere** (`GAP-07`, confirmed by direct inspection of `EventLogger.php` and every `do_action('beauclick/...')` call site across all 18 plugins). Two independent, ungoverned mechanisms exist today: (1) plain, unversioned WordPress `do_action()` hooks (in-process only, nothing persisted, no schema — one confirmed to have zero production subscribers, `beauclick/auth/otp_generated`), and (2) the `wp_bc_events` analytics table, with a free-text `event_type` string and an unvalidated JSON `meta` blob documented only in a code comment. `V3_EVENT_CATALOG.md` (Phase 11 output) is already a full first-draft catalog — 20+ events across booking, commerce/payment, provider, loyalty/referral, notification/AI/search domains, each with producer, payload, consumers, idempotency strategy, and explicit V2 precedent (or "none" where genuinely new).

## Decision

**Adopt `V3_EVENT_CATALOG.md` as the binding event contract**, with Kafka as the transport (release brief baseline — the catalog itself is broker-agnostic by design). Three structural requirements, each grounded in a specific confirmed V2 gap:
1. **Every event is versioned** (`EventName` v1, v2, ...) — V2 had zero versioning; a producer/consumer registry (who produces, who consumes, at what version) must be a real, queryable artifact, not tribal knowledge.
2. **Idempotency is a required field per event, not an afterthought** — the catalog already documents the specific strategy per event (natural key, DB unique constraint, status-transition CAS, remaining-amount recheck), directly reusing the strongest patterns V2 proved worked (financial-service's `UNIQUE(entry_type, reference_type, reference_id)` — "the strongest, DB-enforced idempotency pattern found anywhere in V2," per the catalog's own `OrderPaid` entry) rather than each new consumer inventing its own.
3. **`beauclick/auth/otp_generated`'s absence is deliberate and must remain absolute**: an OTP code must never appear in an event payload, log, or message bus, even internally — explicitly called out in the catalog as a boundary, not an oversight to "complete" later.

## Consequences

- **Positive:** closes a confirmed, cross-cutting gap (`GAP-07`) that made several other bugs harder to catch in V2 (e.g., the stale-reminder-on-reschedule bug the catalog notes would have been prevented by a formal `BookingRescheduled` event instead of an inline direct call). Gives every ADR-002 module a uniform way to react to another module's state changes without direct table access — the mechanism that makes the modular-monolith-with-extraction-path design (ADR-002) actually work.
- **Negative:** genuine new infrastructure (a message broker) that V2 never operated — needs its own operational ownership (topic provisioning, consumer-lag monitoring, dead-letter handling) from day one, not bolted on after a production incident.
- **Risk:** some catalog entries are promotions of a V2 synchronous in-process call to a real async event (e.g. `MembershipActivated`, `NotificationRequested`) — the underlying business rule must be preserved exactly (per the catalog's own notes) even though the transport semantics change from synchronous to eventually-consistent; each such promotion needs its own review for whether eventual consistency is actually acceptable at that call site (most are, per the catalog's analysis — but this needs re-confirming during implementation, not assumed from this document alone).

## Alternatives considered

- **NATS or RabbitMQ** instead of Kafka: the release brief specifies Kafka as baseline; no domain-discovery finding argues for a lighter-weight broker, and Kafka's durable log semantics fit the "event store as source of truth for analytics-service" requirement (`V3_ARCHITECTURE_PLAN.md` §1, row 11) better than a pure message-queue model would.
- **Synchronous HTTP calls between modules instead of an event bus.** Rejected for cross-module reactions (would reintroduce tight coupling ADR-002's module boundaries are meant to avoid) but remains appropriate for genuinely synchronous request/response needs within the monolith (e.g. AI's two-stage authorization/curation call chain, `V3_SECURITY_MODEL.md` §5) — this ADR governs cross-module *facts*, not every internal call.
