-- ---------------------------------------------------------------------------
-- V3.3 Story #161 (`#42d`) — unlocks the `no_show` decision kind on
-- `commerce.booking_outcome_decisions`, ADR-051 §6's 2026-09-15 note (12):
-- "`no_show` ... decision rows stay unwritable (`ck_bod_kind_defined`) until
-- #161 ... defines their rules."
--
-- ## Additive only — the #160 migration is never edited
--
-- `20260920100001_create_booking_outcome_decisions.sql` is #160's own,
-- already applied wherever this platform runs; this migration only widens two
-- CHECK constraints (drop-and-recreate, the only way PostgreSQL changes a
-- CHECK) and adds two new ones scoped to `decision_kind = 'no_show'`. No
-- table is created, no column is added, no existing row is rewritten, and
-- every `cancellation`/`reschedule_consequence` row that already exists keeps
-- satisfying every constraint exactly as before — none of the widened or new
-- CHECKs restrict anything but a `no_show` row.
--
-- ## What a no-show decision row means
--
-- The `#42c` evaluator, invoked by #161's window-expiry sweep/lazy mechanism,
-- reads `terms.noShowRetention` (never `lateCancellationRetention`) and
-- applies the SAME `min(policy, legalCap, collectedRemaining)` arithmetic
-- (`V33-DEC-039` R6, "R5's arithmetic applied to the snapshotted no-show
-- retention policy"). A no-show carries no cutoff or timeliness concept at
-- all: `timely` and `cutoff_instant` are always NULL, exactly as a
-- `legacy_unenrolled` cancellation's already are.
-- ---------------------------------------------------------------------------

-- Unlock the kind #161 defines rules for. `dispute_outcome` (#162) stays refused.
ALTER TABLE commerce.booking_outcome_decisions
    DROP CONSTRAINT ck_bod_kind_defined;
ALTER TABLE commerce.booking_outcome_decisions
    ADD CONSTRAINT ck_bod_kind_defined CHECK (decision_kind IN ('cancellation', 'no_show', 'reschedule_consequence'));

-- `cap_applied` preconditions, widened to admit a no-show's shape: no cutoff,
-- no timeliness, and the cause is `no_show` rather than `customer`. The
-- `customer`/`timely IS FALSE` branch is byte-for-byte what #160 shipped.
ALTER TABLE commerce.booking_outcome_decisions
    DROP CONSTRAINT ck_bod_cap_applied_preconditions;
ALTER TABLE commerce.booking_outcome_decisions
    ADD CONSTRAINT ck_bod_cap_applied_preconditions CHECK (
        basis <> 'cap_applied'
        OR (booking_was_confirmed
            AND policy_key IS NOT NULL
            AND legal_cap_state = 'applied'
            AND retained_toman = LEAST(policy_amount_toman, legal_cap_toman, collected_remaining_toman)
            AND (
                (cause = 'customer' AND timely IS FALSE)
                OR (cause = 'no_show' AND timely IS NULL AND cutoff_instant IS NULL)
            ))
    );

-- A no-show divides exactly what remains collected, same identity a cancellation carries.
ALTER TABLE commerce.booking_outcome_decisions
    ADD CONSTRAINT ck_bod_no_show_sum CHECK (
        decision_kind <> 'no_show' OR retained_toman + refund_toman = collected_remaining_toman
    );

-- The one booking-derived request key a no-show's refund is issued under --
-- always set, exactly as `ck_bod_cancellation_key` always requires one for a
-- cancellation, whether or not this particular decision ends up refunding
-- anything.
ALTER TABLE commerce.booking_outcome_decisions
    ADD CONSTRAINT ck_bod_no_show_key CHECK (
        decision_kind <> 'no_show' OR refund_request_key = 'booking-no-show:' || booking_id::text
    );

-- A no-show carries no cutoff or timeliness fact, structurally — mirrors the
-- `legacy_unenrolled` shape already required of every decision kind.
ALTER TABLE commerce.booking_outcome_decisions
    ADD CONSTRAINT ck_bod_no_show_no_cutoff CHECK (
        decision_kind <> 'no_show' OR (timely IS NULL AND cutoff_instant IS NULL)
    );

COMMENT ON CONSTRAINT ck_bod_kind_defined ON commerce.booking_outcome_decisions IS
    'V3.3 #161 (#42d) unlocked no_show. dispute_outcome stays refused until #162 defines its rules.';
