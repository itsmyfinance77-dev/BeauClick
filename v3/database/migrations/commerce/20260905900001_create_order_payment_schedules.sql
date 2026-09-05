-- ---------------------------------------------------------------------------
-- V3.3 Story #41 (`#41a`). The immutable order collection-schedule snapshot.
-- ADR-043, `V33-DEC-022` Rulings 3, 4 and 5.
--
-- `commerce.orders.total_toman` is currently three facts wearing one name: the
-- full disclosed service price, the amount BeauClick asks the gateway for, and
-- the amount `OrderPaid` reports as collected. They coincide because
-- `full_payment_online` is the only mode that has ever run.
--
-- This table separates them. It activates nothing: `V33-DEC-011` still controls
-- which modes may be ENABLED and is open under #46, so every row this migration
-- writes -- and every row `#41a`'s code writes -- is `full_payment_online`.
--
-- ## The vocabulary is the contract's
--
-- Column names are the snake_case translation of
-- `packages/commercial-policy-contract`'s own field names. No parallel enum and
-- no second arithmetic implementation (`V33-DEC-022` Ruling 2). ADR-043 §2
-- carries the full mapping table.
--
-- ## What is NOT done here
--
-- No column is added to `commerce.orders`; `OrderStatus` is unchanged; no
-- existing order, payment or refund column is touched; no historical migration
-- is edited; there is no soft delete.
-- ---------------------------------------------------------------------------

CREATE TABLE commerce.order_payment_schedules (
    /*
     * The primary key IS the one-to-one guarantee and the idempotency arbiter.
     * A separate unique index would be a second thing to keep in agreement with
     * this one.
     */
    order_id UUID PRIMARY KEY REFERENCES commerce.orders (id),

    collection_mode VARCHAR(32) NOT NULL,

    service_total_toman        BIGINT NOT NULL,
    platform_collectible_toman BIGINT NOT NULL,
    venue_balance_toman        BIGINT NOT NULL,

    /*
     * The policy this schedule was selected from, when one exists.
     *
     * All three are NULL for every row today: `#41a` selects no policy and the
     * backfill describes orders placed before any policy existed. That absence
     * is a fact, not a gap -- `ck_ops_policy_reference` makes "partially
     * referenced" unrepresentable rather than merely discouraged.
     *
     * `#83` (`#41d`) fills these in when publication and selection exist.
     */
    policy_key         VARCHAR(64),
    policy_version     INTEGER,
    policy_accepted_at TIMESTAMPTZ,

    /*
     * Which contract version wrote the row. A future `V2` breakdown becomes a
     * new value here rather than a silent reinterpretation of these rows.
     */
    contract_version SMALLINT NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_ops_mode CHECK (collection_mode IN (
        'pay_at_venue',
        'deposit_online_balance_at_venue',
        'full_payment_online'
    )),

    CONSTRAINT ck_ops_amounts_non_negative CHECK (
        service_total_toman >= 0
        AND platform_collectible_toman >= 0
        AND venue_balance_toman >= 0
    ),

    /*
     * The arithmetic invariant. BeauClick must never record collecting more
     * than the disclosed service total, and the two parts must account for all
     * of it (ADR-039 §3).
     */
    CONSTRAINT ck_ops_sum CHECK (
        platform_collectible_toman + venue_balance_toman = service_total_toman
    ),

    /*
     * Mode consistency, deliberately overlapping `ck_ops_sum`: the sum rule
     * alone would permit `pay_at_venue` with a non-zero collectible, and this
     * rule alone would permit a deposit whose parts do not add up.
     *
     * Deposit mode requires `0 < collectible < total` STRICTLY. A deposit equal
     * to the total is `full_payment_online` and a deposit of zero is
     * `pay_at_venue`; permitting either spelling here would make "which mode
     * was this?" ambiguous at the row level.
     */
    CONSTRAINT ck_ops_mode_consistent CHECK (
        (collection_mode = 'full_payment_online'
            AND platform_collectible_toman = service_total_toman
            AND venue_balance_toman = 0)
        OR (collection_mode = 'pay_at_venue'
            AND platform_collectible_toman = 0
            AND venue_balance_toman = service_total_toman)
        OR (collection_mode = 'deposit_online_balance_at_venue'
            AND platform_collectible_toman > 0
            AND platform_collectible_toman < service_total_toman)
    ),

    CONSTRAINT ck_ops_policy_reference CHECK (
        (policy_key IS NULL AND policy_version IS NULL AND policy_accepted_at IS NULL)
        OR (policy_key IS NOT NULL AND policy_version IS NOT NULL AND policy_accepted_at IS NOT NULL)
    ),

    CONSTRAINT ck_ops_policy_version_positive CHECK (
        policy_version IS NULL OR policy_version >= 1
    ),

    CONSTRAINT ck_ops_contract_version CHECK (contract_version >= 1)
);

