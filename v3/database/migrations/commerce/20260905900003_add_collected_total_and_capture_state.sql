-- ---------------------------------------------------------------------------
-- V3.3 Story #82 (`#41c`). The captured principal, and the state that says so.
-- ADR-045, `V33-DEC-024` Rulings 2 and 3.
--
-- `total_toman`, the payment intent's amount, the ledger receivable and the
-- refund ceiling are today one number wearing four names. They agree only
-- because `full_payment_online` is the one collection mode that has ever run.
--
-- This migration separates the one that matters most: how much money BeauClick
-- actually collected. Without it, a deposit order could be refunded a venue
-- balance the platform never held -- the refund ceiling being `total_toman` is
-- not a style problem, it is a path to giving back money that was never taken.
--
-- ## What is NOT done here
--
-- No table is created or dropped; `commerce.order_payment_schedules` is
-- untouched; no historical migration is edited; no collection mode becomes
-- selectable; no deposit value, percentage or policy exists anywhere in this
-- file.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The captured principal.
--
-- NOT NULL DEFAULT 0 is safe for every existing row precisely because the
-- backfill below immediately replaces the default with the truth. The default
-- exists for FUTURE orders, which are created `pending` and have collected
-- nothing -- zero is not a placeholder there, it is the correct value.
--
-- It is a principal, not a balance: refunds move `refunded_total_toman` and
-- never touch this column (ADR-045 §3). A column that fell when money went back
-- could not bound refunds, because it would be bounding itself.
-- ---------------------------------------------------------------------------
ALTER TABLE commerce.orders
    ADD COLUMN collected_total_toman BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN commerce.orders.collected_total_toman IS
    'Gateway-verified money collected by BeauClick for this order (#82, ADR-045). Written once by the verification transaction, equal to the schedule''s platform_collectible_toman, never reduced by refunds and never reconstructed from total_toman. Bounds every refund.';

-- ---------------------------------------------------------------------------
-- Backfill: classify from lifecycle, never guess.
--
-- Every order that exists predates deposit mode, so each one is either a full
-- online capture or no capture at all. The two branches are exhaustive over the
-- statuses that exist today, and the verification block below proves it rather
-- than trusting it.
-- ---------------------------------------------------------------------------

-- Never collected: awaiting payment, cancelled before payment, or a #81
-- zero-collectible confirmation where the platform deliberately collected
-- nothing.
UPDATE commerce.orders
   SET collected_total_toman = 0
 WHERE status IN ('pending', 'cancelled', 'online_collection_not_required');

-- Collected in full: under the pre-deposit contract `paid` meant the whole
-- total moved, and the refunded states are reachable only from `paid`. Their
-- captured principal is therefore the order total, regardless of how much of it
-- has since been given back.
UPDATE commerce.orders
   SET collected_total_toman = total_toman
 WHERE status IN ('paid', 'partially_refunded', 'refunded');

-- ---------------------------------------------------------------------------
-- Prove the backfill before constraining on it.
--
-- Three separate failures, each with its own message, because "the migration
-- failed" is not a diagnosis:
--
--   1. a status this migration does not know how to classify -- which would
--      mean a status was added without deciding what it collected;
--   2. a row whose refunds now exceed the principal it was just given, which
--      would mean the historical data contradicts the invariant;
--   3. a row collecting more than its own total.
--
-- All three raise. None coerces the row into passing.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
    unclassified INTEGER;
    over_refunded INTEGER;
    over_collected INTEGER;
    collected_rows INTEGER;
BEGIN
    SELECT count(*) INTO unclassified
      FROM commerce.orders
     WHERE status NOT IN (
        'pending', 'cancelled', 'online_collection_not_required',
        'paid', 'partially_refunded', 'refunded'
     );
    IF unclassified > 0 THEN
        RAISE EXCEPTION
            '#82 backfill: % order(s) carry a status this migration cannot classify; decide what they collected before constraining',
            unclassified;
    END IF;

    SELECT count(*) INTO over_refunded
      FROM commerce.orders
     WHERE refunded_total_toman > collected_total_toman;
    IF over_refunded > 0 THEN
        RAISE EXCEPTION
            '#82 backfill: % order(s) are refunded beyond their captured principal; historical data contradicts the invariant',
            over_refunded;
    END IF;

    SELECT count(*) INTO over_collected
      FROM commerce.orders
     WHERE collected_total_toman > total_toman;
    IF over_collected > 0 THEN
        RAISE EXCEPTION
            '#82 backfill: % order(s) collected more than their own total',
            over_collected;
    END IF;

    SELECT count(*) INTO collected_rows
      FROM commerce.orders WHERE collected_total_toman > 0;
    RAISE NOTICE '#82 backfill: % order(s) carry a non-zero captured principal', collected_rows;
END
$verify$;

