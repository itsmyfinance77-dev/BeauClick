-- V3.2-C Story #12, referral-service. Qualification and the two-sided reward
-- (ADR-037).
--
-- Story #27 created an attribution: a pending, immutable, once-ever
-- relationship carrying an expiry and nothing else. Nothing read it. This
-- migration gives it consequences, and the consequences cross a ledger.
--
-- Every rule here is an owner decision recorded in
-- `V3.2_DECISION_REGISTER.md` §C: the referee's first `BookingCompleted`
-- qualifies and nothing else does (`V32-DEC-018`); two independent sides with
-- two ledger reasons and two configured values, both **0**, where zero means
-- honestly disabled (`V32-DEC-016`); 10 qualified referrals per referrer per
-- Tehran calendar month with the two sides capped independently
-- (`V32-DEC-019`); and `ReferralQualified` v1 as the only event
-- (`V32-DEC-033`).
--
-- ## What this migration does NOT touch, and why that is the headline
--
-- **No loyalty migration. No financial migration.** `loyalty.points_entries`
-- carries `reason VARCHAR(64)` with **no CHECK constraint**, so the two new
-- ledger reasons need no schema change at all. `financial.ledger_entries` is a
-- DIFFERENT object owned by `beauclick_financial_owner`; the points ledger is
-- owned by `beauclick_app`. Referral reaches the ledger only through the
-- existing authorised `LoyaltyLedgerService` path and acquires no direct grant
-- on any loyalty or financial table (ADR-037 §9).
--
-- The financial role boundary is therefore preserved by NOT BEING TOUCHED, and
-- the suite re-verifies it after this migration rather than asserting it.

-- ==========================================================================
-- 1. referral.referrals gains the qualification lifecycle
-- ==========================================================================
--
-- Story #27 deliberately shipped no `status` column, and ADR-036 §12 recorded
-- why: the pending state was the existence of the row plus `expires_at`, and a
-- status column whose only value was 'pending' would have been a speculative
-- column for a story that did not exist. It exists now.

ALTER TABLE referral.referrals
    /*
     * The lifecycle state, and the left-hand side of the compare-and-swap.
     *
     * DEFAULT 'pending' so every row Story #27 already wrote becomes pending
     * without a backfill statement -- which is correct rather than convenient:
     * an attribution that has not qualified IS pending, and there is no other
     * state it could have been in.
     *
     * The closed set is exactly two values. There is deliberately no
     * 'expired' and no 'reversed':
     *
     *  * EXPIRED is not a state, it is a PREDICATE -- `expires_at <= now()` --
     *    and storing it would need a sweeper to maintain, which would make a
     *    referral's expiry depend on whether a background job had run rather
     *    than on the clock. The CAS reads the predicate directly.
     *  * REVERSED belongs to Story #28. Adding it now would be adding that
     *    story's vocabulary to a table before its behaviour exists, and
     *    ADR-037 §13 refuses exactly that.
     */
    ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'pending',

    /*
     * When qualification happened. NULL until it does.
     *
     * Written from the SAME injected-clock reading as the counter period and
     * the event's `qualifiedAt`, so a row cannot disagree with the event that
     * announced it.
     */
    ADD COLUMN qualified_at TIMESTAMPTZ NULL,

    /*
     * WHICH booking qualified this referral -- the one thing this story builds
     * for Story #28 (ADR-037 §13).
     *
     * `V32-DEC-017` makes a FULL refund of the qualifying booking's commerce
     * order the reversal trigger. Without this column the reversal story would
     * have to identify the qualifying order by guessing -- scanning the
     * referee's booking history for a plausible candidate, or replaying
     * historical events -- and both would be wrong the moment a referee has
     * more than one completed booking.
     *
     * A COLUMN, not a behaviour. Nothing in this story reads it.
     *
     * No foreign key to `booking.bookings`: cross-schema FKs are against
     * convention (`V3_DATABASE_BLUEPRINT.md` §1), and here the absence is
     * additionally load-bearing for the reason ADR-036 §2 records -- this row
     * is RETAINED past erasure and must not acquire a referential action that
     * could destroy or block it.
     */
    ADD COLUMN qualifying_booking_id UUID NULL,

    /*
     * The closed vocabulary, enforced where it cannot be bypassed.
     */
    ADD CONSTRAINT ck_referrals_status
        CHECK (status IN ('pending', 'qualified')),

    /*
     * The three qualification facts move together or not at all.
     *
     * A `qualified` row MUST carry both its instant and its booking; a
     * `pending` row must carry neither. This is what makes "a qualified
     * referral without its qualifying booking" UNREPRESENTABLE rather than
     * merely unlikely -- and it is the constraint that would catch a future
     * handler that set the status in one statement and the booking in another,
     * which is precisely the shape that leaves Story #28 unable to find the
     * order after a crash between the two.
     */
    ADD CONSTRAINT ck_referrals_qualification_complete CHECK (
        (status = 'pending'   AND qualified_at IS NULL     AND qualifying_booking_id IS NULL)
        OR
        (status = 'qualified' AND qualified_at IS NOT NULL AND qualifying_booking_id IS NOT NULL)
    ),

    /*
     * Qualification cannot precede attribution. A floor, not the mechanism --
     * the instant comes from the injected clock -- but a hand-written UPDATE
     * could otherwise produce a referral that qualified before it existed.
     */
    ADD CONSTRAINT ck_referrals_qualified_after_attribution
        CHECK (qualified_at IS NULL OR qualified_at >= attributed_at);

