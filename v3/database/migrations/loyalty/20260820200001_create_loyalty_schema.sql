-- Phase 3, loyalty-service.
--
-- V2's loyalty domain is the one place in that codebase where idempotency
-- was enforced by the database rather than by convention -- UNIQUE(reference_
-- type, reference_id, reason) on the points ledger, confirmed by discovery to
-- have absorbed a real double-fire. That constraint is preserved here
-- verbatim in shape, with one correction and one addition:
--
--   * Correction: V2 relied on MySQL/InnoDB treating each NULL as distinct
--     under a UNIQUE index, so reference-less manual adjustments were never
--     blocked. PostgreSQL behaves the same way by default -- but "the same
--     way by default" is exactly the kind of cross-engine assumption that
--     silently breaks. The intent is made explicit with a PARTIAL unique
--     index restricted to WHERE reference_type IS NOT NULL, so the rule is
--     stated rather than inherited from a NULL-comparison technicality.
--
--   * Addition: a tier-crossing log. V2 computed a customer's tier at read
--     time and never recorded the moment it changed, so "when did this
--     customer become Gold" was unanswerable and a TierChanged notification
--     was impossible to send without re-deriving state on every points
--     award. The tier itself is STILL never stored -- it remains computed
--     from lifetime earned points. What is stored is the crossing, which is
--     an event, not a cache.

CREATE SCHEMA IF NOT EXISTS loyalty;

-- --------------------------------------------------------------------------
-- The append-only points ledger. The single source of truth for both
-- spendable balance and lifetime earned.
-- --------------------------------------------------------------------------
CREATE TABLE loyalty.points_entries (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    -- Signed: a negative row is a redemption. Never two columns, never a
    -- mutable balance -- the full earn/redeem history must survive.
    points INTEGER NOT NULL,
    reason VARCHAR(64) NOT NULL,
    reference_type VARCHAR(32),
    reference_id UUID,
    -- The multiplier actually applied at award time, in basis points
    -- (10000 = 1.0x). Captured per row for the same reason financial
    -- captures the commission rate per ledger row: a later benefit change
    -- must never retroactively alter what a past award was worth.
    multiplier_bp INTEGER NOT NULL DEFAULT 10000,
    base_points INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_points_entries_multiplier CHECK (multiplier_bp >= 10000),
    -- A reference-bearing row must carry BOTH halves of the reference, or the
    -- idempotency index below silently stops protecting it.
    CONSTRAINT ck_points_entries_reference_pair CHECK (
        (reference_type IS NULL AND reference_id IS NULL)
        OR (reference_type IS NOT NULL AND reference_id IS NOT NULL)
    )
);

-- V2's strongest idempotency guarantee, restated as an explicit partial index.
-- A redelivered BookingCompleted cannot award points twice, whatever the
-- application layer does.
CREATE UNIQUE INDEX uq_points_entries_reference_once
    ON loyalty.points_entries (reference_type, reference_id, reason)
    WHERE reference_type IS NOT NULL;

CREATE INDEX ix_points_entries_user_created ON loyalty.points_entries (user_id, created_at DESC);
-- Serves lifetime_earned (SUM of positive rows) without scanning redemptions.
CREATE INDEX ix_points_entries_user_earned ON loyalty.points_entries (user_id) WHERE points > 0;

-- --------------------------------------------------------------------------
-- Configurable tier definitions. Never hardcoded thresholds in code -- V2's
-- choice, preserved, and the reason GAP-10's "provisional numeric policy"
-- warning does not apply to tiers: there are no constants to be wrong about.
-- --------------------------------------------------------------------------
CREATE TABLE loyalty.tiers (
    id UUID PRIMARY KEY,
    slug VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(191) NOT NULL,
    threshold_points INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_tiers_threshold_non_negative CHECK (threshold_points >= 0)
);

-- Two active tiers at the same threshold makes "which tier does 500 points
-- qualify for" answerable only by tie-break, which is not a business rule
-- anybody signed off. Made unrepresentable instead.
CREATE UNIQUE INDEX uq_tiers_active_threshold
    ON loyalty.tiers (threshold_points) WHERE is_active;

