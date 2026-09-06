-- ---------------------------------------------------------------------------
-- V3.3 Story #83 (`#41d-1`) — the administrator-published booking collection
-- policy catalogue (ADR-048, `V33-DEC-028`, `V33-DEC-029`).
--
-- This migration creates a PUBLICATION plane and nothing else. It creates ZERO
-- policies, ZERO versions, and no seed, default or fallback of any kind. On the
-- day it lands, every order still takes the path it took the day before:
-- nothing here is read by `commerce`, and no row exists to read.
--
-- ## What is deliberately absent
--
-- **No assignment table.** `commercial.seller_collection_policy_assignments`
-- is #104 (`#41d-2`). A table created ahead of the story that fills it would
-- also force an ADR-027 disposition nobody could verify, which is the mistake
-- `referral`'s first migration records at length.
--
-- **No change to `commerce.order_payment_schedules`.** Its all-three
-- `ck_ops_policy_reference` stands untouched until #104 replaces it. This story
-- writes nothing to `commerce`, reads nothing from it, and adds no resolver.
--
-- **No commercial value.** No enabled-mode set, mode default, deposit amount,
-- percentage, minimum, maximum, rounding rule or percentage-base default
-- appears below, and none is possible: every commercial column is NOT NULL with
-- NO DEFAULT, or conditionally NULL by CHECK. `V33-DEC-028` Ruling 2, and a
-- repository test in `services/commercial-policy` enforces it against this
-- file. The one DEFAULT here is `lifecycle_state = 'draft'`, which is the
-- fail-closed state and cannot choose a commercial outcome.
--
-- **No acceptance.** Nothing here records or implies that a customer accepted
-- anything. `policy_accepted_at` lives in `commerce` and stays #42's, after
-- Legal (`V33-DEC-029` Ruling 3).
--
-- ## Column naming is a privacy control, not a style choice
--
-- ADR-027's boot-time coverage check recognises the `_user_id` SUFFIX and
-- rejects a `no_subject_data` claim on any table carrying a subject-shaped
-- column. Every actor column here is therefore `*_by_user_id`, and both tables
-- are claimed `retained` — never `no_subject_data`.
--
-- ## The effective-interval correction
--
-- ADR-048 as accepted specified a plain
-- `tstzrange(activation_starts_at, activation_ends_at, '[)')` over non-draft
-- rows. That is wrong, and the ADR was corrected before this file was written:
-- an open-ended version that is later retired would keep `[start, infinity)`
-- for ever and block every future version of the same key, defeating the
-- forward republication the same ADR requires. The exclusion constraint below
-- therefore indexes the version's EFFECTIVE window. See
-- `commercial.booking_collection_policy_effective_window`.
-- ---------------------------------------------------------------------------

-- `btree_gist` is already installed by the catalogue migration; this is
-- idempotent and stated here so the dependency is visible at the point of use
-- rather than inherited silently.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ==========================================================================
-- commercial.booking_collection_policies -- the stable key
-- ==========================================================================
--
-- One row per policy the platform has ever offered. It carries NO terms: a
-- term that lived here would be a mutable field on a live policy, which is the
-- model ADR-048 §3 rejects for exactly the reason ADR-041 rejected it. Every
-- collection rule lives on an immutable version below.

CREATE TABLE commercial.booking_collection_policies (
    policy_key VARCHAR(64) PRIMARY KEY,

    /*
     * Administrative prose. Never shown to a customer, and never legal copy:
     * approved customer-facing wording is `V33-DEC-017`, still open on #42 and
     * Legal, and nothing in this schema may stand in for it.
     */
    display_name VARCHAR(120) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /*
     * WHO created it. Always the authenticated session's own user id, resolved
     * server-side; no route accepts this value from a caller in a body, a query
     * parameter, a path segment or a header.
     *
     * NULL only where a non-session actor is recorded by label instead -- the
     * same pairing `commercial.plans` and `admin.admin_audit_log` use. No such
     * actor exists in this migration, because this migration seeds nothing.
     */
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    CONSTRAINT ck_bcp_key_shape CHECK (policy_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    CONSTRAINT ck_bcp_display_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_bcp_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    )
);

