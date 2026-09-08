-- V3.3 Story #109 (`#44c`): scoped staff roles and permissions.
--
-- Bound by `V33-DEC-030` D5, `V33-DEC-033` R1-R5, `V33-DEC-020` Ruling 1,
-- `V33-DEC-021` Ruling 6, and ADR-049 section 4 (which the `V33-DEC-033`
-- amendment note in that section makes discoverable).
--
-- ## What this migration deliberately does NOT contain
--
-- No seed, no default row, no backfill and no `UPDATE` of any existing row.
-- `business.business_staff` must come out of this migration byte-identical --
-- adding a CHECK constraint validates the existing rows with a scan but does not
-- rewrite them, so every row keeps its `xmin`, and the #109 real-PostgreSQL
-- suite proves that with a non-vacuity control.
--
-- No change to `business_staff.role`. `V33-DEC-033` R5 and ADR-049 section 4.1:
-- new authority is a scoped GRANT, never a wider role string, because a wider
-- string loses the scope dimension entirely and detaches authority from consent.
--
-- No `CONCURRENTLY`. `database/scripts/migrate.ts` wraps each file in an explicit
-- BEGIN/COMMIT and PostgreSQL forbids CONCURRENTLY inside a transaction.
--
-- No `owner` anywhere. The owner is `business.businesses.owner_id`, derived on
-- every request, and is never a membership role, a vocabulary member or a grant
-- row (ADR-023; `V33-DEC-021` Ruling 13; `V33-DEC-033` R1).

-- ---------------------------------------------------------------------------
-- 1. The `business_staff.status` vocabulary defect
-- ---------------------------------------------------------------------------
--
-- ADR-049 section 4.8 and `V33-DEC-033` R5. Three sources disagreed:
-- `BUSINESS_STAFF_STATUSES` was `['invited','active','inactive','declined']`,
-- this column carried NO CHECK constraint, and
-- `BusinessSubjectDataContract.eraseSubjectData` has always written
-- `status = 'removed'` -- a value neither the type system nor the database knew.
--
-- The vocabulary is reconciled to include `removed`, and the missing CHECK is
-- added over exactly that vocabulary. Every existing row already holds a member
-- of this set, so the validation scan passes without touching a single row.
--
-- The legal transitions this vocabulary admits are unchanged by this story and
-- are stated here so they are not rediscovered:
--
--   (none)   -> invited    an owner or inviting manager creates the row
--   invited  -> active     ONLY the invitee's own authenticated session
--   invited  -> declined   ONLY the invitee's own authenticated session
--   invited  -> inactive   owner removal, or the member leaving
--   active   -> inactive   owner removal, or the member leaving
--   any      -> removed    privacy erasure only; TERMINAL
--
-- No reactivation path exists and none is introduced. `removed` is terminal.
-- A scoped grant is usable only while the membership is `active` (enforced by
-- the authorizer's live re-check, because status is mutable and no foreign key
-- can express it).
ALTER TABLE business.business_staff
    ADD CONSTRAINT ck_business_staff_status
    CHECK (status IN ('invited', 'active', 'inactive', 'declined', 'removed'));

-- The composite target the grant table's same-business foreign key needs.
-- `id` is already the primary key, so this adds a uniqueness guarantee the
-- database already had and changes no existing membership semantics; it exists
-- purely so `(membership_id, business_id)` can be a real REFERENCES target.
ALTER TABLE business.business_staff
    ADD CONSTRAINT uq_business_staff_id_business UNIQUE (id, business_id);