-- ---------------------------------------------------------------------------
-- The refund ceiling moves from the service total to the captured principal.
--
-- `ck_orders_refund_within_total` is DROPPED and replaced rather than
-- supplemented: leaving both would mean two constraints expressing one rule,
-- and the weaker one would be the first place a future author looked.
--
-- The replacement is strictly tighter after the backfill -- `collected <= total`
-- always holds -- so no row that was legal becomes illegal, and PostgreSQL
-- validates that against the whole table when the constraint is added, which is
-- the proof rather than the claim.
-- ---------------------------------------------------------------------------
ALTER TABLE commerce.orders
    DROP CONSTRAINT ck_orders_refund_within_total;

ALTER TABLE commerce.orders
    ADD CONSTRAINT ck_orders_collected_non_negative
        CHECK (collected_total_toman >= 0);

ALTER TABLE commerce.orders
    ADD CONSTRAINT ck_orders_collected_within_total
        CHECK (collected_total_toman <= total_toman);

ALTER TABLE commerce.orders
    ADD CONSTRAINT ck_orders_refund_within_collected
        CHECK (refunded_total_toman <= collected_total_toman);

-- ---------------------------------------------------------------------------
-- The new lifecycle state.
--
-- `online_collection_completed` is 30 characters and the column is already
-- VARCHAR(32) from #81, so no widening is required -- verified rather than
-- assumed by the length assertion in the verification block below.
--
-- The allowlist is rebuilt naming all seven statuses, for the same reason #81
-- rebuilt it: an `OR status = '...'` addendum would split the vocabulary across
-- two constraints, so "which statuses are legal" would mean finding all of them.
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
        'online_collection_not_required',
        'online_collection_completed'
    ));

-- ---------------------------------------------------------------------------
-- One lifetime-consistency rule, and deliberately only one.
--
-- A status that means money was collected must have collected something. The
-- inverse is NOT asserted: `cancelled` is reachable both before a payment and,
-- in principle, after one, and `pending` with a positive principal is exactly
-- the impossible state the capture statement prevents -- constraining it here
-- would encode a claim about a path rather than about a row.
--
-- `paid` is excluded from this rule for one honest reason: a legacy zero-total
-- order can be `paid` with a zero principal, and that is truthful history rather
-- than an inconsistency to reject.
-- ---------------------------------------------------------------------------
ALTER TABLE commerce.orders
    ADD CONSTRAINT ck_orders_capture_state_has_principal
        CHECK (status <> 'online_collection_completed' OR collected_total_toman > 0);

COMMENT ON COLUMN commerce.orders.status IS
    'Order lifecycle state. `paid` means a gateway confirmed the whole service total moved. `online_collection_not_required` (#81) means BeauClick collects nothing online. `online_collection_completed` (#82) means BeauClick''s scheduled ONLINE collection completed while a venue balance may remain -- never paid in full, delivered or settled.';

-- ---------------------------------------------------------------------------
-- Prove the new constraints rather than assume them.
--
-- Planted controls, all rolled back, so this block cannot pass vacuously: the
-- new status must be accepted, an over-refund must be refused, and an
-- over-collection must be refused. A migration that added the column but kept
-- the old ceiling would fail the second probe.
-- ---------------------------------------------------------------------------
DO $prove$
DECLARE
    probe_id UUID;
    status_len INTEGER;
    accepted BOOLEAN := FALSE;
    refused_refund BOOLEAN := FALSE;
    refused_collect BOOLEAN := FALSE;
BEGIN
    SELECT character_maximum_length INTO status_len
      FROM information_schema.columns
     WHERE table_schema = 'commerce' AND table_name = 'orders' AND column_name = 'status';
    IF status_len < 30 THEN
        RAISE EXCEPTION '#82: commerce.orders.status is varchar(%) and cannot hold online_collection_completed', status_len;
    END IF;

    SELECT id INTO probe_id FROM commerce.orders WHERE total_toman > 0 LIMIT 1;
    IF probe_id IS NULL THEN
        RAISE NOTICE '#82: no priced order to probe against; constraints installed unproven';
        RETURN;
    END IF;

    BEGIN
        UPDATE commerce.orders
           SET status = 'online_collection_completed', collected_total_toman = total_toman
         WHERE id = probe_id;
        accepted := TRUE;
        RAISE EXCEPTION 'rollback the accept probe' USING ERRCODE = 'restrict_violation';
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;

    BEGIN
        UPDATE commerce.orders
           SET refunded_total_toman = collected_total_toman + 1
         WHERE id = probe_id;
        refused_refund := FALSE;
    EXCEPTION WHEN check_violation THEN refused_refund := TRUE;
    END;

    BEGIN
        UPDATE commerce.orders
           SET collected_total_toman = total_toman + 1
         WHERE id = probe_id;
        refused_collect := FALSE;
    EXCEPTION WHEN check_violation THEN refused_collect := TRUE;
    END;

    IF NOT accepted THEN
        RAISE EXCEPTION '#82: the new status or principal was refused by a constraint';
    END IF;
    IF NOT refused_refund THEN
        RAISE EXCEPTION '#82: a refund above the captured principal was accepted; the ceiling did not move';
    END IF;
    IF NOT refused_collect THEN
        RAISE EXCEPTION '#82: a principal above the order total was accepted';
    END IF;

    RAISE NOTICE '#82 constraints proved: new state accepted, over-refund refused, over-collection refused';
END
$prove$;
