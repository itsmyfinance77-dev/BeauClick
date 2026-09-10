-- V3.3 Story #128 (`#110b`): booking resource assignment and collision prevention.
--
-- Bound by `V33-DEC-034` R4/R7, ADR-049 §6 (2026-09-09/2026-09-10 amendment
-- notes) and #128's own issue body. ADR-049 is the pre-code gate and is
-- already Accepted; no ADR-050 exists or is authorized.
--
-- ## The ONLY new table in `booking`
--
-- `booking.bookings` and `booking.availability_slots` are UNTOUCHED by this
-- migration -- no column added, no row rewritten. This is the collision-
-- prevention core ADR-049 §6.2 describes: "the only new table in the
-- `booking` schema is the assignment table that joins an opaque resource id
-- to a booking's time range."
--
-- ## `resource_id` is OPAQUE, exactly like `#127a`'s `delivery_location_id`
--
-- References `business.location_resources.id`. **No cross-schema foreign
-- key** (`V3_DATABASE_BLUEPRINT.md` §1, ADR-049 §6.2) and no `business` ORM
-- import anywhere in `booking`. The value arrives as a candidate id from
-- `#131`'s `ELIGIBLE_RESOURCE_DIRECTORY` port and is written here as an
-- opaque UUID, never joined against `business.*` in this schema.
--
-- ## ONE row per booking, mutated across its life -- not appended
--
-- `#131`'s own table has no lifecycle column because a row's existence IS
-- the live requirement; this table is different because a SINGLE booking's
-- resource can change (a reschedule to a different slot may need a
-- different resource, or none at all) while the booking itself stays one
-- row throughout its life (`booking.bookings` is never re-inserted on
-- reschedule -- see `booking.service.ts`'s own `reschedule()`, which UPDATEs
-- the existing row and record the change as a `booking_history` event
-- instead). This table follows the identical discipline: `UNIQUE
-- (booking_id)` is a PLAIN, non-partial index because there is genuinely at
-- most ONE assignment row per booking, ever -- a reschedule UPDATEs this
-- SAME row's `resource_id`/`start_at`/`end_at` rather than releasing one row
-- and inserting another, and a cancellation marks the row `released` rather
-- than deleting it. `status` is the minimal lifecycle marker that makes both
-- possible without falsifying history: `active` means currently occupying
-- the resource, `released` means it no longer does (cancelled, or
-- rescheduled away) but the row survives as the immutable record of what
-- WAS assigned. There is no `released_at`: `updated_at` already answers
-- "when did this last change," and a second timestamp column would carry no
-- fact `updated_at` does not.
--
-- ## What this migration deliberately does NOT contain
--
-- No seed, no default row and no backfill: every booking that exists today
-- gets no assignment row and remains exactly as valid as it is now
-- (`V33-DEC-034` R4 -- assignment is optional; no existing booking, service
-- or slot is invalidated). No `provider.services` change. No customer-facing
-- column of any kind -- the API never returns `resource_id`, and this table
-- is read only by the composition root and by this story's own service.

-- `btree_gist` is already installed (`ex_availability_slots_no_overlap`,
-- `20260820100001_create_booking_schema.sql`), so it is not re-declared here.

CREATE TABLE booking.booking_resource_assignments (
    id UUID PRIMARY KEY,
    booking_id UUID NOT NULL REFERENCES booking.bookings (id),
    resource_id UUID NOT NULL,
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_booking_resource_assignments_range CHECK (end_at > start_at),
    CONSTRAINT ck_booking_resource_assignments_status CHECK (status IN ('active', 'released'))
);

-- At most one assignment per booking, full stop -- see the class-level note
-- above on why this is plain rather than partial.
CREATE UNIQUE INDEX uq_booking_resource_assignments_booking
    ON booking.booking_resource_assignments (booking_id);

-- THE collision guarantee. Half-open `[)` bounds mirror
-- `ex_availability_slots_no_overlap` exactly, so an assignment ending at T
-- and one starting at T on the same resource do not conflict -- the same
-- adjacency rule the slot exclusion constraint already gives professionals.
--
-- Scoped `WHERE (status = 'active')`: a `released` row must not continue to
-- occupy the resource it no longer holds, or a cancelled/rescheduled-away
-- booking would permanently block its old resource and time -- the same
-- partial-constraint technique `uq_bookings_active_slot` already uses for
-- the identical reason on `booking.bookings.slot_id`.
ALTER TABLE booking.booking_resource_assignments
    ADD CONSTRAINT ex_booking_resource_no_overlap
    EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(start_at, end_at, '[)') WITH &&
    ) WHERE (status = 'active');

-- Supports the closure/retirement blocking check (`#128`'s
-- `RESOURCE_ASSIGNMENT_DIRECTORY` port): "does this resource have any
-- still-relevant assignment" filters on `resource_id` and `end_at`.
CREATE INDEX ix_booking_resource_assignments_resource_end
    ON booking.booking_resource_assignments (resource_id, end_at)
    WHERE status = 'active';

COMMENT ON TABLE booking.booking_resource_assignments IS
    'V3.3 #128 (#110b). The only booking-schema table this story adds: joins an opaque business.location_resources.id to one booking''s time range, at most one row per booking, with a GiST exclusion constraint over (resource, time range) among active rows preventing any two bookings from occupying the same resource at overlapping times. No cross-schema FK to business by convention; resource ids cross the module boundary as opaque UUIDs through #131''s ELIGIBLE_RESOURCE_DIRECTORY port. ADR-027 subject_data -- pinned by an explicit test, since the coverage heuristic recognises none of this table''s columns.';
