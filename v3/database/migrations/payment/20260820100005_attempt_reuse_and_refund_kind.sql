-- Closes a double-charge hole found during Phase 2 live QA.
--
-- Observed: a retried `POST /v1/bookings` correctly returned the SAME
-- booking and order (idempotency working), but `initiate()` was called
-- again unconditionally -- producing a SECOND payment attempt with its own
-- gateway reference. Two live references for one intent means two
-- separately-chargeable gateway transactions, and the second charge would
-- have been silently absorbed: verifying it would win its own attempt CAS,
-- then find the order already paid and report a harmless-looking "replayed".
--
-- Two changes, cause and backstop:
--
--   redirect_url  -- lets initiate() REUSE a live attempt instead of opening
--                    a second one, which removes the cause.
--   refunds.kind  -- distinguishes an ORDER refund from a DUPLICATE-CHARGE
--                    correction. The backstop refunds a genuine second
--                    charge, and the kind stops that correction from being
--                    mistaken for a refund of the order itself (which would
--                    wrongly drive the order to `refunded` and reverse a
--                    commission that was only ever earned once).

ALTER TABLE payment.payment_attempts
    ADD COLUMN redirect_url TEXT;

ALTER TABLE payment.refunds
    ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'order';

ALTER TABLE payment.refunds
    ADD CONSTRAINT ck_refunds_kind CHECK (kind IN ('order', 'duplicate_charge'));

-- At most one attempt may be awaiting a gateway result per intent. A second
-- live attempt is exactly the double-charge condition above, so it is now
-- unrepresentable rather than merely avoided by application code.
CREATE UNIQUE INDEX uq_payment_attempts_live_per_intent
    ON payment.payment_attempts (payment_intent_id)
    WHERE status = 'initiated';
