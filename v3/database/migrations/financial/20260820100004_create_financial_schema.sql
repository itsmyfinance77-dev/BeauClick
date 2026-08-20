-- Phase 2, financial-service. THE highest-stakes schema in V3.
--
-- This file is applied by a DEDICATED owner role, not by the application
-- role -- see database/scripts/financial-roles.sql and MIGRATION_URL_FINANCIAL
-- in database/scripts/migrate.ts. That separation is what makes the
-- immutability guarantee structural rather than aspirational: the
-- application role is not the owner, so it cannot grant itself UPDATE on
-- these tables even if it wanted to.
--
-- GAP-01, stated precisely and closed here:
--   V2 could only ever claim "no mutating method exists in LedgerService".
--   Its MySQL hosting lacked the SUPER / log_bin_trust_function_creators
--   privileges its trigger-based attempt needed, so the trigger silently
--   failed to install on the project's own dev/test hosts and code-level
--   convention remained the only always-true guarantee.
--   V3 controls its own PostgreSQL, so the guarantee is a grant: no
--   application role is EVER granted UPDATE, DELETE, or TRUNCATE on any
--   table in this schema (except a narrow, deliberate UPDATE on
--   outbox_events, which holds delivery receipts, not financial facts).

CREATE SCHEMA IF NOT EXISTS financial;

CREATE TABLE financial.ledger_entries (
    id UUID PRIMARY KEY,
    order_id UUID NOT NULL,
    source_id UUID,
    party_type VARCHAR(20) NOT NULL,
    party_id UUID,
    entry_type VARCHAR(20) NOT NULL,
    -- Negative on a refund reversal.
    amount_toman BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'IRT',
    -- Captured at write time, per row, so a future second basis can be
    -- introduced without reinterpreting a single historical row.
    basis VARCHAR(30) NOT NULL,
    -- Basis points, captured at write time and NEVER looked up live. This one
    -- column is what makes a commission-rate change unable to retroactively
    -- alter the meaning of a past transaction, and what lets a refund reverse
    -- at the rate it was originally recorded at.
    commission_rate_bp INT NOT NULL,
    reference_type VARCHAR(20) NOT NULL,
    reference_id UUID NOT NULL,
    -- Append-only: created_at only, no updated_at. Not a convention -- no
    -- connection in the system holds the UPDATE privilege to set one.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_ledger_entry_type CHECK (entry_type IN ('commission', 'receivable')),
    CONSTRAINT ck_ledger_reference_type CHECK (reference_type IN ('order_payment', 'order_refund')),
    CONSTRAINT ck_ledger_party_type CHECK (party_type IN ('platform', 'professional', 'business')),
    CONSTRAINT ck_ledger_rate CHECK (commission_rate_bp BETWEEN 0 AND 10000),
    -- The platform is not a party with an id; every other party must have one.
    CONSTRAINT ck_ledger_party_id CHECK (
        (party_type = 'platform' AND party_id IS NULL) OR (party_type <> 'platform' AND party_id IS NOT NULL)
    ),
    -- A payment records positive amounts, a refund records negative ones.
    -- Sign carries meaning here, so a sign that disagrees with the reference
    -- type is a corruption, not a variant.
    CONSTRAINT ck_ledger_sign CHECK (
        (reference_type = 'order_payment' AND amount_toman >= 0)
        OR (reference_type = 'order_refund' AND amount_toman <= 0)
    )
);

-- THE idempotency guarantee. V2's exact shape -- confirmed there to have
-- absorbed a real double-fire under production-equivalent conditions. A
-- retried PaymentSucceeded or RefundCompleted delivery can never
-- double-record commission or receivable.
CREATE UNIQUE INDEX uq_ledger_entry_once
    ON financial.ledger_entries (entry_type, reference_type, reference_id);