/*
 * The CAS's index.
 *
 * The compare-and-swap addresses the row by `referee_user_id` and filters on
 * `status`, and `uq_referrals_referee` already serves the equality. This
 * partial index serves the OTHER access pattern this story creates: finding
 * pending referrals cheaply without scanning qualified ones, which is what the
 * CAS does on every single `BookingCompleted` the platform emits -- including
 * the overwhelming majority for customers who were never referred at all.
 *
 * Partial on `status = 'pending'` because qualified rows are permanent and
 * accumulate forever, while pending ones are the small working set.
 */
CREATE INDEX ix_referrals_pending_referee
    ON referral.referrals (referee_user_id)
    WHERE status = 'pending';

-- --------------------------------------------------------------------------
-- The immutability trigger, extended to the qualification facts
-- --------------------------------------------------------------------------
--
-- ADR-036 §3 froze four columns and left `expires_at` deliberately outside the
-- frozen set, recording the reason: freezing it would have frozen a column
-- whose Story #12 semantics were not yet decided.
--
-- They are decided now, and the qualification facts join the frozen set with a
-- different rule than the original four. Those four are frozen ALWAYS. These
-- two are frozen ONCE SET -- NULL -> value is the qualification itself and must
-- be allowed exactly once; value -> anything else is a rewrite of the fact
-- Story #28 will rely on.
--
-- `expires_at` remains outside the frozen set. It is still not this story's to
-- decide: a reversal or an extension policy might legitimately move it, and
-- ADR-037 does not prejudge Story #28.
--
-- `status` is deliberately NOT frozen: Story #28 must be able to move a
-- qualified referral onward, and freezing it here would force that story to
-- drop and recreate a trigger to do its own job.

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

    RETURN NEW;
END;
$$;

