-- ---------------------------------------------------------------------------
-- V3.3 Story #161 (`#42d`) — the customer's remedy after a seller, platform or
-- provider cancellation: one fact per order, resolved to the ratified default
-- (full refund) at the moment it is offered, and overridable to a free
-- reschedule while that refund has not yet finished executing (ADR-051 §8,
-- `V33-DEC-039` R7).
--
-- ## Why the row is always born already resolved
--
-- `V33-DEC-039` R7: "Until the customer chooses, or when no eligible slot
-- exists, the outcome is the full refund" — and ADR-051 §8 records that no
-- ratified value exists for `remedy_choice_window_hours` (the numeric family
-- column this story ALSO adds, see the sibling `commercial` migration): "no
-- invented deadline... the immediate-default reading is the fail-closed one."
-- With no ratified waiting period, there is no genuinely OPEN state to model:
-- the refund executes immediately at cancellation exactly as it did before
-- this story, so this row records that fact — `resolved_by = 'default'` — in
-- the SAME insert that offers the choice, never as a later write.
--
-- ## The one further move: 'default' -> 'customer'
--
-- If the customer calls the remedy route BEFORE the refund has finished
-- executing (`execution_status` still `pending` or `manual_required` on the
-- linked `commerce.booking_outcome_decisions` row) and asks for `reschedule`,
-- this row moves ONCE more: `resolved_by` becomes `customer`, `chosen`
-- becomes `reschedule`. A repeated or `refund` choice is a no-op that returns
-- the existing resolution — nothing here changes for it, which is what makes
-- "no double refund" hold trivially: nothing this table does ever triggers a
-- second refund, and choosing `reschedule` does not itself refund anything
-- either (the booking-service reschedule that seam performs is a plain,
-- price-preserving slot move).
--
-- ## No value, no seed, no alteration of an existing table
-- ---------------------------------------------------------------------------

CREATE TABLE commerce.customer_remedy_choices (
    order_id UUID PRIMARY KEY REFERENCES commerce.orders (id),

    /* No cross-schema FK, by convention; verified against the order by trigger. */
    booking_id UUID NOT NULL,

    offered_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* The two options ADR-051 §8 names. Always both; there is no third option and no subset. */
    options TEXT[] NOT NULL DEFAULT ARRAY['refund', 'reschedule']::TEXT[],

    /* NULL until the customer overrides the default with an explicit reschedule choice. */
    chosen VARCHAR(16),
    chosen_at TIMESTAMPTZ,

    /* Always set — see the class note above on why this row is never genuinely unresolved. */
    resolved_by VARCHAR(16) NOT NULL,
    resolved_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT ck_crc_options CHECK (options = ARRAY['refund', 'reschedule']::TEXT[]),
    CONSTRAINT ck_crc_chosen CHECK (chosen IS NULL OR chosen IN ('refund', 'reschedule')),
    CONSTRAINT ck_crc_resolved_by CHECK (resolved_by IN ('customer', 'default')),
    CONSTRAINT ck_crc_chosen_pair CHECK ((chosen IS NULL) = (chosen_at IS NULL)),
    /* A recorded `chosen` value exists only because the customer, not the default, resolved it. */
    CONSTRAINT ck_crc_chosen_requires_customer CHECK (chosen IS NULL OR resolved_by = 'customer'),
    /* The default resolution is silent: it never records a `chosen` value of its own. */
    CONSTRAINT ck_crc_default_has_no_choice CHECK (resolved_by <> 'default' OR chosen IS NULL),
    CONSTRAINT ck_crc_offered_before_resolved CHECK (offered_at <= resolved_at),
    CONSTRAINT ck_crc_chosen_not_before_resolved CHECK (chosen_at IS NULL OR chosen_at >= resolved_at)
);

-- ==========================================================================
-- Integrity at insert: the booking is the order's own, the instant is the
-- database's, and a row is never born already customer-resolved (there is no
-- production path that knows the customer's choice before it offers one)
-- ==========================================================================

CREATE OR REPLACE FUNCTION commerce.enforce_customer_remedy_choice_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_source_type VARCHAR(16);
    v_source_id UUID;
BEGIN
    SELECT source_type, source_id INTO v_source_type, v_source_id
      FROM commerce.orders WHERE id = NEW.order_id;

    IF v_source_type IS DISTINCT FROM 'booking' OR v_source_id IS DISTINCT FROM NEW.booking_id THEN
        RAISE EXCEPTION 'commerce.customer_remedy_choices must describe the order''s own booking'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.offered_at IS DISTINCT FROM now() OR NEW.resolved_at IS DISTINCT FROM now() THEN
        RAISE EXCEPTION 'commerce.customer_remedy_choices.offered_at and resolved_at must both be the database transaction instant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.resolved_by <> 'default' OR NEW.chosen IS NOT NULL THEN
        RAISE EXCEPTION 'commerce.customer_remedy_choices is offered with the default already in effect; a customer choice is recorded by a later UPDATE'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_crc_integrity
    BEFORE INSERT ON commerce.customer_remedy_choices
    FOR EACH ROW
    EXECUTE FUNCTION commerce.enforce_customer_remedy_choice_integrity();

-- ==========================================================================
-- Forward only: the SINGLE 'default' -> 'customer' move, exactly once; no DELETE
-- ==========================================================================

CREATE OR REPLACE FUNCTION commerce.enforce_customer_remedy_choice_forward_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce.customer_remedy_choices rows are permanent: a remedy resolution is never removed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
       OR NEW.offered_at IS DISTINCT FROM OLD.offered_at
       OR NEW.options IS DISTINCT FROM OLD.options
    THEN
        RAISE EXCEPTION 'commerce.customer_remedy_choices identity and offer are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF (NEW.resolved_by, NEW.chosen, NEW.chosen_at) IS DISTINCT FROM (OLD.resolved_by, OLD.chosen, OLD.chosen_at)
       AND NOT (
           OLD.resolved_by = 'default' AND OLD.chosen IS NULL
           AND NEW.resolved_by = 'customer' AND NEW.chosen = 'reschedule' AND NEW.chosen_at IS NOT NULL
       )
    THEN
        RAISE EXCEPTION 'commerce.customer_remedy_choices moves at most once, from the default resolution to a customer reschedule choice'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
       AND NOT (OLD.resolved_by = 'default' AND NEW.resolved_by = 'customer' AND NEW.resolved_at >= OLD.resolved_at)
    THEN
        RAISE EXCEPTION 'commerce.customer_remedy_choices.resolved_at cannot move backward'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_crc_forward_only
    BEFORE UPDATE OR DELETE ON commerce.customer_remedy_choices
    FOR EACH ROW
    EXECUTE FUNCTION commerce.enforce_customer_remedy_choice_forward_only();

COMMENT ON TABLE commerce.customer_remedy_choices IS
    'V3.3 #161 (#42d), ADR-051 §8. One row per order offered a remedy after a seller/platform/provider cancellation. Always born resolved_by = default (the immediate full refund, V33-DEC-039 R7); moves at most once more to resolved_by = customer / chosen = reschedule, while the linked cancellation decision''s refund has not yet executed. order_id PK makes a second remedy request a no-op returning the existing resolution.';
