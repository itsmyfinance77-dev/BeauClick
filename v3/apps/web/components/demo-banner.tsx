/**
 * DEMO BRANCH ONLY (`codex/demo-2026-09-28`) — never merged to master.
 *
 * A persistent, non-dismissable label on every page of the internal team demo,
 * rendered only when the build sets NEXT_PUBLIC_DEMO_LABEL=1. It states what the
 * owner required be clearly labelled: synthetic data, unapproved commercial values
 * and policy copy, and simulated external services (payment, SMS, email, AI).
 */
export const DEMO_LABEL_ENABLED = process.env.NEXT_PUBLIC_DEMO_LABEL === '1';

export function DemoBanner() {
  if (!DEMO_LABEL_ENABLED) return null;
  return (
    <div
      role="note"
      aria-label="نسخهٔ نمایشی"
      style={{
        background: '#3b1d2a',
        color: '#fff',
        fontSize: '13px',
        lineHeight: 1.6,
        padding: '6px 16px',
        textAlign: 'center',
      }}
    >
      نسخهٔ نمایشی داخلی تیم — همهٔ داده‌ها ساختگی‌اند؛ مقادیر تجاری و متن‌های سیاستی این دمو تأییدشده نیستند؛
      پرداخت، پیامک، ایمیل و دستیار هوشمند شبیه‌سازی شده‌اند و هیچ پول یا پیامی واقعاً جابه‌جا نمی‌شود.
    </div>
  );
}
