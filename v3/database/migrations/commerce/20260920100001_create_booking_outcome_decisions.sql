-- ---------------------------------------------------------------------------
-- V3.3 Story #160 (`#42c`) — the booking outcome decision: one immutable
-- money fact per booking and kind (ADR-051 §6 with its 2026-09-15 consistency
-- note; `V33-DEC-039` R1, R2, R4, R5, R8, R14; `V33-DEC-028` Rulings 4 and 8).
--
-- ## What a row is
--
-- The single closed decision about what happens to the money BeauClick
-- collected for one booking, when that booking is cancelled or rescheduled.
-- It is evaluated once, by the pure `evaluateBookingOutcome`, from the order's
-- immutable `commerce.order_outcome_terms` snapshot (or its absence), the
-- booking's database-clock facts and the Legal-evidence status read at the
-- decision instant. The refund that executes it is a separate payment fact.
--
-- ## Every retention is unwritable unless every ratified input is present
--
-- The CHECKs below are not a second copy of the evaluator. They are the
-- ceiling the evaluator cannot exceed even if it were wrong: a non-zero
-- retention can exist only as basis `cap_applied`, which itself can exist
-- only for a customer's late cancellation of a confirmed booking, against an
-- applied Legal cap, at exactly `LEAST(policy, cap, collected remaining)`.
-- A `reschedule_consequence` can carry no money at all: its money and
-- acceptance meaning is not ratified (`V33-DEC-039` R8), so it is dormant.
--
-- ## Mutability, precisely
--
-- Every column is frozen at insert except two, each of which moves forward
-- exactly once: `execution_status` (`pending → executed | manual_required |
-- failed`, recording the refund that executed the decision) and
-- `superseded_by_id` (`NULL → id`, when a later decision of the same kind
-- replaces this one). DELETE is refused. ADR-051 §6 called the table
-- "append-only"; that was not implementable with an execution status and a
-- supersession pointer, and the 2026-09-15 note records the correction.
--
-- ## No value, no seed, no alteration
--
-- No row is created here, no existing table is altered, and no number appears
-- below except the database's own vocabulary and bounds.
-- ---------------------------------------------------------------------------

