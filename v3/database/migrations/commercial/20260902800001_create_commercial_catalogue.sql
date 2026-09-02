-- ---------------------------------------------------------------------------
-- V3.3-A Story #40 (`#40a`) — the seller plan and booking-credit price
-- catalogue (ADR-041, `V33-DEC-009`).
--
-- This schema exists so that commercial terms can change forever without ever
-- rewriting what an existing seller already bought. Almost everything below is
-- therefore a REFUSAL: an exclusion constraint, a CHECK, or a trigger that
-- makes a rewrite unwritable rather than merely discouraged. The application
-- must be able to publish a draft; it must never be able to edit what it
-- published, and there is no grant, route, or SQL path here that would let it.
--
-- ## Where this lives, and why it is not the ledger
--
-- The shared application cluster, owned by the ordinary application role.
-- ADR-041 §11: `financial.*` is the money ledger — legally retained,
-- append-only under a role the application cannot connect as, unreachable from
-- the shared pool by construction (ADR-017). Nothing here is a payment, a
-- receivable, a payout or a revenue recognition. This is what MAY be bought and
-- what it WOULD cost, and this story moves no money at all.
--
-- The immutability the catalogue needs is a different guarantee with a
-- different mechanism: triggers and constraints on rows the application owns,
-- not a grant-enforced append-only schema.
--
-- ## What is deliberately absent
--
-- **No allowance, and none is possible.** No column default, no seeded value
-- and no constant anywhere is a booking allowance — not 200, not any other
-- number. `included_booking_credits` is NOT NULL with NO DEFAULT: an
-- administrator supplies it or the INSERT fails. `D-7` is seeded with zero,
-- which is the ABSENCE of an allowance rather than a choice of one
-- (ADR-041 §6). A repository test in `services/commercial-policy` enforces this
-- against these files.
--
-- **No production price.** The only price this migration writes is zero, for
-- the base workspace `V33-DEC-009` ratifies as zero-price. Every real price
-- stays open under #46 and cannot be added until it closes.
--
-- **No subscription, grant, balance, consumption or purchase table.** Those are
-- #56, #57 and #58. A table created ahead of the story that fills it would also
-- force an ADR-027 disposition nobody could verify, which is the mistake
-- `referral`'s first migration records at length.
--
-- **No outbox_events table.** This story emits nothing and no consumer has been
-- named, so there is no event, no `ServiceName` member and nothing to relay
-- (ADR-041 §12, ADR-039 §8).
--
-- ## Column naming is a privacy control, not a style choice
--
-- ADR-027's boot-time coverage check recognises the `_user_id` SUFFIX and
-- rejects a `no_subject_data` claim on any table carrying a subject-shaped
-- column. Every actor column here is therefore `*_by_user_id`, and all five
-- tables are claimed `retained` — never `no_subject_data`. The naming and the
-- declared disposition agree, and the check can see both.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS commercial;

-- Required by the exclusion constraints below: GiST needs btree_gist to index
-- the plain-equality `plan_key` / `schedule_version_id` operand alongside the
-- range operand. A trusted extension since PostgreSQL 13, so a non-superuser
-- database owner can install it -- already proved on this project's own
-- non-superuser role by `booking`'s slot-overlap constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ==========================================================================
-- Shared validators
-- ==========================================================================
--
-- IMMUTABLE SQL functions, so they may be used inside CHECK constraints. Both
-- validate a set: the elements' shape, the absence of NULLs, and the absence of
-- duplicates. Written here rather than in the application because a set that is
-- only validated on the way in through one code path is validated by that code
-- path and by nothing else.

