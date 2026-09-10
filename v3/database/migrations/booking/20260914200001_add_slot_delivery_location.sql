-- V3.3 Story #127 (`#127a`): the delivery-location context, booking half.
--
-- Bound by `V33-DEC-035` R3 and ADR-049 §6 (2026-09-10 amendment note). This is
-- the FIRST change this family makes to the `booking` schema, and it is
-- deliberately one nullable column and one trigger.
--
-- ## An opaque snapshot, not a foreign key
--
-- `delivery_location_id` holds a `business.locations.id`, and `booking` neither
-- imports a `business` ORM entity nor issues a `business.*` query: there is **no
-- cross-schema foreign key** (`V3_DATABASE_BLUEPRINT.md` §1, ADR-049 §6.2). The
-- value arrives through a `booking`-declared port implemented in the composition
-- root, exactly as `PROFESSIONAL_DIRECTORY` already does for the professional's
-- owning user.
--
-- ## Why a SNAPSHOT and not a live lookup
--
-- `V33-DEC-035` R3, and the reason the audit refused dynamic re-resolution: an
-- owner rebinding a practitioner to another branch would otherwise silently
-- change the meaning of every slot ever created, including appointments a
-- customer already holds. Writing the branch once, at slot creation, makes a
-- rebinding affect **future slots only**. It is the same discipline
-- `booking.bookings` already applies to `slot_start`/`slot_end`, and the same one
-- `commerce.orders` applies to its seller party.
--
-- ## What this migration deliberately does NOT contain
--
-- No backfill, no default and no inferred location: every existing slot keeps
-- NULL and behaves exactly as it does today, which is also what a standalone
-- professional's slots keep for ever. `ADD COLUMN ... NULL` with no default is
-- metadata-only in PostgreSQL 11+, so no row is rewritten and every `xmin`
-- survives -- proved by the #127a suite with a non-vacuity control.
--
-- No resource column, no assignment table and no exclusion constraint. Those are
-- `#110b` (#128), and the required-kind mapping they need is `#127b` (#131).
-- Nothing here touches `booking.bookings`, whose schema and rows are unchanged.

ALTER TABLE booking.availability_slots
    ADD COLUMN delivery_location_id UUID;

COMMENT ON COLUMN booking.availability_slots.delivery_location_id IS
    'V3.3 #127 (#127a). An OPAQUE business.locations.id snapshotted when the slot was created, or NULL. No cross-schema FK by convention and no business ORM import in booking: the value arrives through a booking-declared port. Immutable once the slot leaves `open` (tg_availability_slots_delivery_location_frozen). Never accepted from a DTO and never returned on a professional or customer response.';

-- ---------------------------------------------------------------------------
-- The snapshot is frozen once the slot leaves `open`
-- ---------------------------------------------------------------------------
--
-- A CHECK constraint cannot compare NEW to OLD, so the rule needs a trigger --
-- the same shape `business.enforce_location_resource_lifecycle` (#110a) and
-- `business.enforce_staff_role_grant_immutability` (#109) already use, and the
-- same `restrict_violation` error class.
--
-- Two properties, and the second is the one that closes the loophole:
--
--  1. a **held or booked** slot's snapshot cannot change. Once a customer holds
--     the appointment, where it happens is settled;
--  2. a statement that moves the status away from `open` **and** changes the
--     snapshot **in the same UPDATE** is refused. Without this, the freeze could
--     be stepped over in one statement -- claim and relocate together -- and the
--     row would look as though it had always been at the new branch.
--
-- What stays legal, deliberately: `open -> held` and `open -> booked` with the
-- snapshot unchanged (the claim path), and `held -> open` on release, expiry or
-- cancellation with the snapshot unchanged. Release must not rewrite the
-- snapshot, and it does not need to -- the slot returns to the pool at the branch
-- it was always published for.
--
-- A reschedule moves the booking to a DIFFERENT slot and re-snapshots from that
-- slot; it never carries the old context forward, so it needs no exemption here.
CREATE OR REPLACE FUNCTION booking.enforce_slot_delivery_location_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.delivery_location_id IS DISTINCT FROM OLD.delivery_location_id
       AND (OLD.status <> 'open' OR NEW.status <> 'open') THEN
        RAISE EXCEPTION 'availability_slots.delivery_location_id is frozen once the slot leaves open: an appointment never silently changes branch'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_availability_slots_delivery_location_frozen
    BEFORE UPDATE ON booking.availability_slots
    FOR EACH ROW
    EXECUTE FUNCTION booking.enforce_slot_delivery_location_freeze();
