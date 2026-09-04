-- ---------------------------------------------------------------------------
-- V3.3 Bug #75 (`V33-DEC-021` Ruling 7). The existing-owner backfill.
--
-- Story #69 enforces `bc_manage_own_subscription` on three mounted production
-- routes while account creation grants only `customer`, so every seller was
-- refused `403` and never received the base `D-7` workspace. The application
-- now grants `professional` and `business` atomically with ownership creation.
-- This migration is the other half of that pair, and it exists for the same
-- reason ADR-042 §4's `D-7` backfill does: a creation-time trigger cannot reach
-- sellers who already exist.
--
-- Both halves converge on the SAME arbiter -- `identity.user_roles`'s primary
-- key `(user_id, role_slug)` -- so neither is the "real" one and a race between
-- them resolves to exactly one row.
--
-- ## Ownership, and nothing else
--
-- `provider.professionals.owner_id` and `business.businesses.owner_id`, both
-- filtered on `deleted_at IS NULL`. That is the identical predicate
-- `OwnershipBackedSubscriberPartyResolver` already uses, deliberately: a second
-- definition of "which parties does this user own" would be a second answer to
-- a question `V33-DEC-020` and `V33-DEC-021` both require to have exactly one.
--
-- `verification_status` is NOT consulted. `V33-DEC-021` Ruling 2 makes ownership
-- the trigger, and ADR-042 §4 had already ruled that an unverified professional
-- is a seller whose identity is unconfirmed, not a seller without commercial
-- terms. No `suspended` or `revoked` filter is invented either: those values
-- exist in `VALID_TRANSITIONS` but no route or service reaches them, and Ruling
-- 7 forbids giving an unreachable state speculative behaviour here.
--
-- `business.business_staff` is NOT queried. It does not appear anywhere in this
-- file, and a static test asserts that. An affiliation -- `manager` included --
-- confers no global role (`V33-DEC-021` Ruling 6), so a staff-only user is
-- untouched by both statements below.
--
-- ## `customer` survives
--
-- There is no DELETE, no UPDATE of `role_slug`, and no `set` anywhere. Both
-- statements are additive inserts. `bc_book_service`, `bc_use_ai_assistant` and
-- `bc_view_own_orders` belong to `customer` alone, so a backfill that replaced
-- roles rather than adding them would strip every existing seller of booking,
-- the assistant and their own order history.
--
-- ## Idempotent, and the audit follows the INSERT
--
-- `ON CONFLICT DO NOTHING` on the primary key makes a rerun a no-op: an
-- administrator-created row keeps its `granted_by`, `granted_at` and `reason`
-- untouched, and no duplicate is possible because duplication is
-- unrepresentable. The audit rows are selected FROM the CTE's `RETURNING`, so a
-- rerun that inserts nothing writes nothing -- the trail records what happened,
-- not what was attempted.
--
-- ## It fails rather than skips
--
-- If `professional` or `business` is missing from `identity.roles`, this
-- migration RAISES. A deployment whose role catalogue is incomplete must not
-- silently produce sellers the platform cannot authorize, which is the defect
-- this migration exists to end.
--
-- ## Actor label
--
-- `migration:v3.3-#75`, distinct from `#56a`'s `migration:v3.3-a`. Merging them
-- would put two different migrations' evidence in one bucket, which is the
-- opposite of what Ruling 7 asks for. `actor_user_id` is NULL and
-- `ck_admin_audit_actor` enforces the pairing, so an automatic grant is
-- structurally distinguishable from a human one and no human actor is
-- fabricated. Every reason is a fixed server-owned string; no user prose reaches
-- this table.
-- ---------------------------------------------------------------------------

DO $backfill$
DECLARE
    professional_granted INTEGER;
    business_granted     INTEGER;