CREATE OR REPLACE FUNCTION commercial.is_valid_capability_key_set(keys TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT keys IS NOT NULL
       AND array_position(keys, NULL) IS NULL
       AND NOT EXISTS (SELECT 1 FROM unnest(keys) AS k WHERE k !~ '^[a-z][a-z0-9_]{0,63}$')
       AND (SELECT count(*) FROM unnest(keys) AS k) = (SELECT count(DISTINCT k) FROM unnest(keys) AS k);
$$;

CREATE OR REPLACE FUNCTION commercial.is_valid_preset_quantity_set(quantities INTEGER[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT quantities IS NOT NULL
       AND array_position(quantities, NULL) IS NULL
       AND NOT EXISTS (SELECT 1 FROM unnest(quantities) AS q WHERE q < 1 OR q > 1000000000)
       AND (SELECT count(*) FROM unnest(quantities) AS q) = (SELECT count(DISTINCT q) FROM unnest(quantities) AS q);
$$;

-- ==========================================================================
-- commercial.plans -- the stable plan key
-- ==========================================================================
--
-- One row per plan the platform has ever offered. It carries NO terms: a term
-- that lived here would be a mutable field on a live plan, which is the exact
-- model ADR-041 rejects. Everything a subscriber is entitled to lives on an
-- immutable version below.
--
-- The key pattern admits `D-7` -- an uppercase letter and a hyphen -- which the
-- platform's other stable-key patterns (`^[a-z][a-z0-9_]{0,63}$`) do not.
-- `V33-DEC-009` fixes the base workspace's key as that literal, so the pattern
-- accommodates the ratified identifier rather than the identifier being
-- silently rewritten to suit a convention.

CREATE TABLE commercial.plans (
    plan_key VARCHAR(64) PRIMARY KEY,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /*
     * WHO created it. Always the authenticated session's own user id, resolved
     * server-side; no route anywhere accepts this value from a caller, in a
     * body, a query parameter, a path segment or a header.
     *
     * NULL only where a non-session actor is recorded by label instead -- the
     * same pairing `admin.admin_audit_log` uses for its documented bootstrap,
     * and the reason the seed at the foot of this file can exist without
     * inventing an administrator who does not exist at migration time.
     */
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    CONSTRAINT ck_plans_key_shape CHECK (plan_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    CONSTRAINT ck_plans_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    )
);

-- ==========================================================================
-- commercial.price_schedules -- the stable schedule key
-- ==========================================================================
--
-- `purpose` is a CLOSED vocabulary and is part of the key's identity rather
-- than of a version: a schedule that priced subscriptions last quarter and
-- booking credits this one is two schedules, not two versions of one.
--
--   `seller_plan`     -- what a plan version itself costs per billing term.
--                        `V33-DEC-009`: a flat price is a one-tier schedule, so
--                        there is no scalar price column anywhere and exactly
--                        one pricing mechanism in the platform.
--   `booking_credit`  -- what a quantity of booking credits costs. The tiers
--                        #57 (`#40c`) will snapshot. Nothing in THIS story
--                        purchases against one.

CREATE TABLE commercial.price_schedules (
    schedule_key VARCHAR(64) PRIMARY KEY,

    purpose VARCHAR(24) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    CONSTRAINT ck_price_schedules_key_shape CHECK (schedule_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    CONSTRAINT ck_price_schedules_purpose CHECK (purpose IN ('seller_plan', 'booking_credit')),
    CONSTRAINT ck_price_schedules_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    )
);

-- ==========================================================================
-- commercial.price_schedule_versions -- immutable pricing, versioned
-- ==========================================================================

CREATE TABLE commercial.price_schedule_versions (
    id UUID PRIMARY KEY,

    schedule_key VARCHAR(64) NOT NULL REFERENCES commercial.price_schedules (schedule_key),
    version INTEGER NOT NULL,

    /*
     * `draft -> published -> retired`, one way, no return (ADR-041 §3).
     *
     * The DEFAULT is the fail-closed state, and the INSERT branch of
     * `commercial.enforce_schedule_version_lifecycle` refuses any other one --
     * so a row cannot be born published and skip the publication checks. That
     * makes the seed at the foot of this file a rehearsal of the real path
     * rather than a way around it.
     */
    lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'draft',

    display_name VARCHAR(120) NOT NULL,

    /*
     * `V33-DEC-009`: currency is IRT only unless a later owner decision widens
     * it. A CHECK rather than a lookup table, so widening is a migration and a
     * decision rather than an INSERT.
     *
     * IRT amounts are integer Toman in BIGINT -- the platform's single money
     * representation (`@beauclick/money`), never a float and never a decimal
     * string.
     */
    currency_code CHAR(3) NOT NULL,

    /*
     * The purchasable quantity bounds this schedule prices between. Both are
     * administrator-supplied with NO DEFAULT: `V33-DEC-009` leaves the minimum
     * and maximum custom quantity open under #46, so there is no number here
     * for a deployment to inherit by accident.
     *
     * The upper technical bound of 1,000,000,000 is a REPRESENTATIONAL guard
     * and not a commercial one: `price_tiers.quantity_range` is a generated
     * `int4range` over `max_quantity + 1`, and that addition must not overflow
     * int4. It is the same kind of bound `MAX_AMOUNT_TOMAN` is, and it is
     * roughly seven orders of magnitude above any quantity #46 could plausibly
     * approve.
     */
    min_purchase_quantity INTEGER NOT NULL,
    max_purchase_quantity INTEGER NOT NULL,

    /*
     * `V33-DEC-009` / the commercial packet: quick top-up presets are
     * PRESENTATION ONLY and are never a contract limit. They are stored on the
     * schedule version because that is where quantities live, they are frozen
     * with it, and nothing in this platform reads them to decide anything.
     *
     * Empty is the honest state until #46 approves preset values, and an empty
     * array is what the seed and every unconfigured schedule carry.
     */
    ui_preset_quantities INTEGER[] NOT NULL,

    /*
     * Half-open `[start, end)`. A NULL end means open-ended.
     *
     * NEVER edited after publication, INCLUDING at retirement (ADR-041 §5).
     * Retirement is a separate lifecycle fact; selectability is
     * `lifecycle_state = 'published'` AND the instant falling inside this
     * window -- two live conditions, neither rewriting the other. Closing the
     * window at retirement would mutate a frozen field to express a fact the
     * row already carries, and would destroy the record of what was offered and
     * for how long.
     */
    activation_starts_at TIMESTAMPTZ NOT NULL,
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

    CONSTRAINT uq_price_schedule_versions_key_version UNIQUE (schedule_key, version),
    CONSTRAINT ck_price_schedule_versions_version CHECK (version >= 1),
    CONSTRAINT ck_price_schedule_versions_lifecycle
        CHECK (lifecycle_state IN ('draft', 'published', 'retired')),
    CONSTRAINT ck_price_schedule_versions_currency CHECK (currency_code = 'IRT'),
    CONSTRAINT ck_price_schedule_versions_quantity_bounds CHECK (
        min_purchase_quantity >= 1
        AND max_purchase_quantity >= min_purchase_quantity
        AND max_purchase_quantity <= 1000000000
    ),
    CONSTRAINT ck_price_schedule_versions_presets
        CHECK (commercial.is_valid_preset_quantity_set(ui_preset_quantities)),
    CONSTRAINT ck_price_schedule_versions_window
        CHECK (activation_ends_at IS NULL OR activation_ends_at > activation_starts_at),
    CONSTRAINT ck_price_schedule_versions_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),
    -- A draft claims no publisher; anything past draft must name one, exactly
    -- one way. The pairing is what makes `published_by_user_id` a fact rather
    -- than an optional field somebody forgot to set.
    CONSTRAINT ck_price_schedule_versions_published_actor CHECK (
        (lifecycle_state = 'draft'
            AND published_at IS NULL AND published_by_user_id IS NULL AND published_by_label IS NULL)
        OR (lifecycle_state <> 'draft'
            AND published_at IS NOT NULL
            AND ((published_by_user_id IS NOT NULL AND published_by_label IS NULL)
              OR (published_by_user_id IS NULL AND published_by_label IS NOT NULL)))
    ),
    CONSTRAINT ck_price_schedule_versions_retired_actor CHECK (
        (lifecycle_state <> 'retired'
            AND retired_at IS NULL AND retired_by_user_id IS NULL AND retired_by_label IS NULL)
        OR (lifecycle_state = 'retired'
            AND retired_at IS NOT NULL
            AND ((retired_by_user_id IS NOT NULL AND retired_by_label IS NULL)
              OR (retired_by_user_id IS NULL AND retired_by_label IS NOT NULL)))
    )
);

/*
 * Two versions of one schedule key must never both be active.
 *
 * An EXCLUSION CONSTRAINT and not an application check, for the reason
 * `booking.availability_slots` records: under READ COMMITTED two concurrent
 * publications each observe a free timeline and both commit. That is `GAP-04`
 * in miniature, and Issue #40 asks for the constraint in the database
 * specifically.
 *
 * Partial on `lifecycle_state <> 'draft'` deliberately. A draft is not
 * selectable, so it occupies no timeline; two competing drafts for the same
 * period are a normal administrative state, and this constraint is what decides
 * between them at the moment one of them is published.
 */
ALTER TABLE commercial.price_schedule_versions
    ADD CONSTRAINT ex_price_schedule_versions_no_overlap
    EXCLUDE USING gist (
        schedule_key WITH =,
        tstzrange(activation_starts_at, activation_ends_at, '[)') WITH &&
    ) WHERE (lifecycle_state <> 'draft');

CREATE INDEX ix_price_schedule_versions_key_state
    ON commercial.price_schedule_versions (schedule_key, lifecycle_state, activation_starts_at DESC);

-- ==========================================================================
-- commercial.price_tiers -- quantity range to unit price
-- ==========================================================================
--
-- `V33-DEC-009`: pricing uses immutable versioned tiers, and a FLAT PRICE IS A
-- ONE-TIER SCHEDULE. There is no scalar price column anywhere in this schema,
-- so there is no second, simpler pricing mechanism that later has to grow
-- tiers -- and no migration that would have to rewrite published rows to give
-- it one.

CREATE TABLE commercial.price_tiers (
    id UUID PRIMARY KEY,

    /*
     * ON DELETE CASCADE, which is safe precisely because a version can only be
     * deleted while it is a draft: `commercial.enforce_schedule_version_lifecycle`
     * refuses to delete anything else. A cascade can therefore never destroy
     * tiers belonging to published terms.
     */
    schedule_version_id UUID NOT NULL
        REFERENCES commercial.price_schedule_versions (id) ON DELETE CASCADE,

    min_quantity INTEGER NOT NULL,
    /* NULL means unbounded above, and is legal on the highest tier only --
     * enforced by the contiguity check at publication, not here, because "the
     * highest tier" is a property of the set rather than of a row. */
    max_quantity INTEGER,

    /* Integer Toman. Zero is legal and is what the base workspace uses; a
     * negative price is not a discount, it is a corrupt row. */
    unit_price_toman BIGINT NOT NULL,

    /*
     * The half-open range this tier claims, stored so GiST can index it.
     *
     * GENERATED rather than written by the application: a range that disagreed
     * with `min_quantity`/`max_quantity` would make the overlap constraint
     * below guard a shape nothing else uses.
     */
    quantity_range int4range GENERATED ALWAYS AS (
        int4range(min_quantity, CASE WHEN max_quantity IS NULL THEN NULL ELSE max_quantity + 1 END, '[)')
    ) STORED,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    CONSTRAINT ck_price_tiers_quantities CHECK (
        min_quantity >= 1
        AND min_quantity <= 1000000000
        AND (max_quantity IS NULL OR (max_quantity >= min_quantity AND max_quantity <= 1000000000))
    ),
    -- The same absolute bound `@beauclick/money` enforces in the application,
    -- so a price that would overflow a sum is unwritable rather than merely
    -- rejected by whichever code path happened to construct it.
    CONSTRAINT ck_price_tiers_unit_price
        CHECK (unit_price_toman >= 0 AND unit_price_toman <= 10000000000000),
    CONSTRAINT ck_price_tiers_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    )
);

-- Two tiers claiming quantity 100 is UNWRITABLE, not merely unlikely. The
-- application's own validation runs first and returns a readable refusal; this
-- is what still holds when two administrators edit one draft concurrently.
ALTER TABLE commercial.price_tiers
    ADD CONSTRAINT ex_price_tiers_no_overlap
    EXCLUDE USING gist (
        schedule_version_id WITH =,
        quantity_range WITH &&
    );

CREATE INDEX ix_price_tiers_version_min ON commercial.price_tiers (schedule_version_id, min_quantity);

-- ==========================================================================
-- commercial.plan_versions -- immutable terms, versioned
-- ==========================================================================

CREATE TABLE commercial.plan_versions (
    id UUID PRIMARY KEY,

    plan_key VARCHAR(64) NOT NULL REFERENCES commercial.plans (plan_key),
    version INTEGER NOT NULL,

    lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'draft',

    display_name VARCHAR(120) NOT NULL,

    /*
     * The recurring term, in days, measured from the subscription start
     * instant. NULL means the version has NO recurring term -- which is what
     * the base workspace is, and what makes a NULL meaningfully different from
     * a zero somebody might read as "renews immediately".
     *
     * The commercial packet recommends an anniversary-based term rather than a
     * Gregorian or Solar Hijri calendar month, so an allowance does not change
     * merely because a month has a different length. Display dates may still
     * use the Solar Hijri calendar; that is a presentation concern and not this
     * column's.
     *
     * The VALUE remains open under #46. Nothing is defaulted.
     */
    billing_term_days INTEGER,

    /*
     * The quantitative entitlements. All NOT NULL with NO DEFAULT: an
     * administrator supplies each one or the INSERT fails.
     *
     * `V33-DEC-009`: no allowance, INCLUDING 200, may exist as a code constant,
     * default, fallback or seed. The absence of a DEFAULT on this column is
     * half of how that is made true; the other half is that no code anywhere
     * supplies one, which `services/commercial-policy` enforces by test against
     * these files.
     */
    included_booking_credits INTEGER NOT NULL,
    staff_seats INTEGER NOT NULL,
    included_locations INTEGER NOT NULL,

    /*
     * The feature entitlements this version confers, as stable keys.
     *
     * An ARRAY on the immutable row rather than a child table, and that is a
     * correctness choice rather than a convenience: freezing a parent row does
     * nothing about an INSERT into its children, so a normalised capability
     * table would have needed its own trigger to be as immutable as the terms
     * it belongs to. The tier table below DOES need to be a child table -- it
     * holds ordered ranges an exclusion constraint has to index -- and it
     * carries exactly that trigger.
     *
     * Shape, no-NULL and no-duplicate validation is in the DB, because a set
     * validated only on the way in through one code path is validated by that
     * code path and by nothing else.
     */
    capability_keys TEXT[] NOT NULL,

    /*
     * What this plan version costs, as a published price schedule version.
     *
     * NOT NULL: `V33-DEC-009` makes a flat price a one-tier schedule, so "free"
     * is a schedule whose single tier is zero rather than a NULL that every
     * later reader has to interpret. The publication trigger additionally
     * refuses to publish against a schedule version that is not itself
     * published.
     */
    price_schedule_version_id UUID NOT NULL
        REFERENCES commercial.price_schedule_versions (id),

    /*
     * THE BASE WORKSPACE MECHANISM (ADR-041 §6).
     *
     * `V33-DEC-009` ratifies `D-7` as an automatically assigned, published,
     * zero-price plan version so that every seller has one EXPLICIT
     * subscription history rather than an implicit fallback.
     *
     * That is this column, and it is deliberately NOT a constant in the code.
     * Later stories ask the catalogue "which version is auto-assignable at this
     * instant?" and receive a row or a refusal; they never ask for `D-7`. The
     * string appears in ADR-041, in this file, and in the tests that assert the
     * seeded row's properties -- and in NO production code, which is the whole
     * difference between a base workspace and a hidden fallback.
     *
     * The exclusion constraint below guarantees at most one auto-assignable
     * version is active at any instant, platform-wide, and the publication
     * trigger refuses to publish an auto-assignable version whose price is not
     * a single zero tier -- so the base workspace cannot silently become paid.
     *
     * ASSIGNMENT itself -- creating a subscription row for a seller -- is #56
     * (`#40b`) and does not exist here.
     */
    auto_assignable BOOLEAN NOT NULL DEFAULT false,

    activation_starts_at TIMESTAMPTZ NOT NULL,
    activation_ends_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    /*
     * Issue #40 names this column specifically, and ADR-041 §10 records the
     * consequence: because the row carries it, this table's ADR-027 disposition
     * is `retained` with a stated reason -- never `no_subject_data` -- and the
     * column is NOT renamed to evade the coverage check that recognises the
     * `_user_id` suffix.
     */
    published_at TIMESTAMPTZ,
    published_by_user_id UUID,
    published_by_label VARCHAR(40),

    retired_at TIMESTAMPTZ,
    retired_by_user_id UUID,
    retired_by_label VARCHAR(40),

    CONSTRAINT uq_plan_versions_key_version UNIQUE (plan_key, version),
    CONSTRAINT ck_plan_versions_version CHECK (version >= 1),
    CONSTRAINT ck_plan_versions_lifecycle
        CHECK (lifecycle_state IN ('draft', 'published', 'retired')),
    CONSTRAINT ck_plan_versions_billing_term
        CHECK (billing_term_days IS NULL OR (billing_term_days > 0 AND billing_term_days <= 3660)),
    CONSTRAINT ck_plan_versions_entitlements CHECK (
        included_booking_credits >= 0 AND included_booking_credits <= 1000000000
        AND staff_seats >= 0 AND staff_seats <= 1000000
        AND included_locations >= 0 AND included_locations <= 1000000
    ),
    CONSTRAINT ck_plan_versions_capability_keys
        CHECK (commercial.is_valid_capability_key_set(capability_keys)),
    CONSTRAINT ck_plan_versions_window
        CHECK (activation_ends_at IS NULL OR activation_ends_at > activation_starts_at),
    CONSTRAINT ck_plan_versions_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),
    CONSTRAINT ck_plan_versions_published_actor CHECK (
        (lifecycle_state = 'draft'
            AND published_at IS NULL AND published_by_user_id IS NULL AND published_by_label IS NULL)
        OR (lifecycle_state <> 'draft'
            AND published_at IS NOT NULL
            AND ((published_by_user_id IS NOT NULL AND published_by_label IS NULL)
              OR (published_by_user_id IS NULL AND published_by_label IS NOT NULL)))
    ),
    CONSTRAINT ck_plan_versions_retired_actor CHECK (
        (lifecycle_state <> 'retired'
            AND retired_at IS NULL AND retired_by_user_id IS NULL AND retired_by_label IS NULL)
        OR (lifecycle_state = 'retired'
            AND retired_at IS NOT NULL
            AND ((retired_by_user_id IS NOT NULL AND retired_by_label IS NULL)
              OR (retired_by_user_id IS NULL AND retired_by_label IS NOT NULL)))
    )
);

