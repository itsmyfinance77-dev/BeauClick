-- Verified against a real PostgreSQL 16 server (see V3_PHASE1_IMPLEMENTATION.md
-- Phase 1 completion pass) -- applied via database/scripts/migrate.ts,
-- schema inspected directly via psql, constraints exercised with real
-- INSERT statements, re-run confirmed idempotent (skip-if-applied).

CREATE SCHEMA IF NOT EXISTS provider;

CREATE TABLE provider.locations_cities (
    id UUID PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    is_launched BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE provider.specialties (
    id UUID PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    parent_id UUID REFERENCES provider.specialties (id)
);

CREATE TABLE provider.professionals (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL, -- references identity.users.id; no cross-schema FK by convention (V3_DATABASE_BLUEPRINT.md §1)
    display_name VARCHAR(120) NOT NULL,
    bio TEXT,
    city_id UUID REFERENCES provider.locations_cities (id),
    verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified',
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_professionals_owner_id ON provider.professionals (owner_id);
CREATE INDEX ix_professionals_city_id ON provider.professionals (city_id);

CREATE TABLE provider.professional_specialties (
    professional_id UUID NOT NULL REFERENCES provider.professionals (id),
    specialty_id UUID NOT NULL REFERENCES provider.specialties (id),
    PRIMARY KEY (professional_id, specialty_id)
);

CREATE TABLE provider.services (
    id UUID PRIMARY KEY,
    professional_id UUID NOT NULL REFERENCES provider.professionals (id),
    name VARCHAR(120) NOT NULL,
    duration_minutes INT NOT NULL,
    price_toman INT NOT NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_services_professional_id ON provider.services (professional_id);
