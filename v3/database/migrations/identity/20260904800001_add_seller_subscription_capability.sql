-- V3.3-A Story #69 (`#56b`). The one capability the seller subscription
-- surface needs (`V33-DEC-019`).
--
-- ## `bc_manage_own_subscription`
--
-- Authority to change the holder's OWN commercial terms: selecting a published
-- plan version for a workspace they own, or cancelling it back to the base
-- workspace.
--
-- NOT PRIVILEGED, and that is a decision rather than an omission. `V33-DEC-019`
-- rules it explicitly, and the application correspondingly does NOT add it to
-- `PRIVILEGED_CAPABILITIES`. Two things therefore do not apply to it, and both
-- are worth naming because the three capabilities added before this one all had
-- them:
--
--   * there is no live revocation re-check on each request. The capability is
--     baked into the access token at issue time, so a revoked grant takes
--     effect when the next token is issued — up to the access-token TTL later.
--     That window is unremarkable here: the worst case is a seller changing
--     their own plan slightly after their own authority was withdrawn, which
--     affects nobody else's data and no other party's terms;
--   * `libs/audit`'s refusal to BOOT when a mutation gated on it declares no
--     audit action does not fire. The audit rows are written anyway, by
--     `SellerSubscriptionService`, inside the same transaction as the
--     subscription and the grant — a stronger guarantee than the decorator,
--     because the record cannot be missing unless the change is missing too.
--
-- ## Granted to `professional` and `business`, and to nothing else
--
-- `V33-DEC-018` gives each owned PARTY its own subscription, and both party
-- types are seller workspaces, so both roles carry it. A user owning both holds
-- it once and acts on two workspaces, each named explicitly.
--
-- Deliberately NOT granted to `customer`: a customer has no seller workspace,
-- so the capability would gate an action with nothing to act on.
--
-- Deliberately NOT granted to `administrator` or `platform_operator` either,
-- and that is the more interesting half. This is not an administrative power to
-- be held over other people — there is no administrator route to another
-- seller's subscription in this story, and granting a platform role a
-- capability whose only meaning is "my own" would suggest one exists.
--
-- ## Holding it is necessary and never sufficient
--
-- It gates the ACTION and says nothing about WHICH workspace. That is decided
-- per request by the ownership resolver, which resolves ownership alone and
-- deliberately does not follow staff affiliation (ADR-042 §3) — so a staff
-- member who somehow held this capability would still enumerate no owned party
-- and find nothing to act on. Ownership is what protects an employer's
-- subscription; this is a second lock on a door that is already shut.
--
-- ## Not a widening of anything
--
-- No existing capability is extended and no existing grant changes. The three
-- rows below are additive, and `ON CONFLICT DO NOTHING` makes re-running this
-- migration a no-op — which the idempotency gate asserts.

INSERT INTO identity.capabilities (slug, description, is_privileged) VALUES
    ('bc_manage_own_subscription', 'انتخاب یا لغو طرح اشتراک کسب‌وکار خودتان', false)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES
    ('professional', 'bc_manage_own_subscription'),
    ('business',     'bc_manage_own_subscription')
ON CONFLICT DO NOTHING;
