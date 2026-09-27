-- ---------------------------------------------------------------------------
-- DEMO BRANCH ONLY — F-10/F-11 (owner-approved option B). Design: demo/F10-DESIGN.md.
--
-- execution_status gains:
--   executing   — the durable claim taken BEFORE a refund is sent to the gateway
--                 (pending -> executing -> executed|manual_required|failed); a crash
--                 leaves `executing`, which blocks the #212 remedy (fail-closed) and
--                 is resumed by redelivery (the refund call is idempotent by key);
--   superseded  — the #212 reschedule won (pending -> superseded, or
--                 manual_required -> superseded together with its refund row).
-- manual_required -> executed is added for a recorded manual execution.
--
-- A cancellation decision consumed by the remedy (`superseded`) may itself be
-- superseded by a LATER cancellation decision of the same booking (F-11), whose
-- refund request key is `booking-cancelled:<booking>:after:<consumed decision>`.
-- ---------------------------------------------------------------------------

ALTER TABLE commerce.booking_outcome_decisions DROP CONSTRAINT ck_bod_execution_status;
ALTER TABLE commerce.booking_outcome_decisions
    ADD CONSTRAINT ck_bod_execution_status CHECK (
        execution_status IN ('pending', 'executing', 'executed', 'manual_required', 'failed', 'superseded')
    );

ALTER TABLE commerce.booking_outcome_decisions DROP CONSTRAINT ck_bod_cancellation_key;
ALTER TABLE commerce.booking_outcome_decisions
    ADD CONSTRAINT ck_bod_cancellation_key CHECK (
        decision_kind <> 'cancellation'
        OR refund_request_key = 'booking-cancelled:' || booking_id::text
        OR refund_request_key LIKE 'booking-cancelled:' || booking_id::text || ':after:%'
    );

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
       AND NOT (
            (OLD.execution_status = 'pending' AND NEW.execution_status IN ('executing', 'executed', 'manual_required', 'failed', 'superseded'))
         OR (OLD.execution_status = 'executing' AND NEW.execution_status IN ('executed', 'manual_required', 'failed'))
         OR (OLD.execution_status = 'manual_required' AND NEW.execution_status IN ('executed', 'superseded'))
       )
    THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions.execution_status % -> % is not permitted',
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
       OR v_kind IS DISTINCT FROM NEW.decision_kind
       OR v_superseded IS NOT NULL
       OR v_decided_at < NEW.decided_at
       OR NOT (
            NEW.decision_kind = 'reschedule_consequence'
            -- F-11: a cancellation decision consumed by the #212 remedy may be followed by a later cancellation.
            OR (NEW.decision_kind = 'cancellation' AND NEW.execution_status = 'superseded')
       )
    THEN
        RAISE EXCEPTION 'commerce.booking_outcome_decisions may be superseded only by a later live decision of the same booking and kind'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;