-- ==========================================================================
-- 2. referral.reward_grants -- what was paid, and what deliberately was not
-- ==========================================================================
--
-- `V32-DEC-019`'s owner correction is the whole reason this table has two rows
-- per referral rather than one: *both grants must not be skipped merely because
-- the inviter reached their cap*, and *an invited customer must never lose
-- their own approved reward because of somebody else's activity*.
--
-- The table exists to EXPLAIN a retained loyalty entry, which is also why its
-- subject-data disposition is `retained` (`V32-DEC-019`): destroying it would
-- leave a points row with nothing accounting for it.
CREATE TABLE referral.reward_grants (
    id UUID PRIMARY KEY,

    /*
     * The referral this grant belongs to. No foreign key, for the erasure-
     * lifecycle reason ADR-036 §2 records at length and which applies here
     * with the same force: both rows are retained, but a referential action
     * would tie their fates together in a way no disposition asked for.
     */
    referral_id UUID NOT NULL,

    /*
     * WHO this row is about, and it is not decoration.
     *
     * Named with the `_user_id` suffix so ADR-027's coverage heuristic
     * recognises it: a `no_subject_data` claim on this table would be rejected
     * at boot on the strength of the column name alone. It is also what makes
     * the privacy export possible without joining back to `referrals` -- a
     * subject's own grants are addressable directly.
     */
    recipient_user_id UUID NOT NULL,

    /*
     * Which side. A closed set, CHECK-constrained, and the enum the contract
     * package exports rather than a free-form string.
     */
    side VARCHAR(16) NOT NULL,

    /*
     * What actually happened, and this vocabulary is the story's product
     * surface as much as its data model:
     *
     *  * `awarded`       -- a positive configured value was written to the
     *                       ledger.
     *  * `disabled_zero` -- the configured value is 0. `V32-DEC-016`: zero is
     *                       HONESTLY DISABLED. The row records the decision;
     *                       no ledger row exists and no idempotency slot is
     *                       consumed.
     *  * `capped`        -- the referrer's monthly cap was already spent.
     *                       Referrer side only, by construction: the referee
     *                       has no cap.
     */
    outcome VARCHAR(24) NOT NULL,

    /*
     * The CONFIGURED value at qualification time, which is what makes this row
     * an explanation rather than a restatement.
     *
     * A grant reading `disabled_zero, points 0` says the platform decided, on
     * that date, to award zero -- a materially different claim from silence,
     * and the audit trail `V32-DEC-016`'s "honestly disabled" requires. It also
     * means a later change to the configured figure cannot retroactively alter
     * what a past qualification was worth, which is the same reason
     * `loyalty.points_entries` captures `multiplier_bp` per row.
     */
    points INTEGER NOT NULL,

    /*
     * The ledger reason this side uses. Stored rather than derived, for the
     * reason above: it is part of the explanation of a retained ledger row, and
     * deriving it later from `side` would silently rewrite history if the
     * mapping ever changed.
     */
    ledger_reason VARCHAR(64) NOT NULL,

    granted_at TIMESTAMPTZ NOT NULL,

    /*
     * ONE grant per referral per side, and this is the database half of
     * replay safety.
     *
     * The compare-and-swap already makes a redelivered event a no-op, so this
     * constraint should never fire in a correct system -- which is exactly why
     * it is here. A future code path that reached the grants twice would find
     * the database refusing rather than quietly writing a second row that made
     * a retained ledger entry ambiguous.
     */
    CONSTRAINT uq_reward_grants_referral_side UNIQUE (referral_id, side),

    CONSTRAINT ck_reward_grants_side
        CHECK (side IN ('referrer', 'referee')),
    CONSTRAINT ck_reward_grants_outcome
        CHECK (outcome IN ('awarded', 'disabled_zero', 'capped')),

    /*
     * Points are never negative HERE, and the restriction is deliberate rather
     * than incidental.
     *
     * `V32-DEC-017` makes a reversal a NEW NEGATIVE ROW in the LOYALTY ledger
     * under a distinct reason -- never a mutation of the original, and never a
     * negative grant. A negative value in this column would be Story #28's
     * clawback modelled in the wrong table, which ADR-037 §13 refuses.
     */
    CONSTRAINT ck_reward_grants_points_non_negative CHECK (points >= 0),

    /*
     * The vocabulary and the value must agree, so an incoherent row is
     * unwritable rather than merely unexpected:
     *
     *   awarded        -> a positive value was paid
     *   disabled_zero  -> the configured value really was zero
     *   capped         -> nothing paid, whatever the configured value was
     *
     * `capped` deliberately does NOT constrain `points`: the configured value
     * at the time is still recorded, because "we would have paid N but the cap
     * was spent" is the honest explanation and "we would have paid 0" is a
     * different fact worth keeping apart from it.
     */
    CONSTRAINT ck_reward_grants_outcome_matches_points CHECK (
        (outcome = 'awarded'       AND points > 0)
        OR (outcome = 'disabled_zero' AND points = 0)
        OR (outcome = 'capped')
    ),

    /*
     * Only the referrer can be capped. The referee has no cap by owner
     * decision (`V32-DEC-019`), and a `capped` referee row would be that
     * decision quietly reversed in data.
     */
    CONSTRAINT ck_reward_grants_only_referrer_capped
        CHECK (outcome <> 'capped' OR side = 'referrer')
);

/* A subject's own grants, for the privacy export. */
CREATE INDEX ix_reward_grants_recipient ON referral.reward_grants (recipient_user_id);

