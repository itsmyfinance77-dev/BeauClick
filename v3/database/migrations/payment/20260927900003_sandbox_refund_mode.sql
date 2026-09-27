-- ---------------------------------------------------------------------------
-- DEMO BRANCH ONLY — #212 simulator: a sandbox transaction whose simulated bank
-- has NO refund API.
--
-- #212 (ADR-051 §8) lets a customer switch a non-customer-cause cancellation's
-- refund to a free reschedule only while that refund is `pending` or
-- `manual_required`. The sandbox refunds instantly (`succeeded`), so that state
-- was unreachable in a demo. A real gateway without a refund API produces
-- exactly `manual_required` (PaymentService: `supportsAutomaticRefund=false`).
--
-- Per TRANSACTION, chosen explicitly on the sandbox checkout page, so nothing
-- else (A, B, late capture, any other refund) changes. The sandbox provider is
-- disabled outright under NODE_ENV=production, so this cannot reach production.
-- Existing rows default to `automatic` = today's behaviour.
-- ---------------------------------------------------------------------------

ALTER TABLE payment.sandbox_transactions
    ADD COLUMN refund_mode VARCHAR(10) NOT NULL DEFAULT 'automatic';

ALTER TABLE payment.sandbox_transactions
    ADD CONSTRAINT ck_sandbox_transactions_refund_mode CHECK (refund_mode IN ('automatic', 'manual'));