-- Issue #40: "Activation windows for the same plan key must not overlap; the
-- constraint is enforced in the database, not only in application code."
ALTER TABLE commercial.plan_versions
    ADD CONSTRAINT ex_plan_versions_no_overlap
    EXCLUDE USING gist (
        plan_key WITH =,
        tstzrange(activation_starts_at, activation_ends_at, '[)') WITH &&
    ) WHERE (lifecycle_state <> 'draft');

-- At most ONE automatically assignable version is active at any instant,
-- platform-wide -- across plan keys, not within one. Two base workspaces would
-- make "the seller's automatic plan" ambiguous, and an ambiguous automatic
-- assignment is an implicit fallback wearing a different name.
ALTER TABLE commercial.plan_versions
    ADD CONSTRAINT ex_plan_versions_single_auto_assignable
    EXCLUDE USING gist (
        tstzrange(activation_starts_at, activation_ends_at, '[)') WITH &&
    ) WHERE (auto_assignable AND lifecycle_state <> 'draft');

CREATE INDEX ix_plan_versions_key_state
    ON commercial.plan_versions (plan_key, lifecycle_state, activation_starts_at DESC);

-- Serves the only question later stories ask about the base workspace: which
-- version is auto-assignable at this instant.
CREATE INDEX ix_plan_versions_auto_assignable
    ON commercial.plan_versions (activation_starts_at, activation_ends_at)
    WHERE auto_assignable AND lifecycle_state = 'published';

