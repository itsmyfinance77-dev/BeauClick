-- V3.3 Story #107 (`#44a`): business classification and operating traits,
-- plus the active-owner uniqueness correction the same story owns.
--
-- Bound by `V33-DEC-030` D1/D3, `V33-DEC-032` R1-R8 and ADR-049 sections 1 and 2.
--
-- ## What this migration deliberately does NOT contain
--
-- No seed, no default, no backfill and no inferred row. `V33-DEC-032` R3/R4:
-- an unclassified business is a LEGAL state represented only by the ABSENCE of
-- a row, and every business that exists when this runs stays unclassified until
-- its own owner explicitly writes a classification. A backfill here would
-- invent an answer the owner never gave, and a wrong classification is worse
-- than an absent one.
--
-- No `UPDATE` of `business.businesses`. The story's acceptance criterion is
-- that its existing rows are byte-identical across this migration, and the
-- suite proves it by comparing `xmin` (the inserting transaction id, which any
-- row rewrite would change) before and after.
--
-- No `CONCURRENTLY`. `database/scripts/migrate.ts` wraps each file in an
-- explicit BEGIN/COMMIT, and PostgreSQL forbids CONCURRENTLY inside a
-- transaction. A plain DROP/CREATE pair is correct here and is what the
-- runner's own all-or-nothing guarantee requires.

-- ---------------------------------------------------------------------------
-- 1. The single current vertical
-- ---------------------------------------------------------------------------
--
-- `business_id` IS the "at most one vertical" invariant (`V33-DEC-032` R2):
-- it is the PRIMARY KEY, so a second row for one business is refused by the
-- database rather than by application code. There is deliberately NO surrogate
-- id, NO `is_primary` column, NO lifecycle, NO soft-delete column and NO
-- history mechanism -- each of them would only exist to permit rows the product
-- does not have. History belongs in `admin.admin_audit_log`, which is
-- append-only by GRANT rather than by convention.
--
-- The FK is same-schema and non-cascading (plain REFERENCES, i.e. NO ACTION),
-- matching `business.business_staff.business_id`. Business deletion is a
-- non-goal of this story, and a CASCADE would quietly define what deleting a
-- business means to a classification -- a decision nobody has taken.
CREATE TABLE business.business_verticals (
    business_id UUID PRIMARY KEY REFERENCES business.businesses (id),
    vertical VARCHAR(16) NOT NULL,
    CONSTRAINT ck_business_verticals_vocabulary CHECK (
        vertical IN ('salon', 'clinic', 'maison', 'retail', 'wholesale', 'academy')
    )
);

-- ---------------------------------------------------------------------------
-- 2. Operating traits -- an independent additive set on a separate axis
-- ---------------------------------------------------------------------------
--
-- `V33-DEC-030` D1 and `V33-DEC-032` R6: zero, one or both, keyed by
-- `(business_id, trait)`. The composite primary key is what makes the set a
-- set -- one row per trait, no duplicate, no ordering column, no surrogate id.
-- A salon that opens a second branch stays a salon and gains a trait; the trait
-- is never a seventh vertical.
CREATE TABLE business.business_traits (
    business_id UUID NOT NULL REFERENCES business.businesses (id),
    trait VARCHAR(16) NOT NULL,
    PRIMARY KEY (business_id, trait),
    CONSTRAINT ck_business_traits_vocabulary CHECK (trait IN ('multi_location', 'mobile'))
);

-- ---------------------------------------------------------------------------
-- 3. The active-owner uniqueness correction (ADR-049 section 2.3)
-- ---------------------------------------------------------------------------
--
-- `uq_businesses_owner_id` was UNCONDITIONAL while `BusinessService.create`
-- guards on `deletedAt IS NULL`, so a soft-deleted business would pass the
-- service check and then raise an uncaught 23505 -> 500. Latent only because
-- nothing writes `businesses.deleted_at` today; any business lifecycle work
-- makes it reachable.
--
-- **This index change is inseparable from two authorization fixes that land in
-- the same commit**: the moment the index becomes partial, one user can own a
-- soft-deleted row AND a live row, and `BusinessOwnerResolver` -- which reads
-- `StaffService.roleFor` -- would grant owner authority over both. So
-- `StaffService.roleFor` and `BusinessService.update` both gain the live-row
-- filter in the same change. Publishing this index without them would convert a
-- latent 500 into a live authorization defect.
--
-- The name is preserved so the story's own acceptance criterion reads as
-- written and so nothing that names the index has to be found and updated.
DROP INDEX business.uq_businesses_owner_id;

CREATE UNIQUE INDEX uq_businesses_owner_id
    ON business.businesses (owner_id)
    WHERE deleted_at IS NULL;
