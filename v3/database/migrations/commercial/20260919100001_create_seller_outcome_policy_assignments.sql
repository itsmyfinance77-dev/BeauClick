-- ---------------------------------------------------------------------------
-- V3.3 Story #159 (`#42b`) — the seller's booking-outcome policy selection
-- (ADR-051 §3, `V33-DEC-039` R4–R6, `V33-DEC-031`).
--
-- One table. It records which published outcome-policy KEY a seller party has
-- chosen and the four members it selected inside that key's active version —
-- as immutable history with exactly one CURRENT row per party. It mirrors
-- `commercial.seller_collection_policy_assignments` (#104) deliberately: the
-- same presence-as-enrollment rule, the same forward-only supersession, the
-- same refusal to delete.
--
-- ## Presence IS enrollment (ADR-048 R2)
--
--   * no current row  -> the party is UNENROLLED; its orders carry no outcome
--                        terms and keep today's path;
--   * one current row -> ENROLLED; order creation must resolve it or fail
--                        closed on the online-collection path;
--   * superseded rows -> immutable history.
--
-- There is no DELETE path: removing a row would return an enrolled party to
-- the legacy path, which is the post-lookup fallback `V33-DEC-029` Ruling 8
-- forbids.
--
-- ## The key, not the version, and the members BY VALUE (ADR-051 §3)
--
-- The row names the stable `policy_key` so an administrator can re-range
-- forward without migrating sellers, and it copies the four selected members
-- so no later reader re-reads the family. A selection a later version no
-- longer allows makes resolution fail closed until the seller selects again.
--
-- ## What this migration deliberately does NOT do
--
-- It creates zero assignments and records no commercial value: no cutoff,
-- grace, percentage or amount appears below except as a column type and a
-- bound the ratified contract already fixes. It touches no `commerce` table.
-- ---------------------------------------------------------------------------

CREATE TABLE commercial.seller_outcome_policy_assignments (
    id UUID PRIMARY KEY,

    /* WHICH SELLER PARTY. No FK to another domain's identity table (V3_DATABASE_BLUEPRINT.md §1). */
    seller_party_type VARCHAR(16) NOT NULL,
    seller_party_id UUID NOT NULL,

    /* The stable key. A same-domain FK: a key that vanished would leave a row naming nothing. */
    policy_key VARCHAR(64) NOT NULL
        REFERENCES commercial.booking_outcome_policies (policy_key),

    /*
     * The four selected members, by value. Each is re-checked against the
     * version active at the database instant by
     * `commercial.require_outcome_selection_within_active_version` below; the
     * CHECKs here are the shape, the trigger is the membership.
     */
    cutoff_hours SMALLINT NOT NULL,
    late_retention_kind VARCHAR(32) NOT NULL,
    late_retention_basis_points INTEGER,
    late_retention_amount_toman BIGINT,
    grace_minutes SMALLINT NOT NULL,
    no_show_retention_kind VARCHAR(32) NOT NULL,
    no_show_retention_basis_points INTEGER,
    no_show_retention_amount_toman BIGINT,

    /* WHEN and WHO. The database's clock, never an application host's. */
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by_user_id UUID NOT NULL,

    /*
     * Terminal supersession facts: all NULL while current, all present once
     * superseded. The successor reference is DEFERRABLE INITIALLY DEFERRED for
     * the reason #104's migration records: the pairing CHECK needs the
     * successor's id on the predecessor while the one-current index forbids
     * the successor existing before the predecessor is superseded.
     */
    superseded_at TIMESTAMPTZ,
    superseded_by_user_id UUID,
    superseded_by_assignment_id UUID
        REFERENCES commercial.seller_outcome_policy_assignments (id)
        DEFERRABLE INITIALLY DEFERRED,

    CONSTRAINT ck_sopa_party_type CHECK (seller_party_type IN ('professional', 'business')),

    /* The bounds `#42a`'s sets are drawn from; membership itself is the trigger's. */
    CONSTRAINT ck_sopa_cutoff_hours CHECK (cutoff_hours BETWEEN 0 AND 8760),
    CONSTRAINT ck_sopa_grace_minutes CHECK (grace_minutes BETWEEN 0 AND 1440),

    /* Each retention rule carries exactly the field its kind needs — `#42a`'s option shape, restated. */
    CONSTRAINT ck_sopa_late_retention_kind CHECK (
        late_retention_kind IN ('none', 'percentage_of_collected', 'fixed_toman', 'full_collected')
    ),
    CONSTRAINT ck_sopa_late_retention_shape CHECK (
        (late_retention_kind IN ('none', 'full_collected')
            AND late_retention_basis_points IS NULL AND late_retention_amount_toman IS NULL)
        OR (late_retention_kind = 'percentage_of_collected'
            AND late_retention_basis_points IS NOT NULL
            AND late_retention_basis_points BETWEEN 1 AND 9999
            AND late_retention_amount_toman IS NULL)
        OR (late_retention_kind = 'fixed_toman'
            AND late_retention_basis_points IS NULL
            AND late_retention_amount_toman IS NOT NULL
            AND late_retention_amount_toman > 0 AND late_retention_amount_toman <= 10000000000000)
    ),
    CONSTRAINT ck_sopa_no_show_retention_kind CHECK (
        no_show_retention_kind IN ('none', 'percentage_of_collected', 'fixed_toman', 'full_collected')
    ),
    CONSTRAINT ck_sopa_no_show_retention_shape CHECK (
        (no_show_retention_kind IN ('none', 'full_collected')
            AND no_show_retention_basis_points IS NULL AND no_show_retention_amount_toman IS NULL)
        OR (no_show_retention_kind = 'percentage_of_collected'
            AND no_show_retention_basis_points IS NOT NULL
            AND no_show_retention_basis_points BETWEEN 1 AND 9999
            AND no_show_retention_amount_toman IS NULL)
        OR (no_show_retention_kind = 'fixed_toman'
            AND no_show_retention_basis_points IS NULL
            AND no_show_retention_amount_toman IS NOT NULL
            AND no_show_retention_amount_toman > 0 AND no_show_retention_amount_toman <= 10000000000000)
    ),

    CONSTRAINT ck_sopa_supersession_pairing CHECK (
        (superseded_at IS NULL AND superseded_by_user_id IS NULL AND superseded_by_assignment_id IS NULL)
        OR (superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL AND superseded_by_assignment_id IS NOT NULL)
    ),
    CONSTRAINT ck_sopa_supersession_forward CHECK (superseded_at IS NULL OR superseded_at >= assigned_at),
    CONSTRAINT ck_sopa_not_self_superseding
        CHECK (superseded_by_assignment_id IS NULL OR superseded_by_assignment_id <> id)
);

/*
 * THE INVARIANT: at most one CURRENT selection per seller party. A partial
 * unique index rather than a service check, because the failure it prevents
 * is a race two concurrent first selections would both win at READ COMMITTED.
 */
CREATE UNIQUE INDEX uq_sopa_one_current_per_party
    ON commercial.seller_outcome_policy_assignments (seller_party_type, seller_party_id)
    WHERE superseded_at IS NULL;

CREATE INDEX ix_sopa_party_history
    ON commercial.seller_outcome_policy_assignments (seller_party_type, seller_party_id, assigned_at DESC);

CREATE INDEX ix_sopa_policy_key
    ON commercial.seller_outcome_policy_assignments (policy_key);

-- ==========================================================================
-- Membership: a selection is writable only inside the active version
-- ==========================================================================
--
-- A trigger, because membership in an array and in a child option table under
-- "the version active at this instant" is not expressible as a CHECK or a
-- foreign key. The service checks first for a readable refusal; this is what
-- makes a raw INSERT unable to record a selection the administrator never
-- offered. It locks the active version `FOR SHARE`, so a retirement racing the
-- selection waits (ADR-048 R5) and a selection can never be recorded against a
-- version retired mid-transaction.

CREATE OR REPLACE FUNCTION commercial.require_outcome_selection_within_active_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_version_id UUID;
    v_cutoffs SMALLINT[];
    v_graces SMALLINT[];
BEGIN
    IF NEW.assigned_at < now() - INTERVAL '1 minute' OR NEW.assigned_at > now() + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments.assigned_at must be the database clock, not a supplied instant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT v.id, v.cutoff_hours_allowed, v.no_show_grace_minutes_allowed
      INTO v_version_id, v_cutoffs, v_graces
      FROM commercial.booking_outcome_policy_versions v
     WHERE v.policy_key = NEW.policy_key
       AND v.lifecycle_state = 'published'
       AND v.activation_starts_at <= now()
       AND (v.activation_ends_at IS NULL OR now() < v.activation_ends_at)
       FOR SHARE;

    IF v_version_id IS NULL THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments: the policy key has no version published and active at this instant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NOT (NEW.cutoff_hours = ANY (v_cutoffs)) THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments: cutoff_hours is not a member of the active version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NOT (NEW.grace_minutes = ANY (v_graces)) THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments: grace_minutes is not a member of the active version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM commercial.booking_outcome_policy_retention_options o
         WHERE o.version_id = v_version_id
           AND o.purpose = 'late_cancellation'
           AND o.kind = NEW.late_retention_kind
           AND o.basis_points IS NOT DISTINCT FROM NEW.late_retention_basis_points
           AND o.amount_toman IS NOT DISTINCT FROM NEW.late_retention_amount_toman
    ) THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments: the late-cancellation retention rule is not an option of the active version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM commercial.booking_outcome_policy_retention_options o
         WHERE o.version_id = v_version_id
           AND o.purpose = 'no_show'
           AND o.kind = NEW.no_show_retention_kind
           AND o.basis_points IS NOT DISTINCT FROM NEW.no_show_retention_basis_points
           AND o.amount_toman IS NOT DISTINCT FROM NEW.no_show_retention_amount_toman
    ) THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments: the no-show retention rule is not an option of the active version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_sopa_selection_within_active_version
    BEFORE INSERT ON commercial.seller_outcome_policy_assignments
    FOR EACH ROW
    EXECUTE FUNCTION commercial.require_outcome_selection_within_active_version();

