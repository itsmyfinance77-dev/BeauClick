-- ---------------------------------------------------------------------------
-- V3.3 Story #104 (`#41d-2a`) — the seller collection-policy assignment
-- (ADR-048 R2 and R5, `V33-DEC-029` Ruling 5, `V33-DEC-031` R1).
--
-- One table. It records which published collection policy a seller party has
-- chosen, as immutable history with exactly one CURRENT row per party.
--
-- ## Assignment presence IS enrollment (ADR-048 R2)
--
-- There is no `enrolled` column, no lifecycle state, no boolean and no
-- un-enrollment flag anywhere below, and that is the design rather than an
-- omission:
--
--   * no current row  -> the party is UNENROLLED and keeps the legacy path;
--   * one current row -> the party is ENROLLED; #115 must resolve its key or
--                        fail closed;
--   * superseded rows -> immutable history.
--
-- A separate marker would immediately admit "enrolled with no assignment",
-- which `V33-DEC-029` Ruling 8 gives no behaviour for. Presence is also the
-- only thing that distinguishes an enrolled party whose key currently has no
-- resolvable active version — which must FAIL CLOSED — from a party that was
-- never enrolled, which must not.
--
-- There is likewise **no DELETE path**. Removing a row would return an enrolled
-- party to the legacy full-online path, which is the post-lookup fallback
-- `V33-DEC-029` Ruling 8 forbids wearing a different name. The trigger below
-- refuses DELETE outright.
--
-- ## What this migration deliberately does NOT do
--
-- **It creates zero assignments.** No backfill, no seed, no default policy, no
-- fallback key. Every seller party is unenrolled the moment this lands, and the
-- platform's behaviour is therefore unchanged.
--
-- **It touches no `commerce` table.** Order resolution, the schedule snapshot
-- and the `ck_ops_policy_reference` replacement are #115 (`#41d-2b`).
--
-- **It records no commercial value.** No mode, percentage, amount, bound, base
-- or rounding rule appears here; the row names a stable POLICY KEY and nothing
-- about what that policy says.
--
-- ## Column naming is a privacy control
--
-- ADR-027's coverage check recognises the `_user_id` suffix. Both actor columns
-- are therefore `*_by_user_id`, and the table is claimed `retained` — never
-- `no_subject_data` — in `collection-policy-assignment-subject-data.contract.ts`.
--
-- There is deliberately **no `*_by_label` companion**. Every assignment and
-- every supersession is initiated by an authenticated seller inside a request;
-- no migration, scheduler or system actor can reach this table. A permanently
-- NULL identity column paired with a fictional system actor would be a lie the
-- CHECK would then have to protect.
-- ---------------------------------------------------------------------------

CREATE TABLE commercial.seller_collection_policy_assignments (
    id UUID PRIMARY KEY,

    /*
     * WHICH SELLER PARTY. Snapshotted at creation and immutable: the trigger
     * below refuses a change, so an assignment can never be re-pointed at
     * another party by an UPDATE.
     *
     * No foreign key to `provider.professionals` or `business.businesses` —
     * the repository's cross-schema convention (V3_DATABASE_BLUEPRINT.md §1),
     * and here it also stops another domain's row lifecycle cascading away
     * governed commercial history.
     */
    seller_party_type VARCHAR(16) NOT NULL,
    seller_party_id UUID NOT NULL,

    /*
     * The STABLE KEY, never an exact version (`V33-DEC-029` Ruling 6).
     *
     * Binding the key is what lets an administrator republish forward without
     * migrating a single assignment, while #115 resolves whichever version of
     * that key is active at the database clock instant of each order.
     *
     * A same-domain FK is correct and expected here: both tables live in
     * `commercial`, and a key that vanished under an assignment would leave a
     * row naming nothing.
     */
    policy_key VARCHAR(64) NOT NULL
        REFERENCES commercial.booking_collection_policies (policy_key),

    /*
     * WHEN and WHO. `now()` is the database's, not an application host's: an
     * assignment's instant must not depend on which container served the
     * request.
     */
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by_user_id UUID NOT NULL,

    /*
     * TERMINAL SUPERSESSION FACTS. All three NULL while the row is current, all
     * three present the moment it is superseded — `ck_scpa_supersession_pairing`
     * makes the halfway state unwritable, so "is this current?" has exactly one
     * answer and it is a property of the row rather than of a flag.
     *
     * `superseded_by_assignment_id` is DEFERRABLE INITIALLY DEFERRED, and that
     * is load-bearing rather than decorative — the same reasoning
     * `commercial.seller_subscriptions.superseded_by_id` records. A supersession
     * must satisfy two rules that pull against each other: the pairing CHECK
     * requires the successor's id on the superseded row, and
     * `uq_scpa_one_current_per_party` forbids the successor existing while the
     * predecessor is still current. Neither row can be written first under an
     * immediate constraint.
     *
     * Deferring this one reference resolves it: the predecessor is superseded
     * naming an id that does not exist yet, the successor is inserted with that
     * id, and the reference is checked at COMMIT — by which point both rows
     * exist and the party has exactly one current assignment. A transaction
     * that fails between the two leaves nothing, because the check never
     * passes.
     */
    superseded_at TIMESTAMPTZ,
    superseded_by_user_id UUID,
    superseded_by_assignment_id UUID
        REFERENCES commercial.seller_collection_policy_assignments (id)
        DEFERRABLE INITIALLY DEFERRED,

    CONSTRAINT ck_scpa_party_type
        CHECK (seller_party_type IN ('professional', 'business')),

    /*
     * The three terminal facts arrive together or not at all. Without this a
     * row could carry a supersession instant with no successor, and history
     * would have a hole in it that nothing could later repair.
     */
    CONSTRAINT ck_scpa_supersession_pairing CHECK (
        (superseded_at IS NULL
            AND superseded_by_user_id IS NULL
            AND superseded_by_assignment_id IS NULL)
        OR (superseded_at IS NOT NULL
            AND superseded_by_user_id IS NOT NULL
            AND superseded_by_assignment_id IS NOT NULL)
    ),

    /* Supersession cannot precede the assignment it ends. */
    CONSTRAINT ck_scpa_supersession_forward
        CHECK (superseded_at IS NULL OR superseded_at >= assigned_at),

    /* A row cannot supersede itself: that would be a cycle of length one. */
    CONSTRAINT ck_scpa_not_self_superseding
        CHECK (superseded_by_assignment_id IS NULL OR superseded_by_assignment_id <> id)
);

