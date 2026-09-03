-- ---------------------------------------------------------------------------
-- V3.3-A Story #56 (`#56a`) — the seller subscription foundation and the
-- automatic base workspace (ADR-042, `V33-DEC-018`).
--
-- ADR-041 built a catalogue of what MAY be sold and left one sentence for this
-- migration: "assignment itself -- creating a subscription row for a seller --
-- is #40b and is not implemented here."
--
-- This is that assignment. Its whole purpose is to make "what is this seller
-- entitled to?" a question with a ROW as its answer, so that no later story has
-- to invent one. The invented answer is always the same shape -- a constant, a
-- default, a `?? 200` -- and `V33-DEC-009` forbids exactly that.
--
-- ## The one invariant everything here serves
--
-- Every eligible seller party has exactly ONE active subscription at every
-- instant, and `uq_seller_subscriptions_one_active_per_party` is what makes it
-- true. Not a service check, not a transaction pattern: a partial unique index,
-- so two concurrent first accesses race to the index and one loses.
--
-- `D-7` stops being a fallback the moment that holds, because there is no state
-- in which the platform must guess. It reads a row, or it refuses.
--
-- ## What is deliberately absent
--
-- **No price above zero, in any state.** `ck_seller_subscriptions_zero_price`
-- is unconditional rather than scoped to `active`, which is the stronger form:
-- a paid subscription cannot be written at all, so there is no superseded or
-- cancelled row a later bug could revive into a paid active one. Removing it is
-- a visible migration after #46 and #47 close (ADR-042 §6).
--
-- **No expiry.** `ck_booking_credit_grants_no_expiry` pins `expires_at` to
-- NULL. The column exists because `V33-DEC-010` permits the model to carry one;
-- the constraint is why no code path -- and no raw SQL -- can activate it
-- before Legal approves.
--
-- **No recurrence.** Every publishable version today has
-- `billing_term_days IS NULL`, so `period_index` exists and stays 0. Recurrence
-- is unreachable rather than missing.
--
-- **No balance.** Balance is SUM(grants) - SUM(consumptions), and consumption
-- is #58. A balance column now would have no writer on one side of its own
-- arithmetic.
--
-- **No payment, order, intent, ledger entry, event or outbox.** Nothing here
-- moves money and nothing here has a named consumer.
--
-- ## Where this lives
--
-- The shared application cluster, `commercial` schema, owned by the ordinary
-- application role -- the same placement and the same reasoning ADR-041 §11
-- records for the catalogue. This is an entitlement ledger, not the money
-- ledger, and `financial.*` grants are not touched.
-- ---------------------------------------------------------------------------

-- ==========================================================================
-- commercial.seller_subscriptions
-- ==========================================================================