COMMENT ON TABLE commerce.order_payment_schedules IS
    'Immutable per-order collection schedule (ADR-043). One row per order, written inside the order creation transaction, never updated or deleted.';

-- ---------------------------------------------------------------------------
-- Immutability.
--
-- A schedule is what was agreed when the order was created. Editing one later
-- rewrites a receipt, so both UPDATE and DELETE are refused outright -- the same
-- shape `commercial.reject_grant_rewrite()` uses for booking-credit grants.
--
-- This table has NO legitimately mutable column, so unlike `commerce.orders`
-- the trigger needs no exemption list. That is why the guarantee can be
-- unconditional here and could not be there.
--
-- The order itself still mutates freely: `status`, `refunded_total_toman` and
-- `paid_at` are untouched by this migration.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commerce.reject_order_payment_schedule_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'order_payment_schedules rows are immutable: a schedule is what was agreed at order creation, never an edit'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_order_payment_schedules_immutable
    BEFORE UPDATE OR DELETE ON commerce.order_payment_schedules
    FOR EACH ROW
    EXECUTE FUNCTION commerce.reject_order_payment_schedule_rewrite();

-- ---------------------------------------------------------------------------
-- Backfill: a statement about history, not a default.
--
-- Every order that already exists was placed under the full-online flow, so it
-- receives exactly that: service total = platform collectible = `total_toman`,
-- venue balance zero.
--
-- The policy reference is ABSENT -- all three columns NULL, which
-- `ck_ops_policy_reference` permits explicitly. Those orders were placed before
-- any policy existed to select, and fabricating a key, a version or an
-- acceptance timestamp would put a policy on a receipt that never had one.
--
-- `ON CONFLICT DO NOTHING` on the primary key makes a rerun a no-op, though the
-- migration runner already applies each file once.
-- ---------------------------------------------------------------------------
INSERT INTO commerce.order_payment_schedules (
    order_id, collection_mode,
    service_total_toman, platform_collectible_toman, venue_balance_toman,
    policy_key, policy_version, policy_accepted_at,
    contract_version, created_at
)
SELECT o.id,
       'full_payment_online',
       o.total_toman,
       o.total_toman,
       0,
       NULL, NULL, NULL,
       1,
       o.created_at
  FROM commerce.orders o
ON CONFLICT (order_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Prove the backfill rather than assume it.
--
-- The CHECK constraints already refused any row that violated the arithmetic,
-- so this verifies the one thing they cannot: that EVERY order got a row. A
-- historical order the invariants could not represent must fail the migration
-- loudly rather than leave the table quietly incomplete.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
    missing_count INTEGER;
    schedule_count INTEGER;
BEGIN
    SELECT count(*) INTO missing_count
      FROM commerce.orders o
      LEFT JOIN commerce.order_payment_schedules s ON s.order_id = o.id
     WHERE s.order_id IS NULL;

    IF missing_count > 0 THEN
        RAISE EXCEPTION
            '#41a backfill incomplete: % order(s) have no payment schedule', missing_count;
    END IF;

    SELECT count(*) INTO schedule_count FROM commerce.order_payment_schedules;
    RAISE NOTICE '#41a backfill: % order payment schedule(s), all full_payment_online', schedule_count;
END
$verify$;