-- ==========================================================================
-- commercial.booking_collection_policy_versions -- immutable collection terms
-- ==========================================================================

CREATE TABLE commercial.booking_collection_policy_versions (
    id UUID PRIMARY KEY,

    policy_key VARCHAR(64) NOT NULL REFERENCES commercial.booking_collection_policies (policy_key),
    version INTEGER NOT NULL,

    /*
     * `draft -> published -> retired`, one way, no return (ADR-048 §4).
     *
     * The DEFAULT is the fail-closed state, and the INSERT branch of
     * `commercial.enforce_booking_collection_version_lifecycle` refuses any
     * other one -- so a row cannot be born published and skip publication.
     */
    lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'draft',

    /*
     * The three modes `V33-DEC-003` closed and `V33-DEC-028` Ruling 6 confirmed
     * as final. NOT NULL with NO DEFAULT: an administrator chooses, or the
     * INSERT fails. There is no fourth member and no default member.
     */
    collection_mode VARCHAR(40) NOT NULL,

    /*
     * The deposit CALCULATION RULE. `V33-DEC-028` Ruling 6: fixed and
     * percentage are rules that PRODUCE `deposit_online_balance_at_venue`; they
     * are not modes. NOT NULL with no default, like the mode.
     */
    deposit_kind VARCHAR(16) NOT NULL,

    /*
     * Exactly one of these shapes is populated, decided by `deposit_kind` and
     * enforced by `ck_bcpv_deposit_shape` below. Every one is NULL by absence
     * rather than by default: no amount, rate or bound is a value this schema
     * supplies.
     */
    deposit_amount_toman BIGINT,
    deposit_basis_points INTEGER,
    deposit_minimum_toman BIGINT,
    deposit_maximum_toman BIGINT,

    /*
     * WHICH authoritative order amount a percentage applies to
     * (`V33-DEC-029` Ruling 4). Closed to exactly two members because exactly
     * two exist authoritatively at order creation. Required for a percentage
     * rule, NULL otherwise, and no default: the administrator chooses, and
     * engineering chose neither.
     */
    percentage_base VARCHAR(24),

    /*
     * Which contract version wrote the row. A future `V2` collection contract
     * becomes a new value here rather than a silent reinterpretation of these
     * rows -- the same discipline `commerce.order_payment_schedules` follows.
     */
    contract_version SMALLINT NOT NULL DEFAULT 1,

    /*
     * The activation window.
     *
     * `activation_starts_at` is NULL while the version is a draft and is set
     * from the DATABASE CLOCK at publication (ADR-048 §4). No route accepts an
     * activation-start value at all, so a backdated policy is not something the
     * service declines -- it is something the API has no vocabulary for, and
     * `ck_bcpv_not_retroactive` makes it unwritable through raw SQL too.
     *
     * `activation_ends_at` is an optional forward bound an administrator may
     * set while drafting. NULL means open-ended.
     *
     * NEITHER is ever edited after publication, INCLUDING at retirement
     * (ADR-048 §4). Retirement is a separate lifecycle fact; the effective
     * window is computed from both, and closing the configured window at
     * retirement would destroy the record of what was offered and for how long.
     */
    activation_starts_at TIMESTAMPTZ,
    activation_ends_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    published_at TIMESTAMPTZ,
    published_by_user_id UUID,
    published_by_label VARCHAR(40),

    retired_at TIMESTAMPTZ,
    retired_by_user_id UUID,
    retired_by_label VARCHAR(40),

    CONSTRAINT uq_bcpv_key_version UNIQUE (policy_key, version),
    CONSTRAINT ck_bcpv_version CHECK (version >= 1),
    CONSTRAINT ck_bcpv_contract_version CHECK (contract_version >= 1),

    CONSTRAINT ck_bcpv_lifecycle CHECK (lifecycle_state IN ('draft', 'published', 'retired')),

    CONSTRAINT ck_bcpv_mode CHECK (collection_mode IN (
        'pay_at_venue',
        'deposit_online_balance_at_venue',
        'full_payment_online'
    )),

    CONSTRAINT ck_bcpv_deposit_kind CHECK (deposit_kind IN ('none', 'fixed', 'percentage')),

    /*
     * A deposit exists IF AND ONLY IF the mode is the deposit mode. Both
     * directions, because each alone permits a row that means nothing: a
     * deposit rule under `full_payment_online` is a collectible nobody
     * disclosed, and deposit mode with no rule has no amount to collect.
     */
    CONSTRAINT ck_bcpv_mode_requires_deposit CHECK (
        (collection_mode = 'deposit_online_balance_at_venue' AND deposit_kind <> 'none')
        OR (collection_mode <> 'deposit_online_balance_at_venue' AND deposit_kind = 'none')
    ),

    /*
     * The shape of each rule, exhaustively. Every column not belonging to the
     * chosen kind must be NULL -- an ignored leftover would be a value nobody
     * decided sitting in a published, permanently immutable row.
     */
    CONSTRAINT ck_bcpv_deposit_shape CHECK (
        (deposit_kind = 'none'
            AND deposit_amount_toman IS NULL
            AND deposit_basis_points IS NULL
            AND deposit_minimum_toman IS NULL
            AND deposit_maximum_toman IS NULL
            AND percentage_base IS NULL)
        OR (deposit_kind = 'fixed'
            AND deposit_amount_toman IS NOT NULL
            AND deposit_basis_points IS NULL
            AND deposit_minimum_toman IS NULL
            AND deposit_maximum_toman IS NULL
            AND percentage_base IS NULL)
        OR (deposit_kind = 'percentage'
            AND deposit_amount_toman IS NULL
            AND deposit_basis_points IS NOT NULL
            AND deposit_minimum_toman IS NOT NULL
            AND percentage_base IS NOT NULL)
    ),

    /*
     * Representational bounds, not product ones. `10^13` is the same ceiling
     * `MAX_UNIT_PRICE_TOMAN` sets, and the basis-point range is arithmetic:
     * 0 would be a deposit that collects nothing and 10001 more than the whole
     * price. Neither is a launch value and neither is a default.
     */
    CONSTRAINT ck_bcpv_deposit_amount CHECK (
        deposit_amount_toman IS NULL
        OR (deposit_amount_toman > 0 AND deposit_amount_toman <= 10000000000000)
    ),
    CONSTRAINT ck_bcpv_deposit_rate CHECK (
        deposit_basis_points IS NULL
        OR (deposit_basis_points >= 1 AND deposit_basis_points <= 10000)
    ),
    CONSTRAINT ck_bcpv_deposit_bounds CHECK (
        (deposit_minimum_toman IS NULL
            OR (deposit_minimum_toman >= 0 AND deposit_minimum_toman <= 10000000000000))
        AND (deposit_maximum_toman IS NULL
            OR (deposit_maximum_toman >= 0 AND deposit_maximum_toman <= 10000000000000))
        AND (deposit_maximum_toman IS NULL
            OR deposit_minimum_toman IS NULL
            OR deposit_maximum_toman >= deposit_minimum_toman)
    ),

    /* Non-null exactly for a percentage rule, and closed to two members. */
    CONSTRAINT ck_bcpv_percentage_base CHECK (
        (deposit_kind = 'percentage' AND percentage_base IN ('service_subtotal', 'service_total'))
        OR (deposit_kind <> 'percentage' AND percentage_base IS NULL)
    ),

    /*
     * A draft has no activation start and no publisher; anything past draft has
     * both. The pairing is what makes `activation_starts_at` a published FACT
     * rather than a field somebody may have set early.
     */
    CONSTRAINT ck_bcpv_activation_start_pairing CHECK (
        (lifecycle_state = 'draft' AND activation_starts_at IS NULL)
        OR (lifecycle_state <> 'draft' AND activation_starts_at IS NOT NULL)
    ),

    CONSTRAINT ck_bcpv_window CHECK (
        activation_ends_at IS NULL
        OR activation_starts_at IS NULL
        OR activation_ends_at > activation_starts_at
    ),

    /*
     * NON-RETROACTIVITY (`V33-DEC-029` Ruling 7). An ordinary publication may
     * never open a window in the past. Both instants come from the same
     * database `now()` in the publishing statement, so they are equal; this
     * CHECK is what holds against a maintenance script, a future service and a
     * migration that forgets.
     */
    CONSTRAINT ck_bcpv_not_retroactive CHECK (
        lifecycle_state = 'draft'
        OR (published_at IS NOT NULL AND activation_starts_at >= published_at)
    ),

    CONSTRAINT ck_bcpv_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),
    CONSTRAINT ck_bcpv_published_actor CHECK (
        (lifecycle_state = 'draft'
            AND published_at IS NULL AND published_by_user_id IS NULL AND published_by_label IS NULL)
        OR (lifecycle_state <> 'draft'
            AND published_at IS NOT NULL
            AND ((published_by_user_id IS NOT NULL AND published_by_label IS NULL)
              OR (published_by_user_id IS NULL AND published_by_label IS NOT NULL)))
    ),
    CONSTRAINT ck_bcpv_retired_actor CHECK (
        (lifecycle_state <> 'retired'
            AND retired_at IS NULL AND retired_by_user_id IS NULL AND retired_by_label IS NULL)
        OR (lifecycle_state = 'retired'
            AND retired_at IS NOT NULL
            AND ((retired_by_user_id IS NOT NULL AND retired_by_label IS NULL)
              OR (retired_by_user_id IS NULL AND retired_by_label IS NOT NULL)))
    )
);