/*
 * THE INVARIANT. At most one CURRENT assignment per seller party.
 *
 * A partial unique index rather than a service check, because the failure it
 * prevents is a race: two concurrent first assignments both find no current
 * row, both insert, and the party ends up with two. Check-then-insert cannot
 * fix that at any isolation level below serializable. This can, at READ
 * COMMITTED, with no retry loop — the same reasoning
 * `uq_seller_subscriptions_one_active_per_party` records.
 *
 * "Current" is `superseded_at IS NULL`, not a lifecycle value: presence is the
 * enrollment fact (ADR-048 R2). Superseded rows are excluded, so history
 * accumulates freely.
 */
CREATE UNIQUE INDEX uq_scpa_one_current_per_party
    ON commercial.seller_collection_policy_assignments (seller_party_type, seller_party_id)
    WHERE superseded_at IS NULL;

/* The whole history for one party, newest first — the only read the surface needs. */
CREATE INDEX ix_scpa_party_history
    ON commercial.seller_collection_policy_assignments
       (seller_party_type, seller_party_id, assigned_at DESC);

CREATE INDEX ix_scpa_policy_key
    ON commercial.seller_collection_policy_assignments (policy_key);

-- ==========================================================================
-- Immutability: supersession is the ONE permitted update, and it happens once
-- ==========================================================================

CREATE OR REPLACE FUNCTION commercial.enforce_collection_policy_assignment_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- No un-enrollment path exists, by construction (ADR-048 R2).
        RAISE EXCEPTION 'seller_collection_policy_assignments rows are permanent: an assignment is superseded, never removed, and clearing one would return an enrolled party to the legacy path'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Identity and the assignment fact itself are frozen in every state.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.seller_party_type IS DISTINCT FROM OLD.seller_party_type
       OR NEW.seller_party_id IS DISTINCT FROM OLD.seller_party_id
       OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
       OR NEW.assigned_by_user_id IS DISTINCT FROM OLD.assigned_by_user_id
    THEN
        RAISE EXCEPTION 'seller_collection_policy_assignments is immutable: changing a policy key is a NEW assignment that supersedes this one, never an edit'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Supersession is terminal. A superseded row accepts nothing at all, which
    -- is also the second thing stopping a party from regaining a current row by
    -- reviving history.
    IF OLD.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION 'seller_collection_policy_assignments is already superseded and permanently immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The only permitted UPDATE is the one that supersedes a current row.
    IF NEW.superseded_at IS NULL THEN
        RAISE EXCEPTION 'seller_collection_policy_assignments: the only permitted update is supersession'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- And its instant is the database's, for the same reason the assignment's
    -- is: a supersession time supplied by a caller could reorder history.
    IF NEW.superseded_at < now() - INTERVAL '1 minute'
       OR NEW.superseded_at > now() + INTERVAL '1 minute'
    THEN
        RAISE EXCEPTION 'seller_collection_policy_assignments.superseded_at must be the database clock, not a supplied instant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_scpa_immutable
    BEFORE UPDATE OR DELETE ON commercial.seller_collection_policy_assignments
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_collection_policy_assignment_immutability();

-- ---------------------------------------------------------------------------
-- No seed. Deliberately, and this comment is the record of it.
--
-- Every seller party is unenrolled when this migration lands, so no order
-- behaviour changes and no policy is activated. A seeded assignment would be
-- engineering choosing a commercial outcome on a seller's behalf, which
-- `V33-DEC-028` Ruling 2 forbids.
-- ---------------------------------------------------------------------------
