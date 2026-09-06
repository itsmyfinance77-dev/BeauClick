-- ==========================================================================
-- V3.3 Story #57 (`#40c-1`) — the custom booking-credit purchase record
-- ADR-047 / `V33-DEC-026` / `V33-DEC-027`
-- ==========================================================================
--
-- Three things, in dependency order:
--
--   1. the administrator's binding: a NULLABLE booking-credit schedule key on
--      `plan_versions`, whose target purpose the DATABASE refuses to get wrong;
--   2. the subscription's snapshot of that key, so a plan edit cannot redirect
--      an existing seller's pricing source;
--   3. `commercial.credit_purchases`, the immutable price snapshot itself.
--
-- ## What this migration deliberately does NOT do
--
-- **It seeds nothing.** No schedule, no key, no price, no tier, no quantity
-- bound, no preset. `V33-DEC-027` Ruling 8: existing `D-7` plan versions and
-- every existing subscription keep a NULL binding and are not backfilled, so
-- Story #57 ships SAFELY UNAVAILABLE until an administrator creates a
-- `booking_credit` schedule, publishes a version of it, and publishes a plan
-- version carrying its key. Three deliberate administrative acts, none of them
-- performed here.
--
-- **It does not touch the grant tables.** `ck_booking_credit_grants_source`,
-- `uq_booking_credit_grants_once`, `uq_bcg_identity` and
-- `fk_bcc_grant_identity` are untouched: widening the source and replacing that
-- uniqueness belong to #99, after a verified payment rail exists (`V33-DEC-026`
-- R5). Nothing in this story can insert a booking-credit grant.
--
-- **It creates no payment fact, order, intent or ledger entry.**

-- ==========================================================================
-- 1. The administrator's binding
-- ==========================================================================
--
-- `V33-DEC-027` R7 requires that a binding to a `seller_plan` schedule be
-- UNWRITABLE, and forbids satisfying that with a comment or a controller check.
--
-- A CHECK cannot do it: a CHECK sees only its own row and cannot consult
-- `price_schedules`. So the purpose travels INTO the foreign key.
--
-- `uq_price_schedules_key_purpose` is redundant against the primary key --
-- `schedule_key` is already unique -- and exists solely to be a composite FK
-- target. That is the same technique `#58a` used for `uq_bcg_identity`.

ALTER TABLE commercial.price_schedules
    ADD CONSTRAINT uq_price_schedules_key_purpose UNIQUE (schedule_key, purpose);

ALTER TABLE commercial.plan_versions
    ADD COLUMN booking_credit_schedule_key VARCHAR(64);

/*
 * The discriminator is GENERATED, never supplied.
 *
 * That is what makes the composite foreign key below an invariant rather than a
 * convention: no writer -- not the admin service, not a future story, not raw
 * SQL -- can assert a purpose the schedule does not have, because nothing may
 * write this column at all. It is NULL exactly when the binding is NULL, so an
 * unbound plan version references nothing.
 */
ALTER TABLE commercial.plan_versions
    ADD COLUMN booking_credit_schedule_purpose VARCHAR(24)
        GENERATED ALWAYS AS (
            CASE WHEN booking_credit_schedule_key IS NULL THEN NULL ELSE 'booking_credit' END
        ) STORED;

-- MATCH SIMPLE (the default): when either column is NULL the constraint is
-- satisfied, which is exactly the semantics an optional binding needs.
ALTER TABLE commercial.plan_versions
    ADD CONSTRAINT fk_plan_versions_booking_credit_schedule
        FOREIGN KEY (booking_credit_schedule_key, booking_credit_schedule_purpose)
        REFERENCES commercial.price_schedules (schedule_key, purpose);

COMMENT ON COLUMN commercial.plan_versions.booking_credit_schedule_key IS
    'V33-DEC-027: the price schedule this plan version sells custom booking credits at. NULL means this plan offers none; there is no default and no fallback.';

-- ==========================================================================
-- 2. Published plan versions keep their binding
-- ==========================================================================
--
-- `enforce_plan_version_lifecycle` already freezes every other term once a
-- version leaves draft. The binding joins that list rather than being trusted
-- to stay put: `V33-DEC-027` R3 says a subscription's pricing source cannot be
-- redirected, and the first way to redirect it would be to edit the plan it was
-- snapshotted from.