-- ==========================================================================
-- 3. referral.referrer_counters -- the monthly cap
-- ==========================================================================
--
-- `V32-DEC-019`: **10 qualified referrals per referrer per Tehran calendar
-- month. No lifetime cap.** Charged by ONE conditional statement -- the third
-- time this repository uses the shape, after `chat.send_counters` and
-- `referral.claim_attempts`:
--
--   INSERT ... VALUES ($1, $2, 1)
--   ON CONFLICT (referrer_user_id, period) DO UPDATE
--     SET qualified_count = ... + 1
--     WHERE ... qualified_count < $3
--   RETURNING qualified_count
--
-- Zero rows returned means the cap is spent. NEVER a read-then-write, which
-- `V32-DEC-019` names as `GAP-04` reproduced knowingly; never an in-memory
-- counter, the HTTP throttler, Redis, or a process-local mutex, each of which
-- is per-process while the instance count is `THROTTLE-STORE`-unresolved.
CREATE TABLE referral.referrer_counters (
    /* `_user_id` suffix, for the ADR-027 coverage reason above. */
    referrer_user_id UUID NOT NULL,

    /*
     * The Tehran calendar month, as `YYYY-MM`.
     *
     * ## The one parameter no closed decision pins precisely (ADR-037 §7)
     *
     * `V32-DEC-019` says "Tehran calendar month". That phrase admits two
     * readings and they are materially different:
     *
     *   * the GREGORIAN month evaluated in `Asia/Tehran` -- what this column
     *     stores, and what `ai`'s `tehranCalendarDay` does for its per-day
     *     quota; or
     *   * the JALALI (Solar Hijri) month, Iran's official calendar, which this
     *     repository fully supports (`toJalali`) and which `persian-utils`
     *     says the platform uses "never Gregorian" for user-facing dates.
     *
     * Jalali months begin around the 21st of a Gregorian one, so the two
     * windows differ by roughly three weeks.
     *
     * **The `ai` precedent does not settle it**: for a DAY the two calendars
     * are the same window and only the label differs, so the question a MONTH
     * asks has never been exercised.
     *
     * Implemented as Gregorian-in-Tehran and FLAGGED FOR RATIFICATION rather
     * than presented as settled -- the course `ADR-035` §3 took with the code
     * format, which the owner later ratified as `V32-DEC-034`.
     *
     * It is materially inert today: BOTH configured reward values are **0**, so
     * a capped referrer is paid nothing and an uncapped one is paid nothing.
     * It is also cheap to change now and expensive later -- this is a bucket
     * key that has never gated a payment. If the owner intends Jalali months,
     * that is a new decision-register entry, not a refactor.
     *
     * A VARCHAR bucket rather than a date range, for the contention reason the
     * other two counters record: bucketing means concurrent referrers in
     * different months touch different rows, and the conditional increment only
     * serialises referrers inside the same month.
     */
    period VARCHAR(7) NOT NULL,

    qualified_count INTEGER NOT NULL,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /*
     * The composite key IS the conflict target of the conditional statement
     * above, and one row per referrer per month is what "per month" means.
     */
    PRIMARY KEY (referrer_user_id, period),

    /*
     * A counter that went non-positive would mean the conditional write above
     * had stopped being the only writer.
     */
    CONSTRAINT ck_referrer_counters_count_positive CHECK (qualified_count > 0),

    /*
     * The shape of the bucket key, enforced so a malformed period cannot
     * silently create a parallel window nothing ever caps.
     */
    CONSTRAINT ck_referrer_counters_period_format
        CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

-- ==========================================================================
-- 4. referral.outbox_events -- the module's first, arriving with its producer
-- ==========================================================================
--
-- ADR-035 §7 and ADR-036 §10 both DECLINED to create this table, and both were
-- right at the time: `ReferralAttributed` is deliberately not defined because
-- it has no consumer, and an outbox table nothing writes would still need a
-- subject-data claim nobody could verify.
--
-- `ReferralQualified` v1 has a consumer -- the in-app notification under the
-- existing opt-outable `referral` category (`V32-DEC-033`) -- so the table
-- arrives with its first real producer rather than ahead of one.
--
-- The shape is the platform's standard outbox, identical to `chat`, `ai`,
-- `journey` and the rest, because the relay reads them all through one
-- `OutboxSource` abstraction and a bespoke shape here would be a second thing
-- to keep in step.
CREATE TABLE referral.outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    correlation_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at TIMESTAMPTZ
);

CREATE INDEX ix_referral_outbox_undispatched
    ON referral.outbox_events (created_at)
    WHERE dispatched_at IS NULL;

-- --------------------------------------------------------------------------
-- What is NOT created, stated so a later reader does not assume an omission
-- --------------------------------------------------------------------------
--
-- **No loyalty migration and no financial migration.** See the header: the
-- ledger's `reason` column has no CHECK constraint, so two new reasons need no
-- schema change, and the financial schema is a different object owned by a
-- different role. Referral acquires NO direct grant on any loyalty or financial
-- table; it reaches the ledger only through the existing authorised
-- `LoyaltyLedgerService` path (ADR-037 §9).
--
-- **Nothing for Story #28.** No reversal table, no `reversed_at`, no negative
-- grant, no clawback row, no refund reference, and no order id. `V32-DEC-017`
-- decides the reversal POLICY; ADR-037 §13 refuses to begin its
-- implementation. The single thing this migration does for that story is the
-- `qualifying_booking_id` COLUMN, which is data it will need and not behaviour
-- it will have.
--
-- **No `status = 'expired'` and no expiry sweeper.** Expired is a predicate
-- (`expires_at <= now()`), not a state, and storing it would make a referral's
-- expiry depend on whether a background job had run.
--
-- **No device, IP, browser, user-agent, or fingerprint column** on the counter
-- or anywhere else. `V32-DEC-019` refuses alternative (c) outright, and the
-- absence is structural: there is no column one could be written to.
--
-- **No manual-review, appeal, or administrator-override column or table.** All
-- three refused outright by `V32-DEC-019`.
--
-- **No second points ledger, no referral balance column, and no cash or wallet
-- field.** The reward unit is loyalty points only (`V32-DEC-016`), and the
-- balance lives in `loyalty.points_entries` where it is derived from the full
-- append-only history rather than stored.
