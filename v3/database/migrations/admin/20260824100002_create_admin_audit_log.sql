-- ---------------------------------------------------------------------------
-- The persistent, append-only administrative audit log (GAP-02-V3).
--
-- Until now V3's `AuditLogger` wrote to the structured application logger. That
-- was a reasonable Phase 1 choice and it has two properties that stop being
-- acceptable the moment privileged accounts exist: a log line is not a record
-- anyone can query as part of the product, and a mutation whose audit line
-- fails to write succeeds anyway. V2 found the resulting bug class -- a
-- capability-gated admin mutation that skipped its audit call -- **three
-- separate times across two plugins**, which is why the fix there was
-- structural rather than a reminder.
--
-- OWNERSHIP, and why it matters here exactly as much as it does for the ledger
-- (ADR-009 / ADR-017): this schema and table are owned by
-- `beauclick_admin_audit_owner`, a role the application never connects as. The
-- application role is granted INSERT + SELECT and nothing else. Because it is
-- not the owner, it cannot grant itself back UPDATE or DELETE -- an owner
-- always can, which is the whole reason the application must not be the owner.
--
-- Unlike `financial`, the application needs no second connection pool: INSERT +
-- SELECT is the entire access pattern, so the ordinary DATABASE_URL connection
-- is sufficient and correct. The immutability is a grant, not a convention.
--
-- Requires `database/scripts/admin-audit-roles.sql` to have run first, and
-- MIGRATION_URL_ADMIN to point at the owner role -- the same mechanism
-- migrate.ts already provides for `financial`.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE admin.admin_audit_log (
    id UUID PRIMARY KEY,

    -- WHO. Always the authenticated session's own user id, resolved
    -- server-side. Never a client-supplied actor. NULL only for the documented
    -- one-time bootstrap, which has no privileged account to act as -- and that
    -- row still exists, so even the first grant is auditable.
    actor_user_id UUID,
    -- A short label for a non-session actor ('bootstrap', 'system'). Present
    -- exactly when actor_user_id is NULL, and vice versa.
    actor_label VARCHAR(40),

    -- WHAT. A dotted domain.verb, e.g. 'identity.role_granted'.
    action VARCHAR(80) NOT NULL,

    -- TO WHAT. `target_id` is VARCHAR rather than UUID: not every target is a
    -- uuid (a phone-conflict resolution targets a conflict row, a reindex
    -- targets an index alias by name).
    target_type VARCHAR(40) NOT NULL,
    target_id VARCHAR(120),

    -- Before and after, as bounded JSON objects. These are identifiers, enums,
    -- and counts -- never OTP codes, tokens, payment secrets, or customer free
    -- text. The same deny-list the event catalog enforces on payloads, for the
    -- same reason: this table is a second, longer-lived copy of whatever is put
    -- in it.
    before_state JSONB,
    after_state JSONB,

    -- WHY. Required by the API for every decision a human makes; the column is
    -- nullable only because a few system-initiated actions genuinely have no
    -- human reason to record.
    reason TEXT,

    -- Ties an audit row to the request that produced it, and to every event
    -- that request emitted.
    correlation_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_admin_audit_actor CHECK (
        (actor_user_id IS NOT NULL AND actor_label IS NULL)
        OR (actor_user_id IS NULL AND actor_label IS NOT NULL)
    )
);

-- The two shapes an operator actually queries: "what happened recently" and
-- "what has been done to this thing".
CREATE INDEX ix_admin_audit_created ON admin.admin_audit_log (created_at DESC);
CREATE INDEX ix_admin_audit_target ON admin.admin_audit_log (target_type, target_id, created_at DESC);
CREATE INDEX ix_admin_audit_actor ON admin.admin_audit_log (actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX ix_admin_audit_action ON admin.admin_audit_log (action, created_at DESC);