CREATE OR REPLACE FUNCTION commercial.enforce_plan_version_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    schedule_state TEXT;
    tier_count INTEGER;
    priced_tier_count INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.plan_versions must be created as a draft: a row cannot be born published'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.plan_versions may only be deleted while it is a draft: a published version is a historical record'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.plan_key IS DISTINCT FROM OLD.plan_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label THEN
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
        -- V3.3 #57 (`#40c-1`), `V33-DEC-027` R1: the binding is a published
        -- term like every other, so repricing a seller's credits means
        -- publishing a new plan version, never editing this one.
        OR NEW.booking_credit_schedule_key IS DISTINCT FROM OLD.booking_credit_schedule_key
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

        IF schedule_state IS DISTINCT FROM 'published' THEN
            RAISE EXCEPTION 'commercial.plan_versions cannot be published against a price schedule version that is not itself published'
                USING ERRCODE = 'restrict_violation';
        END IF;

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

-- ==========================================================================
-- 3. The subscription snapshots the KEY, never the version
-- ==========================================================================
--
-- `V33-DEC-027` R3/R4. Snapshotting the key freezes WHICH schedule a seller's
-- credits are priced by; leaving the VERSION unsnapshotted is what lets an
-- administrator reprice forward without migrating a single subscription.
--
-- NULL is the honest value for every row that exists today, and for every
-- subscription activated from a plan version that offers no custom credits.

ALTER TABLE commercial.seller_subscriptions
    ADD COLUMN snapshot_booking_credit_schedule_key VARCHAR(64);

COMMENT ON COLUMN commercial.seller_subscriptions.snapshot_booking_credit_schedule_key IS
    'V33-DEC-027: copied from the plan version at activation and never re-resolved. NULL means this subscription buys no custom credits.';

