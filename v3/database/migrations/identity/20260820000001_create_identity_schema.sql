-- V3_DATABASE_BLUEPRINT.md: schema-per-module, UUIDv7 PKs generated
-- application-side (not gen_random_uuid()), standard audit columns.
-- NOTE (Phase 1 known limitation, see V3_PHASE1_IMPLEMENTATION.md): this
-- file has not been executed against a real PostgreSQL server in this
-- environment (no Docker/psql/pg service available) -- it has been
-- exercised structurally via TypeORM's schema-sync path against pg-mem
-- (libs/testing) in the automated test suite, which validates the DDL
-- shape and every query against it, but is not a substitute for a real
-- Postgres run. Verify this file directly against a real Postgres instance
-- before Phase 2.

CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE identity.users (
    id UUID PRIMARY KEY,
    phone VARCHAR(32) NOT NULL,
    display_name VARCHAR(120),
    roles TEXT[] NOT NULL DEFAULT '{customer}',
    is_verified_professional BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_users_phone ON identity.users (phone);

CREATE TABLE identity.otp_requests (
    id UUID PRIMARY KEY,
    phone VARCHAR(32) NOT NULL,
    purpose VARCHAR(20) NOT NULL,
    code_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts_remaining INT NOT NULL DEFAULT 5,
    consumed_at TIMESTAMPTZ,
    session_user_id UUID,
    request_ip VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_otp_requests_phone_purpose_consumed ON identity.otp_requests (phone, purpose, consumed_at);
CREATE INDEX ix_otp_requests_created_at ON identity.otp_requests (created_at);
CREATE INDEX ix_otp_requests_request_ip_created_at ON identity.otp_requests (request_ip, created_at);

CREATE TABLE identity.refresh_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES identity.users (id),
    token_hash VARCHAR(128) NOT NULL,
    device_label VARCHAR(255),
    user_agent VARCHAR(255),
    replaced_by_token_id UUID,
    revoked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_refresh_tokens_token_hash ON identity.refresh_tokens (token_hash);
CREATE INDEX ix_refresh_tokens_user_id ON identity.refresh_tokens (user_id);

CREATE TABLE identity.phone_conflicts (
    id UUID PRIMARY KEY,
    phone VARCHAR(32) NOT NULL,
    existing_user_id UUID NOT NULL REFERENCES identity.users (id),
    note TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_phone_conflicts_phone ON identity.phone_conflicts (phone);
