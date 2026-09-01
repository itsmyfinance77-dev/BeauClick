-- V3.2-C Story #28, referral-service. Full-refund reversal and the loyalty
-- clawback (ADR-038).
--
-- Story #12 gave an attribution consequences: a qualified referral, two grant
-- rows explaining what was and was not paid, and one column built ahead --
-- `qualifying_booking_id`, which ADR-037 §13 called "a column, not a
-- behaviour". This migration is the behaviour.
--
-- `V32-DEC-017` is the whole policy and every rule below is one of its clauses:
-- only a FULL refund of the qualifying booking's commerce order reverses; a
-- PARTIAL refund does not; a `duplicate_charge` correction NEVER does; there is
-- no time limit; and a reversal is a NEW NEGATIVE ROW under a distinct reason,
-- never a mutation -- so the ledger stays append-only.
--
-- ## What this migration does NOT touch, and why that is again the headline
--
-- **No loyalty migration. No financial migration. No role or grant change.**
--
-- `loyalty.points_entries.points` is already `INTEGER NOT NULL` and already
-- SIGNED -- its own comment says "a negative row is a redemption" -- so the
-- clawback needs no column, no constraint change, and no widening. `reason` is
-- `VARCHAR(64)` with no CHECK, so the two new reversal reasons cost nothing
-- either. `lifetimeEarned()` already sums `points > 0` only, which is why
-- `V32-DEC-017`'s "does not reduce lifetime earned and does not demote a tier"
-- needs no code and no schema: it is a property the ledger already has.
--
-- `financial.ledger_entries` is a DIFFERENT object owned by
-- `beauclick_financial_owner`; the points ledger is owned by `beauclick_app`,
-- and referral reaches it only through the existing authorised
-- `LoyaltyLedgerService` path. The financial role boundary is preserved by NOT
-- BEING TOUCHED, and the suite re-verifies it after this migration rather than
-- asserting it (ADR-038 §13).

-- ==========================================================================
-- 1. referral.referrals gains the terminal reversed state
-- ==========================================================================
--
-- ADR-037 §2 refused to add `reversed` to the status vocabulary when Story #12
-- shipped, on the grounds that it would be "adding that story's vocabulary to a
-- table before its behaviour exists". The behaviour exists now.
--
-- Story #12 also deliberately left `status` OUT of the immutability trigger's
-- frozen set, recording the reason: "Story #28 must be able to move a qualified
-- referral onward, and freezing it here would force that story to drop and
-- recreate a trigger to do its own job." Section 3 below takes that up.

ALTER TABLE referral.referrals
    /*
     * WHEN the reversal happened.
     *
     * A plain column rather than a default, taken from the same injected-clock
     * reading as the event's `reversedAt`, so a row cannot disagree with the
     * event that announced it -- the same discipline `qualified_at` follows.
     */
    ADD COLUMN reversed_at TIMESTAMPTZ NULL,

    /*
     * WHICH commerce order reversed it -- the authoritative cause.
     *
     * Persisted so an operator can explain a negative loyalty balance without
     * replaying events: the order id reaches `commerce.orders` directly and
     * `payment.refunds` through its own `order_id` index, which is how a
     * reversal is traced back to the money that moved.
     *
     * There is deliberately NO `reversal_refund_id`, although `OrderRefunded`
     * carries one and persisting it would look free. The convergence path
     * (ADR-038 §8) reverses a referral whose order was ALREADY fully refunded
     * before qualification was consumed, and that path holds no refund event --
     * so the column would be non-NULL on some reversed rows and NULL on others.
     * A fact that is only sometimes present is a fact no audit can rely on and
     * every reader must first learn the exception to.
     *
     * No foreign key to `commerce.orders`: cross-schema FKs are against
     * convention (`V3_DATABASE_BLUEPRINT.md` §1), and the absence is
     * additionally load-bearing here for the reason ADR-036 §2 records -- this
     * row is RETAINED past erasure and must not acquire a referential action
     * that could destroy or block it.
     */
    ADD COLUMN reversal_order_id UUID NULL;

/*
 * The closed vocabulary gains its third and final member.
 *
 * DROP and re-ADD rather than a second constraint: two overlapping CHECKs on
 * one column is how a vocabulary ends up with a rule nobody can find. There is
 * still no `expired` -- expiry is a PREDICATE (`expires_at <= now()`), not a
 * state, and storing it would make a referral's expiry depend on whether a
 * sweeper had run rather than on the clock (ADR-037 §2).
 */
