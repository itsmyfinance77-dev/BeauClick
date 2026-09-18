-- ---------------------------------------------------------------------------
-- V3.3 Story #43a — the pending-funds journal (ADR-052 §4–§5, §12;
-- `V33-DEC-040` R1, R4, R6 as corrected by `V33-DEC-044` R2; `V33-DEC-025` R7).
--
-- ## What this is
--
-- A balanced, append-only, double-entry journal for every toman BeauClick
-- collects on a new order and every refund against it. It replaces
-- `financial.ledger_entries` for every order collected FROM THIS MIGRATION
-- ONWARD -- `ledger_entries` stays exactly as it is, forever, for every order
-- that collected before it (see the companion migration and #43a's legacy
-- byte-identity proof; ADR-052 §16).
--
-- `#43a` writes exactly two journal kinds: `collection` and `refund`. Every
-- other kind ADR-052 §4 names (`dispute_hold`, `release`, `settlement`, ...)
-- is reserved column-and-CHECK-compatible shape for `#43c`–`#43g`; this
-- migration does not make them writable (`ck_fund_journals_kind_defined`
-- below), matching the `ck_bod_kind_defined` convention
-- `20260920100001_create_booking_outcome_decisions.sql` established for the
-- same "reserve the vocabulary, gate the write" reason.
--
-- ## Why balanced double-entry rather than widening `ledger_entries`
--
-- `ledger_entries.commission_rate_bp NOT NULL` cannot truthfully snapshot a
-- `fixed`, `hybrid`, `zero` or absent commission policy, and one row per
-- payment cannot carry the several components ADR-052 §3 will need. A single
-- balanced journal, checked to sum to zero by the database rather than by
-- application arithmetic, is what makes R6's intent (exact sums, database
-- enforcement) actually provable (ADR-052 §12, rejecting "widen
-- `ledger_entries`" and "a mutable balance table").
--
-- ## The two structural guarantees this file installs
--
-- 1. `tg_fund_postings_chain` (BEFORE INSERT, per row) -- `seq` must chain
--    from the previous posting for the SAME `(order_id, account, component)`,
--    and `balance_after` must equal the previous balance plus this posting's
--    signed delta, ACCOUNT-SIDE AWARE (see the function's own comment for the
--    sign convention). `CHECK (balance_after >= 0)` on the column makes an
--    overdraw refused at the row, not caught later by a read.
-- 2. `tg_fund_postings_journal_balance` (a DEFERRED CONSTRAINT TRIGGER, so it
--    reads the whole transaction's inserts at COMMIT) -- every journal's
--    postings for the order they touch must sum to exactly zero (M0, ADR-052
--    §12). This is the database proof of R6's exact-sum intent; nothing here
--    trusts the caller to have added correctly.
--
-- Both together are why `#43a`'s preflight can prove "unbalanced journal
-- refused at commit; overdraw by 1 refused; zero allowed; parallel `seq` race
-- gives one `23505`" (ADR-052's requirement-to-test matrix, row `a`).
--
-- ## Why triggers and not `UPDATE`
--
-- The financial writer role holds INSERT + SELECT only (ADR-017, GAP-01).
-- `seq`/`balance_after` cannot be computed by a caller reading-then-writing:
-- PostgreSQL requires UPDATE privilege for `SELECT ... FOR UPDATE/SHARE`, so
-- the writer cannot even row-lock to serialize that read (ADR-052 §4,
-- "Serialization [T]"). The application takes a transaction-scoped ADVISORY
-- lock per order (namespace `fjo`, `FundJournalService.recordCollection` /
-- `recordRefund`) before every insert; the `seq` UNIQUE index below is what
-- makes a missed lock fail LOUDLY (`23505`) instead of silently forking the
-- balance chain, which is the whole reason advisory locking is safe to rely
-- on here rather than merely convenient.
--
-- ## No seed, no value, no cross-schema FK
--
-- No row is created here. `order_id` carries no FK to `commerce.orders`,
-- matching this platform's standing convention (financial and commerce are
-- separate DataSources -- ADR-017, ADR-018) and the same choice
-- `20260920100001`'s `booking_outcome_decisions.booking_id` makes.
-- ---------------------------------------------------------------------------

CREATE TABLE financial.fund_journals (
    id UUID PRIMARY KEY,
    kind VARCHAR(20) NOT NULL,

    -- Consumer idempotency (ADR-052 §13): `collection:<paymentIntentId>` /
    -- `refund:<refundId>`. At-least-once delivery writes this journal AT MOST
    -- once, proved by the UNIQUE index below -- never by a preceding SELECT.
    idempotency_key VARCHAR(160) NOT NULL,

    source_type VARCHAR(16) NOT NULL,
    source_id UUID NOT NULL,

    -- The commission-policy snapshot, BY VALUE (ADR-052 §13). Always NULL for
    -- `#43a`'s two kinds -- neither commission policy (`#43b`) exists yet, and
    -- ADR-052 §5 is explicit that a `collection` journal carries "no
    -- commission and no receivable row". Reserved, nullable, for `#43c`'s
    -- `release` journal.
    policy_key VARCHAR(64),
    policy_version INTEGER,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_fund_journals_kind CHECK (kind IN (
        'collection', 'refund', 'dispute_hold', 'dispute_outcome', 'release',
        'reserve_hold', 'reserve_release', 'settlement', 'settlement_reversal',
        'recovery', 'fee'
    )),
    -- `#43a` writes only these two. A later child widens this CHECK when it
    -- implements its own kind -- see `20260920100001`'s `ck_bod_kind_defined`
    -- for the identical reasoning.
    CONSTRAINT ck_fund_journals_kind_defined CHECK (kind IN ('collection', 'refund')),
    CONSTRAINT ck_fund_journals_source_type CHECK (source_type IN ('order')),
    CONSTRAINT ck_fund_journals_policy_pair CHECK ((policy_key IS NULL) = (policy_version IS NULL))
);

-- THE idempotency guarantee (ADR-052 §13). A retried `OrderPaid` /
-- `OrderCollectionCaptured` / `OrderRefunded` delivery writes this journal at
-- most once.
CREATE UNIQUE INDEX uq_fund_journals_idempotency_key
    ON financial.fund_journals (idempotency_key);

CREATE INDEX ix_fund_journals_source ON financial.fund_journals (source_type, source_id);

CREATE TABLE financial.fund_postings (
    id UUID PRIMARY KEY,
    journal_id UUID NOT NULL REFERENCES financial.fund_journals (id),
    order_id UUID NOT NULL,

    -- Copied from `commerce.orders.seller_party_*` through the capture event
    -- ONLY -- never from a request (`V33-DEC-025` R7). `tg_fund_postings_beneficiary`
    -- below refuses a posting that disagrees with the order's first one.
    seller_party_type VARCHAR(16) NOT NULL,
    seller_party_id UUID NOT NULL,

    account VARCHAR(20) NOT NULL,
    -- NULL for every account `#43a` posts to. Reserved for `platform_earned`'s
    -- per-component split (`booking_commission` / `acquisition` /
    -- `processing_recovery`), owned by `#43c`/`#43b`.
    component VARCHAR(32),

    -- Signed BY THE ACCOUNT'S NORMAL SIDE (ADR-052 §4): a debit-normal
    -- account's amount is positive on an increase; a credit-normal account's
    -- amount is NEGATIVE on an increase. That convention is exactly what
    -- makes the raw, unweighted `SUM(amount_toman)` per journal equal zero
    -- for a balanced entry (M0) -- see `tg_fund_postings_journal_balance`.
    -- `tg_fund_postings_chain` below re-derives each account's own natural,
    -- non-negative running total from this same signed value.
    amount_toman BIGINT NOT NULL,

    -- The running-balance chain per (order_id, account, component) — M4.
    seq INTEGER NOT NULL,
    balance_after BIGINT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_fund_postings_seller_party CHECK (seller_party_type IN ('professional', 'business')),
    -- The full account vocabulary ADR-052 §4 names, debit-normal and
    -- credit-normal together -- `tg_fund_postings_chain` is the single place
    -- that says which side each one is on.
    CONSTRAINT ck_fund_postings_account CHECK (account IN (
        'pending', 'disputed', 'available', 'reserve', 'settled', 'refunded',
        'platform_earned', 'provider_fee', 'recovery_out',
        'collected', 'platform_advance', 'recovered_in'
    )),
    CONSTRAINT ck_fund_postings_amount_nonzero CHECK (amount_toman <> 0),
    CONSTRAINT ck_fund_postings_balance_non_negative CHECK (balance_after >= 0),
    CONSTRAINT ck_fund_postings_seq_positive CHECK (seq > 0)
);

-- The chain's own uniqueness (M4), and the loud failure ADR-052 §4 relies on
-- when an advisory lock is ever missed. `COALESCE(component, '')` is
-- load-bearing: PostgreSQL treats every NULL as DISTINCT from every other
-- NULL in a unique index, so a plain `UNIQUE (order_id, account, component,
-- seq)` would NOT catch two concurrent writers both inserting
-- `(order_id, 'pending', NULL, 1)` -- exactly the accounts `#43a` posts to,
-- since `component` is NULL for all of them today.
CREATE UNIQUE INDEX uq_fund_postings_chain
    ON financial.fund_postings (order_id, account, COALESCE(component, ''), seq);

-- Fast lookup for the chain trigger and the beneficiary trigger; also what
-- the `/funds` read route and the M1 reconciliation read use to scope by
-- order.
CREATE INDEX ix_fund_postings_order ON financial.fund_postings (order_id, id);

-- ==========================================================================
-- The running-balance chain (M4) -- BEFORE INSERT, per row
-- ==========================================================================

CREATE OR REPLACE FUNCTION financial.enforce_fund_posting_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_prev_seq INTEGER;
    v_prev_balance BIGINT;
    v_debit_normal BOOLEAN;
    v_delta BIGINT;
BEGIN
    SELECT seq, balance_after INTO v_prev_seq, v_prev_balance
      FROM financial.fund_postings
     WHERE order_id = NEW.order_id
       AND account = NEW.account
       AND component IS NOT DISTINCT FROM NEW.component
     ORDER BY seq DESC
     LIMIT 1;

    IF v_prev_seq IS NULL THEN
        IF NEW.seq <> 1 THEN
            RAISE EXCEPTION 'financial.fund_postings: first posting for order %, account %, component % must have seq = 1, got %',
                NEW.order_id, NEW.account, NEW.component, NEW.seq
                USING ERRCODE = 'restrict_violation';
        END IF;
        v_prev_balance := 0;
    ELSIF NEW.seq <> v_prev_seq + 1 THEN
        RAISE EXCEPTION 'financial.fund_postings: seq must chain from % but got % for order %, account %, component % -- a missing advisory lock let two writers race',
            v_prev_seq + 1, NEW.seq, NEW.order_id, NEW.account, NEW.component
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Debit-normal accounts (ADR-052 §4): the posted amount IS the balance
    -- delta. Credit-normal accounts store the M0-compatible NEGATIVE amount
    -- on an increase, so the balance delta is the amount's negation.
    v_debit_normal := NEW.account IN (
        'pending', 'disputed', 'available', 'reserve', 'settled', 'refunded',
        'platform_earned', 'provider_fee', 'recovery_out'
    );
    v_delta := CASE WHEN v_debit_normal THEN NEW.amount_toman ELSE -NEW.amount_toman END;

    IF NEW.balance_after <> v_prev_balance + v_delta THEN
        RAISE EXCEPTION 'financial.fund_postings: balance_after must equal % (previous % plus delta %) but got % for order %, account %, component %',
            v_prev_balance + v_delta, v_prev_balance, v_delta, NEW.balance_after, NEW.order_id, NEW.account, NEW.component
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_fund_postings_chain
    BEFORE INSERT ON financial.fund_postings
    FOR EACH ROW
    EXECUTE FUNCTION financial.enforce_fund_posting_chain();

-- ==========================================================================
-- The beneficiary (`V33-DEC-025` R7) -- BEFORE INSERT, per row
-- ==========================================================================
-- A posting's seller party can never disagree with the order's FIRST posting
-- of any kind. There is no "correction" path: the beneficiary is fixed at
-- the order's first collection and stays fixed for the order's life.

CREATE OR REPLACE FUNCTION financial.enforce_fund_posting_beneficiary()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_first_type VARCHAR(16);
    v_first_id UUID;
BEGIN
    SELECT seller_party_type, seller_party_id INTO v_first_type, v_first_id
      FROM financial.fund_postings
     WHERE order_id = NEW.order_id
     ORDER BY id ASC
     LIMIT 1;

    IF v_first_type IS NOT NULL
       AND (v_first_type <> NEW.seller_party_type OR v_first_id <> NEW.seller_party_id)
    THEN
        RAISE EXCEPTION 'financial.fund_postings: order % is already attributed to % % -- a posting cannot change its beneficiary',
            NEW.order_id, v_first_type, v_first_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_fund_postings_beneficiary
    BEFORE INSERT ON financial.fund_postings
    FOR EACH ROW
    EXECUTE FUNCTION financial.enforce_fund_posting_beneficiary();

-- ==========================================================================
-- The zero-sum guarantee (M0, ADR-052 §12) -- a DEFERRED CONSTRAINT TRIGGER
-- ==========================================================================
-- Deferred to COMMIT, so it sees every posting the transaction wrote for the
-- journal it is checking -- a multi-row journal insert (one row per account)
-- is only fully visible to this check at the end of the transaction, exactly
-- as `20260920100001`'s `tg_bod_supersession_shape` defers for the same
-- reason (the row it needs is written after the row that references it).
--
-- Fires once per inserted posting and re-derives the SAME total each time;
-- redundant, never wrong -- the cost is one indexed aggregate per posting,
-- paid once at commit.

CREATE OR REPLACE FUNCTION financial.check_fund_journal_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_total BIGINT;
BEGIN
    SELECT SUM(amount_toman) INTO v_total
      FROM financial.fund_postings
     WHERE journal_id = NEW.journal_id AND order_id = NEW.order_id;

    IF v_total IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'financial.fund_journals %: postings for order % sum to % instead of zero',
            NEW.journal_id, NEW.order_id, v_total
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tg_fund_postings_journal_balance
    AFTER INSERT ON financial.fund_postings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION financial.check_fund_journal_balance();

-- ---------------------------------------------------------------------------
-- Grants. No explicit statement is required: `database/scripts/financial-roles.sql`
-- already installs `ALTER DEFAULT PRIVILEGES FOR ROLE beauclick_financial_owner
-- IN SCHEMA financial GRANT INSERT, SELECT ON TABLES TO beauclick_financial_writer`
-- (and `SELECT` to `beauclick_financial_reader`), and this migration runs
-- under `MIGRATION_URL_FINANCIAL` (the owner role), so both new tables inherit
-- writer INSERT+SELECT and reader SELECT automatically, with no UPDATE,
-- DELETE or TRUNCATE granted to anyone but the owner -- proved for these two
-- tables specifically by `role-contract.ts`'s `funds_journal.*` /
-- `funds_posting.*` checks, not merely assumed from the schema-level default.
-- `beauclick_app` already has no USAGE on `financial` at all (schema-level
-- REVOKE from the original migration), so it reaches neither table.
-- ---------------------------------------------------------------------------
