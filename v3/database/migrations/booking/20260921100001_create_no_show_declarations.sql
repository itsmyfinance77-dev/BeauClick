-- ---------------------------------------------------------------------------
-- V3.3 Story #161 (`#42d`) — the no-show declaration: one immutable fact per
-- booking, evidence-minimal, moving no money (ADR-051 §7, `V33-DEC-039` R6).
--
-- ## What a row is
--
-- The professional's declaration that the customer did not show up, at or
-- after the snapshotted `slot_start + grace_minutes`. It replaces, for a
-- booking whose order carries outcome terms, the V2 `slotEnd > now()` guard —
-- but a declaration is evidence, not a decision: it moves no money and writes
-- no refund or retention. `#42c`'s evaluator decides that later, once the
-- objection window this row opens has closed with no dispute.
--
-- ## Guard and window, both computed on the database clock elsewhere
--
-- This migration stores the SNAPSHOT (`grace_minutes_snapshot`,
-- `objection_window_ends_at`); the guard comparison itself
-- (`now() >= slot_start + grace_minutes`) runs in `booking.service.ts` inside
-- the declaring transaction, against `booking.bookings.slot_start`, never
-- against this table.
--
-- ## Append-only in spirit; three columns are outside the hard freeze
--
-- `evaluation_state` is the one column ordinary evaluation ever moves, and
-- only forward: `window_open -> disputed`, `window_open -> evaluated`, or
-- `disputed -> evaluated` (the eventual `#162` dispute outcome). `statement`
-- is left out of the trigger's frozen list so ADR-027 erasure can anonymise
-- it to a fixed marker while keeping the instant and the money consequence it
-- later produces -- the same discipline `booking.booking_history.reason`/
-- `metadata` already follow. `objection_window_ends_at` is ALSO left out, not
-- for a production write path (none exists) but because it is a computed
-- snapshot (`declared_at` + the snapshotted `dispute_window_hours`, itself
-- bounded to at least one hour) that no test could otherwise ever observe as
-- due -- the same reason `booking.bookings.slot_start` is not DB-frozen
-- either, and `booking-outcome-evaluator.pg-spec.ts`'s `placeCutoff` already
-- relies on that for a conceptually-fixed column of its own. `id`,
-- `booking_id`, `declared_by_user_id`, `declared_at` and
-- `grace_minutes_snapshot` are frozen absolutely; DELETE is refused.
--
-- ## No value, no seed, no alteration of an existing table
-- ---------------------------------------------------------------------------

CREATE TABLE booking.no_show_declarations (
    id UUID PRIMARY KEY,

    /* No cross-schema FK, by the platform's convention (see #128's precedent). */
    booking_id UUID NOT NULL REFERENCES booking.bookings (id),

    /* The professional session that declared it (`BookingProfessionalResolver`). */
    declared_by_user_id UUID NOT NULL,

    /* The database clock of the declaring transaction — never the application clock. */
    declared_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /*
     * The seller's snapshotted grace value, in whole minutes. NULL for a
     * booking with no outcome terms (the legacy `slot_end` guard applied
     * instead, and there is no grace value to snapshot).
     */
    grace_minutes_snapshot SMALLINT,

    /* Minimal evidence: a bounded free-text statement. No photo, file, geolocation or health field exists. */
    statement TEXT NOT NULL,

    /*
     * `declared_at + dispute_window_hours` from the order's outcome-terms
     * snapshot. NULL for a legacy (no-terms) booking, which has no dispute
     * window to open and whose declaration is a pure status-history fact,
     * exactly as `markNoShow` behaved before this story.
     */
    objection_window_ends_at TIMESTAMPTZ,

    evaluation_state VARCHAR(16) NOT NULL DEFAULT 'window_open',

    CONSTRAINT ck_nsd_statement_length CHECK (length(btrim(statement)) BETWEEN 1 AND 2000),
    CONSTRAINT ck_nsd_grace_minutes CHECK (grace_minutes_snapshot IS NULL OR grace_minutes_snapshot BETWEEN 0 AND 1440),
    CONSTRAINT ck_nsd_evaluation_state CHECK (evaluation_state IN ('window_open', 'disputed', 'evaluated')),
    /* A legacy declaration (no grace snapshot) opens no objection window; a governed one always does. */
    CONSTRAINT ck_nsd_window_pair CHECK ((grace_minutes_snapshot IS NULL) = (objection_window_ends_at IS NULL)),
    CONSTRAINT ck_nsd_window_after_declared CHECK (objection_window_ends_at IS NULL OR objection_window_ends_at > declared_at)
);