CREATE TABLE commercial.seller_subscriptions (
    id UUID PRIMARY KEY,

    /*
     * WHO HOLDS THIS, frozen at creation.
     *
     * `V33-DEC-018`: the subscriber party is resolved server-side from
     * OWNERSHIP ONLY, once, and never re-resolved. These two columns are that
     * decision made physical.
     *
     * The reason is a real failure this shape prevents:
     * `ProviderBackedFinancialPartyResolver` maps an affiliated professional to
     * their EMPLOYER's party, which is correct for earnings and wrong here.
     * Re-reading affiliation on every access would silently re-point "my
     * subscription" at a salon the day a professional joins one.
     * `V33-DEC-010` already fixed the same rule for returns in the same words:
     * the seller's current affiliation is never re-resolved.
     *
     * No cross-schema FK, per V3_DATABASE_BLUEPRINT.md §1. `professional` ids
     * live in `provider.professionals`, `business` ids in
     * `business.businesses`.
     */
    subscriber_party_type VARCHAR(16) NOT NULL,
    subscriber_party_id UUID NOT NULL,

    /*
     * PROVENANCE. Which catalogue row these terms were copied from.
     *
     * Necessary but NOT sufficient, which is why every entitlement below is
     * also copied. See the snapshot block.
     */
    plan_version_id UUID NOT NULL REFERENCES commercial.plan_versions (id),

    lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'active',

    /*
     * THE SNAPSHOT (ADR-042 §5).
     *
     * A foreign key alone would be correct TODAY, because ADR-041's rows are
     * immutable -- and it would still be wrong. "The terms this seller holds"
     * and "the terms this version describes" are different facts that are equal
     * today and need not stay equal. The moment #46 introduces any per-seller
     * variation, reconstructing history through a join rewrites the past.
     *
     * Copying is what makes this a fact rather than a view.
     *
     * Every value is NOT NULL except `snapshot_billing_term_days`, which is
     * nullable because the source column is: NULL means the version has no
     * recurring term, and is deliberately different from a zero a reader could
     * take for "renews immediately".
     */
    snapshot_plan_key VARCHAR(64) NOT NULL,
    snapshot_version INTEGER NOT NULL,
    snapshot_billing_term_days INTEGER,
    snapshot_included_booking_credits INTEGER NOT NULL,
    snapshot_staff_seats INTEGER NOT NULL,
    snapshot_included_locations INTEGER NOT NULL,
    snapshot_capability_keys TEXT[] NOT NULL,

    /*
     * The price the seller actually holds these terms at.
     *
     * Read from the tiers of the schedule version the plan version POINTS AT,
     * never from `resolvePrice(scheduleKey, at, quantity)`. That function
     * resolves whichever schedule version is active at an instant, which need
     * not be the referenced one -- right for a quote, and for a snapshot it
     * would silently attach a price the seller was never offered.
     *
     * A `seller_plan` schedule's quantity domain is exactly one, because a plan
     * version is selected singly, so the tier covering quantity 1 is the price.
     */
    snapshot_currency_code CHAR(3) NOT NULL,
    snapshot_unit_price_toman BIGINT NOT NULL,
    snapshot_price_schedule_version_id UUID NOT NULL
        REFERENCES commercial.price_schedule_versions (id),

    /* The instant these terms took effect for this party. */
    effective_at TIMESTAMPTZ NOT NULL,

    /*
     * WHO CAUSED IT. Exactly one of each pair, enforced below -- the same
     * pairing `commercial.plan_versions` and `admin.admin_audit_log` use.
     *
     * The label carries automatic actors so no human is fabricated for an
     * action no human took: `system` for lazy assignment, `migration:v3.3-a`
     * for the backfill. Seller-initiated selection (#69) fills the user id.
     */
    created_by_user_id UUID,
    created_by_label VARCHAR(40),

    /*
     * TERMINAL STATE. Written by the one transition that reaches it, and
     * nothing else -- the immutability trigger below permits these columns and
     * `lifecycle_state` and `superseded_by_id`, and refuses every other change.
     */
    superseded_at TIMESTAMPTZ,
    /*
     * DEFERRABLE INITIALLY DEFERRED, and that is load-bearing rather than
     * decorative.
     *
     * A supersession has to satisfy two rules that pull against each other:
     * `ck_seller_subscriptions_superseded` requires the successor's id on the
     * superseded row, and `uq_seller_subscriptions_one_active_per_party`
     * forbids the successor existing while the predecessor is still active. So
     * neither row can be written first under an immediate constraint.
     *
     * Deferring this one FK resolves it: the predecessor is superseded naming
     * an id that does not exist yet, the successor is inserted with that id,
     * and the reference is checked at COMMIT -- by which point both rows exist
     * and the party has exactly one active subscription. A transaction that
     * fails between the two still leaves nothing, because the check never
     * passes.
     */
    superseded_by_id UUID REFERENCES commercial.seller_subscriptions (id)
        DEFERRABLE INITIALLY DEFERRED,
    cancelled_at TIMESTAMPTZ,
    cancelled_by_user_id UUID,
    cancelled_by_label VARCHAR(40),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_seller_subscriptions_party_type
        CHECK (subscriber_party_type IN ('professional', 'business')),

    CONSTRAINT ck_seller_subscriptions_lifecycle
        CHECK (lifecycle_state IN ('active', 'superseded', 'cancelled')),

    /*
     * THE ZERO-PRICE SAFETY BOUNDARY (`V33-DEC-018`, ADR-042 §6).
     *
     * Unconditional, not `WHERE lifecycle_state = 'active'`. A paid
     * subscription is unwritable in EVERY state, so no dormant paid row can be
     * revived into an active one.
     *
     * This is why "only zero-price versions may activate" is a property of the
     * database rather than a rule the service remembers. Removing it requires a
     * later migration named after what it does -- which is the visibility the
     * decision asks for.
     */
    CONSTRAINT ck_seller_subscriptions_zero_price
        CHECK (snapshot_unit_price_toman = 0),

    CONSTRAINT ck_seller_subscriptions_entitlements CHECK (
        snapshot_included_booking_credits >= 0
        AND snapshot_staff_seats >= 0
        AND snapshot_included_locations >= 0
        AND snapshot_version >= 1
        AND (snapshot_billing_term_days IS NULL OR snapshot_billing_term_days > 0)
    ),

    CONSTRAINT ck_seller_subscriptions_created_actor CHECK (
        (created_by_user_id IS NOT NULL AND created_by_label IS NULL)
        OR (created_by_user_id IS NULL AND created_by_label IS NOT NULL)
    ),

    /*
     * Terminal columns are present exactly in their own state, and absent in
     * every other. Without this a `cancelled` row could carry a supersession
     * instant, and "when did this end" would have two answers.
     */
    CONSTRAINT ck_seller_subscriptions_superseded CHECK (
        (lifecycle_state = 'superseded'
            AND superseded_at IS NOT NULL AND superseded_by_id IS NOT NULL)
        OR (lifecycle_state <> 'superseded'
            AND superseded_at IS NULL AND superseded_by_id IS NULL)
    ),

    CONSTRAINT ck_seller_subscriptions_cancelled CHECK (
        (lifecycle_state = 'cancelled'
            AND cancelled_at IS NOT NULL
            AND ((cancelled_by_user_id IS NOT NULL AND cancelled_by_label IS NULL)
              OR (cancelled_by_user_id IS NULL AND cancelled_by_label IS NOT NULL)))
        OR (lifecycle_state <> 'cancelled'
            AND cancelled_at IS NULL
            AND cancelled_by_user_id IS NULL AND cancelled_by_label IS NULL)
    ),

    /* A row cannot supersede itself: that would be a cycle of length one. */
    CONSTRAINT ck_seller_subscriptions_not_self_superseding
        CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);

