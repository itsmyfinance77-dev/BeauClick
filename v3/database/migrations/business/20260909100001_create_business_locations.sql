-- V3.3 Story #108 (`#44b`): organisation locations.
--
-- Bound by `V33-DEC-030` D2/D3 and ADR-049 section 3 (and sections 7.1-7.6 for
-- the privacy, audit and failure contracts). ADR-049 is the pre-code gate and is
-- already Accepted; this migration writes only what section 3 obliges.
--
-- ## What this migration deliberately does NOT contain
--
-- No seed, no default row, no backfill and no inferred location. A business with
-- zero location rows must behave exactly as it does today on every surface
-- (ADR-049 section 3.5, and the rollout-boundary paragraph), so every business
-- that exists when this runs keeps zero locations until its own owner creates
-- one.
--
-- No `UPDATE` of `business.businesses`, and no change to `business.businesses.city_id`
-- beyond an accurate deprecation COMMENT. ADR-049 section 3.3: "Neither this ADR
-- nor #107 drops, renames, reinterprets, migrates or rewrites that column. #108
-- records the deprecation in the schema comment and in its contract; the column,
-- its constraints and every value in it are preserved byte-identical." The #108
-- real-PostgreSQL suite proves that by comparing `xmin` before and after.
--
-- No `CONCURRENTLY`. `database/scripts/migrate.ts` wraps each file in an explicit
-- BEGIN/COMMIT and PostgreSQL forbids CONCURRENTLY inside a transaction. A plain
-- CREATE is correct here and is what the runner's all-or-nothing guarantee
-- requires.
--
-- No cross-schema foreign key on `city_id`. `V3_DATABASE_BLUEPRINT.md` section 1
-- forbids cross-schema FKs by convention, and ADR-049 section 3.2 requires the
-- city to cross the module boundary as an opaque UUID through a port -- `business`
-- imports no `provider` ORM entity and issues no `provider.*` query. The id is
-- validated at write time by a narrow business-owned catalogue port bound in the
-- composition root, on the caller's own transaction.

-- ---------------------------------------------------------------------------
-- 1. The location child rows
-- ---------------------------------------------------------------------------
--
-- A location is a child of exactly one organisation and carries its own name,
-- its own opaque city reference and its own lifecycle (ADR-049 section 3.1).
--
-- `business_id` is a same-schema, non-cascading FK (plain REFERENCES, i.e. NO
-- ACTION), matching `business.business_staff.business_id` and
-- `business.business_verticals.business_id`. Business deletion is a non-goal of
-- this story, and a CASCADE would quietly define what deleting a business means
-- to its locations -- a decision nobody has taken.
--
-- `name` is bounded and its non-empty, whitespace-trimmed shape is enforced in
-- PostgreSQL, not only by the DTO: `name = btrim(name)` rejects any leading or
-- trailing whitespace and `char_length(name) BETWEEN 1 AND 120` rejects an empty
-- or over-long name. The service trims before insert; this constraint is the
-- backstop that holds even for a write that goes around it.
--
-- `lifecycle` is the closed vocabulary `active | suspended | closed`, enforced by
-- a named CHECK, with `active` the initial state. The vocabulary gains no fourth
-- member without a register decision. There is deliberately NO soft-delete
-- column, NO public flag, NO address, coordinate, province, district, phone,
-- resource, service, availability, staff-grant or owner/user id column -- each is
-- a non-goal of #108 named in ADR-049 sections 3 and 7, and #110/#109 own the
-- ones that are real.
CREATE TABLE business.locations (
    id UUID PRIMARY KEY,
    business_id UUID NOT NULL REFERENCES business.businesses (id),
    name VARCHAR(120) NOT NULL,
    -- References provider.locations_cities.id. Opaque here: no cross-schema FK
    -- (V3_DATABASE_BLUEPRINT.md section 1) and no provider ORM import
    -- (ADR-049 section 3.2). Availability is checked at write time through the
    -- business-owned city-catalogue port.
    city_id UUID NOT NULL,
    lifecycle VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_locations_name_shape CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
    CONSTRAINT ck_locations_lifecycle CHECK (lifecycle IN ('active', 'suspended', 'closed'))
);

-- The primary access path is "the locations of one business" -- the collection
-- read, and the enumeration that resolves an opaque `locationRef` against the
-- caller's live-owned locations. Both filter by `business_id`.
CREATE INDEX ix_locations_business_id ON business.locations (business_id);

COMMENT ON TABLE business.locations IS
    'V3.3 #108 (#44b). Named branches of a business.businesses organisation, each with its own opaque city reference and an active|suspended|closed lifecycle. An organisational fact: it names no person and carries no identity column. Owner-only mutation, resolved from live business.businesses.owner_id.';

-- ---------------------------------------------------------------------------
-- 2. `business.businesses.city_id` -- deprecation recorded, value untouched
-- ---------------------------------------------------------------------------
--
-- ADR-049 section 3.3 and `V33-DEC-030` D2. Once child locations exist, a
-- location carries its own city and nothing may keep reading `businesses.city_id`
-- as the place a service is delivered. This story records that in the schema
-- comment and the contract; it does not drop, rename, reinterpret, migrate or
-- rewrite the column, and it changes none of its values. A later migration owes
-- a compatibility story and an explicit backfill definition before removal may
-- even be proposed.
COMMENT ON COLUMN business.businesses.city_id IS
    'DEPRECATED as a service-delivery location by V3.3 #108 (V33-DEC-030 D2, ADR-049 section 3.3). Service-delivery place now lives on business.locations.city_id per child location. This column, its constraints and every value are preserved byte-identical; it is NOT the source any surface may read for where a service is delivered. Removal requires a later migration with its own compatibility story and explicit backfill definition. No value is backfilled from it into business.locations.';