/* At most one declaration per booking, ever (ADR-051 §7, and the state machine's own exclusivity with cancellation). */
CREATE UNIQUE INDEX uq_no_show_declarations_booking ON booking.no_show_declarations (booking_id);

/* The sweep's own candidate scan: due, still-open windows, oldest first. */
CREATE INDEX ix_no_show_declarations_due
    ON booking.no_show_declarations (objection_window_ends_at)
    WHERE evaluation_state = 'window_open';

-- ==========================================================================
-- Integrity at insert: the database's clock
-- ==========================================================================

CREATE OR REPLACE FUNCTION booking.enforce_no_show_declaration_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.declared_at IS DISTINCT FROM now() THEN
        RAISE EXCEPTION 'booking.no_show_declarations.declared_at must be the database transaction instant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.evaluation_state <> 'window_open' THEN
        RAISE EXCEPTION 'booking.no_show_declarations must be created with evaluation_state = window_open'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_nsd_integrity
    BEFORE INSERT ON booking.no_show_declarations
    FOR EACH ROW
    EXECUTE FUNCTION booking.enforce_no_show_declaration_integrity();

-- ==========================================================================
-- Forward only: evaluation_state moves once, in one direction; everything
-- else is frozen; no DELETE
-- ==========================================================================

CREATE OR REPLACE FUNCTION booking.enforce_no_show_declaration_forward_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'booking.no_show_declarations rows are permanent: a declaration is never removed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    /*
     * `statement` is deliberately NOT in this frozen list -- ADR-027 requires
     * erasure to anonymise it to a fixed marker while keeping the instant and
     * the money consequence it later produces. Enforced by convention rather
     * than by trigger, exactly as `booking.booking_history.reason`/`metadata`
     * already are: only `BookingSubjectDataContract.eraseSubjectData` issues
     * such an UPDATE.
     *
     * `objection_window_ends_at` is ALSO not in this frozen list, for a
     * narrower reason: it is computed from `declared_at` (itself frozen and
     * verified against the database clock by the integrity trigger above) plus
     * the snapshotted `dispute_window_hours`, which the platform's own
     * publication CHECK (`commerce.order_outcome_terms.ck_oot_dispute_window`)
     * bounds to at least one hour -- so no production declaration can ever be
     * evaluable inside the same test run that created it, exactly the
     * constraint `booking.bookings.slot_start`/`hold_expires_at` face and are
     * NOT DB-frozen for either. No service in this codebase ever issues this
     * UPDATE; it exists so a test can position a window as already due, the
     * same convention `booking-outcome-evaluator.pg-spec.ts`'s own
     * `placeCutoff` helper already relies on for a different immutable-in-
     * spirit column.
     */
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
       OR NEW.declared_by_user_id IS DISTINCT FROM OLD.declared_by_user_id
       OR NEW.declared_at IS DISTINCT FROM OLD.declared_at
       OR NEW.grace_minutes_snapshot IS DISTINCT FROM OLD.grace_minutes_snapshot
    THEN
        RAISE EXCEPTION 'booking.no_show_declarations is immutable except evaluation_state, statement (ADR-027 erasure) and objection_window_ends_at (test backdating only)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.evaluation_state IS DISTINCT FROM OLD.evaluation_state
       AND NOT (
             (OLD.evaluation_state = 'window_open' AND NEW.evaluation_state IN ('disputed', 'evaluated'))
          OR (OLD.evaluation_state = 'disputed' AND NEW.evaluation_state = 'evaluated')
       )
    THEN
        RAISE EXCEPTION 'booking.no_show_declarations.evaluation_state % -> % is not permitted: it moves forward only, window_open -> disputed -> evaluated',
            OLD.evaluation_state, NEW.evaluation_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_nsd_forward_only
    BEFORE UPDATE OR DELETE ON booking.no_show_declarations
    FOR EACH ROW
    EXECUTE FUNCTION booking.enforce_no_show_declaration_forward_only();

-- ---------------------------------------------------------------------------
-- No backfill: no booking marked no-show before this story acquires a
-- declaration row retroactively.
-- ---------------------------------------------------------------------------

COMMENT ON TABLE booking.no_show_declarations IS
    'V3.3 #161 (#42d), ADR-051 §7. One immutable declaration per booking, minimal evidence, moving no money. grace_minutes_snapshot/objection_window_ends_at are NULL for a legacy (no outcome-terms) booking, which keeps the V2 slot_end guard and never opens an objection window. ADR-027 subject_data (both parties): erasure anonymises statement, keeps the instant and the money consequence it later produces.';
