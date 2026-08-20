-- ADR-009 / GAP-01: the ledger append-only guarantee, expressed as real
-- PostgreSQL role grants rather than application convention.
--
-- V2 could never achieve this: its MySQL hosting lacked the SUPER /
-- log_bin_trust_function_creators privileges its trigger-based attempt
-- needed, so code-level immutability ("no mutating method exists") was the
-- only guarantee that was always true (PRODUCT_GAP_REGISTER.md §53).
-- This script is the V3 equivalent, and it was executed and verified
-- against a real PostgreSQL 16 server during the Phase 1 completion pass:
-- UPDATE, DELETE, and TRUNCATE are all "permission denied for table
-- ledger_entries" for the writer role, while INSERT and SELECT succeed.
--
-- financial-service itself is NOT implemented in Phase 1 (explicitly out of
-- scope). This proves the INFRASTRUCTURE CONTRACT it will depend on is
-- enforceable on the target database before Phase 2 commits to it. The
-- table below is a minimal stand-in with the same immutability
-- requirements, not the real ledger schema.
--
-- Run as a superuser (grants must be issued by an owner/superuser); the
-- application roles themselves are deliberately NOT superusers -- granting
-- SUPERUSER to make this pass would defeat the entire point.

DROP ROLE IF EXISTS beauclick_financial_writer;
DROP ROLE IF EXISTS beauclick_financial_reader;
CREATE ROLE beauclick_financial_writer WITH LOGIN PASSWORD 'CHANGE_ME_PER_ENVIRONMENT';
CREATE ROLE beauclick_financial_reader WITH LOGIN PASSWORD 'CHANGE_ME_PER_ENVIRONMENT';

CREATE SCHEMA IF NOT EXISTS financial_contract_check;
CREATE TABLE IF NOT EXISTS financial_contract_check.ledger_entries (
    id UUID PRIMARY KEY,
    party_id UUID NOT NULL,
    amount BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT USAGE ON SCHEMA financial_contract_check TO beauclick_financial_writer, beauclick_financial_reader;

-- The core of the contract: INSERT + SELECT only. UPDATE/DELETE/TRUNCATE
-- are never granted to any application role.
GRANT INSERT, SELECT ON financial_contract_check.ledger_entries TO beauclick_financial_writer;
GRANT SELECT ON financial_contract_check.ledger_entries TO beauclick_financial_reader;

-- Defence in depth: ensure no mutation privilege arrives via PUBLIC or via
-- a default-privileges rule configured elsewhere.
REVOKE UPDATE, DELETE, TRUNCATE ON financial_contract_check.ledger_entries FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON financial_contract_check.ledger_entries FROM beauclick_financial_writer;
REVOKE UPDATE, DELETE, TRUNCATE ON financial_contract_check.ledger_entries FROM beauclick_financial_reader;
