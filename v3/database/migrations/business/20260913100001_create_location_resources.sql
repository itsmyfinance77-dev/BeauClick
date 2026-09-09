-- V3.3 Story #110 (`#110a`): the location resource catalogue.
--
-- Bound by `V33-DEC-034` R2/R3/R7, `V33-DEC-030` D2 and ADR-049 sections 3 and 6
-- (whose 2026-09-09 amendment note records why `#44d` became three stories).
-- ADR-049 is the pre-code gate and is already Accepted; no ADR-050 exists or is
-- authorized.
--
-- ## What this migration deliberately does NOT contain
--
-- No seed, no default row, no backfill and no inferred resource. A location with
-- zero resource rows behaves exactly as it does today on every surface, so every
-- location that exists when this runs keeps zero resources until its own owner
-- creates one.
--
-- No `booking` schema object of any kind. `booking.booking_resource_assignments`,
-- the collision exclusion constraint and every booking transaction hook belong to
-- `#110b` (#128), and the delivery-location context they need belongs to `#110c`
-- (#127) -- which `V33-DEC-034` R8 leaves unauthorized in both column and table
-- form until its own readiness audit. Nothing here touches `booking.bookings`,
-- `booking.availability_slots` or `provider.services`.
--
-- No `UPDATE` of `business.locations`. Section 1 below adds a uniqueness target
-- that the table's data already satisfies, so PostgreSQL builds an index and
-- rewrites no row: every existing location keeps its `xmin` and every column
-- value byte-identical. The #110a real-PostgreSQL suite proves that with a
-- non-vacuity control that detects a genuine rewrite.
--
-- No `CONCURRENTLY`. `database/scripts/migrate.ts` wraps each file in an explicit
-- BEGIN/COMMIT and PostgreSQL forbids CONCURRENTLY inside a transaction.
--
-- No name uniqueness. `V33-DEC-034` and the #110a contract are explicit that two
-- similar names may be two real physical resources -- "Room 1" on the ground
-- floor and "Room 1" upstairs are not a data-entry error, and a unique index
-- here would refuse a legitimate catalogue. No binding decision requires one.
--
-- No owner, actor, user, staff, phone, customer, booking, occupancy, capacity,
-- price, availability or scheduling column. Actor identity for every mutation
-- lives in `admin.admin_audit_log` and nowhere else (ADR-049 sections 7.2-7.4),
-- and a stored actor here would additionally turn an organisational catalogue
-- fact into a subject-shaped row under ADR-027's column heuristic.

-- ---------------------------------------------------------------------------
-- 1. The composite uniqueness target on `business.locations`
-- ---------------------------------------------------------------------------
--
-- `business.locations.id` is already the primary key, so this adds a uniqueness
-- guarantee the database already had. It exists for exactly one reason: to be a
-- legal REFERENCES target for the composite foreign key in section 2, which is
-- what makes a cross-business resource **unwritable in PostgreSQL** rather than
-- merely refused by a service that could be called a second way.
--
-- The same construction #109 added to `business.business_staff`
-- (`uq_business_staff_id_business`), for the same reason and with the same
-- consequence: adding a UNIQUE constraint builds an index and validates existing
-- rows; it does not rewrite them. `xmin` is preserved on every existing row.
ALTER TABLE business.locations
    ADD CONSTRAINT uq_locations_id_business UNIQUE (id, business_id);

-- ---------------------------------------------------------------------------
-- 2. The resource catalogue
-- ---------------------------------------------------------------------------
--
-- ## A resource belongs to exactly one location
--
-- `V33-DEC-034` R7 and ADR-049 section 6.2. `business_id` is denormalised
-- alongside `location_id` for one purpose: the composite foreign key below
-- proves at the database layer that the resource and its location name the SAME
-- business. Without the denormalised column that check could only be application
-- code, and application code is not where an ownership invariant belongs.
--
-- Non-cascading (NO ACTION), like every other same-schema reference in this
-- module. `V33-DEC-034` and the #110a contract require deletion behaviour to be
-- conservative: a location's deletion must not erase resource history, so there
-- is deliberately no ON DELETE CASCADE. A location is closed, never deleted, and
-- section 3 refuses row deletion outright.
--
-- ## The closed kind vocabulary
--
-- `V33-DEC-034` R2: exactly `room | device | station`, closed by a named CHECK.
-- `station` covers chairs, beds, nail desks, styling positions and comparable
-- service stations -- one member that generalises, rather than a list that needs
-- a fourth entry the first time a salon buys different furniture. There is no
-- `owner`, `chair`, `bed`, `service`, `resource` or speculative member: a further
-- kind requires an explicit decision **tied to a real consumer**, which is the
-- rule `V33-DEC-033` R1 set for scoped roles and this card adopts.
--
-- ## The closed lifecycle, and `retired` is terminal
--
-- Exactly `active | retired`, closed by a named CHECK, `active` the initial
-- state. `retired` is TERMINAL: no restore or reactivate route, service method or
-- transition is authorized by `V33-DEC-034`, and a future restore capability
-- needs its own explicit decision. Section 3 enforces that terminality in
-- PostgreSQL rather than trusting the service to remember it.
--
-- `name` is bounded and its non-empty, whitespace-trimmed shape is enforced here
-- and not only by the DTO, exactly as `ck_locations_name_shape` does for #108:
-- the service trims before insert, and this constraint is the backstop that holds
-- for any write going around it.
CREATE TABLE business.location_resources (
    id UUID PRIMARY KEY,
    location_id UUID NOT NULL,
    business_id UUID NOT NULL,
    kind VARCHAR(16) NOT NULL,
    name VARCHAR(120) NOT NULL,
    lifecycle VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_location_resources_kind CHECK (kind IN ('room', 'device', 'station')),
    CONSTRAINT ck_location_resources_lifecycle CHECK (lifecycle IN ('active', 'retired')),
    CONSTRAINT ck_location_resources_name_shape
        CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),

    -- Same-business integrity, enforced by PostgreSQL rather than by application
    -- code: a resource whose location belongs to a different business than the
    -- resource names is UNWRITABLE.
    CONSTRAINT fk_location_resources_location_same_business
        FOREIGN KEY (location_id, business_id)
        REFERENCES business.locations (id, business_id)
);

-- The primary access path is "the resources of one location", which is both the
-- owner-facing collection read and the enumeration that resolves an opaque
-- `resourceRef` against the caller's own resources. Both filter by `location_id`.
CREATE INDEX ix_location_resources_location_id ON business.location_resources (location_id);

COMMENT ON TABLE business.location_resources IS
    'V3.3 #110 (#110a). The bookable-resource catalogue of a business.locations branch: a closed room|device|station kind vocabulary and an active|retired lifecycle in which retired is terminal. An organisational fact -- it names no person and carries no identity column -- so it is ADR-027 retained, exactly as business.locations is. Same-business integrity is a composite foreign key, not application code. Booking assignment and collision prevention are #110b (#128) and appear nowhere here.';

-- ---------------------------------------------------------------------------
-- 3. Terminal retirement and row preservation, enforced in PostgreSQL
-- ---------------------------------------------------------------------------
--
-- A CHECK constraint cannot compare NEW to OLD, so the rule needs a trigger --
-- the same shape `business.enforce_staff_role_grant_immutability` already uses
-- for #109, and the same `restrict_violation` error class.
--
-- Three properties:
--
--  1. `retired` is ONE-WAY. Nothing may move a retired resource back to `active`,
--     so the terminality `V33-DEC-034` ratified is a property of the database
--     rather than of the service remembering a rule. A retired resource also
--     cannot be renamed or re-kinded -- the row is the record that this resource
--     existed and was withdrawn.
--
--  2. `id`, `location_id`, `business_id` and `created_at` are immutable, so a
--     resource cannot be re-pointed at another location or business after the
--     fact -- which would otherwise be the second way past the composite foreign
--     key, since that key is only checked against the values actually written.
--
--  3. DELETE is refused outright. `V33-DEC-034` and the #110a contract require
--     that no catalogue row is physically deleted through the application and
--     that a location's lifecycle can never erase resource history.
--
-- TRUNCATE bypasses row triggers -- it is not an UPDATE or a DELETE, so no row
-- trigger fires. That is what the test harness reset needs and is NOT a hole in
-- the guarantee: the application role reaches this table only through the
-- service, and the suite that truncates it is the one proving the trigger
-- refuses every write that goes through it.
CREATE OR REPLACE FUNCTION business.enforce_location_resource_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'location_resources rows are never deleted: a retired resource is the record that it existed and was withdrawn'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'location_resources identity is immutable: a resource is never re-pointed at another location or business'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.lifecycle = 'retired' THEN
        RAISE EXCEPTION 'location_resources retirement is terminal: a retired resource is never restored, renamed or re-kinded'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_location_resources_lifecycle
    BEFORE UPDATE OR DELETE ON business.location_resources
    FOR EACH ROW
    EXECUTE FUNCTION business.enforce_location_resource_lifecycle();
