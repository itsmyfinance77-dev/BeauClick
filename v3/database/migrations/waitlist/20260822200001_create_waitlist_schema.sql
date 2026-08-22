-- Phase 4: the Waitlist domain (ADR-024). GAP-26's invariant carries over
-- unchanged from V2: an offer never reserves the slot -- there is no column
-- here that holds a lock on `booking.availability_slots`, and nothing in
-- this schema is read by booking-service's own atomic claim.

CREATE SCHEMA IF NOT EXISTS waitlist;

CREATE TABLE waitlist.entries (
    id UUID PRIMARY KEY,
    customer_id UUID NOT NULL, -- references identity.users.id; no cross-schema FK by convention
    professional_id UUID NOT NULL, -- references provider.professionals.id; no cross-schema FK by convention
    service_id UUID, -- null = any service this professional offers
    status VARCHAR(20) NOT NULL DEFAULT 'waiting',
    offered_slot_id UUID, -- references booking.availability_slots.id; no cross-schema FK by convention
    offered_at TIMESTAMPTZ,
    offer_expires_at TIMESTAMPTZ,
    resulting_booking_id UUID, -- references booking.bookings.id; no cross-schema FK by convention
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One ACTIVE join per (customer, professional, service). NULLS are made
-- comparable with a sentinel via COALESCE -- a plain composite unique index
-- would let a customer join the "any service" (service_id IS NULL)
-- waitlist twice, since PostgreSQL treats NULL as distinct from NULL.
CREATE UNIQUE INDEX uq_waitlist_active_entry
    ON waitlist.entries (customer_id, professional_id, COALESCE(service_id, '00000000-0000-0000-0000-000000000000'))
    WHERE status IN ('waiting', 'offered');

-- At most one ACTIVE offer per slot -- WaitlistService.offerNextFor()'s real
-- backstop behind its own pre-check, the same two-layer discipline
-- BookingService.claimSlot() uses.
CREATE UNIQUE INDEX uq_waitlist_active_offer_slot
    ON waitlist.entries (offered_slot_id)
    WHERE status = 'offered';

CREATE INDEX ix_waitlist_professional_queue ON waitlist.entries (professional_id, created_at) WHERE status IN ('waiting', 'offered');
CREATE INDEX ix_waitlist_offer_expiry ON waitlist.entries (offer_expires_at) WHERE status = 'offered';
CREATE INDEX ix_waitlist_customer_id ON waitlist.entries (customer_id);

CREATE TABLE waitlist.outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    correlation_id UUID,
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_waitlist_outbox_unpublished ON waitlist.outbox_events (id) WHERE published_at IS NULL;
CREATE INDEX ix_waitlist_outbox_correlation_id ON waitlist.outbox_events (correlation_id);