-- THE INVARIANT (ADR-042 §2). At most one ACTIVE subscription per party.
--
-- A partial unique index rather than a service check, because the failure it
-- prevents is a race: two concurrent first accesses both find no subscription,
-- both insert, and the seller ends up with two. Check-then-insert cannot fix
-- that at any isolation level below serializable. This can, at read committed,
-- with no retry loop.
--
-- Superseded and cancelled rows are excluded, so history accumulates freely.
CREATE UNIQUE INDEX uq_seller_subscriptions_one_active_per_party
    ON commercial.seller_subscriptions (subscriber_party_type, subscriber_party_id)
    WHERE lifecycle_state = 'active';

-- The whole history for one party, newest first. The only read #69 needs.
CREATE INDEX ix_seller_subscriptions_party_history
    ON commercial.seller_subscriptions (subscriber_party_type, subscriber_party_id, effective_at DESC);

CREATE INDEX ix_seller_subscriptions_plan_version
    ON commercial.seller_subscriptions (plan_version_id);

-- ==========================================================================
-- commercial.booking_credit_grants
-- ==========================================================================

CREATE TABLE commercial.booking_credit_grants (
    id UUID PRIMARY KEY,

    subscription_id UUID NOT NULL REFERENCES commercial.seller_subscriptions (id),
    plan_version_id UUID NOT NULL REFERENCES commercial.plan_versions (id),

    /*
     * Copied from the subscription, never re-resolved -- `V33-DEC-010`, in the
     * clause that says credits return to the party snapshotted on the row and
     * the seller's current affiliation is never re-read. #58 will consume and
     * return against THESE columns.
     */
    subscriber_party_type VARCHAR(16) NOT NULL,
    subscriber_party_id UUID NOT NULL,

    /*
     * WHERE THE CREDITS CAME FROM. Only `plan_included` exists in this story;
     * #57 widens the CHECK when custom purchases arrive. An enum-by-CHECK
     * rather than a lookup table, matching how the catalogue spells its own
     * closed vocabularies.
     */
    source VARCHAR(24) NOT NULL,

    /*
     * Zero is a real quantity, not a missing one.
     *
     * The seeded `D-7` confers zero credits. Skipping the row would make its
     * absence ambiguous between "conferred nothing" and "not processed yet" --
     * the implicit-fallback shape again, wearing an empty table.
     * `V33-DEC-018` requires the fact to exist.
     */
    quantity INTEGER NOT NULL,

    /*
     * Which billing period this grant belongs to. Always 0 today.
     *
     * Every publishable plan version has `billing_term_days IS NULL`, so no
     * second period can exist and recurrence is unreachable rather than
     * missing. The column is here because the uniqueness below needs it to mean
     * something when #46 approves a term -- not because anything increments it.
     */
    period_index INTEGER NOT NULL DEFAULT 0,

    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /*
     * EXPIRY, structurally unwritable.
     *
     * `V33-DEC-010` permits the model to carry a nullable expiry and forbids
     * activating it before Legal approves. A column plus a comment would be a
     * promise; the CHECK below is a guarantee that holds against raw SQL, a
     * future service, and a migration that forgets.
     */
    expires_at TIMESTAMPTZ,

    CONSTRAINT ck_booking_credit_grants_source
        CHECK (source IN ('plan_included')),

    CONSTRAINT ck_booking_credit_grants_quantity
        CHECK (quantity >= 0 AND quantity <= 1000000000),

    CONSTRAINT ck_booking_credit_grants_period
        CHECK (period_index >= 0),

    CONSTRAINT ck_booking_credit_grants_party_type
        CHECK (subscriber_party_type IN ('professional', 'business')),

    CONSTRAINT ck_booking_credit_grants_no_expiry
        CHECK (expires_at IS NULL),

    /*
     * ONE GRANT PER SUBSCRIPTION, SOURCE AND PERIOD.
     *
     * The loyalty precedent (`uq_points_entries_reference_once`) restated: the
     * only idempotency guarantee worth having is one the database enforces. A
     * replayed or concurrent activation hits this and writes nothing.
     */
    CONSTRAINT uq_booking_credit_grants_once
        UNIQUE (subscription_id, source, period_index)
);

