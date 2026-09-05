-- ---------------------------------------------------------------------------
-- V3.3 Story #81 (`#41b`). The zero-online-collection order state.
-- ADR-044, `V33-DEC-023` Rulings 1 and 2.
--
-- An order whose immutable schedule has `platform_collectible_toman = 0` has
-- nothing for BeauClick to collect online. Today such an order stays `pending`
-- for ever, because only a gateway callback confirms a booking and no callback
-- can arrive for a payment nobody will make.
--
-- This migration adds the one status that lets the confirmation path say what
-- actually happened.
--
-- ## What the new value means, and what it must never be read as
--
-- `online_collection_not_required` means BeauClick is not collecting money
-- online now. It does NOT mean paid, free, settled, completed, waived or
-- written off: a venue balance may still be owed to the seller in full, and
-- that balance is not BeauClick's money.
--
-- `paid` keeps its meaning exactly -- a gateway confirmed money moved -- and
-- stays reachable only through the payment verification path.
--
-- ## What is NOT done here
--
-- No column is added or removed; no order row is rewritten; no historical
-- migration is edited; `commerce.order_payment_schedules` is untouched; no
-- event, timestamp, index or trigger is introduced.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The column must hold the literal before the constraint may name it.
--
-- `status` is VARCHAR(20) and `online_collection_not_required` is 30
-- characters, so the widening is a correctness requirement rather than
-- headroom: without it every INSERT or UPDATE carrying the new value fails with
-- `value too long for type character varying(20)`.
--
-- 32 rather than 30: a VARCHAR length in PostgreSQL costs nothing until it is
-- used, and stopping exactly at today's longest literal would make the next
-- status a schema migration for the sake of two characters.
--
-- Widening a VARCHAR is a catalogue-only change -- no table rewrite, no scan,
-- no lock beyond the brief ACCESS EXCLUSIVE the ALTER itself takes.
-- ---------------------------------------------------------------------------
ALTER TABLE commerce.orders
    ALTER COLUMN status TYPE VARCHAR(32);

-- ---------------------------------------------------------------------------
-- The allowlist, replaced rather than relaxed.
--
-- Dropping the old CHECK and adding one that names all six values keeps the
-- constraint EXACT. The alternative shapes were both rejected:
--
--   * dropping it and not replacing it would turn a typo into a stored row;
--   * an `OR status = 'online_collection_not_required'` addendum would leave
--     the vocabulary split across two constraints, so reading "which statuses
--     are legal" would mean finding all of them.
--
-- Every previously legal value is present. This migration widens the set and
-- removes nothing, so no existing row can violate the new constraint -- and
-- PostgreSQL validates it against the whole table anyway, which is the proof
-- rather than the assumption.
-- ---------------------------------------------------------------------------
ALTER TABLE commerce.orders
    DROP CONSTRAINT ck_orders_status;

ALTER TABLE commerce.orders
    ADD CONSTRAINT ck_orders_status CHECK (status IN (
        'pending',
        'paid',
        'partially_refunded',
        'refunded',
        'cancelled',
        'online_collection_not_required'
    ));

COMMENT ON COLUMN commerce.orders.status IS
    'Order lifecycle state. `paid` means a gateway confirmed money moved and is written only by payment verification. `online_collection_not_required` (#81, ADR-044) means BeauClick collects nothing online for this order -- never paid, free, settled or completed.';

-- ---------------------------------------------------------------------------
-- Prove the constraint rather than assume it.
--
-- Two planted controls, both rolled back, so this DO block cannot pass
-- vacuously: the new value must be accepted and an unknown value must be
-- refused. A migration that widened the column but left the old allowlist in
-- place would fail the first; one that dropped the constraint without replacing
-- it would fail the second.
--
-- The probes run against a real order row when one exists, and are skipped only
-- when the table is empty -- in which case there is nothing the constraint could
-- have been proved against.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
    probe_id UUID;
    accepted BOOLEAN := FALSE;
    refused  BOOLEAN := FALSE;
BEGIN
    SELECT id INTO probe_id FROM commerce.orders LIMIT 1;

    IF probe_id IS NULL THEN
        RAISE NOTICE '#81 ck_orders_status: no order rows to probe against; constraint installed unproven';
        RETURN;
    END IF;

    BEGIN
        UPDATE commerce.orders
           SET status = 'online_collection_not_required'
         WHERE id = probe_id;
        accepted := TRUE;
        RAISE EXCEPTION 'rollback the accept probe' USING ERRCODE = 'restrict_violation';
    EXCEPTION
        WHEN restrict_violation THEN
            NULL;
    END;

    BEGIN
        UPDATE commerce.orders
           SET status = 'definitely_not_a_status'
         WHERE id = probe_id;
        refused := FALSE;
    EXCEPTION
        WHEN check_violation THEN
            refused := TRUE;
    END;

    IF NOT accepted THEN
        RAISE EXCEPTION '#81: ck_orders_status refused online_collection_not_required';
    END IF;

    IF NOT refused THEN
        RAISE EXCEPTION '#81: ck_orders_status accepted an unknown status; the allowlist is not exact';
    END IF;

    RAISE NOTICE '#81 ck_orders_status proved: new value accepted, unknown value refused';
END
$verify$;
