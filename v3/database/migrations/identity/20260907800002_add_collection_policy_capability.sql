-- ---------------------------------------------------------------------------
-- V3.3 Story #104 (`#41d-2a`) — the seller's own collection-policy capability
-- (ADR-048 R2 authorization, `V33-DEC-029` Ruling 10, `V33-DEC-031` R1).
--
-- ## `bc_manage_own_collection_policy`
--
-- One capability, granted to the two seller roles and to nothing else. It says
-- "this role may choose which published collection policy governs its own
-- bookings". It does NOT say which workspace: that is decided per request by
-- live ownership through the opaque `workspaceRef`, and a caller holding this
-- capability who owns no matching party reaches nothing.
--
-- ## NOT PRIVILEGED, and that is a decision rather than an omission
--
-- `V33-DEC-029` Ruling 10 rules it explicitly, and the application
-- correspondingly does NOT add it to `PRIVILEGED_CAPABILITIES`. Two things
-- therefore do not apply to it, exactly as they do not apply to
-- `bc_manage_own_subscription`:
--
--   * there is no live revocation re-check on each request. The capability is
--     baked into the access token at issue time, so a revoked grant takes
--     effect when the next token is issued — up to the access-token TTL later.
--     That window is unremarkable here: the worst case is a seller changing
--     their OWN party's collection policy shortly after their own authority was
--     withdrawn, which affects nobody else's data and no other party's terms,
--     and which changes no order that already exists;
--   * `libs/audit`'s refusal to BOOT when a mutation gated on it declares no
--     audit action does not fire. The audit rows are written anyway, by
--     `CollectionPolicyAssignmentService`, inside the same transaction as the
--     assignment — a stronger guarantee than the decorator, because the record
--     cannot be missing unless the change is missing too.
--
-- ## Granted to `professional` and `business`, and to nothing else
--
-- `V33-DEC-029` Ruling 5 keys an assignment to a seller PARTY, and both party
-- types are seller workspaces, so both roles carry it. A user owning both holds
-- two isolated workspaces and two independent assignments.
--
-- `customer`, `administrator`, `platform_operator` and `moderator` are
-- deliberately absent: none of them owns a seller party, so the grant would
-- confer nothing while widening the apparent blast radius of a role. Staff
-- affiliation is absent for a stronger reason — `business_staff` is not a role
-- here at all, and an affiliated professional owns neither party, so the
-- ownership resolver returns them nothing regardless of any capability they
-- hold.
--
-- ## No existing capability is extended and no existing grant changes
--
-- Both statements are idempotent, so a re-run applies nothing.
-- ---------------------------------------------------------------------------

INSERT INTO identity.capabilities (slug, description, is_privileged) VALUES
    ('bc_manage_own_collection_policy', 'انتخاب سیاست دریافت وجه برای کسب‌وکار خودتان', false)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES
    ('professional', 'bc_manage_own_collection_policy'),
    ('business',     'bc_manage_own_collection_policy')
ON CONFLICT DO NOTHING;