-- ==========================================================================
-- The EFFECTIVE window, and why it is not the configured one
-- ==========================================================================
--
-- ADR-048 as accepted indexed `tstzrange(activation_starts_at,
-- activation_ends_at, '[)')`. Combined with two other rules the same ADR
-- states -- retirement never rewrites the window, and a published version may
-- be open-ended -- that is unsatisfiable: retire an open-ended version and its
-- indexed interval stays `[start, infinity)` for ever, so no later version of
-- the key can ever be published. The ADR was corrected before this file
-- existed; this function is that correction.
--
--   * the interval starts at `activation_starts_at`;
--   * it ends at the EARLIER of the configured `activation_ends_at` (absent
--     meaning `infinity`) and, when the row is retired, `retired_at`;
--   * the upper bound is floored at the lower bound, so a version retired
--     before it ever activated yields an EMPTY interval -- which overlaps
--     nothing, and, just as importantly, does not raise a range error;
--   * the range stays half-open, so a replacement may start at the exact
--     instant its predecessor retired.
--
-- IMMUTABLE because an index expression must be. It is a pure function of the
-- row: `LEAST`, `GREATEST` and `COALESCE` over `timestamptz` comparisons are
-- immutable, and nothing here reads the clock.
--
-- The constraint is deliberately NOT narrowed to `lifecycle_state = 'published'`.
-- Dropping retired rows from the index would make HISTORICAL overlap
-- representable -- two versions recorded as simultaneously effective in the
-- past -- and the guarantee is about the key's whole timeline, not only its
-- live part.

