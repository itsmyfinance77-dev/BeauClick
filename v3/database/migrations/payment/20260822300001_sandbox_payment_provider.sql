-- GAP-06 sandbox: evolve the local mock gateway into a full SANDBOX provider.
--
-- This is a RENAME-AND-EXTEND, deliberately, not a new parallel table. The
-- Phase 2 `mock_gateway_transactions` table already served exactly this
-- purpose -- it is the simulated bank's own books, which `verify()` must go
-- and ASK rather than trusting a callback -- so building a second sandbox
-- table alongside it would have produced two payment simulators, two
-- checkout pages, and two sets of security tests proving the same property.
-- What was genuinely missing is captured below.
--
-- 1. `cancelled` as an outcome DISTINCT from `declined`. The old CHECK
--    constraint permitted only pending/paid/declined, and the checkout page
--    offered a single "انصراف / پرداخت ناموفق" button that conflated the two.
--    They are not the same event: a customer abandoning checkout and a bank
--    refusing a card produce different `failureCode`s, and a QA engineer
--    reproducing a support ticket needs to choose between them.
-- 2. The correlating ids (`order_id`, `payment_intent_id`) and `currency`.
--    A real gateway records what it was asked to charge and for what; the
--    sandbox recording less than that made it a weaker simulation than it
--    needed to be, and made cross-checking an order against the gateway's
--    own books impossible in QA.
-- 3. `updated_at`, so a settled/refunded row shows WHEN it was decided --
--    the old table recorded only creation time.

ALTER TABLE payment.mock_gateway_transactions RENAME TO sandbox_transactions;

-- The old constraint name follows the old table name; renaming a table does
-- not rename its constraints, so this is dropped and re-added rather than
-- left behind under a name that no longer describes anything.
ALTER TABLE payment.sandbox_transactions DROP CONSTRAINT ck_mock_gateway_outcome;
ALTER TABLE payment.sandbox_transactions
    ADD CONSTRAINT ck_sandbox_outcome CHECK (outcome IN ('pending', 'paid', 'declined', 'cancelled'));

-- Nullable with no backfill: rows written before this migration were created
-- by the old provider, which genuinely never recorded these. Inventing a
-- value for them would be fabricating gateway history. Every row written
-- from now on carries them.
ALTER TABLE payment.sandbox_transactions ADD COLUMN order_id UUID;
ALTER TABLE payment.sandbox_transactions ADD COLUMN payment_intent_id UUID;
ALTER TABLE payment.sandbox_transactions ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'IRT';
ALTER TABLE payment.sandbox_transactions ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- QA looks a sandbox transaction up by the order it belongs to far more
-- often than by its opaque reference.
CREATE INDEX ix_sandbox_transactions_order_id ON payment.sandbox_transactions (order_id);
