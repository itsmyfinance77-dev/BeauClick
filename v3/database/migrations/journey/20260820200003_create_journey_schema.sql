-- Phase 3, journey-service. GAP-29's final resolution -- see ADR-019.
--
-- Journey is a STANDALONE domain, not a sub-module of AI. The decisive
-- reason is in this schema rather than in the org chart: `notes` is
-- customer-authored free text that must never reach an external AI
-- provider's prompt. If Journey lived inside ai-service, that data would sit
-- on the same side of the boundary as the code whose whole job is to
-- serialize context into a prompt, and the rule would be upheld by author
-- discipline in every future edit. Owned separately, the AI module cannot
-- read the column at all -- it can only call `inferAiDefaults()`, which
-- returns a typed struct with no free-text field in its type.
--
-- Three tables, where V2 had two. The addition is the timeline, and it is the
-- one real change of shape:
--
--   V2 composed the timeline at READ time by querying `wp_bc_events` and
--   `wp_bc_bookings` directly -- another domain's tables. Its own docblock
--   records the consequence: booking events were logged with no actor_id, so
--   the composer had to first fetch the customer's booking ids and match
--   against that set, a workaround for a coupling that should not have
--   existed. In V3 the timeline is a read model journey OWNS, written by
--   event handlers. Journey reads no other schema.

CREATE SCHEMA IF NOT EXISTS journey;

-- --------------------------------------------------------------------------
-- One row per customer. Ongoing, low-commitment preferences.
-- --------------------------------------------------------------------------
CREATE TABLE journey.beauty_profiles (
    -- The user id IS the primary key: one profile per customer, and there is
    -- no separate profile id a request could name in place of its owner's.
    user_id UUID PRIMARY KEY,
    preferred_city_id UUID,
    preferred_specialty_ids UUID[] NOT NULL DEFAULT '{}',
    budget_min_toman BIGINT,
    budget_max_toman BIGINT,
    -- Customer-authored free text. NEVER leaves this table except to its own
    -- author over their own authenticated session. Not in an event payload,
    -- not in AI context, not in the timeline.
    --
    -- Deliberately short and deliberately unstructured: V2's design note is
    -- explicit that Beauty Journey "must NOT become a medical-record system",
    -- and there is no health/medical field anywhere in this schema. A 500
    -- character cap is a real part of that boundary, not a storage decision.
    notes VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_beauty_profiles_budget_non_negative CHECK (
        (budget_min_toman IS NULL OR budget_min_toman >= 0)
        AND (budget_max_toman IS NULL OR budget_max_toman >= 0)
    ),
    -- A max below the min makes every downstream price filter nonsense.
    CONSTRAINT ck_beauty_profiles_budget_ordered CHECK (
        budget_min_toman IS NULL OR budget_max_toman IS NULL OR budget_min_toman <= budget_max_toman
    )
);

-- --------------------------------------------------------------------------
-- Many rows per customer. A specific, nameable, time-boundable objective.
-- --------------------------------------------------------------------------
CREATE TABLE journey.beauty_goals (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    title VARCHAR(191) NOT NULL,
    specialty_id UUID,
    city_id UUID,
    budget_toman BIGINT,
    target_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_beauty_goals_status CHECK (status IN ('active', 'achieved', 'abandoned')),
    CONSTRAINT ck_beauty_goals_budget CHECK (budget_toman IS NULL OR budget_toman >= 0),
    CONSTRAINT ck_beauty_goals_title_not_blank CHECK (length(btrim(title)) > 0)
);

CREATE INDEX ix_beauty_goals_user_status ON journey.beauty_goals (user_id, status);
-- inferAiDefaults() takes "the most recently created active goal". Without
-- this index that is a scan-and-sort of every goal the customer ever set.
CREATE INDEX ix_beauty_goals_user_active_recent
    ON journey.beauty_goals (user_id, created_at DESC) WHERE status = 'active';

-- --------------------------------------------------------------------------
-- The timeline read model. Written ONLY by event handlers.
-- --------------------------------------------------------------------------
CREATE TABLE journey.timeline_entries (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    -- A stable machine key, e.g. `booking_completed`. The Persian label is
    -- rendered by the API from this key -- storing the label would freeze
    -- today's copy into every historical row.
    entry_type VARCHAR(40) NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    source_id UUID NOT NULL,
    -- Structured, bounded facts for rendering the entry (a professional's id,
    -- a service id). Never free text and never money the customer did not
    -- already see on their own receipt.
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The idempotency guarantee for every timeline consumer. The outbox is
-- at-least-once, so a redelivered BookingCompleted MUST NOT produce a second
-- entry -- and `entry_type` is part of the key because one booking legitimately
-- produces several distinct entries over its life (created, confirmed,
-- completed) that share a source_id.
CREATE UNIQUE INDEX uq_timeline_entries_source
    ON journey.timeline_entries (user_id, entry_type, source_type, source_id);

CREATE INDEX ix_timeline_entries_user_occurred
    ON journey.timeline_entries (user_id, occurred_at DESC);

CREATE TABLE journey.outbox_events (
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

CREATE INDEX ix_journey_outbox_unpublished ON journey.outbox_events (id) WHERE published_at IS NULL;
