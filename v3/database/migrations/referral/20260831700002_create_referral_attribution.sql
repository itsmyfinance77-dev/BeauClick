-- V3.2-C Story #27, referral-service. Attribution: the claim lifecycle
-- (ADR-036).
--
-- Story #11 shipped a referral CODE -- a bearer credential, one per owner,
-- about exactly one person. This migration adds the first object in the
-- domain that is about TWO people, and every constraint below exists because
-- a two-party row is where the interesting failures live.
--
-- Every rule here is an owner decision recorded in
-- `V3.2_DECISION_REGISTER.md` §C: self-referral is unrepresentable and a
-- person is attributed once ever (`V32-DEC-019`), pending attribution expires
-- at 90 days (`V32-DEC-017`), the claim route is throttled at 10 attempts per
-- authenticated caller per hour in PostgreSQL rather than in the in-memory
-- HTTP throttler (`V32-DEC-019`), attribution is immutable (`V32-DEC-019`),
-- and `referral.referrals` is `retained` with the erased side's identity
-- tombstoned because the row is what explains a retained loyalty entry the
-- other party still holds (`V32-DEC-019`).
--
-- ## TWO tables, and the restraint is the same one Story #11 recorded
--
-- `V32-DEC-019`'s dispositions table also names `referral.reward_grants` and
-- `referral.referrer_counters`. NEITHER is created here, because the reward
-- path is Stories #12 and #28. Creating a table ahead of the story that fills
-- it also forces a subject-data claim on it -- and ADR-027's coverage check
-- runs against the real catalogue at boot, so an empty table with a
-- speculative disposition is a claim nobody can verify.

