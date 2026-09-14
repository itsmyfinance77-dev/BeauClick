-- ---------------------------------------------------------------------------
-- V3.3 Story #42 (`#42a`) — the administrator-published booking-outcome policy
-- family, the Persian customer-policy copy family and the Legal-evidence
-- record (ADR-051 §1, §5, §10; `V33-DEC-039`, `V33-DEC-042`, `V33-DEC-043`).
--
-- This migration creates a PUBLICATION plane and nothing else. It creates ZERO
-- policies, ZERO versions, ZERO retention options, ZERO copies, ZERO copy
-- versions and ZERO evidence records. Nothing in `booking`, `commerce`,
-- `payment` or `financial` reads any table below, and no row exists to read:
-- on the day it lands every cancellation, reschedule, no-show, refund and
-- checkout takes exactly the path it took the day before.
--
-- ## What is deliberately absent
--
-- **No seller selection, no order snapshot, no acceptance** — `#42b` (#159).
-- **No evaluator, no decision table, no refund change** — `#42c` (#160).
-- **No no-show declaration, no remedy choice** — `#42d` (#161).
-- **No dispute table** — `#42e` (#162).
-- **No value.** No cutoff, grace, window, count, cap, retention period, copy
-- sentence or evidence appears below, and none is possible: every value
-- column is NOT NULL with NO DEFAULT, or conditionally NULL by CHECK. The
-- owner-endorsed initial publication values of `V33-DEC-039` (24 h, 15 min,
-- 72 h) are an administrator's to publish and are written nowhere here. The
-- only DEFAULTs are the fail-closed lifecycle states (`draft`, `recorded`),
-- `contract_version = 1` and database clocks.
--
-- ## Ranges and sets, not values (ADR-051 §1)
--
-- A numeric version carries the SETS a seller will choose inside — allowed
-- cutoff hours, allowed grace minutes, allowed retention options — never one
-- value handed to a seller. `SMALLINT[]` columns hold the two hour/minute sets
-- and a child table holds the retention options, because an option has a
-- shape (kind plus exactly one numeric field) that an array cannot CHECK.
--
-- ## The Legal-evidence gate (ADR-051 §5)
--
-- A published version with a non-null `legal_cap_*` is UNWRITABLE unless it
-- references a `recorded` evidence record of subject `retention_cap`. Three
-- layers, none of which is the application: an FK, a CHECK that pairs the cap
-- with a reference, and the trigger `commercial.require_valid_legal_evidence_for_cap`.
-- The record itself stores a reference and a summary only — never a document,
-- a name, advice or a file.
--
-- ## Column naming is a privacy control
--
-- Every actor column is `*_user_id`, so ADR-027's coverage check refuses a
-- `no_subject_data` claim on any table here; all six are claimed `retained`.
--
-- ## Reuse
--
-- The effective-window expression `commercial.booking_collection_policy_effective_window`
-- (Story #83) is a pure IMMUTABLE function of four row values and is reused
-- unchanged by both new exclusion constraints; its contract is not touched.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ==========================================================================
-- commercial.legal_evidence_records — an attestation that evidence exists
-- ==========================================================================

CREATE TABLE commercial.legal_evidence_records (
    id UUID PRIMARY KEY,

    /* The stable handle an administrator and a policy version refer to. */
    evidence_key VARCHAR(64) NOT NULL,

    /* Closed. Only `retention_cap` qualifies a legalCap (the trigger below). */
    subject VARCHAR(40) NOT NULL,

    /* `recorded -> retired`, one way. The DEFAULT is the only birth state. */
    status VARCHAR(16) NOT NULL DEFAULT 'recorded',

    /*
     * A REFERENCE to a document held elsewhere, and a short administrative
     * summary. Never the document, never counsel's name, never advice text:
     * the platform records THAT a person attests evidence exists, and where.
     */
    reference_kind VARCHAR(32) NOT NULL,
    reference VARCHAR(512) NOT NULL,
    summary VARCHAR(1000) NOT NULL,

    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_by_user_id UUID NOT NULL,
    /* The audit row written in the same transaction (ADR-051 §5). */
    recorded_audit_id UUID NOT NULL,

    retired_at TIMESTAMPTZ,
    retired_by_user_id UUID,
    retired_audit_id UUID,

    CONSTRAINT uq_ler_evidence_key UNIQUE (evidence_key),
    CONSTRAINT ck_ler_key_shape CHECK (evidence_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    CONSTRAINT ck_ler_subject CHECK (subject IN ('retention_cap', 'withdrawal_posture', 'policy_copy', 'case_file_retention')),
    CONSTRAINT ck_ler_status CHECK (status IN ('recorded', 'retired')),
    CONSTRAINT ck_ler_reference_kind CHECK (reference_kind IN ('document_reference', 'counsel_letter_reference', 'internal_ticket')),
    CONSTRAINT ck_ler_reference CHECK (length(btrim(reference)) BETWEEN 1 AND 512),
    CONSTRAINT ck_ler_summary CHECK (length(btrim(summary)) BETWEEN 1 AND 1000),
    CONSTRAINT ck_ler_retirement_pairing CHECK (
        (status = 'recorded' AND retired_at IS NULL AND retired_by_user_id IS NULL AND retired_audit_id IS NULL)
        OR (status = 'retired' AND retired_at IS NOT NULL AND retired_by_user_id IS NOT NULL AND retired_audit_id IS NOT NULL)
    ),
    CONSTRAINT ck_ler_retired_after_recorded CHECK (retired_at IS NULL OR retired_at >= recorded_at)
);

CREATE OR REPLACE FUNCTION commercial.enforce_legal_evidence_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'recorded' THEN
            RAISE EXCEPTION 'commercial.legal_evidence_records must be created as recorded: retirement is a transition, not an initial state'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.recorded_at < now() - INTERVAL '1 minute' OR NEW.recorded_at > now() + INTERVAL '1 minute' THEN
            RAISE EXCEPTION 'commercial.legal_evidence_records recorded_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commercial.legal_evidence_records rows are permanent: an attestation a published cap referred to is not removable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- UPDATE: every recorded fact is frozen; the only permitted change is the
    -- forward transition recorded -> retired, with a database-clock instant.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.evidence_key IS DISTINCT FROM OLD.evidence_key
       OR NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.reference_kind IS DISTINCT FROM OLD.reference_kind
       OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.summary IS DISTINCT FROM OLD.summary
       OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
       OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id
       OR NEW.recorded_audit_id IS DISTINCT FROM OLD.recorded_audit_id
    THEN
        RAISE EXCEPTION 'commercial.legal_evidence_records is immutable: the recorded facts cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.status = 'retired' THEN
        RAISE EXCEPTION 'commercial.legal_evidence_records is retired and permanently immutable: record a new evidence key instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (OLD.status = 'recorded' AND NEW.status = 'retired') THEN
            RAISE EXCEPTION 'commercial.legal_evidence_records transition % -> % is not permitted', OLD.status, NEW.status
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.retired_at IS NULL
           OR NEW.retired_at < now() - INTERVAL '1 minute'
           OR NEW.retired_at > now() + INTERVAL '1 minute'
        THEN
            RAISE EXCEPTION 'commercial.legal_evidence_records retired_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF NEW.retired_at IS DISTINCT FROM OLD.retired_at
       OR NEW.retired_by_user_id IS DISTINCT FROM OLD.retired_by_user_id
       OR NEW.retired_audit_id IS DISTINCT FROM OLD.retired_audit_id
    THEN
        RAISE EXCEPTION 'commercial.legal_evidence_records retirement facts are written only by the retirement transition'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_ler_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.legal_evidence_records
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_legal_evidence_lifecycle();

/*
 * Strictly ascending means every member is greater than its predecessor, so
 * a set carries no duplicate and its order is canonical. IMMUTABLE because a
 * CHECK expression must be; it reads nothing but its argument.
 */
CREATE OR REPLACE FUNCTION commercial.smallint_array_is_strictly_ascending(p_values SMALLINT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(
        (SELECT bool_and(v > lag)
           FROM (SELECT v, lag(v) OVER (ORDER BY ord) AS lag
                   FROM unnest(p_values) WITH ORDINALITY AS t(v, ord)) AS s
          WHERE lag IS NOT NULL),
        TRUE
    ) AND (p_values IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM unnest(p_values) AS u(v) WHERE v IS NULL);
$$;

-- ==========================================================================
-- commercial.booking_outcome_policies — the stable key of the numeric family
-- ==========================================================================

CREATE TABLE commercial.booking_outcome_policies (
    policy_key VARCHAR(64) PRIMARY KEY,

    /* Administrative prose. Never customer-facing text: that is the copy family. */
    display_name VARCHAR(120) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    CONSTRAINT ck_bop_key_shape CHECK (policy_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    CONSTRAINT ck_bop_display_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_bop_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    )
);

-- ==========================================================================
-- commercial.booking_outcome_policy_versions — immutable ranges and sets
-- ==========================================================================

CREATE TABLE commercial.booking_outcome_policy_versions (
    id UUID PRIMARY KEY,

    policy_key VARCHAR(64) NOT NULL REFERENCES commercial.booking_outcome_policies (policy_key),
    version INTEGER NOT NULL,
    lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'draft',

    /*
     * The two sets a seller chooses inside (`#42b`). Non-empty, strictly
     * ascending, whole units, representationally bounded (one year of hours,
     * one day of minutes). A set with one member is legal — it is still the
     * administrator's published range, not a code value.
     */
    cutoff_hours_allowed SMALLINT[] NOT NULL,
    no_show_grace_minutes_allowed SMALLINT[] NOT NULL,

    /* Administrator values `V33-DEC-039` R8–R12 name. NOT NULL, NO DEFAULT. */
    reschedule_free_count_before_cutoff SMALLINT NOT NULL,
    dispute_window_hours SMALLINT NOT NULL,
    /* Nullable; never shorter than the normal window (`V33-DEC-039` R9). */
    bodily_harm_window_hours SMALLINT,
    appeal_window_hours SMALLINT NOT NULL,
    /* Nullable: "unconfigured" is a state ADR-051 §10 relies on, never a default. */
    case_file_retention_days SMALLINT,

    /*
     * The Legal-cap rule (`V33-DEC-039` R5). Same closed shape as a retention
     * option, minus `none` (an absent cap is NULL, not a `none` rule), and it
     * exists ONLY together with a reference to a Legal-evidence record.
     */
    legal_cap_kind VARCHAR(32),
    legal_cap_basis_points INTEGER,
    legal_cap_amount_toman BIGINT,
    legal_evidence_id UUID REFERENCES commercial.legal_evidence_records (id),

    contract_version SMALLINT NOT NULL DEFAULT 1,

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

    CONSTRAINT uq_bopv_key_version UNIQUE (policy_key, version),
    CONSTRAINT ck_bopv_version CHECK (version >= 1),
    CONSTRAINT ck_bopv_contract_version CHECK (contract_version >= 1),
    CONSTRAINT ck_bopv_lifecycle CHECK (lifecycle_state IN ('draft', 'published', 'retired')),

    /* Sets: non-empty, whole, bounded, strictly ascending (no duplicate member). */
    CONSTRAINT ck_bopv_cutoff_set CHECK (
        cardinality(cutoff_hours_allowed) BETWEEN 1 AND 64
        AND 0 <= ALL (cutoff_hours_allowed)
        AND 8760 >= ALL (cutoff_hours_allowed)
        AND commercial.smallint_array_is_strictly_ascending(cutoff_hours_allowed)
    ),
    CONSTRAINT ck_bopv_grace_set CHECK (
        cardinality(no_show_grace_minutes_allowed) BETWEEN 1 AND 64
        AND 0 <= ALL (no_show_grace_minutes_allowed)
        AND 1440 >= ALL (no_show_grace_minutes_allowed)
        AND commercial.smallint_array_is_strictly_ascending(no_show_grace_minutes_allowed)
    ),

    CONSTRAINT ck_bopv_reschedule_free_count CHECK (reschedule_free_count_before_cutoff BETWEEN 0 AND 100),
    CONSTRAINT ck_bopv_dispute_window CHECK (dispute_window_hours BETWEEN 1 AND 8760),
    CONSTRAINT ck_bopv_bodily_harm_window CHECK (
        bodily_harm_window_hours IS NULL
        OR (bodily_harm_window_hours BETWEEN 1 AND 8760 AND bodily_harm_window_hours >= dispute_window_hours)
    ),
    CONSTRAINT ck_bopv_appeal_window CHECK (appeal_window_hours BETWEEN 1 AND 8760),
    CONSTRAINT ck_bopv_case_file_retention CHECK (
        case_file_retention_days IS NULL OR case_file_retention_days BETWEEN 1 AND 3650
    ),

    /* The cap's shape, exhaustively; `none` is not a cap. */
    CONSTRAINT ck_bopv_legal_cap_kind CHECK (
        legal_cap_kind IS NULL OR legal_cap_kind IN ('percentage_of_collected', 'fixed_toman', 'full_collected')
    ),
    CONSTRAINT ck_bopv_legal_cap_shape CHECK (
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
    /* A cap exists IF AND ONLY IF it references evidence (ADR-051 §5). */
    CONSTRAINT ck_bopv_legal_cap_requires_evidence CHECK (
        (legal_cap_kind IS NULL AND legal_evidence_id IS NULL)
        OR (legal_cap_kind IS NOT NULL AND legal_evidence_id IS NOT NULL)
    ),

    CONSTRAINT ck_bopv_activation_start_pairing CHECK (
        (lifecycle_state = 'draft' AND activation_starts_at IS NULL)
        OR (lifecycle_state <> 'draft' AND activation_starts_at IS NOT NULL)
    ),
    CONSTRAINT ck_bopv_window CHECK (
        activation_ends_at IS NULL OR activation_starts_at IS NULL OR activation_ends_at > activation_starts_at
    ),
    CONSTRAINT ck_bopv_not_retroactive CHECK (
        lifecycle_state = 'draft' OR (published_at IS NOT NULL AND activation_starts_at >= published_at)
    ),
    CONSTRAINT ck_bopv_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),
    CONSTRAINT ck_bopv_published_actor CHECK (
        (lifecycle_state = 'draft'
            AND published_at IS NULL AND published_by_user_id IS NULL AND published_by_label IS NULL)
        OR (lifecycle_state <> 'draft'
            AND published_at IS NOT NULL
            AND ((published_by_user_id IS NOT NULL AND published_by_label IS NULL)
              OR (published_by_user_id IS NULL AND published_by_label IS NOT NULL)))
    ),
    CONSTRAINT ck_bopv_retired_actor CHECK (
        (lifecycle_state <> 'retired'
            AND retired_at IS NULL AND retired_by_user_id IS NULL AND retired_by_label IS NULL)
        OR (lifecycle_state = 'retired'
            AND retired_at IS NOT NULL
            AND ((retired_by_user_id IS NOT NULL AND retired_by_label IS NULL)
              OR (retired_by_user_id IS NULL AND retired_by_label IS NOT NULL)))
    )
);

/*
 * Two versions of one policy key are never effective at the same instant.
 * The EFFECTIVE window (Story #83's corrected expression), half-open, partial
 * on non-draft rows, over the key's whole timeline. See `20260906950001`.
 */
ALTER TABLE commercial.booking_outcome_policy_versions
    ADD CONSTRAINT ex_bopv_no_effective_overlap
    EXCLUDE USING gist (
        policy_key WITH =,
        commercial.booking_collection_policy_effective_window(
            activation_starts_at, activation_ends_at, lifecycle_state, retired_at
        ) WITH &&
    ) WHERE (lifecycle_state <> 'draft');

CREATE INDEX ix_bopv_key_state
    ON commercial.booking_outcome_policy_versions (policy_key, lifecycle_state, activation_starts_at DESC);

CREATE INDEX ix_bopv_legal_evidence
    ON commercial.booking_outcome_policy_versions (legal_evidence_id)
    WHERE legal_evidence_id IS NOT NULL;

-- ==========================================================================
-- commercial.booking_outcome_policy_retention_options — the selectable rules
-- ==========================================================================

CREATE TABLE commercial.booking_outcome_policy_retention_options (
    id UUID PRIMARY KEY,
    version_id UUID NOT NULL REFERENCES commercial.booking_outcome_policy_versions (id),

    /* Which outcome the option is offered for. Closed to the two `V33-DEC-039` names. */
    purpose VARCHAR(24) NOT NULL,
    /* Presentation order inside one purpose; not a value. */
    ordinal SMALLINT NOT NULL,

    kind VARCHAR(32) NOT NULL,
    basis_points INTEGER,
    amount_toman BIGINT,

    CONSTRAINT ck_bopro_purpose CHECK (purpose IN ('late_cancellation', 'no_show')),
    CONSTRAINT ck_bopro_ordinal CHECK (ordinal BETWEEN 0 AND 31),
    CONSTRAINT ck_bopro_kind CHECK (kind IN ('none', 'percentage_of_collected', 'fixed_toman', 'full_collected')),

    /*
     * Exactly the numeric field the kind needs and nothing else. `none` and
     * `full_collected` carry no number; a percentage carries only basis
     * points in 1..9999 (0 IS none and 10000 IS full_collected, and one option
     * per meaning is what makes a published set unambiguous); a fixed amount
     * carries only a positive integer toman.
     *
     * The explicit `IS NOT NULL` terms are load-bearing, not redundant: a CHECK
     * passes when its expression is NULL, so `NULL BETWEEN 1 AND 9999` would
     * otherwise admit a percentage option with no percentage. The real-
     * PostgreSQL suite proves each absent field is refused.
     */
    CONSTRAINT ck_bopro_shape CHECK (
        (kind IN ('none', 'full_collected') AND basis_points IS NULL AND amount_toman IS NULL)
        OR (kind = 'percentage_of_collected'
            AND basis_points IS NOT NULL AND basis_points BETWEEN 1 AND 9999 AND amount_toman IS NULL)
        OR (kind = 'fixed_toman'
            AND basis_points IS NULL AND amount_toman IS NOT NULL AND amount_toman > 0 AND amount_toman <= 10000000000000)
    ),

    CONSTRAINT uq_bopro_ordinal UNIQUE (version_id, purpose, ordinal),
    /* One option per MEANING within a purpose: NULLS NOT DISTINCT makes two `none` rows collide. */
    CONSTRAINT uq_bopro_meaning UNIQUE NULLS NOT DISTINCT (version_id, purpose, kind, basis_points, amount_toman)
);

CREATE INDEX ix_bopro_version ON commercial.booking_outcome_policy_retention_options (version_id, purpose, ordinal);

/*
 * Options are frozen with their version. While the version is a draft they
 * may be replaced as a whole; once it is published or retired, no option row
 * may be inserted, changed or deleted — the published set is what a seller
 * chose inside, and rewriting it would reinterpret every later selection.
 */
CREATE OR REPLACE FUNCTION commercial.enforce_booking_outcome_retention_option_freeze()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_state VARCHAR(16);
    v_version_id UUID;
BEGIN
    v_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;

    IF TG_OP = 'UPDATE' AND NEW.version_id IS DISTINCT FROM OLD.version_id THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_retention_options cannot move between versions'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT lifecycle_state INTO v_state
      FROM commercial.booking_outcome_policy_versions
     WHERE id = v_version_id
       FOR SHARE;

    IF v_state IS NULL THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_retention_options must belong to an existing version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_state <> 'draft' THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_retention_options are frozen once their version is published: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_bopro_freeze
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.booking_outcome_policy_retention_options
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_booking_outcome_retention_option_freeze();

-- ==========================================================================
-- Lifecycle, immutability and the publication preconditions of a version
-- ==========================================================================

CREATE OR REPLACE FUNCTION commercial.enforce_booking_outcome_version_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_late_options INTEGER;
    v_no_show_options INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions must be created as draft: publication is a transition, not an initial state'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions cannot be deleted once published: a version a booking may have snapshotted is not removable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.lifecycle_state = 'retired' THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions is retired and permanently immutable: restore earlier terms by publishing a new version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions identity is immutable: id, policy_key, version and the creation record cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
       AND NOT (
             (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published')
          OR (OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired')
       )
    THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions transition % -> % is not permitted: the lifecycle is draft -> published -> retired and never backwards',
            OLD.lifecycle_state, NEW.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Every term and the window, frozen the moment the version leaves draft.
    IF OLD.lifecycle_state <> 'draft' AND (
           NEW.cutoff_hours_allowed IS DISTINCT FROM OLD.cutoff_hours_allowed
        OR NEW.no_show_grace_minutes_allowed IS DISTINCT FROM OLD.no_show_grace_minutes_allowed
        OR NEW.reschedule_free_count_before_cutoff IS DISTINCT FROM OLD.reschedule_free_count_before_cutoff
        OR NEW.dispute_window_hours IS DISTINCT FROM OLD.dispute_window_hours
        OR NEW.bodily_harm_window_hours IS DISTINCT FROM OLD.bodily_harm_window_hours
        OR NEW.appeal_window_hours IS DISTINCT FROM OLD.appeal_window_hours
        OR NEW.case_file_retention_days IS DISTINCT FROM OLD.case_file_retention_days
        OR NEW.legal_cap_kind IS DISTINCT FROM OLD.legal_cap_kind
        OR NEW.legal_cap_basis_points IS DISTINCT FROM OLD.legal_cap_basis_points
        OR NEW.legal_cap_amount_toman IS DISTINCT FROM OLD.legal_cap_amount_toman
        OR NEW.legal_evidence_id IS DISTINCT FROM OLD.legal_evidence_id
        OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
        OR NEW.activation_starts_at IS DISTINCT FROM OLD.activation_starts_at
        OR NEW.activation_ends_at IS DISTINCT FROM OLD.activation_ends_at
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
        OR NEW.published_by_label IS DISTINCT FROM OLD.published_by_label
    ) THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions is published and its terms are immutable: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published' THEN
        IF NEW.published_at IS NULL OR NEW.activation_starts_at IS NULL THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions publication must set published_at and activation_starts_at'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.published_at < now() - INTERVAL '1 minute' OR NEW.published_at > now() + INTERVAL '1 minute' THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions published_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.activation_starts_at < NEW.published_at THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions cannot activate before it is published: an ordinary publication is never retroactive'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.activation_ends_at IS NOT NULL AND NEW.activation_ends_at <= NEW.activation_starts_at THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions cannot be published with an activation end at or before its start'
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- A published version offers at least one option per purpose; a set
        -- with nothing to choose inside is not a range, it is an absence.
        SELECT count(*) FILTER (WHERE purpose = 'late_cancellation'),
               count(*) FILTER (WHERE purpose = 'no_show')
          INTO v_late_options, v_no_show_options
          FROM commercial.booking_outcome_policy_retention_options
         WHERE version_id = NEW.id;
        IF v_late_options = 0 OR v_no_show_options = 0 THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions cannot be published without at least one retention option for each purpose'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired' THEN
        IF NEW.retired_at IS NULL
           OR NEW.retired_at < now() - INTERVAL '1 minute'
           OR NEW.retired_at > now() + INTERVAL '1 minute'
        THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions retired_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_bopv_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.booking_outcome_policy_versions
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_booking_outcome_version_lifecycle();

-- ==========================================================================
-- The Legal-cap gate (ADR-051 §5) — the load-bearing trigger
-- ==========================================================================
--
-- Named exactly as ADR-051 names it. It runs AFTER the lifecycle trigger (by
-- name order, `tg_bopv_lifecycle` < `tg_bopv_require_evidence`) on every
-- INSERT or UPDATE that carries a cap:
--
--   * whenever a cap or its reference is written (draft included), the
--     referenced record must EXIST and have subject `retention_cap` -- a draft
--     may not point at evidence about something else;
--   * at PUBLICATION (draft -> published), the referenced record must
--     additionally be `recorded` right now. A record retired before
--     publication refuses it; a record retired AFTER publication rewrites
--     nothing here (published rows are immutable) -- the runtime consequence
--     of a later retirement is `#42c`'s evaluator, not this migration.
--
-- Retiring an evidence record therefore never touches a published version,
-- and no published version can carry a cap without a qualifying reference.

CREATE OR REPLACE FUNCTION commercial.require_valid_legal_evidence_for_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_subject VARCHAR(40);
    v_status VARCHAR(16);
    v_publishing BOOLEAN;
    v_cap_written BOOLEAN;
BEGIN
    IF NEW.legal_cap_kind IS NULL THEN
        RETURN NEW;
    END IF;

    v_publishing := TG_OP = 'UPDATE' AND OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published';
    v_cap_written := TG_OP = 'INSERT'
        OR NEW.legal_cap_kind IS DISTINCT FROM OLD.legal_cap_kind
        OR NEW.legal_cap_basis_points IS DISTINCT FROM OLD.legal_cap_basis_points
        OR NEW.legal_cap_amount_toman IS DISTINCT FROM OLD.legal_cap_amount_toman
        OR NEW.legal_evidence_id IS DISTINCT FROM OLD.legal_evidence_id;

    IF NOT (v_publishing OR v_cap_written) THEN
        RETURN NEW;
    END IF;

    IF NEW.legal_evidence_id IS NULL THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions: a legal cap requires a Legal-evidence reference'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT subject, status INTO v_subject, v_status
      FROM commercial.legal_evidence_records
     WHERE id = NEW.legal_evidence_id
       FOR SHARE;

    IF v_subject IS NULL THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions: the referenced Legal-evidence record does not exist'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_subject <> 'retention_cap' THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions: a legal cap may reference only evidence of subject retention_cap'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_publishing AND v_status <> 'recorded' THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions: a legal cap cannot be published against evidence that is not currently recorded'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_bopv_require_evidence
    BEFORE INSERT OR UPDATE ON commercial.booking_outcome_policy_versions
    FOR EACH ROW
    EXECUTE FUNCTION commercial.require_valid_legal_evidence_for_cap();

/* The key never changes and is never deleted (Story #83's rule, restated). */
CREATE OR REPLACE FUNCTION commercial.reject_booking_outcome_policy_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policies rows are permanent: a policy key is the stable identity versions and selections refer to'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policies identity is immutable: the key and its creation record cannot be rewritten'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_booking_outcome_policies_immutable
    BEFORE UPDATE OR DELETE ON commercial.booking_outcome_policies
    FOR EACH ROW
    EXECUTE FUNCTION commercial.reject_booking_outcome_policy_rewrite();

-- ==========================================================================
-- commercial.customer_policy_copies / _versions — Persian text as data
-- ==========================================================================

CREATE TABLE commercial.customer_policy_copies (
    copy_key VARCHAR(64) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    CONSTRAINT ck_cpc_key_shape CHECK (copy_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    CONSTRAINT ck_cpc_display_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_cpc_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    )
);

CREATE TABLE commercial.customer_policy_copy_versions (
    id UUID PRIMARY KEY,
    copy_key VARCHAR(64) NOT NULL REFERENCES commercial.customer_policy_copies (copy_key),
    version INTEGER NOT NULL,
    lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'draft',

    /* Exactly one locale in this contract. A second is a decision, not a default. */
    locale VARCHAR(8) NOT NULL,

    /*
     * The Persian text, as data. There is NO number here — no hour, minute,
     * percentage, amount or window — by construction: every number a
     * customer sees is rendered from a numeric snapshot, so the text cannot
     * drift from the terms (ADR-051 §1). The hash is computed by the DATABASE
     * from the body, so a stored hash can never disagree with the stored text.
     */
    body TEXT NOT NULL,
    body_sha256 CHAR(64) NOT NULL,

    contract_version SMALLINT NOT NULL DEFAULT 1,

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

    CONSTRAINT uq_cpcv_key_version UNIQUE (copy_key, version),
    CONSTRAINT ck_cpcv_version CHECK (version >= 1),
    CONSTRAINT ck_cpcv_contract_version CHECK (contract_version >= 1),
    CONSTRAINT ck_cpcv_lifecycle CHECK (lifecycle_state IN ('draft', 'published', 'retired')),
    CONSTRAINT ck_cpcv_locale CHECK (locale = 'fa-IR'),
    CONSTRAINT ck_cpcv_body CHECK (length(btrim(body)) >= 1 AND octet_length(body) <= 65536),
    CONSTRAINT ck_cpcv_body_hash CHECK (body_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex')),

    CONSTRAINT ck_cpcv_activation_start_pairing CHECK (
        (lifecycle_state = 'draft' AND activation_starts_at IS NULL)
        OR (lifecycle_state <> 'draft' AND activation_starts_at IS NOT NULL)
    ),
    CONSTRAINT ck_cpcv_window CHECK (
        activation_ends_at IS NULL OR activation_starts_at IS NULL OR activation_ends_at > activation_starts_at
    ),
    CONSTRAINT ck_cpcv_not_retroactive CHECK (
        lifecycle_state = 'draft' OR (published_at IS NOT NULL AND activation_starts_at >= published_at)
    ),
    CONSTRAINT ck_cpcv_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),
    CONSTRAINT ck_cpcv_published_actor CHECK (
        (lifecycle_state = 'draft'
            AND published_at IS NULL AND published_by_user_id IS NULL AND published_by_label IS NULL)
        OR (lifecycle_state <> 'draft'
            AND published_at IS NOT NULL
            AND ((published_by_user_id IS NOT NULL AND published_by_label IS NULL)
              OR (published_by_user_id IS NULL AND published_by_label IS NOT NULL)))
    ),
    CONSTRAINT ck_cpcv_retired_actor CHECK (
        (lifecycle_state <> 'retired'
            AND retired_at IS NULL AND retired_by_user_id IS NULL AND retired_by_label IS NULL)
        OR (lifecycle_state = 'retired'
            AND retired_at IS NOT NULL
            AND ((retired_by_user_id IS NOT NULL AND retired_by_label IS NULL)
              OR (retired_by_user_id IS NULL AND retired_by_label IS NOT NULL)))
    )
);

ALTER TABLE commercial.customer_policy_copy_versions
    ADD CONSTRAINT ex_cpcv_no_effective_overlap
    EXCLUDE USING gist (
        copy_key WITH =,
        commercial.booking_collection_policy_effective_window(
            activation_starts_at, activation_ends_at, lifecycle_state, retired_at
        ) WITH &&
    ) WHERE (lifecycle_state <> 'draft');

CREATE INDEX ix_cpcv_key_state
    ON commercial.customer_policy_copy_versions (copy_key, lifecycle_state, activation_starts_at DESC);

CREATE OR REPLACE FUNCTION commercial.enforce_customer_policy_copy_version_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.customer_policy_copy_versions must be created as draft: publication is a transition, not an initial state'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.customer_policy_copy_versions cannot be deleted once published: text a customer may have accepted is not removable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.lifecycle_state = 'retired' THEN
        RAISE EXCEPTION 'commercial.customer_policy_copy_versions is retired and permanently immutable: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.copy_key IS DISTINCT FROM OLD.copy_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.customer_policy_copy_versions identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
       AND NOT (
             (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published')
          OR (OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired')
       )
    THEN
        RAISE EXCEPTION 'commercial.customer_policy_copy_versions transition % -> % is not permitted: the lifecycle is draft -> published -> retired and never backwards',
            OLD.lifecycle_state, NEW.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.lifecycle_state <> 'draft' AND (
           NEW.locale IS DISTINCT FROM OLD.locale
        OR NEW.body IS DISTINCT FROM OLD.body
        OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256
        OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
        OR NEW.activation_starts_at IS DISTINCT FROM OLD.activation_starts_at
        OR NEW.activation_ends_at IS DISTINCT FROM OLD.activation_ends_at
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
        OR NEW.published_by_label IS DISTINCT FROM OLD.published_by_label
    ) THEN
        RAISE EXCEPTION 'commercial.customer_policy_copy_versions is published and its text is immutable: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published' THEN
        IF NEW.published_at IS NULL OR NEW.activation_starts_at IS NULL THEN
            RAISE EXCEPTION 'commercial.customer_policy_copy_versions publication must set published_at and activation_starts_at'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.published_at < now() - INTERVAL '1 minute' OR NEW.published_at > now() + INTERVAL '1 minute' THEN
            RAISE EXCEPTION 'commercial.customer_policy_copy_versions published_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.activation_starts_at < NEW.published_at THEN
            RAISE EXCEPTION 'commercial.customer_policy_copy_versions cannot activate before it is published: an ordinary publication is never retroactive'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.activation_ends_at IS NOT NULL AND NEW.activation_ends_at <= NEW.activation_starts_at THEN
            RAISE EXCEPTION 'commercial.customer_policy_copy_versions cannot be published with an activation end at or before its start'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired' THEN
        IF NEW.retired_at IS NULL
           OR NEW.retired_at < now() - INTERVAL '1 minute'
           OR NEW.retired_at > now() + INTERVAL '1 minute'
        THEN
            RAISE EXCEPTION 'commercial.customer_policy_copy_versions retired_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_cpcv_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.customer_policy_copy_versions
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_customer_policy_copy_version_lifecycle();

CREATE OR REPLACE FUNCTION commercial.reject_customer_policy_copy_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commercial.customer_policy_copies rows are permanent: a copy key is the stable identity versions and acceptances refer to'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.copy_key IS DISTINCT FROM OLD.copy_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.customer_policy_copies identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_customer_policy_copies_immutable
    BEFORE UPDATE OR DELETE ON commercial.customer_policy_copies
    FOR EACH ROW
    EXECUTE FUNCTION commercial.reject_customer_policy_copy_rewrite();

-- ---------------------------------------------------------------------------
-- No seed. Deliberately, and this comment is the record of it.
--
-- `V33-DEC-039` endorsed initial ADMINISTRATOR PUBLICATION values; it ratified
-- no code value, and ADR-051 forbids one. No policy, version, option, copy,
-- copy version or evidence row is written here. Every table above ends this
-- migration empty, and a repository test proves a planted seed would be
-- detected.
-- ---------------------------------------------------------------------------