CREATE INDEX ix_ledger_entries_order ON financial.ledger_entries (order_id);
-- Covers the party-scoped receivable sum, which is the hottest financial
-- read (every seller's dashboard). Partial: commission rows are never
-- summed per party, so keeping them out halves the index.
CREATE INDEX ix_ledger_entries_party_receivable
    ON financial.ledger_entries (party_type, party_id, order_id)
    WHERE entry_type = 'receivable';

CREATE TABLE financial.settlement_batches (
    id UUID PRIMARY KEY,
    kind VARCHAR(16) NOT NULL DEFAULT 'settlement',
    reverses_settlement_id UUID REFERENCES financial.settlement_batches (id),
    party_type VARCHAR(20) NOT NULL,
    party_id UUID NOT NULL,
    -- Negative on a reversal row.
    amount_toman BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'IRT',
    method VARCHAR(60),
    reference VARCHAR(191),
    note TEXT,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_settlement_kind CHECK (kind IN ('settlement', 'reversal')),
    CONSTRAINT ck_settlement_party_type CHECK (party_type IN ('professional', 'business')),
    -- A reversal must say what it reverses; a settlement must not.
    CONSTRAINT ck_settlement_reversal_link CHECK (
        (kind = 'reversal' AND reverses_settlement_id IS NOT NULL)
        OR (kind = 'settlement' AND reverses_settlement_id IS NULL)
    )
);

-- A settlement can be reversed at most once. Append-only means there is no
-- status flag to check, so this constraint IS the guard -- a retried operator
-- action cannot un-settle the same batch twice.
CREATE UNIQUE INDEX uq_settlement_batches_reversal
    ON financial.settlement_batches (reverses_settlement_id)
    WHERE kind = 'reversal';

CREATE INDEX ix_settlement_batches_party ON financial.settlement_batches (party_type, party_id, id DESC);

CREATE TABLE financial.settlement_items (
    id UUID PRIMARY KEY,
    settlement_id UUID NOT NULL REFERENCES financial.settlement_batches (id),
    order_id UUID NOT NULL,
    -- Negative on a reversal item, mirroring the item it reverses.
    amount_toman BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One settlement covers a given order at most once.
CREATE UNIQUE INDEX uq_settlement_items_settlement_order
    ON financial.settlement_items (settlement_id, order_id);

-- "How much has this order been settled?" is one SUM over this index -- no
-- status filter and no join, because reversals are negative rows rather than
-- a status flip on the batch.
CREATE INDEX ix_settlement_items_order ON financial.settlement_items (order_id);

-- Delivery receipts, not financial facts. This is the ONLY table in the
-- schema the writer role may UPDATE, and only so the relay can stamp
-- published_at. Asserted explicitly by financial-immutability.pg-spec.ts.
CREATE TABLE financial.outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    event_version INT NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    published_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_financial_outbox_unpublished
    ON financial.outbox_events (id)
    WHERE published_at IS NULL;

-- ---------------------------------------------------------------------
-- The grants that make GAP-01 structurally true.
-- ---------------------------------------------------------------------
-- Applied here, in the same transaction as the DDL, so the tables can never
-- exist in a permissive state -- not even briefly between two deploy steps.

GRANT USAGE ON SCHEMA financial TO beauclick_financial_writer, beauclick_financial_reader;

-- INSERT + SELECT. Never UPDATE, DELETE, or TRUNCATE.
GRANT INSERT, SELECT ON financial.ledger_entries TO beauclick_financial_writer;
GRANT INSERT, SELECT ON financial.settlement_batches TO beauclick_financial_writer;
GRANT INSERT, SELECT ON financial.settlement_items TO beauclick_financial_writer;

-- The one narrow exception, scoped to the outbox alone.
GRANT INSERT, SELECT, UPDATE ON financial.outbox_events TO beauclick_financial_writer;

GRANT SELECT ON ALL TABLES IN SCHEMA financial TO beauclick_financial_reader;

-- Defence in depth: make sure no mutation privilege can arrive via PUBLIC or
-- via a default-privileges rule configured elsewhere in the cluster.
REVOKE ALL ON ALL TABLES IN SCHEMA financial FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON financial.ledger_entries FROM beauclick_financial_writer, beauclick_financial_reader;
REVOKE UPDATE, DELETE, TRUNCATE ON financial.settlement_batches FROM beauclick_financial_writer, beauclick_financial_reader;
REVOKE UPDATE, DELETE, TRUNCATE ON financial.settlement_items FROM beauclick_financial_writer, beauclick_financial_reader;
REVOKE DELETE, TRUNCATE ON financial.outbox_events FROM beauclick_financial_writer, beauclick_financial_reader;

-- The main application role gets NOTHING here. apps/api's own connection
-- pool -- the one every controller, guard, and background job shares -- must
-- not even be able to read the ledger; financial-service's dedicated
-- connection is the only path in.
REVOKE ALL ON SCHEMA financial FROM beauclick_app;