/*
 * Deliberately NOT a foreign key to `price_schedules`.
 *
 * A snapshot records what was true when it was taken. An FK here would let a
 * later administrative action on the catalogue reach back and constrain a
 * historical subscription -- the same reasoning `#58a` recorded for
 * `booking_credit_consumptions.booking_id`, and the reason the composite FK on
 * `credit_purchases` below points at the version and tier the purchase actually
 * used rather than at the schedule the subscription remembers.
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
       -- V3.3 #57 (`#40c-1`), `V33-DEC-027` R3.
       OR NEW.snapshot_booking_credit_schedule_key IS DISTINCT FROM OLD.snapshot_booking_credit_schedule_key
       OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label THEN
        RAISE EXCEPTION 'seller_subscriptions terms are immutable: a change of terms is a new subscription, never an edit'
            USING ERRCODE = 'restrict_violation';
    END IF;

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

-- ==========================================================================
-- 4. Composite identity targets for the purchase's foreign keys
-- ==========================================================================
--
-- Each is redundant against an existing primary key and exists ONLY so a
-- composite foreign key can prove a relationship a single-row CHECK cannot
-- express. `#58a` established the technique with `uq_bcg_identity`.

ALTER TABLE commercial.seller_subscriptions
    ADD CONSTRAINT uq_seller_subscriptions_identity
        UNIQUE (id, subscriber_party_type, subscriber_party_id);

ALTER TABLE commercial.price_schedule_versions
    ADD CONSTRAINT uq_price_schedule_versions_identity
        UNIQUE (id, schedule_key);

ALTER TABLE commercial.price_tiers
    ADD CONSTRAINT uq_price_tiers_identity
        UNIQUE (id, schedule_version_id);

-- ==========================================================================
-- 5. commercial.credit_purchases — the immutable snapshot
-- ==========================================================================

CREATE TABLE commercial.credit_purchases (
    id UUID PRIMARY KEY,

    /*
     * The subscription the purchase belongs to, and the party it was made for.
     *
     * The party is SNAPSHOTTED rather than joined, for the reason `V33-DEC-020`
     * gave for finance and `V33-DEC-025` R7 restated for credits: current
     * affiliation must not decide historical money. The composite foreign key
     * below then makes "this party really is that subscription's party" a
     * storage guarantee rather than a hope.
     */
    subscription_id UUID NOT NULL REFERENCES commercial.seller_subscriptions (id),
    subscriber_party_type VARCHAR(16) NOT NULL,
    subscriber_party_id UUID NOT NULL,

    /* What the seller asked for. Bounds below are TECHNICAL; the commercial
     * minimum and maximum live on the administrator's schedule version. */
    quantity INTEGER NOT NULL,

    /*
     * The price source, at three levels of precision.
     *
     * `schedule_key` is what the subscription was bound to; the version and
     * tier are what that key actually resolved to at `effective_at`. Recording
     * all three is what makes a later repricing provably invisible to this row.
     */
    schedule_key VARCHAR(64) NOT NULL,
    price_schedule_version_id UUID NOT NULL,
    price_tier_id UUID NOT NULL,

    /* Integer Toman. Never a float, never a decimal string (`@beauclick/money`). */
    unit_price_toman BIGINT NOT NULL,
    total_toman BIGINT NOT NULL,
    currency_code CHAR(3) NOT NULL,

    /** The instant the schedule was resolved at. One captured value, not `now()` twice. */
    effective_at TIMESTAMPTZ NOT NULL,

    /*
     * `awaiting_payment | abandoned` and nothing else (`V33-DEC-026` R2).
     *
     * NEITHER STATE CONFERS ENTITLEMENT, and this story contains no code path
     * that writes a booking-credit grant. `paid` is #99's to add, together with
     * the verified payment fact that would justify it.
     */
    lifecycle_state VARCHAR(24) NOT NULL DEFAULT 'awaiting_payment',

    /*
     * The caller's `Idempotency-Key`, opaque to this table. Bounded to the
     * repository's established header width; a PROTOCOL limit, never a product
     * policy.
     */
    request_key VARCHAR(128) NOT NULL,

    /** The authenticated session's own user id. Never accepted from a request body. */
    requested_by_user_id UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_credit_purchases_party_type
        CHECK (subscriber_party_type IN ('professional', 'business')),

    /*
     * A REPRESENTATIONAL guard, matching `price_schedule_versions`. Together
     * with the price bound below it keeps `unit_price_toman * quantity` far
     * inside `bigint`, so `ck_credit_purchases_total` returns a controlled
     * constraint violation rather than a numeric overflow.
     */
    CONSTRAINT ck_credit_purchases_quantity
        CHECK (quantity >= 1 AND quantity <= 1000000000),

    CONSTRAINT ck_credit_purchases_unit_price
        CHECK (unit_price_toman >= 0 AND unit_price_toman <= 10000000000000),

    CONSTRAINT ck_credit_purchases_money
        CHECK (total_toman >= 0 AND total_toman <= 10000000000000),

    /* The arithmetic is not an application invariant. */
    CONSTRAINT ck_credit_purchases_total
        CHECK (total_toman = unit_price_toman * quantity),

    CONSTRAINT ck_credit_purchases_currency CHECK (currency_code = 'IRT'),

    CONSTRAINT ck_credit_purchases_lifecycle
        CHECK (lifecycle_state IN ('awaiting_payment', 'abandoned')),

    CONSTRAINT ck_credit_purchases_request_key
        CHECK (length(request_key) BETWEEN 8 AND 128),

    /*
     * ONE PURCHASE PER SUBSCRIPTION AND REQUEST KEY.
     *
     * The only idempotency guarantee worth having is one the database enforces:
     * N concurrent submissions of a single key collide here and exactly one
     * row survives, whatever the application believed it had read.
     */
    CONSTRAINT uq_credit_purchases_request UNIQUE (subscription_id, request_key),

    /* This party really is that subscription's party. */
    CONSTRAINT fk_credit_purchases_subscription_party
        FOREIGN KEY (subscription_id, subscriber_party_type, subscriber_party_id)
        REFERENCES commercial.seller_subscriptions (id, subscriber_party_type, subscriber_party_id),

    /* That version really belongs to the key this row names. */
    CONSTRAINT fk_credit_purchases_schedule_version
        FOREIGN KEY (price_schedule_version_id, schedule_key)
        REFERENCES commercial.price_schedule_versions (id, schedule_key),

    /* That tier really belongs to that version. */
    CONSTRAINT fk_credit_purchases_tier
        FOREIGN KEY (price_tier_id, price_schedule_version_id)
        REFERENCES commercial.price_tiers (id, schedule_version_id)
);

/* The seller's own list, newest first, keyset-paged by `(created_at, id)`. */
CREATE INDEX ix_credit_purchases_subscription
    ON commercial.credit_purchases (subscription_id, created_at DESC, id DESC);

