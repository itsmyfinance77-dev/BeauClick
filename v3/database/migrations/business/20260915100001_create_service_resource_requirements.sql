-- V3.3 Story #131 (`#127b`): the service resource-requirement mapping.
--
-- Bound by `V33-DEC-035` R5/R6, ADR-049 section 6 (2026-09-10 amendment note),
-- and #131's own 2026-09-10 read-only readiness audit. ADR-049 is the pre-code
-- gate and is already Accepted; no ADR-050 exists or is authorized.
--
-- ## What this records, and what it deliberately does not
--
-- This mapping records that a professional's service NEEDS a resource of a
-- given kind -- a laser service needs a `device`, a haircut needs a `station`.
-- It does not record which physical resource is assigned to which booking:
-- `booking.booking_resource_assignments`, the collision exclusion constraint
-- and selection itself are `#110b` (#128), and the delivery-location context
-- eligibility resolution needs is `#127a` (#127). Nothing here touches
-- `booking.*` or `provider.*`.
--
-- ## `service_id` is OPAQUE, not a foreign key
--
-- `business` neither imports a `provider` ORM entity nor issues a
-- `provider.*` query (`V3_DATABASE_BLUEPRINT.md` §1, ADR-049 §6.2, §3.2's
-- opaque-id-through-a-port construction). Service existence and ownership are
-- proved by a `business`-declared, composition-root-implemented port on the
-- caller's transaction, exactly as `LOCATION_CITY_CATALOGUE` already is. There
-- is therefore no `REFERENCES provider.services` here, by convention rather
-- than oversight.
--
-- ## No lifecycle column, and no version history
--
-- `V33-DEC-035` R6 closes the cardinality at zero-or-one row per
-- `(business_id, service_id)` with no kind history. This story's own audit
-- (correction 1) rules out a version table. A requirement is therefore a
-- single mutable row: created on first configuration, updated in place on a
-- kind change, and DELETEd on removal -- there is no `retired` state to track
-- because deletion IS removal, unlike `business.location_resources` where a
-- retired resource must stay visible as catalogue history. The full history
-- of who changed what and when already lives in `admin.admin_audit_log`.
--
-- ## What this migration deliberately does NOT contain
--
-- No seed, no default row and no backfill: every service that exists today
-- gets zero requirement rows and remains fully bookable, unchanged. No
-- `booking` schema object of any kind -- `booking.availability_slots` and
-- `booking.bookings` are untouched, and their nullable `service_id` columns
-- keep meaning exactly what they mean today. No owner, actor or user column:
-- actor identity for every mutation lives in `admin.admin_audit_log` and
-- nowhere else, and a stored actor here would turn an organisational mapping
-- fact into a subject-shaped column under ADR-027's heuristic.

-- ---------------------------------------------------------------------------
-- The requirement mapping
-- ---------------------------------------------------------------------------
--
-- `business_id` carries an ordinary same-schema foreign key to
-- `business.businesses` -- both tables live in `business`, so this is not the
-- cross-schema case §6.2 forbids. Non-cascading (NO ACTION), matching every
-- other same-schema reference in this module: a business row is never
-- physically deleted (only soft-deleted via `deleted_at`), so there is no
-- ON DELETE case this constraint needs to handle.
--
-- The closed kind vocabulary is the SAME `room | device | station` #110a
-- already shipped in `business.location_resources` -- named separately here
-- (`ck_service_resource_requirements_kind`) because a shared CHECK across two
-- tables is not expressible in PostgreSQL, not because the vocabulary itself
-- is a second one.
--
-- `uq_service_resource_requirements_business_service` is the named uniqueness
-- rule `V33-DEC-035` R6 requires: a plain (non-partial) UNIQUE index is
-- sufficient because there is no lifecycle column splitting "live" from
-- "historical" rows -- a row's mere existence IS the live requirement.
CREATE TABLE business.service_resource_requirements (
    id UUID PRIMARY KEY,
    business_id UUID NOT NULL REFERENCES business.businesses (id),
    service_id UUID NOT NULL,
    required_kind VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_service_resource_requirements_kind CHECK (required_kind IN ('room', 'device', 'station')),
    CONSTRAINT uq_service_resource_requirements_business_service UNIQUE (business_id, service_id)
);

-- The eligible-candidate resolution query (#131's Booking-facing port) reads
-- by `service_id` alone -- the caller already knows its own business from the
-- slot's snapshotted context, but the requirement lookup is naturally keyed
-- on the service it is resolving. The composite unique index above already
-- covers `(business_id, service_id)`; this second index makes the
-- service-only lookup an index scan rather than a sequential one.
CREATE INDEX ix_service_resource_requirements_service_id ON business.service_resource_requirements (service_id);

COMMENT ON TABLE business.service_resource_requirements IS
    'V3.3 #131 (#127b). Business-owned, service-opaque mapping: at most one required room|device|station kind per (business, provider service). An organisational configuration fact -- it names no person and carries no identity column -- so it is ADR-027 retained. No cross-schema FK to provider.services by convention; ownership is proved through a composition-root port. Selection and assignment are #110b (#128) and appear nowhere here.';
