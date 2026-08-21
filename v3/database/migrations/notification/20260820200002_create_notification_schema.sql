-- Phase 3, notification-service.
--
-- V2's notification design got the hard part right and this schema preserves
-- it exactly: the idempotency slot is RESERVED BY AN INSERT BEFORE DISPATCH,
-- so two near-simultaneous requests for the same notification race for one
-- UNIQUE key and the loser never reaches a channel. Recording after sending
-- would mean a crash between the two double-sends on retry.
--
-- Three things V2 did not have, added here because Phase 3 moves delivery
-- from a synchronous in-request call to an event-driven one:
--
--   1. `next_attempt_at` -- V2's retry sweep re-ran every failed row on every
--      pass with no backoff, so a provider outage produced a tight retry
--      storm against the thing that was already struggling.
--   2. A real terminal state (`dead_lettered`) with the reason preserved.
--      V2's failed rows simply stopped being retried at MAX_ATTEMPTS and sat
--      indistinguishable from ones still awaiting a sweep.
--   3. `payload` -- the template VARS, stored. V2 deliberately did not keep
--      them, and its own retry path documents the consequence: it could not
--      re-render the original message and fell back to sending a generic
--      "you have a notification" notice instead of the real one. Storing the
--      variables (never the rendered text) makes a retry send what the first
--      attempt would have sent.

CREATE SCHEMA IF NOT EXISTS notification;

CREATE TABLE notification.notifications (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    category VARCHAR(20) NOT NULL,
    template_key VARCHAR(60) NOT NULL,
    channel VARCHAR(10) NOT NULL,
    -- Template variables, not rendered text. A template fix reaches a
    -- not-yet-delivered notification; and the rendered Persian sentence never
    -- exists at rest in more than one place.
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Where the user should land when they tap it. Relative path only --
    -- an absolute URL here would be an open-redirect surface.
    deep_link VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    idempotency_key VARCHAR(255) NOT NULL,
    entity_type VARCHAR(40) NOT NULL,
    entity_id UUID NOT NULL,
    -- A stable code, never a provider's raw error string: those carry
    -- recipient addresses and account identifiers into the log.
    error_code VARCHAR(60),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    dead_lettered_at TIMESTAMPTZ,
    CONSTRAINT ck_notifications_channel CHECK (channel IN ('in_app', 'email', 'sms')),
    CONSTRAINT ck_notifications_status CHECK (
        status IN ('pending', 'sent', 'failed', 'suppressed', 'dead_lettered')
    ),
    CONSTRAINT ck_notifications_attempts CHECK (attempts >= 0),
    -- A row claiming to be sent with no timestamp is a row whose delivery
    -- history cannot be audited. V2 hit exactly this: a NULL passed through a
    -- %s placeholder coerced to MySQL's zero-date and looked like a real time.
    CONSTRAINT ck_notifications_sent_has_timestamp CHECK (status <> 'sent' OR sent_at IS NOT NULL),
    CONSTRAINT ck_notifications_dead_has_timestamp CHECK (
        status <> 'dead_lettered' OR dead_lettered_at IS NOT NULL
    ),
    -- Only an in-app notification can be read; there is no read receipt for
    -- SMS, and a read email is not something this system observes.
    CONSTRAINT ck_notifications_read_is_in_app CHECK (read_at IS NULL OR channel = 'in_app'),
    -- A deep link must stay inside the app.
    CONSTRAINT ck_notifications_deep_link_relative CHECK (deep_link IS NULL OR deep_link LIKE '/%')
);

-- THE guarantee. `{templateKey}:{entityType}:{entityId}:{userId}:{channel}`,
-- V2's exact shape. A redelivered event cannot produce a second send.
CREATE UNIQUE INDEX uq_notifications_idempotency ON notification.notifications (idempotency_key);

-- The notification centre's two queries: the user's list, newest first, and
-- their unread count.
CREATE INDEX ix_notifications_user_created
    ON notification.notifications (user_id, created_at DESC)
    WHERE channel = 'in_app' AND status <> 'suppressed';
CREATE INDEX ix_notifications_user_unread
    ON notification.notifications (user_id)
    WHERE channel = 'in_app' AND read_at IS NULL AND status <> 'suppressed';

-- The retry sweep's claim query. Partial, so the sweep never scans the
-- (vastly larger) set of already-delivered rows.
CREATE INDEX ix_notifications_retry_due
    ON notification.notifications (next_attempt_at)
    WHERE status = 'failed' AND next_attempt_at IS NOT NULL;

CREATE INDEX ix_notifications_entity ON notification.notifications (entity_type, entity_id);

-- --------------------------------------------------------------------------
-- Preferences: per CATEGORY, not per category-per-channel. A combinatorial
-- matrix nobody asked for is a settings screen nobody can use.
--
-- Absence of a row means ENABLED -- an opt-out model, so the table records
-- only explicit changes rather than a row per user on day one.
-- --------------------------------------------------------------------------
CREATE TABLE notification.preferences (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    category VARCHAR(20) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- `booking` and `payment` are MANDATORY categories: a booking
    -- confirmation and a payment receipt are operationally required
    -- messages. V2 enforced this by having no preference key for them at
    -- all; here the key exists in the domain but a row disabling it cannot be
    -- written, which is stronger -- a bug in the update path cannot suppress
    -- a receipt.
    CONSTRAINT ck_preferences_mandatory_always_enabled CHECK (
        enabled OR category NOT IN ('booking', 'payment')
    )
);

CREATE UNIQUE INDEX uq_preferences_user_category ON notification.preferences (user_id, category);

CREATE TABLE notification.outbox_events (
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

CREATE INDEX ix_notification_outbox_unpublished
    ON notification.outbox_events (id) WHERE published_at IS NULL;