-- ==========================================================================
-- referral.referrals -- the attribution relationship
-- ==========================================================================
CREATE TABLE referral.referrals (
    id UUID PRIMARY KEY,

    /*
     * The two parties.
     *
     * Both ALWAYS resolved server-side: the referee is the authenticated
     * session and no route anywhere accepts it, and the referrer is read from
     * the claimed code's row -- never sent by a caller, in a body, a query
     * parameter, a path segment, or a header.
     *
     * Named with the `_user_id` SUFFIX rather than `referrer_id`/`referee_id`
     * because ADR-027's boot-time coverage heuristic recognises that suffix: a
     * `no_subject_data` claim on this table would be rejected at boot on the
     * strength of the column names alone. The declared disposition and its
     * test are the real guarantee; the naming is belt, not braces.
     */
    referrer_user_id UUID NOT NULL,
    referee_user_id UUID NOT NULL,

    /*
     * WHICH code was claimed -- the row's internal id, NOT the code string,
     * and that is a privacy decision rather than a normalisation preference.
     *
     * Storing the code here would retain a BEARER CREDENTIAL belonging to the
     * referrer on a row that is `retained` past the referrer's own erasure,
     * and would put it one careless join away from the referee's export --
     * which `V32-DEC-019` forbids in terms: *a referee's export contains their
     * own referral fact and never the referrer's bearer code*. An opaque
     * internal UUID is not a credential and cannot be typed into a claim.
     *
     * NO FOREIGN KEY to `referral.referral_codes`, and the absence is
     * deliberate rather than conventional. The two rows have deliberately
     * DIFFERENT erasure lifecycles: the code is DELETED on its owner's erasure
     * (`V32-DEC-019`, ADR-035 §6) while this row is RETAINED. No referential
     * action expresses that -- CASCADE would destroy the retained
     * relationship, RESTRICT would make erasure impossible, and SET NULL would
     * mutate a column the trigger below freezes. A dangling reference after
     * the referrer's erasure is therefore the CORRECT end state: the
     * credential is destroyed and the relationship survives, which is exactly
     * the disposition the owner ratified.
     */
    referral_code_id UUID NOT NULL,

    /*
     * When the relationship was formed, and when the pending attribution
     * lapses.
     *
     * BOTH are computed in the application from ONE reading of an injected
     * clock, not from `now()` here -- so the 90-day relationship between them
     * is exact rather than approximately exact, and so the boundary is
     * testable without waiting 90 days. `V32-DEC-017` fixes the pending expiry
     * at 90 days as an ABSOLUTE UTC DURATION.
     *
     * Deliberately NOT a Tehran calendar boundary. `V32-DEC-019`'s referrer
     * cap IS per Tehran calendar month and belongs to Story #12; confusing the
     * two would make "90 days" mean something subtly different for a claim at
     * 23:00 than for one at 01:00. The same distinction `ChatClock` already
     * draws against `ai`'s per-calendar-day quota.
     *
     * There is no DEFAULT on either. A default would let a raw INSERT that
     * omitted them produce a row whose expiry bore no relationship to its
     * attribution instant.
     */
    attributed_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,

    /*
     * The tombstone markers (`V32-DEC-019`, ADR-036 §9).
     *
     * The disposition is `retained` WITH THE ERASED SIDE'S IDENTITY
     * TOMBSTONED. This row never held a name, a phone, a display value, or
     * free text -- only ids and instants -- so there is no identifying content
     * to destroy, which is the platform's stated erasure model for id-only
     * rows.
     *
     * What these columns add is the thing the decision asks for and the ids
     * alone do not provide: a POSITIVE RECORD that one side is erased, so no
     * surface can present the relationship as involving an active account, and
     * so the erasure report can count the row honestly as `anonymized` rather
     * than silently as nothing.
     *
     * Stamped with the platform's shared `tombstoneFor(...).erasedAt`. This
     * module invents no tombstone system.
     *
     * These two are the ONLY columns on this table that may ever change, and
     * the trigger below is what makes that true rather than a convention.
     */
    referrer_erased_at TIMESTAMPTZ NULL,
    referee_erased_at TIMESTAMPTZ NULL,

    /*
     * Attributed ONCE, EVER (`V32-DEC-019`).
     *
     * This is the ONLY mechanism. There is no application check that "really"
     * enforces it and no advisory lock in front of it: two concurrent claims
     * for one referee both pass every eligibility read -- under READ COMMITTED
     * neither transaction can see the other's uncommitted row -- and this
     * constraint is what decides which one wins. The loser catches 23505 BY
     * CONSTRAINT NAME and returns the collapsed refusal.
     *
     * The same shape `uq_referral_codes_owner` already has, and the shape
     * `V32-DEC-019` demands in the same words for the referrer cap: never a
     * read-then-write, which is `GAP-04` in miniature.
     *
     * Note what is NOT unique: the referrer. One person may invite many, which
     * is the entire product. Only the referee is capped, and at one.
     */
    CONSTRAINT uq_referrals_referee UNIQUE (referee_user_id),

    /*
     * Self-referral is UNREPRESENTABLE, which is stronger than prevented
     * (`V32-DEC-019`).
     *
     * The service refuses it earlier, with the collapsed refusal, so a caller
     * claiming their own code gets the same answer as every other refusal
     * rather than a constraint error. But the GUARANTEE is this line, and the
     * suite proves it by attempting a RAW INSERT that bypasses the service
     * entirely -- because a guarantee that only holds when the application is
     * correct is not a guarantee.
     */
    CONSTRAINT ck_referrals_no_self CHECK (referrer_user_id <> referee_user_id),

    /*
     * A floor, not the mechanism. The 90-day duration is computed in the
     * application from the injected clock; this only makes a row whose expiry
     * precedes its attribution unwritable, which no correct path produces and
     * a hand-written INSERT easily does.
     */
    CONSTRAINT ck_referrals_expiry_after_attribution CHECK (expires_at > attributed_at)
);

/*
 * The referrer's own rows, for their privacy export.
 *
 * The referee direction needs no index: `uq_referrals_referee` already serves
 * every lookup by referee, which is the hot path (the prior-attribution check
 * on every claim). This one is the only access path not already covered.
 */