-- The read #58 will make: everything granted to this party.
CREATE INDEX ix_booking_credit_grants_party
    ON commercial.booking_credit_grants (subscriber_party_type, subscriber_party_id, granted_at DESC);

-- ==========================================================================
-- Immutability
-- ==========================================================================

/*
 * A subscription's terms and its party never change; only its lifecycle does.
 *
 * This is what makes "a later `D-7` version cannot silently migrate existing
 * subscribers" true. Not a service that declines to write -- nothing CAN write
 * it, including a future migration that forgets. Moving subscribers to a newer
 * base version is a separate owner decision and a separate visible migration
 * (`V33-DEC-018`).
 *
 * The permitted columns are exactly the ones a transition needs. Everything
 * else raises, and the message names the column so a caller learns which rule
 * they hit rather than that "something" was immutable.
 */
CREATE OR REPLACE FUNCTION commercial.enforce_subscription_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.subscriber_party_type IS DISTINCT FROM OLD.subscriber_party_type
       OR NEW.subscriber_party_id IS DISTINCT FROM OLD.subscriber_party_id THEN
        RAISE EXCEPTION 'seller_subscriptions.subscriber_party is immutable: ownership is snapshotted at creation and never re-resolved'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.plan_version_id IS DISTINCT FROM OLD.plan_version_id
       OR NEW.snapshot_plan_key IS DISTINCT FROM OLD.snapshot_plan_key
       OR NEW.snapshot_version IS DISTINCT FROM OLD.snapshot_version
       OR NEW.snapshot_billing_term_days IS DISTINCT FROM OLD.snapshot_billing_term_days
       OR NEW.snapshot_included_booking_credits IS DISTINCT FROM OLD.snapshot_included_booking_credits
       OR NEW.snapshot_staff_seats IS DISTINCT FROM OLD.snapshot_staff_seats
       OR NEW.snapshot_included_locations IS DISTINCT FROM OLD.snapshot_included_locations
       OR NEW.snapshot_capability_keys IS DISTINCT FROM OLD.snapshot_capability_keys
       OR NEW.snapshot_currency_code IS DISTINCT FROM OLD.snapshot_currency_code
       OR NEW.snapshot_unit_price_toman IS DISTINCT FROM OLD.snapshot_unit_price_toman
       OR NEW.snapshot_price_schedule_version_id IS DISTINCT FROM OLD.snapshot_price_schedule_version_id
       OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label THEN
        RAISE EXCEPTION 'seller_subscriptions terms are immutable: a change of terms is a new subscription, never an edit'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- `active` is only ever an INITIAL state. Nothing returns to it, so a
    -- cancelled subscription cannot be revived -- which would also be a second
    -- way past the partial unique index.
    IF OLD.lifecycle_state <> 'active' THEN
        RAISE EXCEPTION 'seller_subscriptions.% is terminal: no transition leaves %', OLD.lifecycle_state, OLD.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state NOT IN ('superseded', 'cancelled') THEN
        RAISE EXCEPTION 'seller_subscriptions: the only transitions are active -> superseded and active -> cancelled'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_seller_subscriptions_immutable
    BEFORE UPDATE ON commercial.seller_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION commercial.enforce_subscription_immutability();