CREATE TABLE commerce.booking_outcome_decisions (
    id UUID PRIMARY KEY,

    /* The booking decided. No cross-schema FK, by the platform's convention. */
    booking_id UUID NOT NULL,
    order_id UUID NOT NULL REFERENCES commerce.orders (id),

    decision_kind VARCHAR(32) NOT NULL,
    /* Derived server-side from the booking's recorded actor; never client-supplied. */
    cause VARCHAR(16) NOT NULL,

    /*
     * THE INSTANT THE OUTCOME IS JUDGED AT (`V33-DEC-039` R4): the database
     * clock of the cancelling (or rescheduling) transaction, copied by value.
     * For a cancellation it is the booking's `cancelled` history row's
     * `created_at`, NOT the later refund consumer's `now()`.
     */
    event_instant TIMESTAMPTZ NOT NULL,
    /* When this row was written: the deciding transaction's clock (trigger-enforced). */
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* Whether the booking had been confirmed before the event (`V33-DEC-039` R1). */
    booking_was_confirmed BOOLEAN NOT NULL,

    /* The snapshot the decision read; both NULL for a `legacy_unenrolled` order. */
    policy_key VARCHAR(64),
    policy_version INTEGER,

    /* `slot_start − cutoff_hours`, and `event_instant <= cutoff_instant`, both computed in SQL. */
    cutoff_instant TIMESTAMPTZ,
    timely BOOLEAN,

    collected_remaining_toman BIGINT NOT NULL,
    policy_amount_toman BIGINT NOT NULL,
    legal_cap_toman BIGINT,
    legal_cap_state VARCHAR(16) NOT NULL,
    retained_toman BIGINT NOT NULL,
    refund_toman BIGINT NOT NULL,

    /* Why the amounts are what they are, in a closed vocabulary. */
    basis VARCHAR(32) NOT NULL,

    execution_status VARCHAR(16) NOT NULL,
    refund_request_key VARCHAR(128),

    superseded_by_id UUID REFERENCES commerce.booking_outcome_decisions (id) DEFERRABLE INITIALLY DEFERRED,

    -- --- vocabularies ---------------------------------------------------------
    /* ADR-051 §6's binding vocabulary. */
    CONSTRAINT ck_bod_kind CHECK (
        decision_kind IN ('cancellation', 'no_show', 'reschedule_consequence', 'dispute_outcome')
    ),
    /*
     * The two kinds this story defines rules for. `no_show` (#161) and
     * `dispute_outcome` (#162) are refused until the story that defines their
     * rules replaces this constraint — a kind with no kind-specific CHECK must
     * not be writable in the meantime.
     */
    CONSTRAINT ck_bod_kind_defined CHECK (decision_kind IN ('cancellation', 'reschedule_consequence')),
    CONSTRAINT ck_bod_cause CHECK (
        cause IN ('customer', 'seller', 'platform', 'provider', 'force_majeure', 'no_show')
    ),
    CONSTRAINT ck_bod_legal_cap_state CHECK (legal_cap_state IN ('applied', 'absent', 'retired')),
    CONSTRAINT ck_bod_basis CHECK (
        basis IN ('legacy_unenrolled', 'invalid_terms', 'non_customer_cause', 'not_confirmed', 'timely',
                  'cap_absent', 'cap_retired', 'cap_applied', 'pre_existing_refund')
    ),
    CONSTRAINT ck_bod_execution_status CHECK (
        execution_status IN ('pending', 'executed', 'manual_required', 'failed')
    ),

    -- --- shapes ---------------------------------------------------------------
    CONSTRAINT ck_bod_non_negative CHECK (
        collected_remaining_toman >= 0 AND policy_amount_toman >= 0
        AND retained_toman >= 0 AND refund_toman >= 0
        AND (legal_cap_toman IS NULL OR legal_cap_toman >= 0)
    ),
    CONSTRAINT ck_bod_policy_pair CHECK ((policy_key IS NULL) = (policy_version IS NULL)),
    CONSTRAINT ck_bod_cap_pair CHECK ((legal_cap_state = 'applied') = (legal_cap_toman IS NOT NULL)),
    CONSTRAINT ck_bod_timely_pair CHECK ((timely IS NULL) = (cutoff_instant IS NULL)),
    /* A `timely` that disagrees with its own instants is unwritable (R4: the boundary is timely). */
    CONSTRAINT ck_bod_timely_is_boundary CHECK (timely IS NULL OR timely = (event_instant <= cutoff_instant)),
    CONSTRAINT ck_bod_event_not_after_decision CHECK (event_instant <= decided_at),
    /* A legacy order read no terms, so it can carry no terms-derived fact. */
    CONSTRAINT ck_bod_legacy_reads_nothing CHECK (
        policy_key IS NOT NULL
        OR (cutoff_instant IS NULL AND legal_cap_state = 'absent' AND policy_amount_toman = 0)
    ),

    -- --- the retention ceiling -----------------------------------------------
    CONSTRAINT ck_bod_retained_within_collected CHECK (retained_toman <= collected_remaining_toman),
    /* No retention without an applied Legal cap (ADR-051 §5, `V33-DEC-039` R5). */
    CONSTRAINT ck_bod_retention_requires_cap_applied CHECK (retained_toman = 0 OR basis = 'cap_applied'),
    CONSTRAINT ck_bod_cap_applied_preconditions CHECK (
        basis <> 'cap_applied'
        OR (cause = 'customer'
            AND booking_was_confirmed
            AND timely IS FALSE
            AND policy_key IS NOT NULL
            AND legal_cap_state = 'applied'
            AND retained_toman = LEAST(policy_amount_toman, legal_cap_toman, collected_remaining_toman))
    ),
    CONSTRAINT ck_bod_basis_consistent CHECK (
        (basis <> 'legacy_unenrolled' OR policy_key IS NULL)
        AND (basis <> 'non_customer_cause' OR cause <> 'customer')
        AND (basis <> 'not_confirmed' OR NOT booking_was_confirmed)
        AND (basis <> 'timely' OR timely IS TRUE)
        AND (basis <> 'cap_absent' OR legal_cap_state = 'absent')
        AND (basis <> 'cap_retired' OR legal_cap_state = 'retired')
    ),

    -- --- per kind ----------------------------------------------------------------
    /* A cancellation divides exactly what remains collected: nothing appears, nothing vanishes. */
    CONSTRAINT ck_bod_cancellation_sum CHECK (
        decision_kind <> 'cancellation' OR retained_toman + refund_toman = collected_remaining_toman
    ),
    /* The one booking-derived request key today's refund handler already uses. */
    CONSTRAINT ck_bod_cancellation_key CHECK (
        decision_kind <> 'cancellation' OR refund_request_key = 'booking-cancelled:' || booking_id::text
    ),
    /* DORMANT: a reschedule consequence carries no money until its semantics are ratified (R8). */
    CONSTRAINT ck_bod_reschedule_consequence_dormant CHECK (
        decision_kind <> 'reschedule_consequence'
        OR (cause = 'customer' AND retained_toman = 0 AND refund_toman = 0
            AND execution_status = 'executed' AND refund_request_key IS NULL)
    ),

    -- --- execution ---------------------------------------------------------------
    /* Nothing to execute is executed; only a positive refund can wait. */
    CONSTRAINT ck_bod_execution_needs_refund CHECK (refund_toman > 0 OR execution_status = 'executed')
);