CREATE OR REPLACE FUNCTION commercial.booking_collection_policy_effective_window(
    p_activation_starts_at TIMESTAMPTZ,
    p_activation_ends_at TIMESTAMPTZ,
    p_lifecycle_state VARCHAR,
    p_retired_at TIMESTAMPTZ
)
RETURNS TSTZRANGE
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT tstzrange(
        p_activation_starts_at,
        GREATEST(
            p_activation_starts_at,
            LEAST(
                COALESCE(p_activation_ends_at, 'infinity'::timestamptz),
                CASE
                    WHEN p_lifecycle_state = 'retired'
                        THEN COALESCE(p_retired_at, 'infinity'::timestamptz)
                    ELSE 'infinity'::timestamptz
                END
            )
        ),
        '[)'
    );
$$;

/*
 * Two versions of one policy key must never be effective at the same instant.
 *
 * An EXCLUSION CONSTRAINT and not an application check, for the reason
 * `commercial.price_schedule_versions` records: under READ COMMITTED two
 * concurrent publications each observe a free timeline and both commit.
 *
 * Partial on `lifecycle_state <> 'draft'` deliberately. A draft is not
 * selectable, so it occupies no timeline; two competing drafts for the same
 * period are a normal administrative state, and this constraint is what decides
 * between them at the moment one of them is published.
 */