CREATE INDEX ix_referrals_referrer ON referral.referrals (referrer_user_id);

-- --------------------------------------------------------------------------
-- Attribution is IMMUTABLE, enforced by the database (`V32-DEC-019`)
-- --------------------------------------------------------------------------
--
-- *No route, service method, or admin path rewrites the referrer, the code, or
-- the attribution instant.* Story #27 requires a second attribution to be
-- UNWRITABLE, not merely unimplemented.
--
-- `uq_referrals_referee` already makes a second INSERT unwritable. It says
-- nothing about an UPDATE, and "there is no route that does that" is exactly
-- the guarantee that decays the first time somebody adds an admin surface.
--
-- ## Why a trigger, in a repository that has none
--
-- This is the first trigger in the codebase and the departure needs a reason
-- rather than a shrug (ADR-036 §3).
--
-- The platform's existing immutability mechanism is privilege revocation:
-- `financial.ledger_entries` is owned by `beauclick_financial_owner` and
-- REVOKE UPDATE strips the application role (ADR-017). That mechanism is
-- unavailable here for a specific reason -- `referral` is an APPLICATION-OWNED
-- schema, and the tombstone above requires the application role to UPDATE this
-- very table. A blanket REVOKE UPDATE would break erasure. A column-level
-- grant would still leave the owner able to re-grant itself in one statement,
-- which is precisely the argument ADR-017 makes AGAINST an application-owned
-- ledger.
--
-- A trigger fires for the table owner too, and it protects the four frozen
-- columns while leaving the two tombstone columns writable. It is the only
-- mechanism that expresses "these four are frozen and those two are not".
--
-- `expires_at` is deliberately OUTSIDE the frozen set even though nothing
-- updates it: freezing it would freeze a column whose Story #12 semantics are
-- not yet decided, and the four columns `V32-DEC-019` names are the four it
-- names.
--
-- IS DISTINCT FROM rather than <>, so a NULL on either side compares correctly
-- rather than yielding NULL and silently skipping the check. None of the four
-- is nullable today; writing it the other way would make that a load-bearing
-- assumption instead of an observation.

CREATE OR REPLACE FUNCTION referral.reject_attribution_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.referrer_user_id IS DISTINCT FROM OLD.referrer_user_id
       OR NEW.referee_user_id IS DISTINCT FROM OLD.referee_user_id
       OR NEW.referral_code_id IS DISTINCT FROM OLD.referral_code_id
       OR NEW.attributed_at IS DISTINCT FROM OLD.attributed_at
    THEN
        -- Names the COLUMN SET, never the values. A referrer id in an error
        -- message is a subject id in a log line, and `V32-DEC-033` keeps
        -- referral material out of exception text.
        RAISE EXCEPTION 'referral.referrals attribution is immutable: referrer_user_id, referee_user_id, referral_code_id and attributed_at cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_referrals_immutable
    BEFORE UPDATE ON referral.referrals
    FOR EACH ROW
    EXECUTE FUNCTION referral.reject_attribution_rewrite();