/* ONE live decision per booking and kind (ADR-051 §6): the linearization point. */
CREATE UNIQUE INDEX uq_bod_one_live_per_kind
    ON commerce.booking_outcome_decisions (booking_id, decision_kind)
    WHERE superseded_by_id IS NULL;

CREATE INDEX ix_bod_order ON commerce.booking_outcome_decisions (order_id);

-- ==========================================================================
-- Integrity at insert: the database's clock, the order's own booking, the
-- order's own snapshot
-- ==========================================================================
--
-- A trigger because each fact lives on another row or on the transaction
-- clock, neither of which a CHECK can read. It reads only `commerce` tables.

CREATE OR REPLACE FUNCTION commerce.enforce_booking_outcome_decision_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_source_type VARCHAR(16);
    v_source_id UUID;
    v_terms_found BOOLEAN;
    v_policy_key VARCHAR(64);
    v_policy_version INTEGER;
BEGIN
    IF NEW.decided_at IS DISTINCT FROM now() THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions.decided_at must be the database transaction instant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT source_type, source_id INTO v_source_type, v_source_id
      FROM commerce.orders WHERE id = NEW.order_id;

    IF v_source_type IS DISTINCT FROM 'booking' OR v_source_id IS DISTINCT FROM NEW.booking_id THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions must decide the booking its order was created for'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT true, policy_key, policy_version INTO v_terms_found, v_policy_key, v_policy_version
      FROM commerce.order_outcome_terms WHERE order_id = NEW.order_id;

    IF COALESCE(v_terms_found, false) THEN
        IF NEW.policy_key IS DISTINCT FROM v_policy_key OR NEW.policy_version IS DISTINCT FROM v_policy_version THEN
            RAISE EXCEPTION 'commerce.booking_outcome_decisions must record the order''s own accepted terms'
                USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF NEW.policy_key IS NOT NULL THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions cannot name terms for an order that has none'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.superseded_by_id IS NOT NULL THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions cannot be born superseded'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_bod_integrity
    BEFORE INSERT ON commerce.booking_outcome_decisions
    FOR EACH ROW
    EXECUTE FUNCTION commerce.enforce_booking_outcome_decision_integrity();

-- ==========================================================================
-- Forward only: two columns move once; everything else is frozen; no DELETE
-- ==========================================================================

