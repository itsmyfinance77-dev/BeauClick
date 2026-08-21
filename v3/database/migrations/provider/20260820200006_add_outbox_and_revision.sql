-- Phase 3: provider-service becomes an event producer.
--
-- Until now provider-service had no outbox, because nothing consumed its
-- facts. Search does, and the coupling it replaces is the one V2 got wrong:
-- there, a verification status change reached the search index only because
-- `VerificationService::transition()` synchronously called `Indexer::sync()`
-- in the same request. Any code path that changed a profile without going
-- through that one method left the index silently stale, and provider-service
-- could not be deployed without search being up.
--
-- `revision` is the other half. It is a per-professional counter incremented
-- on every indexable change, and it is what makes at-least-once, unordered
-- event delivery actually safe:
--
--   Two edits land close together. The relay redelivers the first after the
--   second has already been applied. Without a revision the consumer has no
--   way to know it is about to overwrite newer data with older data -- the
--   payloads look equally valid. With one, the older revision is discarded.
--
-- This is a real failure mode, not a theoretical one: the outbox is
-- explicitly at-least-once and two relay instances may both pick up a row.

ALTER TABLE provider.professionals
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;

-- A revision must never go backwards or stand still across a change; the
-- consumer's discard rule is only sound if the producer's counter is
-- genuinely monotonic.
ALTER TABLE provider.professionals
    ADD CONSTRAINT ck_professionals_revision_positive CHECK (revision > 0);

-- Services belong to a professional and share that professional's revision
-- stream: a service edit bumps the OWNING professional's revision, because the
-- search document is per-professional and that is the thing whose version
-- must be comparable.
CREATE TABLE provider.outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_provider_outbox_unpublished ON provider.outbox_events (id) WHERE published_at IS NULL;
