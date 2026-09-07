-- ---------------------------------------------------------------------------
-- V3.3 Story #115 (`#41d-2b`) — the schedule may reference a policy WITHOUT
-- recording customer acceptance (ADR-048 §2, `V33-DEC-031`).
--
-- ## The defect this corrects
--
-- `ck_ops_policy_reference`, as shipped by `20260905900001`, is all three or
-- none: `policy_key`, `policy_version` AND `policy_accepted_at`. That was right
-- while nothing selected a policy, because "partially referenced" was
-- unrepresentable and every row was NULL anyway.
--
-- It becomes wrong the moment an enrolled seller's order resolves a policy.
-- #115 snapshots the KEY and the VERSION that priced the booking; it records no
-- acceptance, because customer acceptance is #42's, after Legal. Under the old
-- CHECK that row is unwritable, so the constraint would force this story either
-- to fabricate an acceptance instant nobody gave — putting a consent record on
-- a receipt that never had one — or to drop the policy reference and lose the
-- audit trail the whole feature exists to create.
--
-- ADR-048 §2 ratifies the third option, which is the only honest one: the two
-- facts are independent, so the constraint must say so.
--
-- ## What replaces it
--
--   * key and version remain ALL-OR-NONE. A version without a key names
--     nothing; a key without a version cannot be resolved back to terms, and
--     `V33-DEC-029` Ruling 6 binds an order to an exact version rather than to
--     whatever the key means later.
--   * `policy_version` stays positive when present — unchanged, and still
--     enforced separately by `ck_ops_policy_version_positive`, which this
--     migration does not touch. The predicate is repeated inside the new CHECK
--     so the constraint is self-contained and a future edit to either one
--     cannot silently widen the pair.
--   * `policy_accepted_at` becomes INDEPENDENTLY NULLABLE. It is no longer
--     mentioned by this constraint at all.
--
-- Acceptance is therefore permitted to arrive later, next to a key and version
-- that are already there — which is exactly the shape #42 will need, and which
-- this story deliberately does not populate.
--
-- ## What this migration does NOT do
--
-- **It updates no row.** There is no `UPDATE`, no `INSERT`, no `DELETE` and no
-- table rewrite. `DROP CONSTRAINT` and `ADD CONSTRAINT` alter the catalogue,
-- and the validation scan that `ADD CONSTRAINT` runs reads rows without writing
-- them, so every existing row keeps its bytes and its `xmin`. The #115 suite
-- proves that with a row-hash multiset and an `xmin` comparison taken before
-- and after, rather than asserting it here.
--
-- The new predicate is strictly WEAKER than the old one — every triple the old
-- CHECK admitted (all three NULL, or all three present) still satisfies it — so
-- the validation scan cannot fail on existing data. That is why this is safe
-- without a `NOT VALID` / `VALIDATE CONSTRAINT` split.
--
-- **It leaves every other invariant exactly as it found it**: `ck_ops_sum`,
-- `ck_ops_mode_consistent`, `ck_ops_policy_version_positive`,
-- `ck_ops_contract_version`, the one-row-per-order primary key, and
-- `tg_order_payment_schedules_immutable`. A schedule is still immutable; this
-- changes which schedules may be WRITTEN, never whether a written one may
-- change.
-- ---------------------------------------------------------------------------

ALTER TABLE commerce.order_payment_schedules
    DROP CONSTRAINT ck_ops_policy_reference;

ALTER TABLE commerce.order_payment_schedules
    ADD CONSTRAINT ck_ops_policy_reference CHECK (
        (policy_key IS NULL AND policy_version IS NULL)
        OR (policy_key IS NOT NULL AND policy_version IS NOT NULL AND policy_version >= 1)
    );

COMMENT ON CONSTRAINT ck_ops_policy_reference ON commerce.order_payment_schedules IS
    'Key and version are all-or-none and the version is positive when present (V3.3 #115). policy_accepted_at is independently nullable: #115 snapshots which policy priced the booking, and #42 records customer acceptance later, after Legal.';

COMMENT ON COLUMN commerce.order_payment_schedules.policy_accepted_at IS
    'Customer acceptance of the policy. Deliberately NULL for every row: neither #104 (assignment) nor #115 (order resolution) records acceptance. #42 owns it, after Legal.';