ALTER TABLE commercial.booking_collection_policy_versions
    ADD CONSTRAINT ex_bcpv_no_effective_overlap
    EXCLUDE USING gist (
        policy_key WITH =,
        commercial.booking_collection_policy_effective_window(
            activation_starts_at, activation_ends_at, lifecycle_state, retired_at
        ) WITH &&
    ) WHERE (lifecycle_state <> 'draft');

CREATE INDEX ix_bcpv_key_state
    ON commercial.booking_collection_policy_versions (policy_key, lifecycle_state, activation_starts_at DESC);

-- ==========================================================================
-- Lifecycle, immutability and deletion
-- ==========================================================================

CREATE OR REPLACE FUNCTION commercial.enforce_booking_collection_version_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- A row cannot be BORN published. Publication is a transition that sets
        -- the activation instant from the database clock; an INSERT that
        -- skipped it could carry any instant at all, including a past one.
        IF NEW.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.booking_collection_policy_versions must be created as draft: publication is a transition, not an initial state'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        -- A draft may be discarded. A published or retired version may not: a
        -- version an order may have been priced against is not removable, and
        -- deleting a retired one would silently free its historical interval.
        IF OLD.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.booking_collection_policy_versions cannot be deleted once published: a version an order may have been priced against is not removable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    -- ---- UPDATE ----------------------------------------------------------

    IF OLD.lifecycle_state = 'retired' THEN
        RAISE EXCEPTION 'commercial.booking_collection_policy_versions is retired and permanently immutable: restore earlier terms by publishing a new version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Identity, frozen in every state including draft.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.booking_collection_policy_versions identity is immutable: id, policy_key, version and the creation record cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
       AND NOT (
             (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published')
          OR (OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired')
       )
    THEN
        RAISE EXCEPTION 'commercial.booking_collection_policy_versions transition % -> % is not permitted: the lifecycle is draft -> published -> retired and never backwards',
            OLD.lifecycle_state, NEW.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Terms and the activation window, frozen the moment the version leaves
    -- draft. In draft they are editable, which is what a draft is for.
    IF OLD.lifecycle_state <> 'draft' AND (
           NEW.collection_mode IS DISTINCT FROM OLD.collection_mode
        OR NEW.deposit_kind IS DISTINCT FROM OLD.deposit_kind
        OR NEW.deposit_amount_toman IS DISTINCT FROM OLD.deposit_amount_toman
        OR NEW.deposit_basis_points IS DISTINCT FROM OLD.deposit_basis_points
        OR NEW.deposit_minimum_toman IS DISTINCT FROM OLD.deposit_minimum_toman
        OR NEW.deposit_maximum_toman IS DISTINCT FROM OLD.deposit_maximum_toman
        OR NEW.percentage_base IS DISTINCT FROM OLD.percentage_base
        OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
        OR NEW.activation_starts_at IS DISTINCT FROM OLD.activation_starts_at
        OR NEW.activation_ends_at IS DISTINCT FROM OLD.activation_ends_at
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
        OR NEW.published_by_label IS DISTINCT FROM OLD.published_by_label
    ) THEN
        RAISE EXCEPTION 'commercial.booking_collection_policy_versions is published and its terms are immutable: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- ---- Publication preconditions ---------------------------------------
    --
    -- Checked HERE and not only in the service, because the activation instant
    -- must come from the DATABASE. A service that set it from its own clock
    -- would be trusting an application host's time to decide when a commercial
    -- commitment began.
    IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published' THEN
        IF NEW.published_at IS NULL OR NEW.activation_starts_at IS NULL THEN
            RAISE EXCEPTION 'commercial.booking_collection_policy_versions publication must set published_at and activation_starts_at'
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- The instants must be the database's own, not a caller's. A tolerance
        -- rather than equality, because the two `now()` calls in one statement
        -- share a transaction timestamp but a maintenance script may not.
        IF NEW.published_at < now() - INTERVAL '1 minute'
           OR NEW.published_at > now() + INTERVAL '1 minute'
        THEN
            RAISE EXCEPTION 'commercial.booking_collection_policy_versions published_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.activation_starts_at < NEW.published_at THEN
            RAISE EXCEPTION 'commercial.booking_collection_policy_versions cannot activate before it is published: an ordinary publication is never retroactive'
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.activation_ends_at IS NOT NULL AND NEW.activation_ends_at <= NEW.activation_starts_at THEN
            RAISE EXCEPTION 'commercial.booking_collection_policy_versions cannot be published with an activation end at or before its start'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    -- Retirement takes its instant from the database for the same reason
    -- publication does: the effective-window expression above is computed from
    -- `retired_at`, so a supplied instant would let a caller move a historical
    -- interval and free timeline that was genuinely occupied.
    IF OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired' THEN
        IF NEW.retired_at IS NULL THEN
            RAISE EXCEPTION 'commercial.booking_collection_policy_versions retirement must set retired_at'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.retired_at < now() - INTERVAL '1 minute'
           OR NEW.retired_at > now() + INTERVAL '1 minute'
        THEN
            RAISE EXCEPTION 'commercial.booking_collection_policy_versions retired_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_bcpv_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.booking_collection_policy_versions
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_booking_collection_version_lifecycle();

/*
 * The key itself never changes, and a key with versions behind it is not
 * deletable. Both are the same guarantee the catalogue's
 * `reject_catalogue_key_rewrite` makes: the key is the stable identity an
 * assignment (#104) will one day bind to, and a rewritten or vanished key would
 * silently re-point every version under it.
 */
CREATE OR REPLACE FUNCTION commercial.reject_booking_collection_policy_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commercial.booking_collection_policies rows are permanent: a policy key is the stable identity versions and assignments refer to'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.booking_collection_policies identity is immutable: the key and its creation record cannot be rewritten'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_booking_collection_policies_immutable
    BEFORE UPDATE OR DELETE ON commercial.booking_collection_policies
    FOR EACH ROW
    EXECUTE FUNCTION commercial.reject_booking_collection_policy_rewrite();

-- ---------------------------------------------------------------------------
-- No seed. Deliberately, and this comment is the record of it.
--
-- The catalogue migration seeds `D-7` because `V33-DEC-009` ratified a
-- zero-price base workspace. Nothing comparable is ratified here: which
-- collection modes may be enabled, and every deposit bound, base and rounding
-- value, remain OPEN / UNPUBLISHED under #83's own issue after `V33-DEC-028`.
-- A seeded policy would be engineering choosing one, so this migration ends
-- with the tables empty and the platform's behaviour unchanged.
-- ---------------------------------------------------------------------------