CREATE TABLE loyalty.membership_plans (
    id UUID PRIMARY KEY,
    slug VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(191) NOT NULL,
    -- A plan may be granted automatically on qualifying for this tier.
    tier_id UUID REFERENCES loyalty.tiers (id),
    is_paid BOOLEAN NOT NULL DEFAULT false,
    price_toman BIGINT,
    billing_period_days INTEGER,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_membership_plans_price CHECK (price_toman IS NULL OR price_toman >= 0),
    CONSTRAINT ck_membership_plans_period CHECK (billing_period_days IS NULL OR billing_period_days > 0),
    -- A paid plan with no price is a plan nobody can be charged for.
    CONSTRAINT ck_membership_plans_paid_has_price CHECK (NOT is_paid OR price_toman IS NOT NULL)
);

-- TierMembershipSync looks up "the active plan linked to this tier" and takes
-- the first match. With two linked plans that lookup is nondeterministic --
-- the same customer could get a different membership depending on row order.
CREATE UNIQUE INDEX uq_membership_plans_tier
    ON loyalty.membership_plans (tier_id) WHERE tier_id IS NOT NULL AND is_active;

-- --------------------------------------------------------------------------
-- Membership is account STATE, not a ledger: at most one row per user,
-- mutated in place. V2's shape, kept deliberately -- the audit trail lives in
-- the event stream (MembershipActivated / MembershipEnded), not a fifth table.
-- --------------------------------------------------------------------------
CREATE TABLE loyalty.memberships (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE,
    plan_id UUID NOT NULL REFERENCES loyalty.membership_plans (id),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    activation_source VARCHAR(20) NOT NULL DEFAULT 'manual',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_memberships_status CHECK (status IN ('active', 'expired', 'cancelled')),
    CONSTRAINT ck_memberships_source CHECK (activation_source IN ('manual', 'tier_qualification'))
);

CREATE INDEX ix_memberships_expiry ON loyalty.memberships (expires_at) WHERE status = 'active';

-- --------------------------------------------------------------------------
-- Entitlements, polymorphic over tier | membership_plan.
-- --------------------------------------------------------------------------
CREATE TABLE loyalty.benefits (
    id UUID PRIMARY KEY,
    source_type VARCHAR(20) NOT NULL,
    source_id UUID NOT NULL,
    benefit_type VARCHAR(30) NOT NULL,
    label VARCHAR(191) NOT NULL,
    -- Typed config, not free text. `{"multiplierBp": 12000}` or
    -- `{"percentBp": 1000}` depending on benefit_type.
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_benefits_source_type CHECK (source_type IN ('tier', 'membership_plan')),
    CONSTRAINT ck_benefits_type CHECK (
        benefit_type IN ('bonus_points_multiplier', 'discount_percentage', 'descriptive')
    )
);

CREATE INDEX ix_benefits_source ON loyalty.benefits (source_type, source_id) WHERE is_active;

-- --------------------------------------------------------------------------
-- Tier crossings. The tier is still computed, never stored; this records
-- WHEN it changed so the change can be notified and analysed.
-- --------------------------------------------------------------------------
CREATE TABLE loyalty.tier_crossings (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    from_tier_slug VARCHAR(64),
    to_tier_slug VARCHAR(64),
    lifetime_earned INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The idempotency guarantee for LoyaltyTierChanged. Recomputing the same
-- crossing -- which happens on every redelivered award -- inserts nothing.
-- `to_tier_slug` is COALESCEd because a customer can legitimately cross to
-- "no tier" only once at a given lifetime total, and NULL <> NULL would let
-- that row duplicate forever.
CREATE UNIQUE INDEX uq_tier_crossings_once
    ON loyalty.tier_crossings (user_id, COALESCE(to_tier_slug, ''), lifetime_earned);

CREATE INDEX ix_tier_crossings_user ON loyalty.tier_crossings (user_id, created_at DESC);

-- --------------------------------------------------------------------------
-- Transactional outbox (V3_DATABASE_BLUEPRINT.md §7).
-- --------------------------------------------------------------------------
CREATE TABLE loyalty.outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_loyalty_outbox_unpublished ON loyalty.outbox_events (id) WHERE published_at IS NULL;