CREATE OR REPLACE FUNCTION commerce.enforce_booking_outcome_decision_forward_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions rows are permanent: a decision about money is never removed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.decision_kind IS DISTINCT FROM OLD.decision_kind
       OR NEW.cause IS DISTINCT FROM OLD.cause
       OR NEW.event_instant IS DISTINCT FROM OLD.event_instant
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.booking_was_confirmed IS DISTINCT FROM OLD.booking_was_confirmed
       OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
       OR NEW.cutoff_instant IS DISTINCT FROM OLD.cutoff_instant
       OR NEW.timely IS DISTINCT FROM OLD.timely
       OR NEW.collected_remaining_toman IS DISTINCT FROM OLD.collected_remaining_toman
       OR NEW.policy_amount_toman IS DISTINCT FROM OLD.policy_amount_toman
       OR NEW.legal_cap_toman IS DISTINCT FROM OLD.legal_cap_toman
       OR NEW.legal_cap_state IS DISTINCT FROM OLD.legal_cap_state
       OR NEW.retained_toman IS DISTINCT FROM OLD.retained_toman
       OR NEW.refund_toman IS DISTINCT FROM OLD.refund_toman
       OR NEW.basis IS DISTINCT FROM OLD.basis
       OR NEW.refund_request_key IS DISTINCT FROM OLD.refund_request_key
    THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions is immutable: only execution_status and superseded_by_id move, forward'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.execution_status IS DISTINCT FROM OLD.execution_status
       AND NOT (OLD.execution_status = 'pending' AND NEW.execution_status IN ('executed', 'manual_required', 'failed'))
    THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions.execution_status % -> % is not permitted: it moves once, forward from pending',
            OLD.execution_status, NEW.execution_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id
       AND NOT (OLD.superseded_by_id IS NULL AND NEW.superseded_by_id IS NOT NULL AND NEW.superseded_by_id <> OLD.id)
    THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions.superseded_by_id is set once and never changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_bod_forward_only
    BEFORE UPDATE OR DELETE ON commerce.booking_outcome_decisions
    FOR EACH ROW
    EXECUTE FUNCTION commerce.enforce_booking_outcome_decision_forward_only();

-- ==========================================================================
-- Supersession is by a live decision of the same booking and kind, at commit
-- ==========================================================================
--
-- DEFERRED, because the replacing row is inserted after the old row points at
-- it (the FK above is deferred for the same reason). #160 supersedes only a
-- reschedule consequence with the next one; `dispute_outcome` (#162) extends
-- this function when it defines its kind.

CREATE OR REPLACE FUNCTION commerce.require_booking_outcome_supersession_shape()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_booking_id UUID;
    v_kind VARCHAR(32);
    v_superseded UUID;
    v_decided_at TIMESTAMPTZ;
BEGIN
    IF NEW.superseded_by_id IS NULL OR NEW.superseded_by_id IS NOT DISTINCT FROM OLD.superseded_by_id THEN
        RETURN NULL;
    END IF;

    SELECT booking_id, decision_kind, superseded_by_id, decided_at
      INTO v_booking_id, v_kind, v_superseded, v_decided_at
      FROM commerce.booking_outcome_decisions WHERE id = NEW.superseded_by_id;

    IF v_booking_id IS DISTINCT FROM NEW.booking_id
       OR NEW.decision_kind <> 'reschedule_consequence'
       OR v_kind IS DISTINCT FROM 'reschedule_consequence'
       OR v_superseded IS NOT NULL
       OR v_decided_at < NEW.decided_at
    THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions may be superseded only by a later live decision of the same booking and kind'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tg_bod_supersession_shape
    AFTER UPDATE ON commerce.booking_outcome_decisions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION commerce.require_booking_outcome_supersession_shape();

-- ---------------------------------------------------------------------------
-- No backfill. A booking cancelled before this story keeps the refund it
-- already received; if its `BookingCancelled` is ever redelivered, the decision
-- written then records that refund truthfully (basis `pre_existing_refund`).
-- ---------------------------------------------------------------------------