-- ==========================================================================
-- Immutability: supersession is the ONE permitted update, and it happens once
-- ==========================================================================

CREATE OR REPLACE FUNCTION commercial.enforce_outcome_policy_assignment_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments rows are permanent: a selection is superseded, never removed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.seller_party_type IS DISTINCT FROM OLD.seller_party_type
       OR NEW.seller_party_id IS DISTINCT FROM OLD.seller_party_id
       OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.cutoff_hours IS DISTINCT FROM OLD.cutoff_hours
       OR NEW.late_retention_kind IS DISTINCT FROM OLD.late_retention_kind
       OR NEW.late_retention_basis_points IS DISTINCT FROM OLD.late_retention_basis_points
       OR NEW.late_retention_amount_toman IS DISTINCT FROM OLD.late_retention_amount_toman
       OR NEW.grace_minutes IS DISTINCT FROM OLD.grace_minutes
       OR NEW.no_show_retention_kind IS DISTINCT FROM OLD.no_show_retention_kind
       OR NEW.no_show_retention_basis_points IS DISTINCT FROM OLD.no_show_retention_basis_points
       OR NEW.no_show_retention_amount_toman IS DISTINCT FROM OLD.no_show_retention_amount_toman
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
       OR NEW.assigned_by_user_id IS DISTINCT FROM OLD.assigned_by_user_id
    THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments is immutable: a different selection is a NEW row that supersedes this one'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments is already superseded and permanently immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.superseded_at IS NULL THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments: the only permitted update is supersession'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.superseded_at < now() - INTERVAL '1 minute' OR NEW.superseded_at > now() + INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'seller_outcome_policy_assignments.superseded_at must be the database clock, not a supplied instant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_sopa_immutable
    BEFORE UPDATE OR DELETE ON commercial.seller_outcome_policy_assignments
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_outcome_policy_assignment_immutability();

-- ---------------------------------------------------------------------------
-- No seed. Every seller party is unenrolled when this lands, so no order
-- behaviour changes. A seeded selection would be engineering choosing a
-- commercial outcome on a seller's behalf (`V33-DEC-028` Ruling 2).
-- ---------------------------------------------------------------------------