ALTER TABLE referral.referrals DROP CONSTRAINT ck_referrals_status;
ALTER TABLE referral.referrals
    ADD CONSTRAINT ck_referrals_status
        CHECK (status IN ('pending', 'qualified', 'reversed'));

/*
 * The qualification facts now survive the reversal, and must.
 *
 * The original constraint admitted exactly two shapes. A reversed row is a
 * THIRD, and it keeps every qualification fact: `V32-DEC-017` reverses the
 * REWARD, never the record that it was earned. Losing `qualifying_booking_id`
 * on reversal would destroy the only link back to the order that caused it --
 * on the very row whose job is now to explain that order.
 */
ALTER TABLE referral.referrals DROP CONSTRAINT ck_referrals_qualification_complete;
ALTER TABLE referral.referrals
    ADD CONSTRAINT ck_referrals_qualification_complete CHECK (
        (status = 'pending'  AND qualified_at IS NULL     AND qualifying_booking_id IS NULL)
        OR
        (status IN ('qualified', 'reversed')
             AND qualified_at IS NOT NULL AND qualifying_booking_id IS NOT NULL)
    );

/*
 * The reversal facts move together or not at all.
 *
 * This is the constraint that makes TORN REVERSAL FACTS unwritable: a row
 * marked reversed without the order that reversed it, or carrying a reversal
 * instant while still qualified, is refused by the database rather than merely
 * not produced by the application. It is what would catch a future handler that
 * set the status in one statement and the cause in another -- precisely the
 * shape that leaves an auditor unable to explain a negative balance after a
 * crash between the two.
 *
 * Proved by raw SQL that bypasses every entity and every service.
 */
ALTER TABLE referral.referrals
    ADD CONSTRAINT ck_referrals_reversal_complete CHECK (
        (status = 'reversed'  AND reversed_at IS NOT NULL AND reversal_order_id IS NOT NULL)
        OR
        (status <> 'reversed' AND reversed_at IS NULL     AND reversal_order_id IS NULL)
    );

/*
 * A reversal cannot precede the qualification it reverses.
 *
 * A floor, not the mechanism -- the instant comes from the injected clock --
 * but a hand-written UPDATE could otherwise produce a referral that was
 * clawed back before it was ever awarded. The mirror of
 * `ck_referrals_qualified_after_attribution`.
 */
ALTER TABLE referral.referrals
    ADD CONSTRAINT ck_referrals_reversed_after_qualified
        CHECK (reversed_at IS NULL OR reversed_at >= qualified_at);

/*
 * The reversal handler's index.
 *
 * The reversal addresses a referral by its QUALIFYING BOOKING -- the only
 * handle it has, since `OrderRefunded` carries no customer and no source, and
 * the order lookup resolves the booking id from `commerce.orders.source_id`.
 * Without this index that lookup is a sequential scan of every referral the
 * platform has ever qualified, on every full refund of every order, forever.
 *
 * Partial on `status = 'qualified'` for the reason `ix_referrals_pending_referee`
 * is partial on pending: reversed rows are permanent and accumulate, while the
 * reversible set is the small working one. It is also the exact predicate of
 * the compare-and-swap, so the index serves the whole WHERE clause.
 */
CREATE INDEX ix_referrals_qualified_booking
    ON referral.referrals (qualifying_booking_id)
    WHERE status = 'qualified';

-- ==========================================================================
-- 2. referral.reward_reversals -- what was clawed back, and what was not
-- ==========================================================================
--
-- A SEPARATE table rather than columns on `reward_grants`, and the reason is
-- the same one that keeps the loyalty ledger append-only.
--
-- `reward_grants` records what the platform decided AT QUALIFICATION. Bolting
-- reversal columns onto that row would mean UPDATEing a historical record to
-- say what happened to it later -- so the row would no longer be a statement
-- about a moment, and a reader could no longer tell, from the row alone,
-- whether they were looking at the original decision or a rewritten one. The
-- ledger this table explains works exactly the other way: a reversal there is a
-- new row, never a mutation (`V32-DEC-017`). This table matches it.
--
-- Two rows per reversed referral, always both, for the same reason
-- `reward_grants` writes two: the sides are independent facts (`V32-DEC-019`'s
-- owner correction), and one of them frequently has nothing to reverse.

