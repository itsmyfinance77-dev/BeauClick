-- ---------------------------------------------------------------------------
-- `bc_moderate_media` (V3.1 Phase C).
--
-- A NEW capability rather than a reuse of `bc_moderate_verification`, and the
-- reasoning is the same one this schema's own seed already recorded when it
-- decided which capabilities `platform_operator` should hold:
--
--   Deciding whether a professional is who they claim to be is the
--   OPERATIONAL tier's work. Removing somebody's published work from the
--   marketplace is CONTENT MODERATION. They are different authorities over
--   different things, and folding the second into the first would hand every
--   platform operator takedown power as a side effect of being able to
--   approve a verification.
--
-- So it goes to `moderator` -- who already holds `bc_moderate_reviews` and
-- whose whole role is content -- and to `administrator`. Deliberately NOT to
-- `platform_operator`, exactly as `bc_moderate_reviews` is not, which means
-- the bootstrap operator Phase A creates cannot take a professional's
-- portfolio down. That refusal is the rule working (V3_SECURITY_MODEL.md §9),
-- not a gap.
--
-- Privileged, so it inherits both properties the privileged list carries:
-- `CapabilityGuard` re-checks it against live data on every request rather
-- than trusting a token issued up to a TTL ago, and `libs/audit`'s boot
-- assertion refuses to start the application if a mutation gated on it does
-- not declare an audit record.
--
-- Additive and idempotent: `ON CONFLICT DO NOTHING` throughout, so a re-run
-- applies nothing and an environment that somehow already has the row is not
-- an error.
-- ---------------------------------------------------------------------------

INSERT INTO identity.capabilities (slug, description, is_privileged) VALUES
    ('bc_moderate_media', 'بررسی گزارش‌ها و حذف تصاویر نامناسب', true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES
    ('moderator', 'bc_moderate_media'),
    ('administrator', 'bc_moderate_media')
ON CONFLICT DO NOTHING;
