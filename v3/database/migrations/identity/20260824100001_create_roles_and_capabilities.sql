-- ---------------------------------------------------------------------------
-- Dynamic roles and capabilities (R31-01).
--
-- Phase 1 deliberately kept the role -> capability MAPPING in code
-- (`services/identity/src/rbac/capabilities.ts`) rather than building these
-- tables, and said so honestly. What no document recorded until the V3.1
-- reconciliation is the CONSEQUENCE: `AccountResolverService` writes
-- `roles: ['customer']` at account creation and **no code path anywhere ever
-- writes that column again**. Every privileged capability was therefore
-- ungrantable, and all five `/v1/admin/*` surfaces -- settlement, settlement
-- reversal, search reindex, notification retry, loyalty policy -- were
-- unreachable by any account the application could produce.
--
-- This migration makes the assignment real. It does NOT change how any
-- authorization check works: every guard still checks a capability NAME, never
-- a role string, exactly as the Phase 1 docblock promised ("upgrading to
-- dynamic roles/capabilities later changes only where this map's data comes
-- from, not how any guard/controller checks it").
--
-- EXPAND, not contract (ADR-016). `identity.users.roles` is left in place and
-- kept in sync during this window; a later migration may drop it once nothing
-- reads it. Removing a column in the same migration that introduces its
-- replacement is exactly the deploy-ordering hazard the discipline exists to
-- avoid.
-- ---------------------------------------------------------------------------

CREATE TABLE identity.capabilities (
    slug VARCHAR(60) PRIMARY KEY,
    description TEXT NOT NULL,
    -- A capability that grants authority over OTHER people's data or the
    -- platform itself. Read by the privileged re-check path: these are the
    -- capabilities whose revocation must take effect immediately rather than
    -- at the next token issuance.
    is_privileged BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE identity.roles (
    slug VARCHAR(40) PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    description TEXT NOT NULL,
    -- A role nobody may grant through the ordinary application flow. Enforced
    -- in code by RoleService, and recorded here so the DATA says which roles
    -- are dangerous rather than only a constant in a TypeScript file.
    is_privileged BOOLEAN NOT NULL DEFAULT false,
    -- The single role every new account receives. Exactly one row may be true;
    -- see the unique index below.
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_roles_single_default ON identity.roles (is_default) WHERE is_default;

CREATE TABLE identity.role_capabilities (
    role_slug VARCHAR(40) NOT NULL REFERENCES identity.roles (slug) ON DELETE CASCADE,
    capability_slug VARCHAR(60) NOT NULL REFERENCES identity.capabilities (slug) ON DELETE CASCADE,
    PRIMARY KEY (role_slug, capability_slug)
);

-- ---------------------------------------------------------------------------
-- The assignment table. This is what did not exist.
--
-- `granted_by` is NULLABLE for exactly two cases and no others: the automatic
-- `customer` grant at account creation (no human actor), and the documented
-- one-time bootstrap of the first platform operator (no privileged account
-- exists yet to be the actor). Every other row records a real granting user.
-- ---------------------------------------------------------------------------
CREATE TABLE identity.user_roles (
    user_id UUID NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
    role_slug VARCHAR(40) NOT NULL REFERENCES identity.roles (slug),
    granted_by UUID REFERENCES identity.users (id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason TEXT,
    PRIMARY KEY (user_id, role_slug)
);

CREATE INDEX ix_user_roles_role ON identity.user_roles (role_slug);

-- ---------------------------------------------------------------------------
-- Seed.
--
-- The values below are the EXACT contents of `CAPABILITIES_BY_ROLE` at the
-- time of this migration. That constant does not disappear -- it becomes the
-- seed's own source, and `rbac/capabilities.spec.ts` asserts the two agree, so
-- a capability added to one and forgotten in the other fails a test rather
-- than silently diverging into two authorization systems.
-- ---------------------------------------------------------------------------

INSERT INTO identity.capabilities (slug, description, is_privileged) VALUES
    ('bc_book_service',            'رزرو خدمت', false),
    ('bc_use_ai_assistant',        'استفاده از دستیار هوشمند', false),
    ('bc_view_own_orders',         'مشاهده سفارش‌های خود', false),
    ('bc_manage_own_profile',      'مدیریت پروفایل خود', false),
    ('bc_manage_own_services',     'مدیریت خدمات خود', false),
    ('bc_view_own_bookings',       'مشاهده رزروهای خود', false),
    ('bc_manage_own_availability', 'مدیریت زمان‌های آزاد خود', false),
    ('bc_view_own_finance',        'مشاهده اطلاعات مالی خود', false),
    ('bc_manage_business_staff',   'مدیریت کارکنان کسب‌وکار', false),
    ('bc_moderate_verification',   'بررسی و تأیید احراز هویت متخصص‌ها', true),
    ('bc_moderate_reviews',        'بررسی و مدیریت دیدگاه‌ها', true),
    ('bc_manage_platform',         'مدیریت پلتفرم', true);

INSERT INTO identity.roles (slug, name, description, is_privileged, is_default) VALUES
    ('customer',          'مشتری',            'حساب پیش‌فرض هر کاربر تازه‌ثبت‌نام‌شده.', false, true),
    ('professional',      'متخصص',            'ارائه‌دهنده خدمت. در V3 با مالکیت ردیف پروفایل تعیین می‌شود، نه با این نقش.', false, false),
    ('business',          'کسب‌وکار',         'مالک کسب‌وکار. در V3 با مالکیت ردیف کسب‌وکار تعیین می‌شود، نه با این نقش.', false, false),
    ('moderator',         'ناظر محتوا',       'بررسی احراز هویت و دیدگاه‌ها. بدون دسترسی به تنظیمات پلتفرم.', true, false),
    ('platform_operator', 'اپراتور پلتفرم',   'کمترین سطح دسترسی عملیاتی: مدیریت پلتفرم و بررسی احراز هویت.', true, false),
    ('administrator',     'مدیر ارشد',        'دسترسی کامل. از مسیر عادی برنامه قابل اعطا نیست.', true, false);

INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES
    ('customer', 'bc_book_service'),
    ('customer', 'bc_use_ai_assistant'),
    ('customer', 'bc_view_own_orders'),

    ('professional', 'bc_manage_own_profile'),
    ('professional', 'bc_manage_own_services'),
    ('professional', 'bc_view_own_bookings'),
    ('professional', 'bc_manage_own_availability'),
    ('professional', 'bc_view_own_finance'),

    ('business', 'bc_manage_own_profile'),
    ('business', 'bc_manage_own_services'),
    ('business', 'bc_view_own_bookings'),
    ('business', 'bc_manage_business_staff'),
    ('business', 'bc_manage_own_availability'),
    ('business', 'bc_view_own_finance'),

    ('moderator', 'bc_moderate_verification'),
    ('moderator', 'bc_moderate_reviews'),

    -- platform_operator gains `bc_moderate_verification` here, which the Phase 1
    -- static map did not give it.
    --
    -- Stated as a deliberate widening rather than slipped in: Phase A's own
    -- brief requires that a platform operator can decide a verification, and
    -- the alternative -- granting the bootstrap account BOTH platform_operator
    -- and moderator -- would mean the first privileged account also holds
    -- `bc_moderate_reviews`, authority over a domain that does not exist yet.
    -- Verification review IS the operational tier's work; review moderation is
    -- not. This is the narrower of the two options, which is what
    -- V3_SECURITY_MODEL.md §9 asks for.
    ('platform_operator', 'bc_manage_platform'),
    ('platform_operator', 'bc_moderate_verification'),

    ('administrator', 'bc_manage_platform'),
    ('administrator', 'bc_moderate_verification'),
    ('administrator', 'bc_moderate_reviews'),
    ('administrator', 'bc_manage_own_profile');

-- ---------------------------------------------------------------------------
-- Backfill. Every existing account keeps exactly the roles its `roles` column
-- already claims, so this migration changes nobody's authorization.
--
-- `granted_by` is NULL: these grants predate the concept of a granting actor.
-- ---------------------------------------------------------------------------
INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason)
SELECT u.id, r.slug, NULL, 'backfill from identity.users.roles'
FROM identity.users u
CROSS JOIN LATERAL unnest(u.roles) AS existing(role_slug)
JOIN identity.roles r ON r.slug = existing.role_slug
ON CONFLICT DO NOTHING;
