import Link from 'next/link';
import styles from './site-footer.module.css';

/**
 * The customer platform's footer — `Prototype - Customer.dc.html` §01.
 *
 * ## Every link here goes somewhere that exists
 *
 * The prototype's footer is drawn with `href="#"` throughout, as prototypes
 * are. Turning those into real destinations is an implementation decision,
 * and the rule applied is: a column entry ships only when its route is built.
 * «درباره ما», «قوانین و مقررات», «حریم خصوصی» and «پشتیبانی» have no routes
 * in `app/`, so the «بیوکلیک» column is not rendered at all rather than
 * rendered with four links that lead nowhere. A dead link in a footer is a
 * small lie, and it is the kind that survives to production.
 *
 * Recorded as a gap rather than improvised: the legal and support pages are
 * `33_FOOTER_LEGAL.md`, which is designed and not built.
 */

const CUSTOMER_LINKS = [
  { href: '/search', label: 'جست‌وجوی متخصص' },
  { href: '/bookings', label: 'رزروهای من' },
  { href: '/loyalty', label: 'باشگاه مشتریان' },
  { href: '/journey', label: 'مسیر زیبایی من' },
];

const PROFESSIONAL_LINKS = [
  { href: '/pro', label: 'ثبت‌نام متخصص' },
  { href: '/pro/profile', label: 'احراز هویت' },
  { href: '/business', label: 'ثبت کسب‌وکار' },
];

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.columns}>
          <div>
            <div className={styles.brandRow}>
              <span className={styles.brandDot} aria-hidden="true" />
              <span className={styles.brandName}>BeauClick</span>
            </div>
            <p className={styles.blurb}>
              مارکت‌پلیس خدمات زیبایی. رزرو آنلاین از متخصص‌های تأییدشده، با قیمت شفاف و زمان واقعی.
            </p>
          </div>

          <nav className={styles.column} aria-label="پیوندهای مشتریان">
            <div className={styles.columnTitle}>مشتری‌ها</div>
            {CUSTOMER_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className={styles.link}>
                {link.label}
              </Link>
            ))}
          </nav>

          <nav className={styles.column} aria-label="پیوندهای متخصص‌ها">
            <div className={styles.columnTitle}>متخصص‌ها</div>
            {PROFESSIONAL_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className={styles.link}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className={styles.legal}>
          <span>© ۱۴۰۴ بیوکلیک. تمام حقوق محفوظ است.</span>
          <span>ساخته شده در یزد</span>
        </div>
      </div>
    </footer>
  );
}
