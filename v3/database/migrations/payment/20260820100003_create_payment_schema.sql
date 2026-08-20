-- Phase 2, payment-service.
--
-- Two unique constraints carry the entire idempotency story, and both are
-- database-level rather than application convention:
--
--   1. uq_payment_intents_live_order -- a partial UNIQUE over orders whose
--      intent is still non-terminal. Double-clicking "pay" cannot open two
--      intents for one order, which is how a customer gets charged twice for
--      one booking.
--   2. uq_payment_attempts_provider_reference -- the gateway's own
--      transaction id is unique per provider. A replayed callback therefore
--      resolves to the SAME attempt row, giving the verification path exactly
--      one row to compare-and-swap and making double-processing impossible.

CREATE SCHEMA IF NOT EXISTS payment;

CREATE TABLE payment.payment_intents (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL,     -- references commerce.orders.id; no cross-schema FK by convention
    customer_id UUID NOT NULL,
    -- Captured before the customer ever reaches the gateway, so an order
    -- total mutated in the meantime cannot launder an amount mismatch.
    amount_toman BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'IRT',
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    provider_key VARCHAR(40) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    succeeded_at TIMESTAMPTZ,
    failure_code VARCHAR(60),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_payment_intents_status CHECK (
        status IN ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired')
    ),
    CONSTRAINT ck_payment_intents_amount CHECK (amount_toman >= 0),
    -- A succeeded intent must say when. Prevents a "paid" row with no
    -- timestamp, which downstream reconciliation would have to guess about.
    CONSTRAINT ck_payment_intents_succeeded_at CHECK (
        (status = 'succeeded' AND succeeded_at IS NOT NULL) OR status <> 'succeeded'
    )
);

CREATE UNIQUE INDEX uq_payment_intents_live_order
    ON payment.payment_intents (order_id)
    WHERE status IN ('created', 'pending', 'succeeded');

CREATE INDEX ix_payment_intents_order ON payment.payment_intents (order_id);
CREATE INDEX ix_payment_intents_expiring
    ON payment.payment_intents (expires_at)
    WHERE status IN ('created', 'pending');

CREATE TABLE payment.payment_attempts (
    id UUID PRIMARY KEY,
    payment_intent_id UUID NOT NULL REFERENCES payment.payment_intents (id),
    provider_key VARCHAR(40) NOT NULL,
    provider_reference VARCHAR(128) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'initiated',
    requested_amount_toman BIGINT NOT NULL,
    -- What the GATEWAY said it captured, learned only from server-to-server
    -- verification -- never from a callback parameter.
    verified_amount_toman BIGINT,
    provider_transaction_id VARCHAR(128),
    failure_code VARCHAR(60),
    provider_response JSONB,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_payment_attempts_status CHECK (status IN ('initiated', 'succeeded', 'failed')),
    CONSTRAINT ck_payment_attempts_amount CHECK (requested_amount_toman >= 0),
    -- A succeeded attempt must carry the amount the gateway confirmed.
    CONSTRAINT ck_payment_attempts_verified CHECK (
        (status = 'succeeded' AND verified_amount_toman IS NOT NULL AND verified_at IS NOT NULL)
        OR status <> 'succeeded'
    )
);

-- The callback-replay guard.
CREATE UNIQUE INDEX uq_payment_attempts_provider_reference
    ON payment.payment_attempts (provider_key, provider_reference);

CREATE INDEX ix_payment_attempts_intent ON payment.payment_attempts (payment_intent_id);

CREATE TABLE payment.refunds (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL,
    payment_intent_id UUID NOT NULL REFERENCES payment.payment_intents (id),
    payment_attempt_id UUID REFERENCES payment.payment_attempts (id),
    -- Deterministic per cause, so the same cause firing twice cannot refund
    -- twice -- the guarantee does not rely on a caller generating a fresh key.
    request_key VARCHAR(128) NOT NULL,
    amount_toman BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    provider_refund_reference VARCHAR(128),
    failure_code VARCHAR(60),
    reason VARCHAR(255) NOT NULL,
    requested_by_actor_type VARCHAR(16) NOT NULL,
    requested_by_actor_id UUID,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_refunds_status CHECK (status IN ('pending', 'succeeded', 'failed', 'manual_required')),
    CONSTRAINT ck_refunds_amount CHECK (amount_toman > 0),
    CONSTRAINT ck_refunds_actor CHECK (requested_by_actor_type IN ('customer', 'professional', 'system', 'admin'))
);

CREATE UNIQUE INDEX uq_refunds_order_request_key ON payment.refunds (order_id, request_key);
CREATE INDEX ix_refunds_order ON payment.refunds (order_id);

-- The local mock gateway's own books: a stand-in for the external bank's
-- records, not part of the payment domain. It is a real table specifically
-- so that verification has to ASK it -- exactly as a real adapter asks a
-- real gateway over HTTP. Only MockGatewayProvider ever touches it.
CREATE TABLE payment.mock_gateway_transactions (
    reference VARCHAR(128) PRIMARY KEY,
    amount_toman BIGINT NOT NULL,
    outcome VARCHAR(20) NOT NULL DEFAULT 'pending',
    settlement_reference VARCHAR(128),
    refund_reference VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_mock_gateway_outcome CHECK (outcome IN ('pending', 'paid', 'declined'))
);

CREATE TABLE payment.outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    event_version INT NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    published_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_payment_outbox_unpublished
    ON payment.outbox_events (id)
    WHERE published_at IS NULL;
