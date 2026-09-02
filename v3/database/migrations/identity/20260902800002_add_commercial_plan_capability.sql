-- V3.3-A Story #40 (`#40a`). The one capability the plan catalogue needs
-- (ADR-041 §9, `V33-DEC-009`).
--
-- ## `bc_manage_commercial_plans`
--
-- Authority to define the commercial terms sellers are billed against:
-- immutable plan versions, their entitlements, their activation windows, and
-- the price schedules and tiers behind them.
--
-- PRIVILEGED, and the application also adds it to `PRIVILEGED_CAPABILITIES`,
-- which confers two things this row cannot:
--
--   * a live revocation re-check on every request, so an administrator whose
--     authority has just been withdrawn loses the surface now rather than at
--     access-token expiry (up to fifteen minutes later);
--   * `libs/audit`'s refusal to BOOT when a mutation gated on it declares no
--     audit action -- `GAP-02`'s bug class, which V2 hit three times across two
--     plugins before the fix was made structural.
--
-- ## Granted to `administrator`, and deliberately NOT to `platform_operator`
--
-- That tier exists precisely to be the narrower one. Publishing an immutable,
-- activation-windowed commitment about what sellers pay is not routine platform
-- operation, and a capability that cannot be un-exercised -- a published version
-- can never be edited or reactivated -- is the wrong one to hand to the default
-- privileged tier.
--
-- It is the same call, for the same reason, that `bc_moderate_chat` records.
--
-- ## Not a widening of anything
--
-- `bc_manage_platform` is not extended and no existing grant changes. Holding
-- the platform-operations capability has never implied commercial authority,
-- and starting it out correctly scoped is cheaper than narrowing it later.

INSERT INTO identity.capabilities (slug, description, is_privileged) VALUES
    ('bc_manage_commercial_plans', 'تعریف طرح‌های فروشنده و جدول قیمت اعتبار نوبت', true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES
    ('administrator', 'bc_manage_commercial_plans')
ON CONFLICT DO NOTHING;
