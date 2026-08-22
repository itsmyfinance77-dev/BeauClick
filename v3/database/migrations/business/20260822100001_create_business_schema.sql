-- Phase 4: the Business/Seller domain (ADR-023). Deliberately a separate
-- schema from `provider`, not a column added to `provider.professionals` --
-- see ADR-023 §1 for why Business is modeled as its own party rather than a
-- layer under Professional.

CREATE SCHEMA IF NOT EXISTS business;

CREATE TABLE business.businesses (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL, -- references identity.users.id; no cross-schema FK by convention (V3_DATABASE_BLUEPRINT.md §1)
    display_name VARCHAR(120) NOT NULL,
    bio TEXT,
    city_id UUID, -- references provider.locations_cities.id; no cross-schema FK by convention
    verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified',
    revision BIGINT NOT NULL DEFAULT 1,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_businesses_owner_id ON business.businesses (owner_id);

-- `owner` is not a value of `role` here on purpose -- see BusinessStaffEntity's
-- docblock. A membership row always starts `invited` and only the invited
-- user's own session can move it to `active` (StaffService.accept).
CREATE TABLE business.business_staff (
    id UUID PRIMARY KEY,
    business_id UUID NOT NULL REFERENCES business.businesses (id),
    user_id UUID NOT NULL, -- references identity.users.id; no cross-schema FK by convention
    professional_id UUID, -- references provider.professionals.id; no cross-schema FK by convention
    role VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'invited',
    invited_by UUID NOT NULL,
    responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One membership row per (business, user) regardless of status -- a second
-- invite to someone already invited/active/declined is rejected at the
-- storage layer rather than silently creating a duplicate row.
CREATE UNIQUE INDEX uq_business_staff_membership ON business.business_staff (business_id, user_id);

-- At most one ACTIVE business affiliation per professional at a time -- see
-- BusinessStaffEntity's docblock for why this must be unambiguous.
CREATE UNIQUE INDEX uq_business_staff_active_professional
    ON business.business_staff (professional_id)
    WHERE status = 'active' AND professional_id IS NOT NULL;

CREATE INDEX ix_business_staff_user_id ON business.business_staff (user_id);

CREATE TABLE business.outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    correlation_id UUID,
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_business_outbox_unpublished ON business.outbox_events (id) WHERE published_at IS NULL;
CREATE INDEX ix_business_outbox_correlation_id ON business.outbox_events (correlation_id);
