-- Phase 3, analytics-service.
--
-- Storage choice: PostgreSQL, not ClickHouse. Stated plainly because the
-- roadmap names ClickHouse and this is a deliberate departure.
--
-- The evidence: V2's analytics ran every metric as a live aggregate over
-- `wp_bc_events` at a confirmed volume in the low thousands of rows, and its
-- own docblock argues -- correctly -- that a pre-aggregation layer at that
-- scale would mean maintaining a second source of truth, a backfill path, and
-- a staleness story for a performance problem that does not exist. V3 does not
-- have more data than V2 did; it has the same domain with a better schema.
-- Standing up a columnar cluster now would be infrastructure with no measured
-- problem behind it, which §25 explicitly warns against.
--
-- What IS taken from the ClickHouse-shaped design, because it costs almost
-- nothing and is what actually makes dashboards cheap:
--
--   * an append-only fact table with a typed, indexed subject rather than a
--     free-text `event_type` and an unvalidated JSON blob (V2's real shape);
--   * a daily rollup table so a dashboard reads pre-aggregated rows instead
--     of scanning facts -- the exact table V2's own docblock names as the
--     natural next step;
--   * a `metric_kind` column that makes the difference between a directly
--     measured number and a derived one legible IN THE DATA, not just in a
--     dashboard footnote.
--
-- The migration path is real: the fact table is append-only and
-- date-partitionable by `occurred_on`, so moving it to a columnar store later
-- is a copy, not a redesign.

CREATE SCHEMA IF NOT EXISTS analytics;

-- --------------------------------------------------------------------------
-- The fact table. One row per domain event worth measuring.
-- --------------------------------------------------------------------------
CREATE TABLE analytics.events (
    -- The producing outbox row's id. NOT a fresh id: making the source event's
    -- id the primary key is what makes ingestion idempotent, so a redelivered
    -- event cannot inflate a count. V2's analytics had no such guard.
    event_id UUID PRIMARY KEY,
    event_type VARCHAR(80) NOT NULL,
    event_version INTEGER NOT NULL,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    -- The party the fact is ABOUT, normalized. GAP-15's closure: V2's
    -- profile_view logged the raw CPT post type here while every other event
    -- logged 'provider', so the two could never be compared. A CHECK
    -- constraint now makes the un-normalized value unstorable.
    subject_type VARCHAR(30),
    subject_id UUID,
    -- Who did it, when it is a person. NULL for system-originated facts.
    actor_id UUID,
    -- Bounded, structured dimensions -- never a free-form blob. Anything a
    -- metric groups by must be here; anything else does not belong in
    -- analytics at all.
    dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The single numeric fact this event contributes, if any (an order total,
    -- a points award, a latency). Integer Toman where it is money.
    metric_value BIGINT,
    occurred_at TIMESTAMPTZ NOT NULL,
    -- Denormalized calendar day in the platform timezone, so every rollup
    -- groups without a per-row timezone conversion in the GROUP BY -- which
    -- would defeat any index on it.
    occurred_on DATE NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_analytics_events_subject_normalized CHECK (
        subject_type IS NULL
        OR subject_type IN ('provider', 'customer', 'order', 'booking', 'search', 'notification', 'membership')
    ),
    CONSTRAINT ck_analytics_events_subject_pair CHECK (
        (subject_type IS NULL AND subject_id IS NULL) OR (subject_type IS NOT NULL AND subject_id IS NOT NULL)
    )
);

-- The shape every metric query has: a type, over a date range.
CREATE INDEX ix_analytics_events_type_day ON analytics.events (event_type, occurred_on);
-- Professional-scoped analytics: one provider's facts over a range. The
-- leading subject columns are what keep Professional A's query from touching
-- Professional B's rows at all.
CREATE INDEX ix_analytics_events_subject_day
    ON analytics.events (subject_type, subject_id, occurred_on)
    WHERE subject_type IS NOT NULL;
CREATE INDEX ix_analytics_events_actor_day
    ON analytics.events (actor_id, occurred_on) WHERE actor_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Daily rollups. What dashboards actually read.
-- --------------------------------------------------------------------------
CREATE TABLE analytics.daily_metrics (
    metric_key VARCHAR(60) NOT NULL,
    metric_day DATE NOT NULL,
    -- The empty string and the nil UUID mean "platform-wide"; any other value
    -- is a professional/business-scoped figure, and is what every
    -- provider-facing query filters on before anything else.
    --
    -- SENTINELS rather than NULLs, deliberately. NULL is the more natural
    -- modelling choice, but `NULL <> NULL` means a plain composite key cannot
    -- dedupe the platform-wide row, and the COALESCE-based unique index that
    -- would fix it is an EXPRESSION index -- which PostgreSQL will not accept
    -- as an `ON CONFLICT` target. The recompute-replaces-never-appends
    -- guarantee is worth more here than the modelling purity, because a
    -- doubled rollup has nothing downstream able to detect it.
    scope_type VARCHAR(30) NOT NULL DEFAULT '',
    scope_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    -- How this number came to exist. Never presented without it: a proxy
    -- must not be able to masquerade as a direct measurement in a dashboard,
    -- which is precisely how V2's "conversion rate" figures could mislead.
    metric_kind VARCHAR(20) NOT NULL,
    count_value BIGINT NOT NULL DEFAULT 0,
    sum_value BIGINT NOT NULL DEFAULT 0,
    distinct_actors INTEGER NOT NULL DEFAULT 0,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_daily_metrics_kind CHECK (
        metric_kind IN ('event_derived', 'domain_derived', 'correlation_derived')
    ),
    -- Recomputing a day REPLACES it. A plain composite primary key, so it can
    -- serve as an `ON CONFLICT` target -- see the sentinel note above.
    PRIMARY KEY (metric_key, metric_day, scope_type, scope_id)
);

CREATE INDEX ix_daily_metrics_scope_day
    ON analytics.daily_metrics (scope_type, scope_id, metric_day)
    WHERE scope_type <> '';

-- --------------------------------------------------------------------------
-- Rollup progress. Which days have been computed, so a sweep recomputes only
-- what changed instead of the whole history on every run.
-- --------------------------------------------------------------------------
CREATE TABLE analytics.rollup_state (
    metric_key VARCHAR(60) PRIMARY KEY,
    last_computed_day DATE,
    last_run_at TIMESTAMPTZ,
    last_run_rows INTEGER
);
