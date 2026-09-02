-- V3.2-C Story #11, referral-service. The customer's referral identity
-- (ADR-035).
--
-- Every constraint here is an owner decision recorded in
-- `V3.2_DECISION_REGISTER.md` §C on 2026-08-30: one referral code per owner
-- (`V32-DEC-019`), the invite link is `{origin}/invite/{code}` with no
-- independent expiry (`V32-DEC-033`), and `referral.referral_codes` is
-- `subject_data`, deleted on the owner's erasure, because an ownerless code
-- must not remain claimable (`V32-DEC-019`).
--
-- ## ONE table, and this story creates exactly one
--
-- `V32-DEC-019`'s dispositions table also names `referral.referrals`,
-- `referral.reward_grants`, and `referral.referrer_counters`. **None of them is
-- created here**, because attribution is Story #27 and the reward path is
-- Stories #12 and #28. Creating a table ahead of the story that fills it would
-- also force a subject-data claim on it -- and ADR-027's coverage check runs
-- against the real catalogue at boot, so an empty table with a speculative
-- disposition is a claim nobody can verify.
--
-- ## The things deliberately absent from this table
--
-- **No `expires_at`.** `V32-DEC-033`: the invite link has no independent
-- expiry, and its validity follows the code and the referral lifecycle. A
-- column nothing sets would be a third clock, and the state it would create --
-- "this link expired but your code still works" -- is one nobody can explain.
--
-- **No `revoked_at`.** Erasure DELETES the row, which is the disposition
-- `V32-DEC-019` chose. A soft-revocation column would make that claim false in
-- the schema while it was still true in the code. A future revocation state
-- that is not erasure is a migration and a decision, not a nullable column
-- added on the chance somebody wants one.
--
-- **No `outbox_events` table.** This story emits nothing. `ReferralQualified`
-- and `ReferralReversed` are approved by `V32-DEC-033` but belong to the reward
-- path and have no producer yet, and `ReferralAttributed` is deliberately NOT
-- defined because it has no consumer. An outbox table nothing writes would
-- still need a subject-data claim nobody could verify.
--
-- **No usage, share, or claim counters.** No `share_count`, `last_shared_at`,
-- or `claimed_count`. Each would be an analytics fact this story is forbidden
-- to collect, and `V32-DEC-033` refuses share-tracking outright. The absence is
-- structural: there is no column that could hold one.
--
-- ## Column naming is a privacy control, not a style choice
--
-- ADR-027's boot-time coverage check rejects a `no_subject_data` claim on any
-- table carrying a subject-shaped column, and it recognises the `_user_id`
-- SUFFIX. The identity column is therefore named `owner_user_id` rather than
-- `owner` or `user`: the naming and the declared disposition agree, and the
-- check can see both. The disposition is still declared explicitly and proved
-- by test; the naming is belt, not braces.

CREATE SCHEMA IF NOT EXISTS referral;

-- --------------------------------------------------------------------------
-- One row per owner. The whole of Story #11.
-- --------------------------------------------------------------------------
CREATE TABLE referral.referral_codes (
    id UUID PRIMARY KEY,

    /*
     * The owner. ALWAYS resolved from the authenticated session; no route
     * anywhere accepts this value from a caller, in a body, a query parameter,
     * a path segment, or a header.
     *
     * UNIQUE is `V32-DEC-019`'s "one referral code per owner", enforced by the
     * database rather than by policy. It is also what makes the create-on-first-
     * read route safe under concurrency: two simultaneous first reads both find
     * no row and both insert, and this constraint is what decides which one
     * wins. The loser re-reads and returns the winner's code, so both callers
     * receive the SAME code rather than the owner ending up with two.
     */
    owner_user_id UUID NOT NULL,

    /*
     * The code itself.
     *
     * Ten characters from a 31-character alphabet (ADR-035 §3): Crockford
     * Base32 minus `0`, so `I`, `L`, `O`, `U`, and `0` are all absent -- the
     * glyphs a reader supplies from memory instead of from the screen. About
     * 49.5 bits of entropy, drawn from a CSPRNG with rejection sampling rather
     * than modulo, and carrying NO user-derived material: not the phone, the
     * user id, a timestamp, a sequence, or a hash of any of them.
     *
     * VARCHAR(16) rather than CHAR(10): the width is deliberately larger than
     * the current length so that ratifying a longer code (ADR-035 §3 flags the
     * parameter as unratified) is a constant change rather than a column
     * rewrite on a table that will by then be referenced by attribution rows.
     * The exact length is enforced by the contract and by a CHECK below, which
     * is where a reader looks for it.
     *
     * UNIQUE is the global-uniqueness guarantee AND the collision mechanism.
     * Generation is insert-and-retry against this index -- never a
     * read-then-write "is this code taken" check, which is `GAP-04` in
     * miniature: two concurrent generations that draw the same code both
     * observe it free under READ COMMITTED and both proceed.
     */
    code VARCHAR(16) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /*
     * The shape, enforced where it cannot be bypassed.
     *
     * The service generates from the contract's alphabet, so this constraint is
     * not the primary control -- it is the one that still holds when somebody
     * inserts directly, which is exactly how a test seeds a forced collision
     * and exactly how a future migration might try to backfill.
     *
     * Written as an explicit character class rather than as a length check
     * alone, so a code containing `O` or `0` is unwritable rather than merely
     * unlikely.
     */
    CONSTRAINT ck_referral_codes_shape
        CHECK (code ~ '^[123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$'),

    /*
     * One code per owner (`V32-DEC-019`). Named, because the service tells this
     * violation apart from the code collision below BY NAME rather than by
     * catching every 23505 and guessing -- a handler that mistook an owner
     * conflict for a code collision would loop generating fresh codes while the
     * real conflict never went away.
     */
    CONSTRAINT uq_referral_codes_owner UNIQUE (owner_user_id),

    /*
     * Globally unique. This constraint IS the collision-handling mechanism, not
     * a safety net under an application check -- there is no weaker path to
     * accidentally rely on. Deliberately the same shape as
     * `uq_wishlist_saved_items_user_target` and
     * `uq_points_entries_reference_once`, and for the reason those migrations
     * record.
     */
    CONSTRAINT uq_referral_codes_code UNIQUE (code)
);

-- No additional index is created, and the absence is deliberate.
--
-- Both access paths this story has are already served by the two unique
-- constraints above: the read route looks a row up by `owner_user_id`, and the
-- subject-data export and erasure do the same. Story #27's claim route will
-- look one up by `code`, which `uq_referral_codes_code` serves. A third index
-- would be one nothing reads.

-- --------------------------------------------------------------------------
-- What is NOT created, stated so a later reader does not assume an omission
-- --------------------------------------------------------------------------
--
-- No `referral.outbox_events`. No `referral.referrals` (Story #27). No
-- `referral.reward_grants` and no `referral.referrer_counters` (Stories #12 and
-- #28). No foreign key to `identity.users`: cross-schema FKs are against
-- convention (`V3_DATABASE_BLUEPRINT.md` §1), and here the absence is
-- additionally load-bearing, because an `ON DELETE CASCADE` would make erasure
-- look like it worked while the module's own subject-data contract -- the thing
-- ADR-027 makes verifiable -- did nothing.