-- ==========================================================================
-- referral.claim_attempts -- the PostgreSQL claim throttle (`V32-DEC-019`)
-- ==========================================================================
--
-- *10 attempts per authenticated caller per hour*, enforced HERE and not in
-- the in-memory HTTP throttler, whose effective limit multiplies by instance
-- count while `THROTTLE-STORE` is unresolved. The guard still runs as coarse
-- abuse control; it is not what makes ten mean ten.
--
-- This number is not a comfort setting. `V32-DEC-034` prices it as a GUESS
-- RATE -- 10 per hour against a 31^10 keyspace is an exhaustive search of
-- ~9.35 billion years -- and makes it the stated reason the code is ten
-- characters rather than eight. A throttle that counted only SUCCESSFUL claims
-- would bound nothing and would make that table false, which is why the slot
-- is reserved BEFORE eligibility is evaluated (ADR-036 §6a).
CREATE TABLE referral.claim_attempts (
    /*
     * `claimant_user_id`, not `user_id`, for the ADR-027 suffix reason the
     * referrals table above records.
     */
    claimant_user_id UUID NOT NULL,

    /*
     * The start of the UTC hour, computed in the application from the injected
     * clock.
     *
     * BUCKETED rather than a rolling window, and the reason is contention
     * rather than simplicity -- the same reason `chat.send_counters` records
     * for its minute bucket. One counter row per user, rewritten on every
     * attempt, becomes the hottest row in the schema and serialises every
     * claimant against every other. Bucketing means the conditional increment
     * only ever serialises claimants inside the SAME hour, which is precisely
     * the set the limit is about.
     */
    window_start TIMESTAMPTZ NOT NULL,

    attempt_count INT NOT NULL,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /*
     * The composite key IS the conflict target of the one conditional
     * statement that charges an attempt:
     *
     *   INSERT ... VALUES ($1, $2, 1)
     *   ON CONFLICT (claimant_user_id, window_start) DO UPDATE
     *     SET attempt_count = ... + 1
     *     WHERE ... attempt_count < $3
     *   RETURNING attempt_count
     *
     * Zero rows returned means the limit is spent. `V32-DEC-019` forbids the
     * alternative in the same words it uses for the referrer cap: never a
     * read-then-write, which lets two concurrent claims both observe 9 and
     * both write 10.
     */
    PRIMARY KEY (claimant_user_id, window_start),

    /*
     * A counter that went negative or unbounded would mean the conditional
     * write above stopped being the only writer. Cheap, and it fails loudly
     * rather than silently disabling the limit.
     */
    CONSTRAINT ck_claim_attempts_count_positive CHECK (attempt_count > 0)
);

-- --------------------------------------------------------------------------
-- What is NOT created, stated so a later reader does not assume an omission
-- --------------------------------------------------------------------------
--
-- No `referral.reward_grants` and no `referral.referrer_counters` -- Stories
-- #12 and #28.
--
-- No `referral.outbox_events`. `ReferralAttributed` is deliberately NOT
-- defined and NOT emitted: it has no consumer (`V32-DEC-033`, ADR-035 §7,
-- ADR-036 §10). Story #12 consumes `BookingCompleted` (`V32-DEC-018`), not an
-- attribution event, and `V32-DEC-033` restricts referral notifications to the
-- qualified and reversed moments. An outbox table nothing writes would still
-- need a subject-data claim nobody could verify.
--
-- No `status`, `qualified_at`, `reward_*`, `capped`, `reversal_*`, or
-- `review_*` column on `referral.referrals`. `V32-DEC-019` permits a
-- capped-or-refused enum on the referral row and `V32-DEC-016`/`V32-DEC-017`
-- define qualification and reversal -- all of which belong to Stories #12 and
-- #28. The pending state in THIS story is the existence of the row plus
-- `expires_at`, and that is complete: an attribution that never qualified and
-- whose expiry has passed is expired, and the thing that reads it does not
-- exist yet.
--
-- No device, IP, browser, user-agent, or fingerprint column. `V32-DEC-019`
-- refuses alternative (c) outright, and the absence is structural: there is no
-- column one could be written to.
--
-- No manual-review, appeal, or administrator-override column or table. All
-- three are refused outright by `V32-DEC-019`.
--
-- No cross-schema foreign key to `identity.users` or `booking.bookings`.
-- Cross-schema FKs are against convention (`V3_DATABASE_BLUEPRINT.md` §1), and
-- here the absence is additionally load-bearing: an ON DELETE CASCADE from
-- `identity.users` would destroy a RETAINED row on erasure and make the
-- module's own subject-data contract -- the thing ADR-027 makes verifiable --
-- appear to work while doing nothing. Both facts are read through narrow
-- ports at claim time instead (ADR-011, ADR-036 §4).
