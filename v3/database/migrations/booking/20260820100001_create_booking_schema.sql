-- Phase 2, booking-service. V3_DATABASE_BLUEPRINT.md conventions:
-- schema-per-module, UUIDv7 PKs generated application-side, snake_case
-- columns, timestamptz everywhere.
--
-- Three database-level invariants are the load-bearing part of this file.
-- They are not documentation of what the application intends -- they are
-- what makes the intent true even if a future code path is wrong:
--
--   1. ex_availability_slots_no_overlap -- a professional can never have
--      two overlapping slots. V2 enforced this with a SELECT before INSERT,
--      which two concurrent requests both pass.
--   2. uq_bookings_active_slot -- one slot can back at most ONE live
--      (pending/confirmed) booking. V2 had no such constraint at all; its
--      only protection was the atomic claim in application code.
--   3. uq_availability_slots_professional_start -- makes bulk generation
--      idempotent by construction (ON CONFLICT DO NOTHING) instead of by a
--      per-candidate SELECT loop.

CREATE SCHEMA IF NOT EXISTS booking;

-- Required by the exclusion constraint below: GiST needs btree_gist to
-- index the plain-equality `professional_id` operand alongside the range
-- operand. A trusted extension since PostgreSQL 13, so a non-superuser
-- database owner can install it (verified on this project's own
-- non-superuser role before this migration was written -- ADR-009's
-- discipline of confirming a hosting precondition rather than assuming it).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE booking.availability_slots (
    id UUID PRIMARY KEY,
    professional_id UUID NOT NULL, -- references provider.professionals.id; no cross-schema FK by convention
    service_id UUID,               -- references provider.services.id; NULL means "any service"
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    held_until TIMESTAMPTZ,
    held_by_booking_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_availability_slots_status CHECK (status IN ('open', 'held', 'booked')),
    CONSTRAINT ck_availability_slots_range CHECK (end_at > start_at),
    -- A held slot must say until when; an open slot must not claim to.
    CONSTRAINT ck_availability_slots_hold CHECK (
        (status = 'held' AND held_until IS NOT NULL) OR (status <> 'held')
    )
);

CREATE UNIQUE INDEX uq_availability_slots_professional_start
    ON booking.availability_slots (professional_id, start_at);

ALTER TABLE booking.availability_slots
    ADD CONSTRAINT ex_availability_slots_no_overlap
    EXCLUDE USING gist (
        professional_id WITH =,
        tstzrange(start_at, end_at, '[)') WITH &&
    );

CREATE INDEX ix_availability_slots_professional_start_status
    ON booking.availability_slots (professional_id, start_at, status);

-- Supports the hold-expiry sweep and the claim predicate's expired-hold
-- branch without scanning every slot ever created.
CREATE INDEX ix_availability_slots_expiring_holds
    ON booking.availability_slots (held_until)
    WHERE status = 'held';

CREATE TABLE booking.bookings (
    id UUID PRIMARY KEY,
    customer_id UUID NOT NULL,      -- references identity.users.id
    professional_id UUID NOT NULL,  -- references provider.professionals.id
    service_id UUID,
    slot_id UUID NOT NULL REFERENCES booking.availability_slots (id),
    slot_start TIMESTAMPTZ NOT NULL,
    slot_end TIMESTAMPTZ NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    hold_expires_at TIMESTAMPTZ,
    reschedule_count INT NOT NULL DEFAULT 0,
    cancellation_reason VARCHAR(255),
    cancelled_by_actor_type VARCHAR(16),
    cancelled_by_actor_id UUID,
    confirmed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_bookings_status CHECK (
        status IN ('pending', 'confirmed', 'completed', 'cancelled', 'expired', 'no_show')
    ),
    CONSTRAINT ck_bookings_reschedule_count CHECK (reschedule_count >= 0)
);

-- THE double-booking backstop. Partial, so terminal bookings (cancelled,
-- expired, completed, no_show) legitimately share a slot id with whichever
-- booking currently holds it.
CREATE UNIQUE INDEX uq_bookings_active_slot
    ON booking.bookings (slot_id)
    WHERE status IN ('pending', 'confirmed');

CREATE INDEX ix_bookings_customer_status ON booking.bookings (customer_id, status);
CREATE INDEX ix_bookings_professional_status ON booking.bookings (professional_id, status);
CREATE INDEX ix_bookings_professional_slot_start ON booking.bookings (professional_id, slot_start DESC);

-- The expiry sweep's only query. Partial, so it stays tiny regardless of
-- how many historical bookings exist -- an unpartitioned index here would
-- grow with total booking volume forever while only ever being read for
-- the handful of currently-pending rows.
CREATE INDEX ix_bookings_expiring_holds
    ON booking.bookings (hold_expires_at)
    WHERE status = 'pending';

CREATE TABLE booking.booking_history (
    id UUID PRIMARY KEY,
    booking_id UUID NOT NULL REFERENCES booking.bookings (id),
    event VARCHAR(20) NOT NULL,
    from_status VARCHAR(16),
    to_status VARCHAR(16),
    actor_type VARCHAR(16) NOT NULL,
    actor_id UUID,
    reason VARCHAR(255),
    metadata JSONB,
    -- Append-only: no updated_at, by V3_DATABASE_BLUEPRINT.md §5's own
    -- exception for audit tables.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_booking_history_actor CHECK (actor_type IN ('customer', 'professional', 'system', 'admin'))
);

CREATE INDEX ix_booking_history_booking_id ON booking.booking_history (booking_id, id);

CREATE TABLE booking.idempotency_keys (
    id UUID PRIMARY KEY,
    scope VARCHAR(40) NOT NULL,
    owner_id UUID NOT NULL,
    key VARCHAR(128) NOT NULL,
    result_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scoped by owner deliberately: an idempotency key is a client-chosen
-- string, so a globally-unique key would let one customer's key collide
-- with another's -- and a collision here returns the OTHER customer's
-- booking id.
CREATE UNIQUE INDEX uq_booking_idempotency_keys
    ON booking.idempotency_keys (scope, owner_id, key);

CREATE TABLE booking.outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    event_version INT NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    published_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The relay's only query: unpublished rows in creation order. Partial so it
-- covers only the backlog, not every event ever emitted.
CREATE INDEX ix_booking_outbox_unpublished
    ON booking.outbox_events (id)
    WHERE published_at IS NULL;
