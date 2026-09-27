-- ---------------------------------------------------------------------------
-- DEMO BRANCH ONLY — F-10 (owner-approved option B): controlled manual-refund
-- execution + supersession of an unexecuted manual refund by the #212 remedy.
-- Design: demo/F10-DESIGN.md (state machines, lock order, limits).
--
-- 1. payment.refunds gains `superseded` (the customer's #212 reschedule won
--    before any manual execution was claimed). The row is KEPT with its amount;
--    no RefundCompleted is ever emitted for it; commitments/ceilings ignore it.
-- 2. `manual_tracked`: true only for refunds moved to manual_required by code
--    that records manual execution. Existing (legacy/unknown) manual_required
--    rows stay false and are never superseded — they are not presumed unpaid.
-- 3. payment.manual_refund_executions: the durable, exclusive execution claim
--    an operator must take BEFORE transferring money by hand. At most one
--    active (claimed/uncertain/executed) row per refund; no timeout release.
--
-- LIMIT: a database lock cannot stop a transfer made outside the system
-- without first taking the claim. Nothing here moves money.
-- ---------------------------------------------------------------------------

ALTER TABLE payment.refunds DROP CONSTRAINT ck_refunds_status;
ALTER TABLE payment.refunds
    ADD CONSTRAINT ck_refunds_status CHECK (status IN ('pending', 'succeeded', 'failed', 'manual_required', 'superseded'));

ALTER TABLE payment.refunds ADD COLUMN manual_tracked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payment.refunds ADD COLUMN superseded_at TIMESTAMPTZ;
ALTER TABLE payment.refunds
    ADD CONSTRAINT ck_refunds_superseded_pair CHECK ((status = 'superseded') = (superseded_at IS NOT NULL));

CREATE TABLE payment.manual_refund_executions (
    id UUID PRIMARY KEY,
    refund_id UUID NOT NULL REFERENCES payment.refunds (id),
    state VARCHAR(12) NOT NULL,
    claimed_by_user_id UUID NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_by_user_id UUID,
    resolved_at TIMESTAMPTZ,
    external_reference VARCHAR(128),
    note VARCHAR(500),
    CONSTRAINT ck_mre_state CHECK (state IN ('claimed', 'executed', 'uncertain', 'released')),
    CONSTRAINT ck_mre_resolution_pair CHECK ((state = 'claimed') = (resolved_at IS NULL AND resolved_by_user_id IS NULL)),
    CONSTRAINT ck_mre_executed_reference CHECK (state <> 'executed' OR (external_reference IS NOT NULL AND length(trim(external_reference)) > 0))
);

-- The exclusivity: one active claim per refund (released rows are history).
CREATE UNIQUE INDEX uq_manual_refund_executions_active
    ON payment.manual_refund_executions (refund_id)
    WHERE state IN ('claimed', 'uncertain', 'executed');
CREATE INDEX ix_manual_refund_executions_refund ON payment.manual_refund_executions (refund_id);

-- Forward only: claimed -> executed | uncertain | released; uncertain -> executed | released.
-- executed and released are terminal. No DELETE. Identity columns never change.
CREATE OR REPLACE FUNCTION payment.enforce_manual_refund_execution_forward_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'payment.manual_refund_executions rows are permanent' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.refund_id IS DISTINCT FROM OLD.refund_id
       OR NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
        RAISE EXCEPTION 'payment.manual_refund_executions identity is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'claimed' AND NEW.state IN ('executed', 'uncertain', 'released'))
        OR (OLD.state = 'uncertain' AND NEW.state IN ('executed', 'released'))
    ) THEN
        RAISE EXCEPTION 'payment.manual_refund_executions.state % -> % is not permitted', OLD.state, NEW.state
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_mre_forward_only
    BEFORE UPDATE OR DELETE ON payment.manual_refund_executions
    FOR EACH ROW
    EXECUTE FUNCTION payment.enforce_manual_refund_execution_forward_only();

-- Defence in depth on the refund itself: a supersession is only ever of a TRACKED
-- manual_required refund with no active or executed claim.
CREATE OR REPLACE FUNCTION payment.enforce_refund_supersession()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'superseded' AND OLD.status IS DISTINCT FROM 'superseded' THEN
        IF OLD.status <> 'manual_required' OR NOT OLD.manual_tracked THEN
            RAISE EXCEPTION 'payment.refunds: only a tracked manual_required refund can be superseded'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM payment.manual_refund_executions
                    WHERE refund_id = OLD.id AND state IN ('claimed', 'uncertain', 'executed')) THEN
            RAISE EXCEPTION 'payment.refunds: a refund with a claimed, uncertain or executed manual execution cannot be superseded'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    IF OLD.status = 'superseded' AND NEW.status IS DISTINCT FROM 'superseded' THEN
        RAISE EXCEPTION 'payment.refunds: a superseded refund is terminal' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_refunds_supersession
    BEFORE UPDATE ON payment.refunds
    FOR EACH ROW
    EXECUTE FUNCTION payment.enforce_refund_supersession();