-- ==========================================================================
-- 6. Immutability
-- ==========================================================================
--
-- DELETE is refused outright. UPDATE is refused for every snapshot column, and
-- permitted for `lifecycle_state` on exactly one transition.
--
-- `awaiting_payment -> abandoned` is legal here even though this story exposes
-- no route that performs it (ADR-047 §6). The state exists because the
-- lifecycle was ratified with two members; a transition the schema forbids
-- would make the second member unreachable and therefore a lie. #99 widens this
-- to `awaiting_payment -> paid`, in the same transaction as a verified payment
-- fact, and not before.

CREATE OR REPLACE FUNCTION commercial.reject_credit_purchase_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commercial.credit_purchases is immutable: a purchase request is a retained record and is never deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
       OR NEW.subscriber_party_type IS DISTINCT FROM OLD.subscriber_party_type
       OR NEW.subscriber_party_id IS DISTINCT FROM OLD.subscriber_party_id
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.schedule_key IS DISTINCT FROM OLD.schedule_key
       OR NEW.price_schedule_version_id IS DISTINCT FROM OLD.price_schedule_version_id
       OR NEW.price_tier_id IS DISTINCT FROM OLD.price_tier_id
       OR NEW.unit_price_toman IS DISTINCT FROM OLD.unit_price_toman
       OR NEW.total_toman IS DISTINCT FROM OLD.total_toman
       OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
       OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
       OR NEW.request_key IS DISTINCT FROM OLD.request_key
       OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'commercial.credit_purchases snapshot is immutable: the price a seller was offered is never rewritten'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
       AND NOT (OLD.lifecycle_state = 'awaiting_payment' AND NEW.lifecycle_state = 'abandoned') THEN
        RAISE EXCEPTION 'commercial.credit_purchases transition % -> % is not permitted', OLD.lifecycle_state, NEW.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_credit_purchases_immutable
    BEFORE UPDATE OR DELETE ON commercial.credit_purchases
    FOR EACH ROW
    EXECUTE FUNCTION commercial.reject_credit_purchase_rewrite();

-- ==========================================================================
-- 7. Prove the guarantees on the live database
-- ==========================================================================
--
-- The same shape `#58a`'s migration used: assert here, against real PostgreSQL,
-- what the suite will assert again from the application's side.

DO $prove$
DECLARE
    refused BOOLEAN;
BEGIN
    -- A binding to a `seller_plan` schedule must be UNWRITABLE. The seeded
    -- `D-7-base-price` is exactly such a schedule, so this is a real target.
    refused := false;
    BEGIN
        UPDATE commercial.plan_versions
           SET booking_credit_schedule_key = 'D-7-base-price'
         WHERE plan_key = 'D-7';
        RAISE EXCEPTION 'control failure: a seller_plan schedule was accepted as a booking-credit binding';
    EXCEPTION
        WHEN foreign_key_violation THEN refused := true;
        WHEN restrict_violation THEN refused := true;
    END;
    IF NOT refused THEN
        RAISE EXCEPTION 'commercial.plan_versions accepted a wrong-purpose booking-credit binding';
    END IF;

    -- The seeded catalogue must remain unbound. `V33-DEC-027` R8: no backfill.
    IF EXISTS (SELECT 1 FROM commercial.plan_versions WHERE booking_credit_schedule_key IS NOT NULL) THEN
        RAISE EXCEPTION 'a plan version carries a booking-credit binding: this migration seeds none';
    END IF;
    IF EXISTS (SELECT 1 FROM commercial.seller_subscriptions WHERE snapshot_booking_credit_schedule_key IS NOT NULL) THEN
        RAISE EXCEPTION 'a subscription carries a booking-credit schedule snapshot: this migration backfills none';
    END IF;

    -- No booking-credit schedule may exist as a result of this migration.
    IF EXISTS (SELECT 1 FROM commercial.price_schedules WHERE purpose = 'booking_credit') THEN
        RAISE EXCEPTION 'a booking_credit price schedule exists: this migration seeds none';
    END IF;

    -- The grant source vocabulary is #99's to widen, not this story's.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_booking_credit_grants_source'
           AND pg_get_constraintdef(oid) NOT LIKE '%custom_purchase%'
    ) THEN
        RAISE EXCEPTION 'ck_booking_credit_grants_source was widened: custom_purchase belongs to #99';
    END IF;

    RAISE NOTICE 'credit_purchases: wrong-purpose binding refused, nothing seeded, nothing backfilled, grant source untouched.';
END
$prove$;
