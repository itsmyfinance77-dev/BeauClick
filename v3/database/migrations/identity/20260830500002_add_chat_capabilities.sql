-- V3.2-B. The two capabilities internal chat needs.
--
-- Both are NEW. V2's `bc_send_message` and `bc_view_all_conversations` exist
-- nowhere in the V3 workspace, so nothing is being widened here -- which is the
-- safer starting point, and it is why the moderation capability can be scoped
-- correctly from the first day rather than inherited already too broad.
--
-- ## `bc_use_chat`
--
-- Granted to `customer` and `professional`. Both sides of a conversation need
-- it: `V32-DEC-011` lets either legitimate participant initiate, and a
-- professional replying to their own customer is the ordinary case.
--
-- It is NOT granted to `business`. Business-side access is not a role question
-- at all -- it is membership, evaluated per request against
-- `business.business_staff` (owner or an ACTIVE manager). A role grant would be
-- the wrong shape: it would say "anyone holding the business role may use chat"
-- where the rule is "the owner and active managers of THIS business may read
-- THIS conversation". `ChatSellerAccessPort` answers that; a capability cannot.
--
-- Holding the capability is necessary and never sufficient. Eligibility
-- (`V32-DEC-011`) and the send window (`V32-DEC-012`) are re-evaluated inside the
-- send transaction on every message, and neither is expressible as a grant.
--
-- ## `bc_moderate_chat`
--
-- Privileged, and deliberately NOT a widening of `bc_moderate_media`: reviewing
-- a private conversation and taking down a public portfolio image are different
-- privileges, and conflating them would hand every media moderator a
-- private-message read.
--
-- Granted to `moderator` and `administrator`. **Not `platform_operator`** --
-- that tier exists precisely to be the narrower one, and reading a customer's
-- private messages is not platform operation.
--
-- The application also adds it to `PRIVILEGED_CAPABILITIES`, which confers two
-- things this row cannot: a live revocation re-check on every request, so a
-- withdrawn moderator loses the surface immediately rather than at token expiry;
-- and `libs/audit`'s refusal to BOOT when a mutation gated on it declares no
-- audit action.

INSERT INTO identity.capabilities (slug, description, is_privileged) VALUES
    ('bc_use_chat',       'گفتگو با ارائه‌دهنده خدمت', false),
    ('bc_moderate_chat',  'بررسی گفتگوهای گزارش‌شده', true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES
    ('customer',      'bc_use_chat'),
    ('professional',  'bc_use_chat'),
    ('moderator',     'bc_moderate_chat'),
    ('administrator', 'bc_moderate_chat')
ON CONFLICT DO NOTHING;
