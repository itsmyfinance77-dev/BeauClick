-- ---------------------------------------------------------------------------
-- V3.3 Story #192 (`#43b-2`) — the per-order commission snapshot
-- (ADR-052 §2, `V33-DEC-028` Ruling 4, ratified by `V33-DEC-044`).
--
-- One row per (order, component), written INSIDE the checkout transaction, by
-- VALUE. It records which published rule — or its explicit absence — binds an
-- order at the moment of commitment, so `#43c` can compute commission later
-- from these columns and never from live policy.
--
-- ## Why by value, and why at commitment
--
-- ADR-052 §2 rejects two alternatives explicitly, and the reasons are the
-- reason this table exists rather than a join:
--
--   * *Resolve the version "as of" the order instant when the ledger handler
--     runs* is not deterministic. A publication stamped `now() = T0` that
--     commits at T0+5s is invisible to a handler running at T0+2 and visible
--     at T0+6. `#43b-1` made the stamp exactly the transaction clock so that
--     window is as narrow as PostgreSQL can make it; this table closes it
--     entirely, because the answer is written once and never recomputed.
--   * *Snapshot at collection rather than at order creation* would let a rate
--     published between booking and capture reach a booking the seller had
--     already accepted.
--
-- ## `absent` is a row, not a missing row
--
-- Every new order writes all three components. `absent` means no rule was
-- active; `zero` means an administrator published "charge nothing". `#43c`
-- must be able to tell those apart when it explains why an order was never
-- charged, and a reader cannot distinguish them from an empty result.
--
-- The one case with no rows at all is an order created BEFORE this migration.
-- ADR-052 §2 fixes its reading: every reader treats a missing row as `absent`.
-- No backfill runs here — a backfilled row would assert that the platform
-- resolved a rule for an order at a moment when it could not have.
--
-- ## Append-only, by trigger
--
-- A snapshot that could be updated is not a snapshot. `tg_oct_append_only`
-- refuses UPDATE and DELETE outright: a correction is `#43c`'s reconciliation
-- exception, never a rewrite of what bound the order.
--
-- ## ADR-027
--
-- `commerce.order_commission_terms` is claimed `retained` by Commerce's own
-- contract. It carries no `*_user_id` column — the order does — and it is the
-- commercial record of what a seller's order was charged under, which must
-- survive an erasure for the same reason `commerce.orders` does.
-- ---------------------------------------------------------------------------