-- ==========================================================================
-- The lifecycle, enforced by the database
-- ==========================================================================
--
-- Everything below refuses. Read them as the answer to "what stops an
-- administrator, a future migration, or a bug from rewriting terms somebody
-- already bought against", because that is what each one is for.
--
-- Written as an explicit ALLOW-LIST of transitions rather than as a list of
-- refusals, so a fourth lifecycle state added later is refused by default
-- rather than silently permitted from and to everywhere. That is the shape
-- `referral.reject_attribution_rewrite` uses and the reason it records.

CREATE OR REPLACE FUNCTION commercial.enforce_schedule_version_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    tier_count INTEGER;
    gap_count INTEGER;
    lowest_min INTEGER;
    highest_max INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- A row cannot be BORN published. Publication runs the checks below,
        -- and an INSERT that skipped them would be a published schedule with
        -- gaps in it. The seed at the foot of this migration therefore inserts
        -- a draft and publishes it, exercising the same path the API does.
        IF NEW.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.price_schedule_versions must be created as draft: publication is a transition, not an initial state'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.price_schedule_versions cannot be deleted once published: a version somebody may have bought against is not removable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    -- ---- UPDATE ----------------------------------------------------------

    -- A retired version accepts nothing at all. It can neither be reactivated
    -- nor edited (`V33-DEC-009`); restoring earlier terms requires a NEW
    -- version, which is the whole point of versioning them.
    IF OLD.lifecycle_state = 'retired' THEN
        RAISE EXCEPTION 'commercial.price_schedule_versions is retired and permanently immutable: restore earlier terms by publishing a new version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Identity, frozen in every state including draft.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.schedule_key IS DISTINCT FROM OLD.schedule_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.price_schedule_versions identity is immutable: id, schedule_key, version and the creation record cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
       AND NOT (
             (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published')
          OR (OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired')
       )
    THEN
        RAISE EXCEPTION 'commercial.price_schedule_versions transition % -> % is not permitted: the lifecycle is draft -> published -> retired and never backwards',
            OLD.lifecycle_state, NEW.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Terms, frozen the moment the version leaves draft. In draft they are
    -- editable, which is what a draft is for.
    IF OLD.lifecycle_state <> 'draft' AND (
           NEW.display_name IS DISTINCT FROM OLD.display_name
        OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
        OR NEW.min_purchase_quantity IS DISTINCT FROM OLD.min_purchase_quantity
        OR NEW.max_purchase_quantity IS DISTINCT FROM OLD.max_purchase_quantity
        OR NEW.ui_preset_quantities IS DISTINCT FROM OLD.ui_preset_quantities
        OR NEW.activation_starts_at IS DISTINCT FROM OLD.activation_starts_at
        OR NEW.activation_ends_at IS DISTINCT FROM OLD.activation_ends_at
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
        OR NEW.published_by_label IS DISTINCT FROM OLD.published_by_label
    ) THEN
        RAISE EXCEPTION 'commercial.price_schedule_versions is published and its terms are immutable: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- ---- Publication preconditions ---------------------------------------
    --
    -- Checked HERE and not only in the service, because a schedule with a hole
    -- in it must be unpublishable rather than merely unlikely to be published:
    -- once it is published nothing can repair it, and a resolution landing in
    -- the hole would have no price at all.
    IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published' THEN
        SELECT count(*) INTO tier_count
          FROM commercial.price_tiers WHERE schedule_version_id = NEW.id;

        IF tier_count = 0 THEN
            RAISE EXCEPTION 'commercial.price_schedule_versions cannot be published with no tier: a flat price is a one-tier schedule, not an empty one'
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- Contiguity. Overlap is already impossible (ex_price_tiers_no_overlap),
        -- so "every tier begins exactly where the previous one ended" is
        -- sufficient to prove there is no gap. A NULL previous maximum means an
        -- unbounded tier is followed by another one, which is also caught here.
        SELECT count(*) INTO gap_count
          FROM (
            SELECT min_quantity,
                   lag(max_quantity) OVER (ORDER BY min_quantity) AS prev_max,
                   row_number() OVER (ORDER BY min_quantity) AS rn
              FROM commercial.price_tiers
             WHERE schedule_version_id = NEW.id
          ) t
         WHERE t.rn > 1 AND (t.prev_max IS NULL OR t.min_quantity <> t.prev_max + 1);

        IF gap_count > 0 THEN
            RAISE EXCEPTION 'commercial.price_schedule_versions cannot be published with a gap between tiers: every tier must begin where the previous one ended'
                USING ERRCODE = 'restrict_violation';
        END IF;

        SELECT min(min_quantity) INTO lowest_min
          FROM commercial.price_tiers WHERE schedule_version_id = NEW.id;

        IF lowest_min <> NEW.min_purchase_quantity THEN
            RAISE EXCEPTION 'commercial.price_schedule_versions tiers must start at min_purchase_quantity (%), found %',
                NEW.min_purchase_quantity, lowest_min
                USING ERRCODE = 'restrict_violation';
        END IF;

        SELECT max_quantity INTO highest_max
          FROM commercial.price_tiers
         WHERE schedule_version_id = NEW.id
         ORDER BY min_quantity DESC LIMIT 1;

        IF highest_max IS NOT NULL AND highest_max < NEW.max_purchase_quantity THEN
            RAISE EXCEPTION 'commercial.price_schedule_versions tiers must cover max_purchase_quantity (%), highest tier ends at %',
                NEW.max_purchase_quantity, highest_max
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_price_schedule_versions_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.price_schedule_versions
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_schedule_version_lifecycle();

/*
 * The tier table is the hole freezing the parent row would leave.
 *
 * Nothing about `commercial.price_schedule_versions` being immutable prevents an
 * INSERT into its children, so the tier set is made as immutable as the version
 * that owns it: no write of any kind once the parent has left draft.
 */
CREATE OR REPLACE FUNCTION commercial.enforce_price_tier_parent_is_draft()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    parent_state VARCHAR(16);
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT lifecycle_state INTO parent_state
          FROM commercial.price_schedule_versions WHERE id = OLD.schedule_version_id;
        -- No parent row means it is being deleted in this same statement and
        -- this is the ON DELETE CASCADE. Its own BEFORE DELETE trigger has
        -- already refused unless the version was a draft, so there is nothing
        -- further to check and refusing here would make a draft undeletable.
        IF parent_state IS NOT NULL AND parent_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.price_tiers cannot be deleted once its schedule version is published: the tier set is as immutable as the terms that own it'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    SELECT lifecycle_state INTO parent_state
      FROM commercial.price_schedule_versions WHERE id = NEW.schedule_version_id;

    IF parent_state IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'commercial.price_tiers may only be written while its schedule version is a draft: the tier set is as immutable as the terms that own it'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_price_tiers_parent_is_draft
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.price_tiers
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_price_tier_parent_is_draft();

CREATE OR REPLACE FUNCTION commercial.enforce_plan_version_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    schedule_state VARCHAR(16);
    tier_count INTEGER;
    priced_tier_count INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.plan_versions must be created as draft: publication is a transition, not an initial state'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.plan_versions cannot be deleted once published: a version somebody may have subscribed against is not removable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.lifecycle_state = 'retired' THEN
        RAISE EXCEPTION 'commercial.plan_versions is retired and permanently immutable: it can neither be reactivated nor edited, and restoring earlier terms requires a new version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.plan_key IS DISTINCT FROM OLD.plan_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.plan_versions identity is immutable: id, plan_key, version and the creation record cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
       AND NOT (
             (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published')
          OR (OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired')
       )
    THEN
        RAISE EXCEPTION 'commercial.plan_versions transition % -> % is not permitted: the lifecycle is draft -> published -> retired and never backwards',
            OLD.lifecycle_state, NEW.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.lifecycle_state <> 'draft' AND (
           NEW.display_name IS DISTINCT FROM OLD.display_name
        OR NEW.billing_term_days IS DISTINCT FROM OLD.billing_term_days
        OR NEW.included_booking_credits IS DISTINCT FROM OLD.included_booking_credits
        OR NEW.staff_seats IS DISTINCT FROM OLD.staff_seats
        OR NEW.included_locations IS DISTINCT FROM OLD.included_locations
        OR NEW.capability_keys IS DISTINCT FROM OLD.capability_keys
        OR NEW.price_schedule_version_id IS DISTINCT FROM OLD.price_schedule_version_id
        OR NEW.auto_assignable IS DISTINCT FROM OLD.auto_assignable
        OR NEW.activation_starts_at IS DISTINCT FROM OLD.activation_starts_at
        OR NEW.activation_ends_at IS DISTINCT FROM OLD.activation_ends_at
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
        OR NEW.published_by_label IS DISTINCT FROM OLD.published_by_label
    ) THEN
        RAISE EXCEPTION 'commercial.plan_versions is published and its terms are immutable: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published' THEN
        SELECT lifecycle_state INTO schedule_state
          FROM commercial.price_schedule_versions WHERE id = NEW.price_schedule_version_id;

        -- A published plan priced by a draft schedule would be selectable at a
        -- price still being edited.
        IF schedule_state IS DISTINCT FROM 'published' THEN
            RAISE EXCEPTION 'commercial.plan_versions cannot be published against a price schedule version that is not itself published'
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- The base workspace cannot silently become paid. `V33-DEC-009` fixes
        -- `D-7` as ZERO-price, and this is where that survives a later edit
        -- attempt -- it does not depend on anyone remembering.
        IF NEW.auto_assignable THEN
            SELECT count(*), count(*) FILTER (WHERE unit_price_toman <> 0)
              INTO tier_count, priced_tier_count
              FROM commercial.price_tiers WHERE schedule_version_id = NEW.price_schedule_version_id;

            IF tier_count <> 1 OR priced_tier_count <> 0 THEN
                RAISE EXCEPTION 'an automatically assignable plan version must be priced by exactly one zero tier: the base workspace is zero-price by decision'
                    USING ERRCODE = 'restrict_violation';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_plan_versions_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.plan_versions
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_plan_version_lifecycle();

-- The two catalogue-key tables hold nothing but a key and its provenance, so
-- there is nothing legitimate to update. Refusing outright is clearer than a
-- column-by-column freeze of a row with no editable column.
CREATE OR REPLACE FUNCTION commercial.reject_catalogue_key_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable: a key and who created it are facts, not settings', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_plans_immutable
    BEFORE UPDATE ON commercial.plans
    FOR EACH ROW
    EXECUTE FUNCTION commercial.reject_catalogue_key_rewrite();

CREATE TRIGGER tg_price_schedules_immutable
    BEFORE UPDATE ON commercial.price_schedules
    FOR EACH ROW
    EXECUTE FUNCTION commercial.reject_catalogue_key_rewrite();

-- ==========================================================================
-- The `D-7` base workspace (`V33-DEC-009`, ADR-041 §6)
-- ==========================================================================
--
-- The ONE row this migration seeds, and the reasons it is not the thing the
-- rest of this file exists to prevent:
--
--  * It is not a production price. It is ZERO, which is the price
--    `V33-DEC-009` ratifies for the base workspace, and the publication trigger
--    above refuses to let an auto-assignable version be anything else.
--
--  * It is not a hard-coded allowance. `included_booking_credits` is 0 -- the
--    ABSENCE of an allowance, not a choice of one. Seats, locations and the
--    capability set are likewise zero and empty. `V33-DEC-009` fixes only that
--    the base workspace is published and zero-price; the "minimal
--    base-workspace capabilities" remain open under #46, and zero and empty are
--    the only values that confer nothing and therefore invent nothing.
--
--  * It is not a fallback. Nothing reads these numbers in this story -- there
--    is no subscription, grant or consumption path yet -- and when #46 closes
--    the base-workspace definition the administrator publishes a NEW `D-7`
--    version. This one cannot be edited, which is the point.
--
--  * It is not a code path. No production code names `D-7`. Later stories ask
--    for the auto-assignable published version at an instant and get a row or a
--    refusal.
--
-- The actor is a LABEL rather than a user id, because there is no administrator
-- at migration time -- the same pairing `admin.admin_audit_log.actor_label`
-- uses for the documented bootstrap. No audit row is written from here: this is
-- a schema fact recorded by `public.schema_migrations` and by this file, and
-- `admin.admin_audit_log` records administrator actions taken through the API,
-- which a migration is not.
--
-- Inserted as a DRAFT and then PUBLISHED, deliberately. The INSERT branch of
-- both lifecycle triggers refuses a row born published, so the seed travels the
-- same path an administrator does and every publication check runs against it.

INSERT INTO commercial.price_schedules (schedule_key, purpose, created_by_label)
VALUES ('D-7-base-price', 'seller_plan', 'migration:v3.3-a');

INSERT INTO commercial.price_schedule_versions (
    id, schedule_key, version, display_name, currency_code,
    min_purchase_quantity, max_purchase_quantity, ui_preset_quantities,
    activation_starts_at, created_by_label
) VALUES (
    '01930000-0000-7000-8000-000000000001', 'D-7-base-price', 1,
    'D-7 base workspace price', 'IRT',
    -- One subscription, priced once. Not a commercial bound: a plan version is
    -- selected singly, so the quantity domain of a `seller_plan` schedule is
    -- exactly one.
    1, 1,
    -- Empty. Preset quantities are presentation only and their values are open
    -- under #46.
    '{}',
    -- Open-ended from the epoch, so the base workspace is active for every
    -- instant a later story could ask about. A start date in the future would
    -- leave sellers with no automatic plan until it arrived.
    '1970-01-01T00:00:00Z', 'migration:v3.3-a'
);

INSERT INTO commercial.price_tiers (
    id, schedule_version_id, min_quantity, max_quantity, unit_price_toman, created_by_label
) VALUES (
    '01930000-0000-7000-8000-000000000002', '01930000-0000-7000-8000-000000000001',
    -- A one-tier schedule IS the flat-price representation (`V33-DEC-009`).
    1, 1, 0, 'migration:v3.3-a'
);

UPDATE commercial.price_schedule_versions
   SET lifecycle_state = 'published',
       published_at = now(),
       published_by_label = 'migration:v3.3-a'
 WHERE id = '01930000-0000-7000-8000-000000000001';

INSERT INTO commercial.plans (plan_key, created_by_label)
VALUES ('D-7', 'migration:v3.3-a');

INSERT INTO commercial.plan_versions (
    id, plan_key, version, display_name,
    billing_term_days, included_booking_credits, staff_seats, included_locations,
    capability_keys, price_schedule_version_id, auto_assignable,
    activation_starts_at, created_by_label
) VALUES (
    '01930000-0000-7000-8000-000000000003', 'D-7', 1, 'D-7',
    -- NULL: the base workspace has no recurring term. Not zero, which a reader
    -- could take for "renews immediately".
    NULL,
    -- Zero, empty, zero, zero. See the block above: the absence of an
    -- entitlement, never a choice of one, and nothing in this story reads them.
    0, 0, 0, '{}',
    '01930000-0000-7000-8000-000000000001',
    true,
    '1970-01-01T00:00:00Z', 'migration:v3.3-a'
);

UPDATE commercial.plan_versions
   SET lifecycle_state = 'published',
       published_at = now(),
       published_by_label = 'migration:v3.3-a'
 WHERE id = '01930000-0000-7000-8000-000000000003';
