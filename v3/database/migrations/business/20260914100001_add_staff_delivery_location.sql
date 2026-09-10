-- V3.3 Story #127 (`#127a`): the delivery-location context, business half.
--
-- Bound by `V33-DEC-035` R2/R4 and ADR-049 §§3, 4 and 6 (whose 2026-09-10
-- amendment note records why `#110c` became two stories). ADR-049 is the
-- pre-code gate and is already Accepted; no ADR-050 exists or is authorized.
--
-- ## Why the authority is the membership and not something new
--
-- `V33-DEC-035` R2. A slot can be created only by the professional whose session
-- it is, and locations are owner-only -- two authorities that do not otherwise
-- intersect. The consented `business_staff` row is the one object both already
-- touch: the owner creates and manages it, and it names exactly the professional
-- whose calendar the slots belong to. Putting the branch on that row therefore
-- needs no new relationship, no new role, and no new consent step.
--
-- **Business ownership alone binds nothing.** A user who owns a business AND owns
-- a professional profile still has no delivery location unless an ACTIVE
-- `business_staff` membership carries one. That is deliberate: guessing a branch
-- from ownership is exactly the first-row selection this story exists to avoid.
--
-- ## What this migration deliberately does NOT contain
--
-- No backfill, no default and no inferred location. Every existing membership
-- keeps `location_id IS NULL` and behaves exactly as it does today, which is also
-- the state a standalone professional stays in for ever.
--
-- No second location column, no join table and no ordering column. One membership
-- carries **at most one** location, and a practitioner working at several
-- branches of one business in the same period is **not representable** here --
-- an explicit MVP limitation with its own future decision (`V33-DEC-035` R4),
-- never an accidental query-order rule. Replacing this column with a future
-- assignment table must not require rewriting one historical slot, which is why
-- the slot's snapshot (the booking-half migration) is independent of this column.
--
-- No role, capability or grant. A location assignment says WHERE someone works,
-- never WHAT they may do: `SCOPED_STAFF_ROLES` is untouched and no capability is
-- minted (`V33-DEC-035` R2).

-- ---------------------------------------------------------------------------
-- The branch a consented membership works at
-- ---------------------------------------------------------------------------
--
-- Nullable, because it must be: a standalone professional has no business, an
-- affiliated professional may have no assigned branch, and every row that exists
-- when this runs has neither.
--
-- `ADD COLUMN ... NULL` with no default is metadata-only in PostgreSQL 11+, so no
-- existing row is rewritten and every `xmin` is preserved. The #127a
-- real-PostgreSQL suite proves that rather than assuming it, with a non-vacuity
-- control that detects a genuine rewrite.
ALTER TABLE business.business_staff
    ADD COLUMN location_id UUID;

-- Same-business integrity, enforced by PostgreSQL rather than by application
-- code: a membership of business A cannot be pointed at a location of business B.
-- The composite target is `uq_locations_id_business`, which #110a added for
-- exactly this construction, and which #109 added to `business_staff` itself
-- before that.
--
-- Non-cascading (NO ACTION), like every other same-schema reference in this
-- module. A location is closed, never deleted, so there is no cascade to define;
-- and a cascade here would silently unbind staff as a side effect of an
-- administrative lifecycle change, which is the class of thing ADR-049 §6.6
-- refuses.
ALTER TABLE business.business_staff
    ADD CONSTRAINT fk_business_staff_location_same_business
    FOREIGN KEY (location_id, business_id)
    REFERENCES business.locations (id, business_id);

-- The access path is "which membership works at this branch", used when a
-- location's lifecycle is examined. Partial, because the overwhelming majority of
-- memberships carry no location and an index entry for each would be dead weight.
CREATE INDEX ix_business_staff_location_id
    ON business.business_staff (location_id)
    WHERE location_id IS NOT NULL;

COMMENT ON COLUMN business.business_staff.location_id IS
    'V3.3 #127 (#127a). The business.locations branch this consented membership works at, or NULL. Owner-managed only; never writable by the professional, a staff member or a practitioner_chat holder. Same-business integrity is a composite foreign key, not application code. It confers no role and no capability. At most one location per membership: a simultaneously multi-branch practitioner is not representable and is a named future decision (V33-DEC-035 R4).';