CREATE TABLE referral.reward_reversals (
    id UUID PRIMARY KEY,

    /*
     * The referral whose reward was reversed.
     *
     * No relation and no foreign key, for the erasure-lifecycle reason ADR-036
     * §2 records: both rows are retained, and a referential action would tie
     * their fates together in a way no disposition asked for.
     */
    referral_id UUID NOT NULL,

    /*
     * Whose reward this reversal concerns.
     *
     * Named with the `_user_id` suffix so ADR-027's coverage heuristic
     * recognises it -- a `no_subject_data` claim on this table would be
     * rejected at boot on the strength of the column name alone -- and present
     * at all so a subject's own reversals are addressable WITHOUT joining back
     * to `referrals`. That is what lets the privacy export show a person their
     * own clawback without ever loading the row that names the counterparty.
     */
    recipient_user_id UUID NOT NULL,

    side VARCHAR(16) NOT NULL,

    /*
     * What actually happened to this side, and the second value is not a
     * failure.
     *
     *   `reversed`            -- a negative ledger row was written.
     *   `nothing_to_reverse`  -- the original grant was `disabled_zero` or
     *                            `capped`, so no ledger row ever existed to
     *                            reverse. `V32-DEC-016`'s honest zero applies
     *                            in this direction too: no zero-value negative
     *                            row is written and NO IDEMPOTENCY SLOT IS
     *                            CONSUMED, so a figure the business later
     *                            approves can still be awarded and still be
     *                            reversed against the same referral id.
     *
     * Recorded rather than inferred, because "reverse both sides" must never
     * be read as "write two zero-point ledger rows" -- and a row saying the
     * platform considered this side and found nothing to take back is a
     * materially different claim from no row at all. The same argument
     * `V32-DEC-016` makes for writing a `disabled_zero` grant.
     */
    outcome VARCHAR(24) NOT NULL,

    /*
     * The MAGNITUDE clawed back, as a non-negative integer.
     *
     * Non-negative because the direction is carried by the table's name and by
     * the ledger row's reason, which is where direction belongs; a signed
     * column here would let a reversal row assert a reward.
     *
     * The value is the points the LEDGER ROW actually carried, not the base
     * figure `reward_grants.points` recorded -- ADR-038 §5. `award()` applies
     * the recipient's membership multiplier on top of the base, so reversing
     * the grant's figure would under-claw exactly those customers whose tier
     * earned them a bonus, by an amount that grows with the benefit and that
     * nothing would ever report.
     */
    points INTEGER NOT NULL,

    /*
     * The reversal reason this side used, stored rather than derived from
     * `side` -- the same treatment `reward_grants.ledger_reason` gets, for the
     * same reason: this row's job is to explain a retained ledger entry, and
     * deriving the mapping would silently rewrite the history of every past
     * reversal if the mapping ever changed.
     */
    ledger_reason VARCHAR(64) NOT NULL,

    reversed_at TIMESTAMPTZ NOT NULL,

    /*
     * One reversal per referral per side, enforced rather than intended.
     *
     * This is the second of the two independent duplicate guards. The first is
     * the compare-and-swap on `status = 'qualified'`, which a redelivered
     * `OrderRefunded` loses; this one would refuse the write even if the CAS
     * were removed, which is exactly what the mutation probe checks.
     */
    CONSTRAINT uq_reward_reversals_referral_side UNIQUE (referral_id, side),

    CONSTRAINT ck_reward_reversals_side
        CHECK (side IN ('referrer', 'referee')),
    CONSTRAINT ck_reward_reversals_outcome
        CHECK (outcome IN ('reversed', 'nothing_to_reverse')),
    CONSTRAINT ck_reward_reversals_points_non_negative
        CHECK (points >= 0),

    /*
     * The outcome and the amount cannot disagree.
     *
     * `nothing_to_reverse` with a non-zero figure would claim points were taken
     * back that were not; `reversed` with zero would be the zero-value row
     * `V32-DEC-016` forbids, wearing a different name.
     */
    CONSTRAINT ck_reward_reversals_outcome_matches_points CHECK (
        (outcome = 'reversed'           AND points > 0)
        OR
        (outcome = 'nothing_to_reverse' AND points = 0)
    )
);

