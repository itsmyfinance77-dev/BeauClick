-- DEMO BRANCH ONLY (codex/demo-2026-09-28) — DEMO-DEC-001 part B. Never merged to master.
--
-- A durable replacement offer after a provider-side (seller / platform / provider)
-- cancellation, independent of the default refund, which continues untouched.
-- Distinct from #161/#212's `commerce.customer_remedy_choices` (reschedule INSTEAD of
-- the refund, only while the refund is still pending); that table is not altered.
--
-- The offer guarantees access to the replacement flow — not a slot, not the old
-- price. A replacement is always a NEW booking with its own order and payment
-- (no fund transfer: see DEMO-DEC-001 §B "Money").

CREATE TABLE commerce.replacement_offers (
    -- One offer per cancelled booking; a redelivered cancellation never offers twice.
    original_booking_id UUID PRIMARY KEY,
    original_order_id UUID NOT NULL,
    customer_id UUID NOT NULL,
    professional_id UUID NOT NULL,
    service_id UUID NOT NULL,
    offered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    resolved_at TIMESTAMPTZ,
    -- The ONE replacement booking that confirmed. UNIQUE: a booking replaces at most one original.
    replacement_booking_id UUID UNIQUE,
    CONSTRAINT ck_replacement_offers_status CHECK (status IN ('open', 'used', 'dismissed')),
    -- `used` iff a replacement is recorded; `open` has no resolution instant.
    CONSTRAINT ck_replacement_offers_used CHECK ((status = 'used') = (replacement_booking_id IS NOT NULL)),
    CONSTRAINT ck_replacement_offers_resolved CHECK ((status = 'open') = (resolved_at IS NULL))
);

CREATE INDEX ix_replacement_offers_customer ON commerce.replacement_offers (customer_id);

-- Every booking attempted under an offer (pending, expired, cancelled or confirmed).
-- The offer is "used" exactly when one of these bookings has confirmed.
CREATE TABLE commerce.replacement_offer_attempts (
    booking_id UUID PRIMARY KEY,
    original_booking_id UUID NOT NULL REFERENCES commerce.replacement_offers (original_booking_id),
    idempotency_key VARCHAR(200) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_replacement_offer_attempt_key UNIQUE (original_booking_id, idempotency_key)
);