/*
 * A grant is a fact. #58's consumption and return are separate rows, never
 * edits to this one, so both UPDATE and DELETE are refused outright.
 */
CREATE OR REPLACE FUNCTION commercial.reject_grant_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'booking_credit_grants rows are immutable: consumption and return are separate facts, never edits'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_booking_credit_grants_immutable
    BEFORE UPDATE OR DELETE ON commercial.booking_credit_grants
    FOR EACH ROW
    EXECUTE FUNCTION commercial.reject_grant_rewrite();

-- ==========================================================================
-- The `D-7` backfill (`V33-DEC-018`, ADR-042 §4)
-- ==========================================================================
--
-- Every eligible party that already exists receives the base workspace, in this
-- migration's own transaction, with its own audit rows.
--
-- ## `D-7` is not named here either
--
-- The predicate below is the same question ADR-041 §6 designed the
-- `auto_assignable` flag to answer: which version is auto-assignable at this
-- instant? `ex_plan_versions_single_auto_assignable` guarantees at most one
-- platform-wide, so it has one answer or none -- and this never has to choose.
--
-- ## It fails rather than skips
--
-- If no auto-assignable published version is active, the migration FAILS. That
-- is deliberate and it has a visible cost: migration success now depends on
-- catalogue state. The alternative -- inserting nothing and continuing -- would
-- leave sellers with no subscription, which is the implicit fallback this story
-- exists to delete, reintroduced as an empty table.
--
-- ## Eligibility
--
-- `deleted_at IS NULL` and nothing else. `verification_status` is deliberately
-- NOT consulted: an unverified professional is a seller whose identity is
-- unconfirmed, not a seller without commercial terms, and conflating the two
-- would deny the base workspace to everyone awaiting review.

DO $backfill$
DECLARE
    base_version   commercial.plan_versions%ROWTYPE;
    base_price     BIGINT;
    base_currency  CHAR(3);
    tier_count     INTEGER;
    assigned_count INTEGER;