CREATE TABLE commerce.order_commission_terms (
    /*
     * No surrogate key: `(order_id, component)` IS the identity, and a second
     * row for one component of one order is the exact mistake the primary key
     * has to make unrepresentable.
     *
     * No FOREIGN KEY to `commerce.orders`, matching `order_outcome_terms`
     * beside it: the write happens in the same transaction as the order's own
     * INSERT, so the reference cannot dangle, and a constraint here would add
     * a lock on the orders row that the checkout path does not need.
     */
    order_id UUID NOT NULL,
    component VARCHAR(32) NOT NULL,

    /*
     * `absent` — no active rule for this component at commitment.
     * `zero`   — an administrator published "charge nothing".
     * `rule`   — a rate, an amount or both, copied below.
     */
    state VARCHAR(16) NOT NULL,

    /*
     * WHICH published version bound the order. Present exactly for `zero` and
     * `rule`: a `zero` is a published decision and must be traceable to the
     * version that made it, while an `absent` names nothing because nothing
     * was published.
     */
    policy_key VARCHAR(64),
    policy_version INTEGER,

    /*
     * The rule itself, copied by value from
     * `commercial.commission_policy_versions`. The same four shapes, and the
     * same CHECK matrix, because a snapshot that could hold a shape the
     * publisher cannot publish would be unreadable by the engine.
     */
    rule_kind VARCHAR(16),
    bp INTEGER,
    fixed_toman BIGINT,
    base VARCHAR(32),

    /*
     * Which arithmetic was understood to apply when this order committed.
     * Copied from the version, so a later correction to the engine cannot
     * silently re-price an order that already exists.
     */
    arithmetic_version INTEGER,

    /*
     * The transaction instant, from the database. Equal for all three rows of
     * one order, because they are written in one statement in one transaction.
     */
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (order_id, component),

    CONSTRAINT ck_oct_component CHECK (
        component IN ('booking_commission', 'acquisition', 'processing_recovery')
    ),
    CONSTRAINT ck_oct_state CHECK (state IN ('absent', 'zero', 'rule')),
    CONSTRAINT ck_oct_base CHECK (base IS NULL OR base IN ('platform_collected_amount', 'service_total')),
    CONSTRAINT ck_oct_bp_range CHECK (bp IS NULL OR (bp >= 0 AND bp <= 10000)),
    CONSTRAINT ck_oct_fixed_nonnegative CHECK (fixed_toman IS NULL OR fixed_toman >= 0),
    CONSTRAINT ck_oct_arithmetic_version CHECK (arithmetic_version IS NULL OR arithmetic_version >= 1),

    /*
     * THE STATE MATRIX. An `absent` row carries nothing at all; a `zero` row
     * names its version and carries no rule fields; a `rule` row names its
     * version and carries exactly the fields its shape requires.
     *
     * Written as one CHECK for the reason `ck_cpv_shape` is: the states are
     * exhaustive and mutually exclusive, so a future state has to be added
     * here deliberately rather than slipping in as an unconstrained
     * combination.
     */
    CONSTRAINT ck_oct_state_shape CHECK (
        (state = 'absent'
             AND policy_key IS NULL AND policy_version IS NULL
             AND rule_kind IS NULL AND bp IS NULL AND fixed_toman IS NULL AND base IS NULL
             AND arithmetic_version IS NULL)
        OR (state = 'zero'
             AND policy_key IS NOT NULL AND policy_version IS NOT NULL
             AND rule_kind = 'zero'
             AND bp IS NULL AND fixed_toman IS NULL AND base IS NULL
             AND arithmetic_version IS NOT NULL)
        OR (state = 'rule'
             AND policy_key IS NOT NULL AND policy_version IS NOT NULL
             AND arithmetic_version IS NOT NULL
             AND (
                    (rule_kind = 'percentage' AND bp IS NOT NULL AND base IS NOT NULL AND fixed_toman IS NULL)
                 OR (rule_kind = 'fixed' AND fixed_toman IS NOT NULL AND fixed_toman > 0 AND bp IS NULL AND base IS NULL)
                 OR (rule_kind = 'hybrid' AND bp IS NOT NULL AND base IS NOT NULL AND fixed_toman IS NOT NULL)
             ))
    )
);

/*
 * `#43c` reads one order's three rows at recognition; the primary key already
 * covers that. This index serves the reconciliation direction instead — "which
 * orders did this published version bind?" — which is how an administrator
 * answers a question about a rate they published, and how `#43c`'s exception
 * sink finds the affected orders.
 */
CREATE INDEX ix_oct_policy ON commerce.order_commission_terms (policy_key, policy_version)
    WHERE policy_key IS NOT NULL;

-- ==========================================================================
-- Append-only
-- ==========================================================================
--
-- No UPDATE and no DELETE, for anybody. The snapshot's whole value is that it
-- says what bound the order at commitment; a row that can be edited afterwards
-- says only what somebody last wanted it to say.
--
-- A trigger rather than a grant, because `commerce` is application-owned: the
-- role that writes the row is the role that would rewrite it, so a privilege
-- cannot separate them. `financial`'s append-only guarantee rests on role
-- ownership (ADR-017); this one cannot, and says so.

CREATE OR REPLACE FUNCTION commerce.reject_order_commission_terms_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'commerce.order_commission_terms is append-only: what bound order % at commitment cannot be rewritten', OLD.order_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RAISE EXCEPTION 'commerce.order_commission_terms is append-only: the snapshot for order % cannot be deleted', OLD.order_id
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_oct_append_only
    BEFORE UPDATE OR DELETE ON commerce.order_commission_terms
    FOR EACH ROW
    EXECUTE FUNCTION commerce.reject_order_commission_terms_rewrite();

-- ---------------------------------------------------------------------------
-- No backfill, and this comment is the record of it.
--
-- Every order that predates this migration has no rows here, and ADR-052 §2
-- fixes the reading: a reader treats the absence as `absent`. Writing rows for
-- those orders would be the platform asserting that it resolved a rule at a
-- moment when no rule existed to resolve — a fact manufactured to make a table
-- look complete. The legacy disposition ADR-052's "Open gates" names is where
-- that question is answered, by a recorded decision, before any real-money
-- rollout.
-- ---------------------------------------------------------------------------
