-- Phase 3, search-service.
--
-- Search is a READ MODEL and never a system of record. Nothing in this schema
-- is authoritative for anything: every column is derived from an event another
-- service produced, and the whole schema can be dropped and rebuilt.
--
-- Why a PostgreSQL projection exists at all, when the documents live in
-- OpenSearch:
--
--   1. **Rebuild without replaying history.** OpenSearch is a derived store
--      that can be lost, corrupted, or need a mapping change that requires a
--      fresh index. Rebuilding from here is a bounded scan of a few hundred
--      rows. Rebuilding from the event log instead would mean replaying every
--      event ever produced, which grows without bound and depends on outbox
--      rows nobody promised to retain.
--
--   2. **Counters cannot be accumulated in OpenSearch.** "How many bookings
--      has this professional completed" is a running total incremented by an
--      event. A read-modify-write against a search engine has no transaction
--      to make it atomic, so two concurrent events would lose one increment.
--      Here it is one UPDATE ... SET n = n + 1.
--
--   3. **Out-of-order and duplicate delivery need a version to compare
--      against.** `revision` is that version, and it lives with the data it
--      guards.
--
-- The recovery story is therefore two-level and both levels are real:
-- OpenSearch lost -> rebuild from this schema; this schema lost -> rebuild
-- from provider-service through the reindex port.

CREATE SCHEMA IF NOT EXISTS search;

-- --------------------------------------------------------------------------
-- The projected provider document. One row per professional.
-- --------------------------------------------------------------------------
CREATE TABLE search.provider_documents (
    professional_id UUID PRIMARY KEY,
    -- Monotonic per professional, assigned by provider-service. An event
    -- carrying a revision <= the stored one is a duplicate or an out-of-order
    -- delivery and is DISCARDED. This is what makes at-least-once, unordered
    -- delivery safe rather than merely usually-fine.
    revision BIGINT NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    bio TEXT,
    city_id UUID,
    city_name VARCHAR(120),
    specialty_ids UUID[] NOT NULL DEFAULT '{}',
    specialty_names TEXT[] NOT NULL DEFAULT '{}',
    verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified',
    -- Service catalogue, denormalized for name search and price faceting.
    -- JSONB rather than a child table: it is always read and written whole,
    -- as one document, and a join to rebuild one document would be pure cost.
    services JSONB NOT NULL DEFAULT '[]'::jsonb,
    min_price_toman BIGINT,
    max_price_toman BIGINT,
    -- Soft delete: a removed professional must leave the index, and a
    -- hard delete here would lose the revision that proves the removal is
    -- newer than a straggling update event still in flight.
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    -- Ranking output, recomputed from search.ranking_signals.
    ranking_score NUMERIC(9, 4) NOT NULL DEFAULT 0,
    ranking_signal_keys TEXT[] NOT NULL DEFAULT '{}',
    -- NULL once the row has been successfully pushed to OpenSearch. A
    -- non-NULL value is the outstanding-work queue the sync sweep drains, so
    -- an OpenSearch outage degrades to "stale index", never "lost update".
    index_dirty_since TIMESTAMPTZ,
    indexed_at TIMESTAMPTZ,
    source_updated_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_provider_documents_revision CHECK (revision > 0),
    CONSTRAINT ck_provider_documents_prices CHECK (
        (min_price_toman IS NULL OR min_price_toman >= 0)
        AND (max_price_toman IS NULL OR max_price_toman >= 0)
        AND (min_price_toman IS NULL OR max_price_toman IS NULL OR min_price_toman <= max_price_toman)
    )
);

-- The sync sweep's claim query.
CREATE INDEX ix_provider_documents_dirty
    ON search.provider_documents (index_dirty_since)
    WHERE index_dirty_since IS NOT NULL;

-- --------------------------------------------------------------------------
-- Accumulated ranking signals. Written by event handlers, read by the scorer.
--
-- These are counters, not a copy of another table: booking-service owns
-- bookings and never exposes "how many did this professional complete" as a
-- query search may run. Search accumulates the fact from the events instead.
-- --------------------------------------------------------------------------
CREATE TABLE search.ranking_signals (
    professional_id UUID PRIMARY KEY,
    completed_bookings INTEGER NOT NULL DEFAULT 0,
    cancelled_bookings INTEGER NOT NULL DEFAULT 0,
    created_bookings INTEGER NOT NULL DEFAULT 0,
    profile_views INTEGER NOT NULL DEFAULT 0,
    -- Rating is carried so the filter/sort surface and the Bayesian shrinkage
    -- term exist and are correct the moment reviews ship. NO V3 PRODUCER
    -- WRITES THESE YET -- there is no review domain in V3 as of Phase 3, and
    -- inventing one to populate them would be fabricating a signal. They stay
    -- at zero, which the scorer already treats as "no evidence" and handles
    -- through cold-start blending rather than as a penalty.
    rating_sum INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    -- Rolling freshness signal: events counted within the recent window.
    recent_activity_count INTEGER NOT NULL DEFAULT 0,
    last_activity_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_ranking_signals_non_negative CHECK (
        completed_bookings >= 0 AND cancelled_bookings >= 0 AND created_bookings >= 0
        AND profile_views >= 0 AND rating_sum >= 0 AND review_count >= 0
        AND recent_activity_count >= 0
    )
);

-- --------------------------------------------------------------------------
-- Signal idempotency.
--
-- A counter increment is NOT naturally idempotent: replaying BookingCompleted
-- twice increments twice, and the number is then permanently wrong with
-- nothing to detect it. Every increment therefore records the event that
-- caused it, and a redelivery loses the INSERT.
-- --------------------------------------------------------------------------
CREATE TABLE search.signal_applications (
    -- The outbox row's id -- unique per emitted event, stable across
    -- redeliveries of that same event.
    event_id UUID NOT NULL,
    signal VARCHAR(40) NOT NULL,
    professional_id UUID NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, signal)
);

CREATE INDEX ix_signal_applications_applied ON search.signal_applications (applied_at);

-- --------------------------------------------------------------------------
-- Index lifecycle state. One row per logical index.
-- --------------------------------------------------------------------------
CREATE TABLE search.index_state (
    index_key VARCHAR(60) PRIMARY KEY,
    -- The concrete physical index behind the alias. A mapping change creates
    -- a NEW physical index and atomically re-points the alias, so search
    -- never serves a half-populated index during a reindex.
    physical_index VARCHAR(120) NOT NULL,
    mapping_version INTEGER NOT NULL,
    last_full_reindex_at TIMESTAMPTZ,
    last_full_reindex_count INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE search.outbox_events (
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

CREATE INDEX ix_search_outbox_unpublished ON search.outbox_events (id) WHERE published_at IS NULL;