BEGIN
    SELECT * INTO base_version
      FROM commercial.plan_versions v
     WHERE v.auto_assignable
       AND v.lifecycle_state = 'published'
       AND v.activation_starts_at <= now()
       AND (v.activation_ends_at IS NULL OR v.activation_ends_at > now())
     LIMIT 1;

    IF base_version.id IS NULL THEN
        RAISE EXCEPTION 'no automatically assignable published plan version is active: the base workspace cannot be assigned, and there is deliberately no fallback (V33-DEC-018)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The price the version POINTS AT, not whichever schedule version happens
    -- to be active now. See the snapshot block above.
    SELECT sv.currency_code INTO base_currency
      FROM commercial.price_schedule_versions sv
     WHERE sv.id = base_version.price_schedule_version_id;

    SELECT count(*), min(t.unit_price_toman) INTO tier_count, base_price
      FROM commercial.price_tiers t
     WHERE t.schedule_version_id = base_version.price_schedule_version_id
       AND t.min_quantity <= 1
       AND (t.max_quantity IS NULL OR t.max_quantity >= 1);

    IF tier_count <> 1 THEN
        RAISE EXCEPTION 'the auto-assignable version''s schedule does not price quantity 1 exactly once (found % tiers)', tier_count
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Belt and braces against the CHECK: this states WHY rather than letting a
    -- constraint violation be the only explanation a reader gets.
    IF base_price <> 0 THEN
        RAISE EXCEPTION 'the auto-assignable version is not zero-price, and paid activation is unavailable while #46/#47 are open (V33-DEC-018)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- ON CONFLICT DO NOTHING rather than a NOT EXISTS filter: the partial
    -- unique index is the arbiter, so this statement is safe to re-run and
    -- converges with the lazy-ensure path on exactly the same guarantee.
    WITH eligible AS (
        SELECT 'professional'::VARCHAR(16) AS party_type, p.id AS party_id
          FROM provider.professionals p
         WHERE p.deleted_at IS NULL
        UNION ALL
        SELECT 'business'::VARCHAR(16), b.id
          FROM business.businesses b
         WHERE b.deleted_at IS NULL
    ),
    inserted AS (
        INSERT INTO commercial.seller_subscriptions (
            id, subscriber_party_type, subscriber_party_id, plan_version_id,
            lifecycle_state,
            snapshot_plan_key, snapshot_version, snapshot_billing_term_days,
            snapshot_included_booking_credits, snapshot_staff_seats,
            snapshot_included_locations, snapshot_capability_keys,
            snapshot_currency_code, snapshot_unit_price_toman,
            snapshot_price_schedule_version_id,
            effective_at, created_by_label
        )
        SELECT
            gen_random_uuid(), e.party_type, e.party_id, base_version.id,
            'active',
            base_version.plan_key, base_version.version, base_version.billing_term_days,
            base_version.included_booking_credits, base_version.staff_seats,
            base_version.included_locations, base_version.capability_keys,
            base_currency, base_price,
            base_version.price_schedule_version_id,
            now(), 'migration:v3.3-a'
          FROM eligible e
        ON CONFLICT DO NOTHING
        RETURNING id, subscriber_party_type, subscriber_party_id, snapshot_included_booking_credits
    ),
    granted AS (
        -- The grant is written in the SAME statement chain, so a party can
        -- never end up with a subscription and no grant. Zero quantity still
        -- writes a row: `V33-DEC-018` requires the activation fact to exist.
        INSERT INTO commercial.booking_credit_grants (
            id, subscription_id, plan_version_id,
            subscriber_party_type, subscriber_party_id,
            source, quantity, period_index
        )
        SELECT gen_random_uuid(), i.id, base_version.id,
               i.subscriber_party_type, i.subscriber_party_id,
               'plan_included', i.snapshot_included_booking_credits, 0
          FROM inserted i
        RETURNING subscription_id
    ),
    audited AS (
        -- `actor_label`, never a fabricated human: the table's own
        -- `ck_admin_audit_actor` already permits exactly this pairing, and #40a
        -- established `migration:v3.3-a` as the label a migration acts under.
        --
        -- The application role holds INSERT + SELECT on `admin.*`
        -- (`admin-audit-roles.sql`), so this needs no second connection and
        -- commits or rolls back with the rows above.
        INSERT INTO admin.admin_audit_log (
            id, actor_user_id, actor_label, action, target_type, target_id,
            after_state, reason
        )
        SELECT gen_random_uuid(), NULL, 'migration:v3.3-a',
               'commercial.subscription_assigned', 'commercial.seller_subscription',
               i.id::text,
               jsonb_build_object(
                   'subscriberPartyType', i.subscriber_party_type,
                   'lifecycleState', 'active',
                   'includedBookingCredits', i.snapshot_included_booking_credits
               ),
               'base workspace assigned by migration backfill'
          FROM inserted i
        RETURNING id
    )
    SELECT count(*) INTO assigned_count FROM inserted;

    RAISE NOTICE 'base workspace assigned to % existing seller part(ies)', assigned_count;
END;
$backfill$;

-- ==========================================================================
-- Documentation the catalogue itself carries
-- ==========================================================================

COMMENT ON TABLE commercial.seller_subscriptions IS
    'V3.3-A #56a: one immutable subscription per seller party per set of terms. Exactly one active per party, enforced by uq_seller_subscriptions_one_active_per_party. Zero-price only until #46/#47 close. ADR-042.';

COMMENT ON TABLE commercial.booking_credit_grants IS
    'V3.3-A #56a: entitlement grants issued once at activation from the subscription snapshot. Immutable; consumption and return (#58) are separate facts. Expiry pinned NULL until Legal approves. ADR-042.';
