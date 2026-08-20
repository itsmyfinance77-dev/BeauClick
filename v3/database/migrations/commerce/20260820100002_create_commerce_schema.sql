-- Phase 2, commerce-service. A NATIVE order domain -- explicitly not a
-- re-implementation of WooCommerce, which does not exist in V3.
--
-- The two structural decisions here:
--
--   1. uq_orders_source -- UNIQUE(source_type, source_id). This is the
--      database-level closure of GAP-03: V2's booking->order creation had no
--      idempotency guard and "self-healed only by accident". A second
--      authoritative order for one booking is now impossible, whatever the
--      application does.
--   2. ck_orders_total_consistent -- the total is not an independently
--      writable number. It must equal subtotal - discount + fee, so an order
--      whose stored total disagrees with its own line items cannot be
--      persisted at all.
--
-- Money is BIGINT integer Toman throughout (ADR-017). V2 used INT, which
-- caps at 2,147,483,647 Toman -- reachable by a lifetime ledger sum.

CREATE SCHEMA IF NOT EXISTS commerce;

CREATE TABLE commerce.orders (
    id UUID PRIMARY KEY,
    source_type VARCHAR(16) NOT NULL,
    source_id UUID NOT NULL,
    customer_id UUID NOT NULL,
    seller_party_type VARCHAR(16) NOT NULL,
    seller_party_id UUID NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    currency VARCHAR(3) NOT NULL DEFAULT 'IRT',
    subtotal_toman BIGINT NOT NULL,
    discount_total_toman BIGINT NOT NULL DEFAULT 0,
    fee_total_toman BIGINT NOT NULL DEFAULT 0,
    total_toman BIGINT NOT NULL,
    refunded_total_toman BIGINT NOT NULL DEFAULT 0,
    paid_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_orders_source_type CHECK (source_type IN ('booking', 'direct')),
    CONSTRAINT ck_orders_seller_party CHECK (seller_party_type IN ('professional', 'business')),
    CONSTRAINT ck_orders_status CHECK (status IN ('pending', 'paid', 'partially_refunded', 'refunded', 'cancelled')),
    CONSTRAINT ck_orders_amounts_non_negative CHECK (
        subtotal_toman >= 0
        AND discount_total_toman >= 0
        AND fee_total_toman >= 0
        AND total_toman >= 0
        AND refunded_total_toman >= 0
    ),
    -- The total is derived, not independently writable.
    CONSTRAINT ck_orders_total_consistent CHECK (
        total_toman = subtotal_toman - discount_total_toman + fee_total_toman
    ),
    -- An order can never be refunded for more than it was charged, no matter
    -- how many concurrent refunds race each other.
    CONSTRAINT ck_orders_refund_within_total CHECK (refunded_total_toman <= total_toman)
);

-- GAP-03, closed structurally.
CREATE UNIQUE INDEX uq_orders_source ON commerce.orders (source_type, source_id);

CREATE INDEX ix_orders_customer_status ON commerce.orders (customer_id, status);
CREATE INDEX ix_orders_seller ON commerce.orders (seller_party_type, seller_party_id);

CREATE TABLE commerce.order_items (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES commerce.orders (id),
    item_type VARCHAR(20) NOT NULL,
    reference_id UUID,
    -- Snapshot at order time. A later catalogue edit must never change what
    -- a past customer was charged or what their receipt says they bought.
    name VARCHAR(200) NOT NULL,
    quantity INT NOT NULL,
    unit_price_toman BIGINT NOT NULL,
    line_total_toman BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_order_items_quantity CHECK (quantity > 0),
    CONSTRAINT ck_order_items_price CHECK (unit_price_toman >= 0 AND line_total_toman >= 0),
    CONSTRAINT ck_order_items_line_total CHECK (line_total_toman = unit_price_toman * quantity)
);

CREATE INDEX ix_order_items_order ON commerce.order_items (order_id);

CREATE TABLE commerce.order_adjustments (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL REFERENCES commerce.orders (id),
    -- Which pricing rule produced this. Persisted so a historical total stays
    -- explainable after the rule itself changes or is retired.
    rule_key VARCHAR(60) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    code VARCHAR(60),
    label VARCHAR(200) NOT NULL,
    amount_toman BIGINT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_order_adjustments_kind CHECK (kind IN ('discount', 'fee')),
    -- A discount is negative and a fee is positive, always. The sign carries
    -- meaning, so a sign/kind mismatch is a corruption, not a variant.
    CONSTRAINT ck_order_adjustments_sign CHECK (
        (kind = 'discount' AND amount_toman < 0) OR (kind = 'fee' AND amount_toman > 0)
    )
);

CREATE INDEX ix_order_adjustments_order ON commerce.order_adjustments (order_id, sort_order);

CREATE TABLE commerce.outbox_events (
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

CREATE INDEX ix_commerce_outbox_unpublished
    ON commerce.outbox_events (id)
    WHERE published_at IS NULL;
