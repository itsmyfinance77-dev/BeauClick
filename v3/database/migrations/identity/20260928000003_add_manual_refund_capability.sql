-- ---------------------------------------------------------------------------
-- DEMO BRANCH ONLY — F-10: authority to claim and record the manual execution of
-- a refund (payment.manual_refund_executions). Privileged (money), administrator
-- only; every mutation it gates writes an admin audit row.
-- ---------------------------------------------------------------------------

INSERT INTO identity.capabilities (slug, description, is_privileged) VALUES
    ('bc_execute_manual_refunds', 'ثبت اجرای دستی بازپرداخت‌ها (دمو، شبیه‌سازی‌شده)', true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES
    ('administrator', 'bc_execute_manual_refunds')
ON CONFLICT DO NOTHING;