-- ---------------------------------------------------------------------------
-- 2. The scoped grant store
-- ---------------------------------------------------------------------------
--
-- ## Anchored on the membership, never on a user id
--
-- ADR-049 section 4.2. Anchoring on `business_staff.id` is what keeps consent
-- STRUCTURAL: a row starts `invited` and only the invitee's own session may move
-- it to `active`, so a grant cannot exist for someone who never accepted.
-- Anchoring on a user id would quietly restore the hazard ADR-023 closed.
--
-- ## Exactly one role, and it is business-scoped
--
-- `V33-DEC-033` R1: the vocabulary is exactly `practitioner_chat`, closed by a
-- named CHECK. R2: that role is PRACTITIONER-SPECIFIC, but the persisted grant
-- stays BUSINESS-SCOPED -- practitioner identity is a property of the
-- consent-bearing membership this row is already anchored on, not a second scope
-- axis. There is deliberately no owner, user, phone, professional or location
-- scope column here. Location scoping stays deferred because a location owns no
-- bookings.
--
-- ## Immutable facts plus one-way revocation
--
-- A grant is never edited. A revoke stamps the revocation columns; a re-grant
-- inserts a new row. The full table is the history and `revoked_at IS NULL` is
-- the live set, which is why the uniqueness below is partial.
CREATE TABLE business.staff_role_grants (
    id UUID PRIMARY KEY,
    membership_id UUID NOT NULL,
    -- Denormalised so the composite foreign key below can prove that the
    -- membership and the grant name the SAME business at the database layer.
    business_id UUID NOT NULL,
    role VARCHAR(24) NOT NULL,
    -- The live owner who granted. `*_user_id` on purpose: ADR-027's coverage
    -- cross-check recognises that suffix, so a future `no_subject_data` claim on
    -- this table would be refused at boot rather than by someone noticing.
    granted_by_user_id UUID NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Null while live. Set by the owner on revoke, and left NULL by privacy
    -- erasure, which revokes without a human actor.
    revoked_by_user_id UUID NULL,
    revoked_at TIMESTAMPTZ NULL,

    CONSTRAINT ck_staff_role_grants_role CHECK (role IN ('practitioner_chat')),
    -- A revoking actor implies a revocation instant. The reverse is deliberately
    -- permitted: privacy erasure revokes with `revoked_at` set and no actor.
    CONSTRAINT ck_staff_role_grants_revocation CHECK (revoked_by_user_id IS NULL OR revoked_at IS NOT NULL),
    -- Same-business integrity, enforced by PostgreSQL rather than by application
    -- code: a grant whose membership belongs to a different business than the
    -- grant names is UNWRITABLE, not merely refused by a service that could be
    -- called a second way. Non-cascading (NO ACTION) like every other
    -- same-schema reference in this module.
    CONSTRAINT fk_staff_role_grants_membership_same_business
        FOREIGN KEY (membership_id, business_id)
        REFERENCES business.business_staff (id, business_id)
);

-- At most ONE LIVE grant per (membership, role, business). A revoked row does
-- not occupy the slot, so revoke-then-re-grant is ordinary and history is kept.
-- Partial uniqueness is a real-PostgreSQL property: pg-mem does not honour it,
-- so the concurrency proof lives in the #109 real-PG suite (ADR-049 section 2.4).
CREATE UNIQUE INDEX uq_staff_role_grants_live
    ON business.staff_role_grants (membership_id, role, business_id)
    WHERE revoked_at IS NULL;

-- The authorizer's hot path: "does this membership hold a live grant?" -- one
-- indexed probe, never a scan and never a per-conversation lookup.
CREATE INDEX ix_staff_role_grants_live_membership
    ON business.staff_role_grants (membership_id)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE business.staff_role_grants IS
    'V3.3 #109 (#44c). Scoped staff authority, anchored on a consented business_staff membership. Exactly one role vocabulary member (practitioner_chat), business-scoped; practitioner identity is derived from the membership, not stored here. Immutable facts plus one-way revocation; at most one live grant per (membership, role, business). ADR-027 subject_data.';

-- ---------------------------------------------------------------------------
-- 3. Immutability and one-way revocation, enforced in PostgreSQL
-- ---------------------------------------------------------------------------
--
-- `V33-DEC-033` R5: "immutable grant rows plus revocation". A CHECK constraint
-- cannot compare NEW to OLD, so the rule needs a trigger -- the same shape
-- `commercial.enforce_subscription_immutability` already uses, and the same
-- `restrict_violation` error class.
--
-- Two properties, and the second is the one that matters for authorization:
--
--  1. nothing but the two revocation columns may ever change, so a grant cannot
--     be re-pointed at another membership, business or role after the fact;
--  2. revocation is ONE-WAY. An already-revoked grant can never be revived --
--     which is also the second way somebody could get past `uq_staff_role_grants_live`.
--
-- DELETE is refused outright: the revoked row IS the record that the authority
-- once existed and then ended. TRUNCATE bypasses row triggers, which is what the
-- test harness reset needs and is not a hole -- the application role reaches this
-- table only through the service.
CREATE OR REPLACE FUNCTION business.enforce_staff_role_grant_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'staff_role_grants rows are never deleted: a revoked grant is the record that the authority existed and ended'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.role IS DISTINCT FROM OLD.role
       OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
       OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
        RAISE EXCEPTION 'staff_role_grants facts are immutable: re-granting is a new row, never an edit'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'staff_role_grants revocation is one-way: a revoked grant is never revived'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_staff_role_grants_immutable
    BEFORE UPDATE OR DELETE ON business.staff_role_grants
    FOR EACH ROW
    EXECUTE FUNCTION business.enforce_staff_role_grant_immutability();
