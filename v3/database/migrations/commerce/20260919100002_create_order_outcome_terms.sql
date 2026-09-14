-- ---------------------------------------------------------------------------
-- V3.3 Story #159 (`#42b`) — the immutable order-level outcome-terms snapshot
-- and the customer's acceptance of it (ADR-051 §3–§4, `V33-DEC-039` R13,
-- `V33-DEC-042` R2, `V33-DEC-029` Rulings 2–3).
--
-- ## A 1:1 side table, not columns on the schedule (ADR-051 §3)
--
-- `commerce.order_payment_schedules` is the COLLECTION contract, and a
-- `legacy_unenrolled` order legitimately has a schedule and no outcome terms.
-- The ABSENCE of a row here is the fail-closed fact `#42c` reads.
--
-- ## The schedule is not altered
--
-- It gains no column, no CHECK change and no change to its immutability
-- (ADR-043 §4). What it gains is one DEFERRABLE constraint trigger that
-- enforces the invariant ADR-051 §4 states — "the row never says accepted
-- about a booking with no terms" — at commit, in the database rather than in
-- a service (ADR-043 §3: every invariant is a database constraint).
--
-- ## Write order (the #159 preflight's correction to ADR-051's table)
--
-- The schedule is immutable, so `policy_accepted_at` cannot be set after the
-- fact. Order creation therefore inserts this row FIRST and the schedule LAST,
-- with `policy_accepted_at = now()`; both instants are the transaction's, and
-- the constraint triggers below require them to be equal.
--
-- ## No value
--
-- No row is created here. Every term is copied by value at order creation
-- from an administrator-published version and a seller's selection.
-- ---------------------------------------------------------------------------

