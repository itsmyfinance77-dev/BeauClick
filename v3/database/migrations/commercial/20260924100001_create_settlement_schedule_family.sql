-- ---------------------------------------------------------------------------
-- V3.3 Story #175 (`#43d`) — the settlement schedule family and the seller
-- risk class (ADR-052 §1 and §8, `V33-DEC-040` R4, ratified by `V33-DEC-044`).
--
-- Two tables' worth of publication plane and one assignment plane. Nothing
-- reads them on the day this lands: the settlement proposal that will is
-- `#43e` (#176), which is `gate:external` behind the payout rail.
--
-- ## What is published, and what is assigned
--
--   * `settlement_schedule_policies` / `_versions` — how often a seller's
--     money is proposed for settlement, the minimum worth paying out, and the
--     reserve held back. Published by an administrator, versioned, immutable
--     once published.
--   * `seller_risk_class_assignments` — which schedule a given seller falls
--     under. Assigned deliberately, one current row per party, forward-only.
--
-- The two are separate because they change on different cadences and under
-- different review: a schedule is a commercial policy the platform publishes,
-- while a risk class is a judgement about one seller. Putting them in one
-- table would make re-classifying a seller look like re-publishing a policy.
--
-- ## Keyed by `(plan_key, risk_class)`
--
-- ADR-052 §1 is explicit. A plan's settlement terms legitimately differ by
-- risk: the same subscription plan may settle weekly for a standard seller
-- and hold a reserve for an elevated one. The key is therefore the PAIR, and
-- the effective-window exclusion below is per pair — two versions of one pair
-- can never be effective at once, while different pairs are independent.
--
-- ## No value is published here, and "weekly" is not a default
--
-- `settlement_interval_days` is NOT NULL with NO DEFAULT. Seven is not
-- written anywhere in this file: if the platform settles weekly it is because
-- an administrator published 7, and the row records who and when. The
-- nullable columns (`minimum_payout_toman`, `reserve_bp`, `reserve_cap_toman`)
-- are nullable because "no minimum" and "no reserve" are real, distinct
-- states — not because a default is waiting to fill them in.
--
-- ## No inferred risk class
--
-- `V33-DEC-040` R4: "never inferred". There is no default class, no scoring,
-- no backfill and no trigger that assigns one. A seller with no assignment
-- has NO class, and `#43e`'s resolver must answer `unresolved` rather than
-- quietly settling them as standard. That is the fail-closed reading, and the
-- absence of a DEFAULT on `risk_class` is what enforces it.
--
-- ## ADR-027
--
-- Both families are claimed `retained`. The schedule carries administrator
-- attribution; the assignment carries both the administrator who classified a
-- seller and the seller party itself. The class IS exported to the owning
-- seller — it changes when their money moves — but the free-text `reason` is
-- not: an `elevated` classification encodes risk and fraud-detection signal,
-- and a self-service export is not the place to disclose the platform's
-- detection posture. That decision is recorded on #175's preflight and
-- asserted by test.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ==========================================================================
-- commercial.settlement_schedule_policies -- the stable key
-- ==========================================================================

CREATE TABLE commercial.settlement_schedule_policies (
    policy_key VARCHAR(64) PRIMARY KEY,

    /*
     * The pair this key serves. `plan_key` is free-form rather than a foreign
     * key into `commercial.plans`: a settlement schedule may legitimately be
     * published for a plan that does not exist yet, and an FK here would make
     * the publication order of two unrelated families load-bearing.
     */
    plan_key VARCHAR(64) NOT NULL,
    risk_class VARCHAR(16) NOT NULL,

    display_name VARCHAR(120) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    CONSTRAINT ck_ssp_key_shape CHECK (policy_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    CONSTRAINT ck_ssp_plan_key_shape CHECK (plan_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    CONSTRAINT ck_ssp_risk_class CHECK (risk_class IN ('standard', 'elevated')),
    CONSTRAINT ck_ssp_display_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_ssp_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),

    /*
     * One key per `(plan_key, risk_class)`, for the reason `#43b-1`'s
     * `uq_cp_component` exists: `#43e`'s resolver asks "the active committed
     * schedule for this plan and this risk class", and two keys would give
     * that question two answers with no ratified tie-break.
     */
    CONSTRAINT uq_ssp_plan_risk UNIQUE (plan_key, risk_class)
);

-- ==========================================================================
-- commercial.settlement_schedule_policy_versions -- immutable terms
-- ==========================================================================

CREATE TABLE commercial.settlement_schedule_policy_versions (
    id UUID PRIMARY KEY,

    policy_key VARCHAR(64) NOT NULL REFERENCES commercial.settlement_schedule_policies (policy_key),
    version INTEGER NOT NULL,

    lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'draft',

    /*
     * How many days between settlement proposals. NOT NULL, NO DEFAULT, and
     * strictly positive: a zero interval would mean "continuously", which is
     * not a cadence anybody ratified, and a negative one is meaningless.
     */
    settlement_interval_days INTEGER NOT NULL,

    /*
     * Below this, a proposal is not worth making. NULL means NO minimum — a
     * real state, distinct from zero, which would mean "propose any amount
     * including nothing".
     */
    minimum_payout_toman BIGINT,

    /*
     * The share held back, and the ceiling on it. Both NULL means no reserve
     * at all. A cap without a rate holds nothing, and a rate without a cap is
     * an uncapped reserve — both are legitimate, so neither implies the other
     * and the CHECK below does not pair them.
     */
    reserve_bp INTEGER,
    reserve_cap_toman BIGINT,

    activation_starts_at TIMESTAMPTZ,
    activation_ends_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    published_at TIMESTAMPTZ,
    published_by_user_id UUID,
    published_by_label VARCHAR(40),

    retired_at TIMESTAMPTZ,
    retired_by_user_id UUID,
    retired_by_label VARCHAR(40),

    CONSTRAINT uq_sspv_key_version UNIQUE (policy_key, version),
    CONSTRAINT ck_sspv_version_positive CHECK (version >= 1),
    CONSTRAINT ck_sspv_lifecycle CHECK (lifecycle_state IN ('draft', 'published', 'retired')),

    CONSTRAINT ck_sspv_interval CHECK (settlement_interval_days > 0 AND settlement_interval_days <= 365),
    CONSTRAINT ck_sspv_minimum CHECK (minimum_payout_toman IS NULL OR minimum_payout_toman >= 0),
    CONSTRAINT ck_sspv_reserve_bp CHECK (reserve_bp IS NULL OR (reserve_bp >= 0 AND reserve_bp <= 10000)),
    CONSTRAINT ck_sspv_reserve_cap CHECK (reserve_cap_toman IS NULL OR reserve_cap_toman >= 0),

    CONSTRAINT ck_sspv_window_by_state CHECK (
        (lifecycle_state = 'draft' AND activation_starts_at IS NULL)
        OR (lifecycle_state <> 'draft' AND activation_starts_at IS NOT NULL)
    ),
    CONSTRAINT ck_sspv_window_order CHECK (
        activation_ends_at IS NULL
        OR activation_starts_at IS NULL
        OR activation_ends_at > activation_starts_at
    ),
    CONSTRAINT ck_sspv_not_retroactive CHECK (
        lifecycle_state = 'draft'
        OR (published_at IS NOT NULL AND activation_starts_at >= published_at)
    ),
    CONSTRAINT ck_sspv_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),
    CONSTRAINT ck_sspv_published_record CHECK (
        (lifecycle_state = 'draft'
             AND published_at IS NULL AND published_by_user_id IS NULL AND published_by_label IS NULL)
        OR (lifecycle_state <> 'draft'
             AND published_at IS NOT NULL
             AND ((published_by_user_id IS NOT NULL AND published_by_label IS NULL)
                  OR (published_by_user_id IS NULL AND published_by_label IS NOT NULL)))
    ),
    CONSTRAINT ck_sspv_retired_record CHECK (
        (lifecycle_state <> 'retired'
             AND retired_at IS NULL AND retired_by_user_id IS NULL AND retired_by_label IS NULL)
        OR (lifecycle_state = 'retired'
             AND retired_at IS NOT NULL
             AND ((retired_by_user_id IS NOT NULL AND retired_by_label IS NULL)
                  OR (retired_by_user_id IS NULL AND retired_by_label IS NOT NULL)))
    )
);

/*
 * The EFFECTIVE window, with the same correction `#43b-1` and the collection
 * family record, and deliberately its own function: a shared one would let a
 * change to another family's window semantics silently re-index this one.
 */
CREATE OR REPLACE FUNCTION commercial.settlement_schedule_effective_window(
    p_activation_starts_at TIMESTAMPTZ,
    p_activation_ends_at TIMESTAMPTZ,
    p_lifecycle_state VARCHAR,
    p_retired_at TIMESTAMPTZ
)
RETURNS TSTZRANGE
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT tstzrange(
        p_activation_starts_at,
        GREATEST(
            p_activation_starts_at,
            LEAST(
                COALESCE(p_activation_ends_at, 'infinity'::timestamptz),
                CASE
                    WHEN p_lifecycle_state = 'retired'
                        THEN COALESCE(p_retired_at, 'infinity'::timestamptz)
                    ELSE 'infinity'::timestamptz
                END
            )
        ),
        '[)'
    );
$$;

ALTER TABLE commercial.settlement_schedule_policy_versions
    ADD CONSTRAINT ex_sspv_no_effective_overlap
    EXCLUDE USING gist (
        policy_key WITH =,
        commercial.settlement_schedule_effective_window(
            activation_starts_at, activation_ends_at, lifecycle_state, retired_at
        ) WITH &&
    ) WHERE (lifecycle_state <> 'draft');

CREATE INDEX ix_sspv_key_state
    ON commercial.settlement_schedule_policy_versions (policy_key, lifecycle_state, activation_starts_at DESC);

-- ==========================================================================
-- Lifecycle, with the same no-tolerance publication instant as `#43b-1`
-- ==========================================================================
--
-- ADR-052 §1's strict rule covers every family it names, not only commission:
-- `published_at` must EQUAL the transaction `now()`. `#43e` will resolve a
-- schedule inside a settlement-proposal transaction, so the same reasoning
-- applies — the width of the stamp-to-commit window is the width of the race.

CREATE OR REPLACE FUNCTION commercial.enforce_settlement_schedule_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions must be created as draft: publication is a transition, not an initial state'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions cannot be deleted once published: a schedule a payout may have been proposed under is not removable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.lifecycle_state = 'retired' THEN
        RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions is retired and permanently immutable: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
       AND NOT (
             (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published')
          OR (OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired')
       )
    THEN
        RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions transition % -> % is not permitted: the lifecycle is draft -> published -> retired and never backwards',
            OLD.lifecycle_state, NEW.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.lifecycle_state <> 'draft' AND (
           NEW.settlement_interval_days IS DISTINCT FROM OLD.settlement_interval_days
        OR NEW.minimum_payout_toman IS DISTINCT FROM OLD.minimum_payout_toman
        OR NEW.reserve_bp IS DISTINCT FROM OLD.reserve_bp
        OR NEW.reserve_cap_toman IS DISTINCT FROM OLD.reserve_cap_toman
        OR NEW.activation_starts_at IS DISTINCT FROM OLD.activation_starts_at
        OR NEW.activation_ends_at IS DISTINCT FROM OLD.activation_ends_at
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
        OR NEW.published_by_label IS DISTINCT FROM OLD.published_by_label
    ) THEN
        RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions is published and its terms are immutable: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published' THEN
        IF NEW.published_at IS NULL OR NEW.activation_starts_at IS NULL THEN
            RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions publication must set published_at and activation_starts_at'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.published_at <> now() THEN
            RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions published_at must be exactly the transaction clock (ADR-052 §1: no tolerance), not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.activation_starts_at < NEW.published_at THEN
            RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions cannot activate before it is published: a settlement schedule is never retroactive'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.activation_ends_at IS NOT NULL AND NEW.activation_ends_at <= NEW.activation_starts_at THEN
            RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions cannot be published with an activation end at or before its start'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired' THEN
        IF NEW.retired_at IS NULL THEN
            RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions retirement must set retired_at'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.retired_at <> now() THEN
            RAISE EXCEPTION 'commercial.settlement_schedule_policy_versions retired_at must be exactly the transaction clock (ADR-052 §1: no tolerance), not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_sspv_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.settlement_schedule_policy_versions
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_settlement_schedule_lifecycle();

CREATE OR REPLACE FUNCTION commercial.reject_settlement_schedule_policy_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (
            SELECT 1 FROM commercial.settlement_schedule_policy_versions WHERE policy_key = OLD.policy_key
        ) THEN
            RAISE EXCEPTION 'commercial.settlement_schedule_policies cannot be deleted while versions exist for the key'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    /*
     * The pair is frozen for the reason `#43b-1` freezes a component: moving a
     * key from one `(plan, risk class)` to another would silently re-point
     * every version behind it, so a settlement proposed under `elevated`
     * would find itself explained by terms published for `standard`.
     */
    IF NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.plan_key IS DISTINCT FROM OLD.plan_key
       OR NEW.risk_class IS DISTINCT FROM OLD.risk_class
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.settlement_schedule_policies identity is immutable: the key, its plan, its risk class and its creation record cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_settlement_schedule_policies_immutable
    BEFORE UPDATE OR DELETE ON commercial.settlement_schedule_policies
    FOR EACH ROW
    EXECUTE FUNCTION commercial.reject_settlement_schedule_policy_rewrite();

-- ==========================================================================
-- commercial.seller_risk_class_assignments -- deliberate, forward-only
-- ==========================================================================
--
-- One CURRENT row per seller party, superseded rather than edited, with a
-- mandatory reason. `V33-DEC-040` R4 forbids inference, so there is no
-- default class and no trigger that creates one: a party with no row here has
-- no class, and `#43e` must fail closed rather than settle them as standard.

CREATE TABLE commercial.seller_risk_class_assignments (
    id UUID PRIMARY KEY,

    seller_party_type VARCHAR(16) NOT NULL,
    seller_party_id UUID NOT NULL,

    risk_class VARCHAR(16) NOT NULL,

    /*
     * WHY this seller carries this class. Mandatory: a classification that
     * changes when a seller's money moves is not something anybody may record
     * without saying why.
     *
     * Retained and NOT exported (ADR-027, #175's preflight): an `elevated`
     * class in practice encodes risk and fraud-detection signal, and a
     * self-service export is not the place to disclose the platform's
     * detection posture. The CLASS is exported; this text is not.
     */
    reason VARCHAR(500) NOT NULL,

    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by_user_id UUID,
    assigned_by_label VARCHAR(40),

    superseded_at TIMESTAMPTZ,
    superseded_by_user_id UUID,
    superseded_by_assignment_id UUID,

    CONSTRAINT ck_srca_party_type CHECK (seller_party_type IN ('professional', 'business')),
    CONSTRAINT ck_srca_risk_class CHECK (risk_class IN ('standard', 'elevated')),
    CONSTRAINT ck_srca_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
    CONSTRAINT ck_srca_assigned_actor CHECK (
        (assigned_by_user_id IS NOT NULL AND assigned_by_label IS NULL)
        OR (assigned_by_user_id IS NULL AND assigned_by_label IS NOT NULL)
    ),
    CONSTRAINT ck_srca_supersession_record CHECK (
        (superseded_at IS NULL AND superseded_by_user_id IS NULL AND superseded_by_assignment_id IS NULL)
        OR (superseded_at IS NOT NULL AND superseded_by_user_id IS NOT NULL AND superseded_by_assignment_id IS NOT NULL)
    ),
    CONSTRAINT ck_srca_supersession_forward CHECK (superseded_at IS NULL OR superseded_at >= assigned_at),
    CONSTRAINT ck_srca_not_self_superseding
        CHECK (superseded_by_assignment_id IS NULL OR superseded_by_assignment_id <> id)
);

/*
 * THE INVARIANT: at most one CURRENT class per seller party. A partial unique
 * index rather than a service check, because the failure it prevents is a race
 * two concurrent first classifications would both win at READ COMMITTED.
 */
CREATE UNIQUE INDEX uq_srca_one_current_per_party
    ON commercial.seller_risk_class_assignments (seller_party_type, seller_party_id)
    WHERE superseded_at IS NULL;

CREATE INDEX ix_srca_party_history
    ON commercial.seller_risk_class_assignments (seller_party_type, seller_party_id, assigned_at DESC);

CREATE OR REPLACE FUNCTION commercial.enforce_seller_risk_class_forward_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commercial.seller_risk_class_assignments rows are permanent: a class is superseded, never removed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.superseded_at IS NOT NULL THEN
        RAISE EXCEPTION 'commercial.seller_risk_class_assignments is already superseded and permanently immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The ONLY permitted update is the supersession stamp itself. Everything
    -- else about a classification is what it was when it was made.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.seller_party_type IS DISTINCT FROM OLD.seller_party_type
       OR NEW.seller_party_id IS DISTINCT FROM OLD.seller_party_id
       OR NEW.risk_class IS DISTINCT FROM OLD.risk_class
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
       OR NEW.assigned_by_user_id IS DISTINCT FROM OLD.assigned_by_user_id
       OR NEW.assigned_by_label IS DISTINCT FROM OLD.assigned_by_label
    THEN
        RAISE EXCEPTION 'commercial.seller_risk_class_assignments is immutable apart from its supersession: record a new classification instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.superseded_at IS NULL THEN
        RAISE EXCEPTION 'commercial.seller_risk_class_assignments cannot be un-superseded'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.superseded_at <> now() THEN
        RAISE EXCEPTION 'commercial.seller_risk_class_assignments superseded_at must be exactly the transaction clock, not a supplied instant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_srca_forward_only
    BEFORE UPDATE OR DELETE ON commercial.seller_risk_class_assignments
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_seller_risk_class_forward_only();

-- ---------------------------------------------------------------------------
-- No seed, and this comment is the record of it.
--
-- No schedule, interval, minimum, reserve or risk class appears above. In
-- particular SEVEN does not: if the platform ever settles weekly it will be
-- because an administrator published 7 and the row records who and when.
-- `V33-DEC-040` R4's "never inferred" covers the class the same way, so no
-- party is classified here and none is classified by any trigger above.
--
-- The tables therefore start empty, and `#43e`'s resolver must treat that as
-- `unresolved` rather than as a reason to invent a cadence.
-- ---------------------------------------------------------------------------
