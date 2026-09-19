-- ---------------------------------------------------------------------------
-- V3.3 Story #173 (`#43b-1`) — the administrator-published commission policy
-- family (ADR-052 §1 and §3, `V33-DEC-040` R1, ratified by `V33-DEC-044`).
--
-- This migration creates a PUBLICATION plane and nothing else. It creates ZERO
-- policies, ZERO versions, and no seed, default or fallback of any kind. On the
-- day it lands nothing reads these tables: the per-order snapshot that will
-- read them is `#43b-2` (#192), and recognition is `#43c`. An order priced the
-- day after this migration is priced exactly as it was the day before.
--
-- ## Why a family at all
--
-- `#43a` removed `FINANCIAL_COMMISSION_RATE_BP`, `DEFAULT_COMMISSION_RATE_BP`
-- and `FinancialConfig` (ADR-052 §16), leaving the platform with no commission
-- number anywhere — deliberately, because `V33-DEC-040` R1 requires commission
-- to be a published, versioned rule rather than a code constant. This family is
-- where that rule comes to live. Until an administrator publishes one, the
-- absence of an active version is a meaningful, fail-closed state that `#43b-2`
-- records as `absent` — never a reason to invent a rate.
--
-- ## What is deliberately absent
--
-- **No snapshot table.** `commerce.order_commission_terms` is #192 (`#43b-2`).
-- Creating it here would force an ADR-027 disposition for a table no code
-- writes, and would let a later story quietly change its shape before the first
-- row ever existed.
--
-- **No fee-allocation or settlement-schedule family.** ADR-052 §1 names three
-- more families; they are `#43g` (#178) and `#43d` (#175). Each changes on a
-- different cadence and under a different review, which is why the same ADR
-- refuses to put them in one table.
--
-- **No commercial value.** No rate, no fixed amount, no base and no component
-- default appears below, and none is representable: every rule column is either
-- NOT NULL with NO DEFAULT or conditionally NULL by CHECK, and `base` in
-- particular has no DEFAULT precisely because a defaulted base would silently
-- decide what a percentage is taken OF. The only DEFAULT on a version is
-- `lifecycle_state = 'draft'`, the fail-closed state, which cannot choose a
-- commercial outcome. A repository scan test enforces this against this file.
--
-- **No arithmetic.** The engine that turns these rows into an amount is pure
-- TypeScript in `packages/commercial-policy-contract` (ADR-052 §3) and runs in
-- no database. What lives here is only the rule's SHAPE.
--
-- ## Publication is stricter here than in every earlier family
--
-- ADR-048's other families accept `published_at` within ±1 minute of the
-- database clock. ADR-052 §1 requires the publication instant to be **exactly**
-- the transaction `now()`, "with no tolerance", and §2 explains why in its own
-- rejection: a version stamped `now() = T0` that commits at T0+5s is invisible
-- to a reader at T0+2 and visible at T0+6, and a ±1-minute tolerance widens
-- that window from seconds to minutes. A commission rule is resolved inside a
-- checkout transaction by `#43b-2`, so the width of that window is the width of
-- the race. The trigger below therefore compares for equality against
-- `now()` — the TRANSACTION timestamp, stable for every statement in the
-- transaction, so a service that computes the instant with its own `now()` in
-- the same transaction matches exactly, while a caller-supplied literal cannot.
--
-- ## Column naming is a privacy control, not a style choice
--
-- ADR-027's boot-time coverage check recognises the `_user_id` SUFFIX and
-- rejects a `no_subject_data` claim on any table carrying a subject-shaped
-- column. Every actor column here is therefore `*_by_user_id`, and both tables
-- are claimed `retained` — an administrator's authorship of a commercial rule
-- is a business record, not erasable personal data, and the rule itself binds
-- orders for as long as they exist.
-- ---------------------------------------------------------------------------

-- Already installed by the catalogue migration; idempotent, and stated here so
-- the dependency is visible at the point of use rather than inherited silently.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ==========================================================================
-- commercial.commission_policies -- the stable key, one per component
-- ==========================================================================
--
-- One row per component the platform charges on. It carries NO rule: a rate
-- that lived here would be a mutable field on a live policy, the model ADR-048
-- §3 rejects. Every rule lives on an immutable version below.
--
-- `UNIQUE (component)` is the load-bearing constraint, not decoration. ADR-052
-- §1 says "one stable key per component", and §2's resolver asks a question
-- with exactly one answer: "the active committed version for this component".
-- If two keys could carry `booking_commission`, that question would have two
-- answers and the resolver would need a tie-break rule nobody has ratified.
-- Here a second key for a component is UNREPRESENTABLE rather than merely
-- discouraged.

CREATE TABLE commercial.commission_policies (
    policy_key VARCHAR(64) PRIMARY KEY,

    /*
     * The three components ADR-052 §3 evaluates, in that fixed order. There is
     * no fourth member and no default member: an administrator names the
     * component or the INSERT fails.
     */
    component VARCHAR(32) NOT NULL,

    /*
     * Administrative prose. Never shown to a seller or a customer, and never
     * legal copy: what a seller is told about commission is a separate,
     * unratified surface, and nothing in this schema may stand in for it.
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

    CONSTRAINT ck_cp_key_shape CHECK (policy_key ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    CONSTRAINT ck_cp_component CHECK (
        component IN ('booking_commission', 'acquisition', 'processing_recovery')
    ),
    CONSTRAINT ck_cp_display_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
    CONSTRAINT ck_cp_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),
    CONSTRAINT uq_cp_component UNIQUE (component)
);

-- ==========================================================================
-- commercial.commission_policy_versions -- immutable rules, four shapes
-- ==========================================================================

CREATE TABLE commercial.commission_policy_versions (
    id UUID PRIMARY KEY,

    policy_key VARCHAR(64) NOT NULL REFERENCES commercial.commission_policies (policy_key),
    version INTEGER NOT NULL,

    /*
     * `draft -> published -> retired`, one way, no return (ADR-048 §4).
     *
     * The DEFAULT is the fail-closed state, and the INSERT branch of
     * `commercial.enforce_commission_version_lifecycle` refuses any other one,
     * so a row cannot be born published and skip publication.
     */
    lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'draft',

    /*
     * The four closed shapes (`V33-DEC-040` R1, ADR-052 §1). NOT NULL with NO
     * DEFAULT: an administrator chooses a shape, or the INSERT fails.
     *
     * `zero` is a PUBLISHED ROW meaning "this component charges nothing" — a
     * deliberate, audited decision. It is not the same fact as the absence of
     * any active version, which means nobody has decided. `#43b-2` records
     * those as `zero` and `absent` respectively, and `#43c` must be able to
     * tell them apart when it asks why an order was never charged.
     */
    rule_kind VARCHAR(16) NOT NULL,

    /*
     * Basis points, 0..10000. Present for `percentage` and `hybrid` only, and
     * the shape CHECK below makes any other pairing unrepresentable.
     *
     * 0 is permitted and is NOT a synonym for `zero`: a `percentage` at 0 bp
     * over a base still records which base the platform reserved the right to
     * charge on, and a later version can raise it without changing shape.
     */
    bp INTEGER,

    /*
     * A flat amount in Toman. `> 0` for `fixed` (a `fixed` rule of zero is the
     * `zero` shape, and allowing both would make two rows mean one thing);
     * `>= 0` inside `hybrid`, where the flat part may legitimately be nothing
     * while the percentage part carries the charge. ADR-052 §1, verbatim.
     */
    fixed_toman BIGINT,

    /*
     * What a percentage is taken OF (ADR-052 §3):
     *   `platform_collected_amount` -> `commerce.orders.collected_total_toman`
     *   `service_total`             -> `commerce.orders.total_toman`
     *
     * NO DEFAULT, and that is the single most consequential absence in this
     * file. The two bases differ by exactly the amount a customer has not paid
     * yet, so a defaulted base would silently decide whether the platform
     * charges on money it holds or on money it merely expects. Required for
     * `percentage` and `hybrid`, forbidden otherwise.
     */
    base VARCHAR(32),

    /*
     * Which arithmetic produced — and will reproduce — an amount from this
     * rule. `#43b-2` copies it onto every order's snapshot so that a rule
     * evaluated in the future is evaluated the way it was understood when the
     * order committed, even if the engine is later corrected. NOT NULL with no
     * DEFAULT: the service supplies the engine's own exported constant, so the
     * database can never disagree with the code about which arithmetic ran.
     */
    arithmetic_version INTEGER NOT NULL,

    /*
     * The activation window. Both instants are NULL in draft and set by the
     * publication transition; `activation_ends_at` stays NULL for an
     * open-ended version, which is the ordinary case.
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

    CONSTRAINT uq_cpv_key_version UNIQUE (policy_key, version),
    CONSTRAINT ck_cpv_version_positive CHECK (version >= 1),
    CONSTRAINT ck_cpv_lifecycle CHECK (lifecycle_state IN ('draft', 'published', 'retired')),
    CONSTRAINT ck_cpv_rule_kind CHECK (rule_kind IN ('zero', 'percentage', 'fixed', 'hybrid')),
    CONSTRAINT ck_cpv_base CHECK (
        base IS NULL OR base IN ('platform_collected_amount', 'service_total')
    ),
    CONSTRAINT ck_cpv_bp_range CHECK (bp IS NULL OR (bp >= 0 AND bp <= 10000)),
    CONSTRAINT ck_cpv_fixed_nonnegative CHECK (fixed_toman IS NULL OR fixed_toman >= 0),
    CONSTRAINT ck_cpv_arithmetic_version CHECK (arithmetic_version >= 1),

    /*
     * THE SHAPE MATRIX (ADR-052 §1). Each shape is paired to exactly its
     * fields, in one CHECK, so a half-specified rule cannot exist even for the
     * duration of a transaction:
     *
     *   zero       -> no bp, no fixed amount, no base
     *   percentage -> bp and base, no fixed amount
     *   fixed      -> a fixed amount STRICTLY above zero, no bp, no base
     *   hybrid     -> bp, base, and a fixed amount that may be zero
     *
     * Written as one constraint rather than four partial ones because the
     * shapes are exhaustive and mutually exclusive: a single expression makes
     * "which shapes exist" readable in one place, and a future shape has to be
     * added here deliberately rather than slipping in as an unconstrained
     * combination.
     */
    CONSTRAINT ck_cpv_shape CHECK (
        (rule_kind = 'zero'
             AND bp IS NULL AND fixed_toman IS NULL AND base IS NULL)
        OR (rule_kind = 'percentage'
             AND bp IS NOT NULL AND base IS NOT NULL AND fixed_toman IS NULL)
        OR (rule_kind = 'fixed'
             AND fixed_toman IS NOT NULL AND fixed_toman > 0 AND bp IS NULL AND base IS NULL)
        OR (rule_kind = 'hybrid'
             AND bp IS NOT NULL AND base IS NOT NULL AND fixed_toman IS NOT NULL)
    ),

    /*
     * The activation window exists exactly when the version has left draft, and
     * an ordinary publication is never retroactive. The `>=` is deliberate: a
     * version may activate at the instant it is published, and `#43b-2`'s
     * resolver reads committed rows, so an activation exactly at `published_at`
     * is reachable rather than a moment nobody can observe.
     */
    CONSTRAINT ck_cpv_window_by_state CHECK (
        (lifecycle_state = 'draft' AND activation_starts_at IS NULL)
        OR (lifecycle_state <> 'draft' AND activation_starts_at IS NOT NULL)
    ),
    CONSTRAINT ck_cpv_window_order CHECK (
        activation_ends_at IS NULL
        OR activation_starts_at IS NULL
        OR activation_ends_at > activation_starts_at
    ),
    CONSTRAINT ck_cpv_not_retroactive CHECK (
        lifecycle_state = 'draft'
        OR (published_at IS NOT NULL AND activation_starts_at >= published_at)
    ),

    /*
     * The publication and retirement records exist exactly in the states that
     * have them, and each names exactly one actor -- a session user or a label,
     * never both and never neither.
     */
    CONSTRAINT ck_cpv_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),
    CONSTRAINT ck_cpv_published_record CHECK (
        (lifecycle_state = 'draft'
             AND published_at IS NULL AND published_by_user_id IS NULL AND published_by_label IS NULL)
        OR (lifecycle_state <> 'draft'
             AND published_at IS NOT NULL
             AND ((published_by_user_id IS NOT NULL AND published_by_label IS NULL)
                  OR (published_by_user_id IS NULL AND published_by_label IS NOT NULL)))
    ),
    CONSTRAINT ck_cpv_retired_record CHECK (
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
-- The same correction `commercial.booking_collection_policy_effective_window`
-- records, for the same reason, and deliberately NOT shared with it: a
-- function shared across families would make a future change to one family's
-- window semantics silently change every other family's historical index.
--
--   * the interval starts at `activation_starts_at`;
--   * it ends at the EARLIER of the configured `activation_ends_at` (absent
--     meaning `infinity`) and, when the row is retired, `retired_at`;
--   * the upper bound is floored at the lower bound, so a version retired
--     before it ever activated yields an EMPTY interval -- which overlaps
--     nothing and raises no range error;
--   * the range stays half-open, so a replacement may start at the exact
--     instant its predecessor retired.
--
-- IMMUTABLE because an index expression must be: `LEAST`, `GREATEST` and
-- `COALESCE` over `timestamptz` are immutable, and nothing here reads a clock.

CREATE OR REPLACE FUNCTION commercial.commission_policy_effective_window(
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
 * An EXCLUSION CONSTRAINT and not an application check: under READ COMMITTED
 * two concurrent publications each observe a free timeline and both commit.
 * For this family that is not merely untidy — with `uq_cp_component` above, one
 * key IS one component, so an overlap would mean an order could resolve two
 * different commission rules for the same component at the same instant, and
 * which one it got would depend on row order.
 *
 * Partial on `lifecycle_state <> 'draft'` deliberately: a draft is not
 * selectable, so it occupies no timeline, and two competing drafts for the same
 * period are a normal administrative state. This constraint is what decides
 * between them at the moment one of them is published.
 *
 * NOT narrowed to `published`: dropping retired rows would make HISTORICAL
 * overlap representable, and the guarantee is about the key's whole timeline.
 */
ALTER TABLE commercial.commission_policy_versions
    ADD CONSTRAINT ex_cpv_no_effective_overlap
    EXCLUDE USING gist (
        policy_key WITH =,
        commercial.commission_policy_effective_window(
            activation_starts_at, activation_ends_at, lifecycle_state, retired_at
        ) WITH &&
    ) WHERE (lifecycle_state <> 'draft');

/*
 * The resolver's index (`#43b-2`, ADR-052 §2): "the active version of this key
 * at this instant" is a backwards scan on the activation instant within one
 * key and state.
 */
CREATE INDEX ix_cpv_key_state
    ON commercial.commission_policy_versions (policy_key, lifecycle_state, activation_starts_at DESC);

-- ==========================================================================
-- Lifecycle, immutability and deletion
-- ==========================================================================

CREATE OR REPLACE FUNCTION commercial.enforce_commission_version_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- A row cannot be BORN published. Publication is a transition that
        -- takes its instant from the database clock; an INSERT that skipped it
        -- could carry any instant at all, including a past one.
        IF NEW.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.commission_policy_versions must be created as draft: publication is a transition, not an initial state'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        -- A draft may be discarded. A published or retired version may not: a
        -- version an order may have been snapshotted against is not removable,
        -- and deleting a retired one would silently free its historical
        -- interval and let a later publication claim a period that was
        -- genuinely occupied.
        IF OLD.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.commission_policy_versions cannot be deleted once published: a version an order may have been snapshotted against is not removable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    -- ---- UPDATE ----------------------------------------------------------

    IF OLD.lifecycle_state = 'retired' THEN
        RAISE EXCEPTION 'commercial.commission_policy_versions is retired and permanently immutable: restore earlier terms by publishing a new version'
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
        RAISE EXCEPTION 'commercial.commission_policy_versions identity is immutable: id, policy_key, version and the creation record cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
       AND NOT (
             (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published')
          OR (OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired')
       )
    THEN
        RAISE EXCEPTION 'commercial.commission_policy_versions transition % -> % is not permitted: the lifecycle is draft -> published -> retired and never backwards',
            OLD.lifecycle_state, NEW.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The RULE and the window, frozen the moment the version leaves draft. In
    -- draft they are editable, which is what a draft is for.
    IF OLD.lifecycle_state <> 'draft' AND (
           NEW.rule_kind IS DISTINCT FROM OLD.rule_kind
        OR NEW.bp IS DISTINCT FROM OLD.bp
        OR NEW.fixed_toman IS DISTINCT FROM OLD.fixed_toman
        OR NEW.base IS DISTINCT FROM OLD.base
        OR NEW.arithmetic_version IS DISTINCT FROM OLD.arithmetic_version
        OR NEW.activation_starts_at IS DISTINCT FROM OLD.activation_starts_at
        OR NEW.activation_ends_at IS DISTINCT FROM OLD.activation_ends_at
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
        OR NEW.published_by_label IS DISTINCT FROM OLD.published_by_label
    ) THEN
        RAISE EXCEPTION 'commercial.commission_policy_versions is published and its rule is immutable: publish a new version instead'
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
            RAISE EXCEPTION 'commercial.commission_policy_versions publication must set published_at and activation_starts_at'
                USING ERRCODE = 'restrict_violation';
        END IF;

        /*
         * EQUALITY, not the ±1-minute tolerance every earlier family accepts.
         * ADR-052 §1 requires the publication instant to be exactly the
         * transaction `now()`, "with no tolerance", and §2's rejection explains
         * the cost of anything looser: `#43b-2` resolves this rule inside a
         * checkout transaction, so the gap between the stamped instant and the
         * commit is a window in which a publication is neither reliably visible
         * nor reliably invisible. A tolerance turns that window from seconds
         * into minutes.
         *
         * `now()` is the TRANSACTION timestamp, so a service that computes the
         * instant with its own `now()` inside the same transaction matches
         * exactly, while a caller-supplied literal — or an instant taken from
         * an application host's clock — cannot.
         */
        IF NEW.published_at <> now() THEN
            RAISE EXCEPTION 'commercial.commission_policy_versions published_at must be exactly the transaction clock (ADR-052 §1: no tolerance), not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.activation_starts_at < NEW.published_at THEN
            RAISE EXCEPTION 'commercial.commission_policy_versions cannot activate before it is published: a commission rule is never retroactive'
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF NEW.activation_ends_at IS NOT NULL AND NEW.activation_ends_at <= NEW.activation_starts_at THEN
            RAISE EXCEPTION 'commercial.commission_policy_versions cannot be published with an activation end at or before its start'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    -- Retirement takes its instant from the database for the same reason
    -- publication does, and under the same equality rule: the effective-window
    -- expression above is computed from `retired_at`, so a supplied instant
    -- would let a caller move a historical interval and free timeline that was
    -- genuinely occupied.
    IF OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired' THEN
        IF NEW.retired_at IS NULL THEN
            RAISE EXCEPTION 'commercial.commission_policy_versions retirement must set retired_at'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.retired_at <> now() THEN
            RAISE EXCEPTION 'commercial.commission_policy_versions retired_at must be exactly the transaction clock (ADR-052 §1: no tolerance), not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_cpv_lifecycle
    BEFORE INSERT OR UPDATE OR DELETE ON commercial.commission_policy_versions
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_commission_version_lifecycle();

/*
 * The key itself never changes, and a key with versions behind it is not
 * deletable. The same guarantee the catalogue and the collection family make:
 * `policy_key` is a foreign key from every version and, once `#43b-2` lands,
 * a VALUE copied onto order snapshots — a snapshot whose key was renamed would
 * name a policy that never existed.
 *
 * `component` is frozen for the same reason and a sharper one: moving a key
 * from one component to another would silently re-point every version behind
 * it, so an order snapshotted under `acquisition` would find itself explained
 * by a rule the administrator published as `booking_commission`.
 */
CREATE OR REPLACE FUNCTION commercial.reject_commission_policy_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (
            SELECT 1 FROM commercial.commission_policy_versions WHERE policy_key = OLD.policy_key
        ) THEN
            RAISE EXCEPTION 'commercial.commission_policies cannot be deleted while versions exist for the key'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.component IS DISTINCT FROM OLD.component
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.commission_policies identity is immutable: the key, its component and its creation record cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_commission_policies_immutable
    BEFORE UPDATE OR DELETE ON commercial.commission_policies
    FOR EACH ROW
    EXECUTE FUNCTION commercial.reject_commission_policy_rewrite();

-- ---------------------------------------------------------------------------
-- No seed. Deliberately, and this comment is the record of it.
--
-- The catalogue migration seeds `D-7` because `V33-DEC-009` ratified a
-- zero-price base workspace. Nothing comparable is ratified here, and
-- `V33-DEC-040` R1 is explicit that commission is whatever an administrator
-- publishes: no rate, component default or base has been ratified by anyone.
-- A seeded policy would be engineering choosing one, so this migration ends
-- with both tables empty and the platform's behaviour unchanged.
--
-- No GRANT appears above either, matching every other `commercial` migration:
-- the schema is owned by the application role, which is why these tables can
-- carry a `draft -> published -> retired` UPDATE at all — and why the
-- append-only financial roles are given nothing here.
-- ---------------------------------------------------------------------------