CREATE TABLE commerce.order_outcome_terms (
    order_id UUID PRIMARY KEY REFERENCES commerce.orders (id),

    /*
     * THE LEGAL SELLER (`V33-DEC-042` R2): the order's server-resolved seller
     * party, frozen here. A trigger requires it to equal the order row, so no
     * caller can substitute another party. The display name is deliberately
     * NOT snapshotted — R2 reuses the existing public-name source rather than
     * creating a second one.
     */
    seller_party_type VARCHAR(16) NOT NULL,
    seller_party_id UUID NOT NULL,

    /* Which numeric version and which text version were accepted. No FK across schemas. */
    policy_key VARCHAR(64) NOT NULL,
    policy_version INTEGER NOT NULL,
    copy_key VARCHAR(64) NOT NULL,
    copy_version INTEGER NOT NULL,

    /* The seller's four selections, by value. */
    cutoff_hours SMALLINT NOT NULL,
    late_retention_kind VARCHAR(32) NOT NULL,
    late_retention_basis_points INTEGER,
    late_retention_amount_toman BIGINT,
    grace_minutes SMALLINT NOT NULL,
    no_show_retention_kind VARCHAR(32) NOT NULL,
    no_show_retention_basis_points INTEGER,
    no_show_retention_amount_toman BIGINT,

    /* The administrator values of the resolved version, by value. */
    reschedule_free_count SMALLINT NOT NULL,
    dispute_window_hours SMALLINT NOT NULL,
    bodily_harm_window_hours SMALLINT,
    appeal_window_hours SMALLINT NOT NULL,
    case_file_retention_days SMALLINT,

    /* The Legal cap and its evidence reference, both nullable and paired (ADR-051 §5). */
    legal_cap_kind VARCHAR(32),
    legal_cap_basis_points INTEGER,
    legal_cap_amount_toman BIGINT,
    legal_evidence_id UUID,

    contract_version SMALLINT NOT NULL,

    /* The transaction instant; must equal the schedule's `policy_accepted_at`. */
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_oot_seller_party_type CHECK (seller_party_type IN ('professional', 'business')),
    CONSTRAINT ck_oot_policy_version CHECK (policy_version >= 1),
    CONSTRAINT ck_oot_copy_version CHECK (copy_version >= 1),
    CONSTRAINT ck_oot_contract_version CHECK (contract_version = 1),

    CONSTRAINT ck_oot_cutoff_hours CHECK (cutoff_hours BETWEEN 0 AND 8760),
    CONSTRAINT ck_oot_grace_minutes CHECK (grace_minutes BETWEEN 0 AND 1440),
    CONSTRAINT ck_oot_late_retention_kind CHECK (
        late_retention_kind IN ('none', 'percentage_of_collected', 'fixed_toman', 'full_collected')
    ),
    CONSTRAINT ck_oot_late_retention_shape CHECK (
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
    CONSTRAINT ck_oot_no_show_retention_kind CHECK (
        no_show_retention_kind IN ('none', 'percentage_of_collected', 'fixed_toman', 'full_collected')
    ),
    CONSTRAINT ck_oot_no_show_retention_shape CHECK (
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

    CONSTRAINT ck_oot_reschedule_free_count CHECK (reschedule_free_count BETWEEN 0 AND 100),
    CONSTRAINT ck_oot_dispute_window CHECK (dispute_window_hours BETWEEN 1 AND 8760),
    CONSTRAINT ck_oot_bodily_harm_window CHECK (
        bodily_harm_window_hours IS NULL
        OR (bodily_harm_window_hours BETWEEN 1 AND 8760 AND bodily_harm_window_hours >= dispute_window_hours)
    ),
    CONSTRAINT ck_oot_appeal_window CHECK (appeal_window_hours BETWEEN 1 AND 8760),
    CONSTRAINT ck_oot_case_file_retention CHECK (
        case_file_retention_days IS NULL OR case_file_retention_days BETWEEN 1 AND 3650
    ),

    /* The cap's shape, exhaustively, as `#42a` publishes it; `none` is not a cap. */
    CONSTRAINT ck_oot_legal_cap_kind CHECK (
        legal_cap_kind IS NULL OR legal_cap_kind IN ('percentage_of_collected', 'fixed_toman', 'full_collected')
    ),
    CONSTRAINT ck_oot_legal_cap_shape CHECK (
        (legal_cap_kind IS NULL AND legal_cap_basis_points IS NULL AND legal_cap_amount_toman IS NULL)
        OR (legal_cap_kind = 'percentage_of_collected'
            AND legal_cap_basis_points IS NOT NULL
            AND legal_cap_basis_points BETWEEN 1 AND 9999 AND legal_cap_amount_toman IS NULL)
        OR (legal_cap_kind = 'fixed_toman'
            AND legal_cap_basis_points IS NULL
            AND legal_cap_amount_toman IS NOT NULL
            AND legal_cap_amount_toman > 0 AND legal_cap_amount_toman <= 10000000000000)
        OR (legal_cap_kind = 'full_collected'
            AND legal_cap_basis_points IS NULL AND legal_cap_amount_toman IS NULL)
    ),
    /* A cap exists if and only if it references evidence (ADR-051 §5). */
    CONSTRAINT ck_oot_legal_cap_requires_evidence CHECK (
        (legal_cap_kind IS NULL AND legal_evidence_id IS NULL)
        OR (legal_cap_kind IS NOT NULL AND legal_evidence_id IS NOT NULL)
    )
);

-- ==========================================================================
-- Integrity at insert: the legal seller is the order's, the instant is the
-- database's
-- ==========================================================================
--
-- A trigger because both facts live on another row (`commerce.orders`) or on
-- the transaction clock, neither of which a CHECK can read.

CREATE OR REPLACE FUNCTION commerce.enforce_order_outcome_terms_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_party_type VARCHAR(16);
    v_party_id UUID;
BEGIN
    SELECT seller_party_type, seller_party_id INTO v_party_type, v_party_id
      FROM commerce.orders WHERE id = NEW.order_id;

    IF v_party_type IS NULL THEN
        RAISE EXCEPTION 'commerce.order_outcome_terms must describe an existing order'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.seller_party_type IS DISTINCT FROM v_party_type OR NEW.seller_party_id IS DISTINCT FROM v_party_id THEN
        RAISE EXCEPTION 'commerce.order_outcome_terms: the legal seller must be the order''s snapshotted seller party'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.resolved_at IS DISTINCT FROM now() THEN
        RAISE EXCEPTION 'commerce.order_outcome_terms.resolved_at must be the database transaction instant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_oot_integrity
    BEFORE INSERT ON commerce.order_outcome_terms
    FOR EACH ROW
    EXECUTE FUNCTION commerce.enforce_order_outcome_terms_integrity();

-- ==========================================================================
-- Append-only: the accepted terms of a booking are never rewritten
-- ==========================================================================

CREATE OR REPLACE FUNCTION commerce.reject_order_outcome_terms_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'commerce.order_outcome_terms rows are immutable: they are the terms the customer accepted when the order was created'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_oot_append_only
    BEFORE UPDATE OR DELETE ON commerce.order_outcome_terms
    FOR EACH ROW
    EXECUTE FUNCTION commerce.reject_order_outcome_terms_rewrite();

-- ==========================================================================
-- Acceptance <=> terms, checked at COMMIT
-- ==========================================================================
--
-- Two DEFERRABLE INITIALLY DEFERRED constraint triggers, because the two rows
-- are written in one transaction and each direction must hold once both exist:
--
--   * a terms row requires the order's schedule to record acceptance at the
--     same instant — no snapshot without a genuine acceptance;
--   * a schedule recording acceptance requires a terms row at that instant —
--     no acceptance about an order with no terms (ADR-051 §4).
--
-- Because the schedule is immutable and its `policy_accepted_at` is NULL for
-- every order written before this story, a `legacy_unenrolled` order can never
-- acquire terms later (ADR-051 concurrency invariant 7).

CREATE OR REPLACE FUNCTION commerce.require_acceptance_for_outcome_terms()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_accepted_at TIMESTAMPTZ;
BEGIN
    SELECT policy_accepted_at INTO v_accepted_at
      FROM commerce.order_payment_schedules WHERE order_id = NEW.order_id;

    IF v_accepted_at IS NULL OR v_accepted_at IS DISTINCT FROM NEW.resolved_at THEN
        RAISE EXCEPTION 'commerce.order_outcome_terms requires the order''s schedule to record the customer''s acceptance in the same transaction'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tg_oot_requires_acceptance
    AFTER INSERT ON commerce.order_outcome_terms
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION commerce.require_acceptance_for_outcome_terms();

CREATE OR REPLACE FUNCTION commerce.require_outcome_terms_for_acceptance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_resolved_at TIMESTAMPTZ;
BEGIN
    IF NEW.policy_accepted_at IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT resolved_at INTO v_resolved_at
      FROM commerce.order_outcome_terms WHERE order_id = NEW.order_id;

    IF v_resolved_at IS NULL OR v_resolved_at IS DISTINCT FROM NEW.policy_accepted_at THEN
        RAISE EXCEPTION 'commerce.order_payment_schedules.policy_accepted_at requires the order''s outcome terms committed in the same transaction'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tg_ops_acceptance_requires_outcome_terms
    AFTER INSERT ON commerce.order_payment_schedules
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION commerce.require_outcome_terms_for_acceptance();

-- ---------------------------------------------------------------------------
-- No backfill. Every existing order predates any outcome policy, so it has no
-- terms and its `policy_accepted_at` stays NULL — which is the truth.
-- ---------------------------------------------------------------------------