/*
 * The export's access path: a subject's own reversals, without touching
 * `referrals` and therefore without loading the counterparty (ADR-038 §11).
 * The mirror of `ix_reward_grants_recipient`.
 */
CREATE INDEX ix_reward_reversals_recipient ON referral.reward_reversals (recipient_user_id);

-- ==========================================================================
-- 3. The immutability trigger, extended to the reversal
-- ==========================================================================
--
-- ADR-036 §3 froze four attribution columns ALWAYS. ADR-037 §2 added the two
-- qualification facts, frozen ONCE SET, and left `status` deliberately unfrozen
-- so this story could move a qualified referral onward without dropping and
-- recreating a trigger to do its own job.
--
-- This migration adds two rules with a third shape:
--
--   * the reversal facts are frozen ONCE SET, like the qualification facts;
--   * the STATUS becomes a one-way street. It was unconstrained before because
--     `pending -> qualified` was the only transition that existed and the
--     `ck_referrals_qualification_complete` CHECK already made a backwards move
--     unwritable. With a third state that is no longer true: `reversed ->
--     qualified` satisfies every CHECK on the table, and would silently
--     resurrect a reward the platform has taken back.
--
-- CREATE OR REPLACE, not DROP and CREATE. The trigger `tg_referrals_immutable`
-- keeps pointing at this function throughout, so there is no instant during the
-- migration in which the attribution is unprotected.

CREATE OR REPLACE FUNCTION referral.reject_attribution_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- The original four, frozen always (ADR-036 §3).
    IF NEW.referrer_user_id IS DISTINCT FROM OLD.referrer_user_id
       OR NEW.referee_user_id IS DISTINCT FROM OLD.referee_user_id
       OR NEW.referral_code_id IS DISTINCT FROM OLD.referral_code_id
       OR NEW.attributed_at IS DISTINCT FROM OLD.attributed_at
    THEN
        RAISE EXCEPTION 'referral.referrals attribution is immutable: referrer_user_id, referee_user_id, referral_code_id and attributed_at cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The qualification facts, frozen ONCE SET (ADR-037 §2).
    --
    -- Named as a column set and never as values: a booking id in an error
    -- message is an identifier in a log line, and `V32-DEC-033` keeps referral
    -- material out of exception text.
    IF OLD.qualified_at IS NOT NULL
       AND (NEW.qualified_at IS DISTINCT FROM OLD.qualified_at
            OR NEW.qualifying_booking_id IS DISTINCT FROM OLD.qualifying_booking_id)
    THEN
        RAISE EXCEPTION 'referral.referrals qualification is immutable once recorded: qualified_at and qualifying_booking_id cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The reversal facts, frozen ONCE SET (ADR-038 §4).
    --
    -- Same rule as the qualification facts and for the same reason: NULL ->
    -- value IS the reversal and must be allowed exactly once; value ->
    -- anything else rewrites the cause of a clawback that is already reflected
    -- in a customer's balance.
    IF OLD.reversed_at IS NOT NULL
       AND (NEW.reversed_at IS DISTINCT FROM OLD.reversed_at
            OR NEW.reversal_order_id IS DISTINCT FROM OLD.reversal_order_id)
    THEN
        RAISE EXCEPTION 'referral.referrals reversal is immutable once recorded: reversed_at and reversal_order_id cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The lifecycle is a ONE-WAY STREET (ADR-038 §4).
    --
    -- pending -> qualified -> reversed, and never backwards. Every other
    -- transition is refused here rather than left to the CHECK constraints,
    -- which cannot express it: `reversed -> qualified` with the reversal
    -- columns cleared satisfies all four of them.
    --
    -- Written as an explicit allow-list rather than as a list of refusals, so a
    -- FOURTH status added later is refused by default rather than silently
    -- permitted from and to everywhere.
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (
             (OLD.status = 'pending'   AND NEW.status = 'qualified')
          OR (OLD.status = 'qualified' AND NEW.status = 'reversed')
       )
    THEN
        RAISE EXCEPTION 'referral.referrals status transition % -> % is not permitted: the lifecycle is pending -> qualified -> reversed and never backwards',
            OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;