BEGIN
    -- The role catalogue is a precondition, not something to work around.
    IF NOT EXISTS (SELECT 1 FROM identity.roles WHERE slug = 'professional') THEN
        RAISE EXCEPTION 'identity.roles is missing the professional role; the #75 backfill cannot run';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.roles WHERE slug = 'business') THEN
        RAISE EXCEPTION 'identity.roles is missing the business role; the #75 backfill cannot run';
    END IF;

    -- -----------------------------------------------------------------------
    -- Professional owners.
    --
    -- The join to identity.users is not decoration: `user_roles.user_id` is a
    -- real FK, and an owner row whose user has been hard-deleted would abort the
    -- whole migration rather than be skipped. `deleted_at IS NULL` on the user
    -- additionally excludes an erased account -- erasure anonymizes the user row
    -- in place and deletes its role grants, so re-granting one here would undo
    -- part of an erasure that already completed.
    -- -----------------------------------------------------------------------
    WITH inserted AS (
        INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason)
        SELECT DISTINCT p.owner_id, 'professional', NULL::uuid,
               'professional role granted by migration backfill from existing ownership'
          FROM provider.professionals p
          JOIN identity.users u ON u.id = p.owner_id AND u.deleted_at IS NULL
         WHERE p.deleted_at IS NULL
        ON CONFLICT (user_id, role_slug) DO NOTHING
        RETURNING user_id
    ), audited AS (
        INSERT INTO admin.admin_audit_log (
            id, actor_user_id, actor_label, action, target_type, target_id,
            after_state, reason
        )
        SELECT gen_random_uuid(), NULL, 'migration:v3.3-#75',
               'identity.professional_owner_role_granted', 'identity.user_role',
               i.user_id::text,
               jsonb_build_object('role', 'professional'),
               'professional role granted by migration backfill from existing ownership'
          FROM inserted i
        RETURNING id
    )
    SELECT count(*) INTO professional_granted FROM inserted;

    -- -----------------------------------------------------------------------
    -- Business owners. The same shape, the same predicate, and deliberately a
    -- SEPARATE statement rather than a CASE: neither knows about the other, so a
    -- dual owner receives both rows without either statement having to be aware
    -- that dual ownership exists (`V33-DEC-021` Ruling 4).
    -- -----------------------------------------------------------------------
    WITH inserted AS (
        INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason)
        SELECT DISTINCT b.owner_id, 'business', NULL::uuid,
               'business role granted by migration backfill from existing ownership'
          FROM business.businesses b
          JOIN identity.users u ON u.id = b.owner_id AND u.deleted_at IS NULL
         WHERE b.deleted_at IS NULL
        ON CONFLICT (user_id, role_slug) DO NOTHING
        RETURNING user_id
    ), audited AS (
        INSERT INTO admin.admin_audit_log (
            id, actor_user_id, actor_label, action, target_type, target_id,
            after_state, reason
        )
        SELECT gen_random_uuid(), NULL, 'migration:v3.3-#75',
               'identity.business_owner_role_granted', 'identity.user_role',
               i.user_id::text,
               jsonb_build_object('role', 'business'),
               'business role granted by migration backfill from existing ownership'
          FROM inserted i
        RETURNING id
    )
    SELECT count(*) INTO business_granted FROM inserted;

    -- -----------------------------------------------------------------------
    -- The denormalized column, kept in sync during the expand window (ADR-016).
    --
    -- Recomputed FROM `identity.user_roles` rather than appended to, and only
    -- for users this migration actually touched. Nothing reads it any more, but
    -- leaving it disagreeing with the authority is how the next author reads the
    -- wrong one.
    -- -----------------------------------------------------------------------
    UPDATE identity.users u
       SET roles = COALESCE(r.slugs, ARRAY[]::text[])
      FROM (
        -- `identity.users.roles` is `text[]` while `user_roles.role_slug` is
        -- `varchar(40)`, so `array_agg` alone yields `varchar[]` and the
        -- comparison below is a type error rather than a no-op. The explicit
        -- `::text` is what makes both sides the same array type.
        SELECT ur.user_id, array_agg(ur.role_slug::text ORDER BY ur.role_slug) AS slugs
          FROM identity.user_roles ur
         GROUP BY ur.user_id
      ) r
     WHERE r.user_id = u.id
       AND u.deleted_at IS NULL
       AND u.roles IS DISTINCT FROM r.slugs
       AND EXISTS (
         SELECT 1 FROM provider.professionals p WHERE p.owner_id = u.id AND p.deleted_at IS NULL
         UNION ALL
         SELECT 1 FROM business.businesses b WHERE b.owner_id = u.id AND b.deleted_at IS NULL
       );

    RAISE NOTICE '#75 backfill: % professional owner role(s), % business owner role(s)',
        professional_granted, business_granted;
END
$backfill$;
