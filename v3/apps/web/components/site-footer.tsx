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
 * «درباره ما» has no route in `app/`, so it is left out rather than linked
 * to nothing. A dead link in a footer is a small lie, and it is the kind that
 * survives to production.
 *
 * The «بیوکلیک» column links the four pages of `33_FOOTER_LEGAL.md`. Their
 * text is not approved yet, so each publishes a labelled placeholder rather
 * than 404ing -- the spec's reason for building them ahead of the content.
 * `/privacy-policy` is the legal page; `/account/privacy` is a different,
 * signed-in page for a person's own data requests.
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

/** Also the footer's own test fixture: every route here must exist under `app/`. */
export const COMPANY_LINKS = [
  { href: '/terms', label: 'قوانین و مقررات' },
  { href: '/privacy-policy', label: 'حریم خصوصی' },
  { href: '/contact', label: 'تماس' },
  { href: '/support', label: 'پشتیبانی' },
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
              <Link key={link.href} href={link.href} className={`${styles.link} bc-tap`}>
                {link.label}
              </Link>
            ))}
          </nav>

          <nav className={styles.column} aria-label="پیوندهای متخصص‌ها">
            <div className={styles.columnTitle}>متخصص‌ها</div>
            {PROFESSIONAL_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className={`${styles.link} bc-tap`}>
                {link.label}
              </Link>
            ))}
          </nav>
          <nav className={styles.column} aria-label="پیوندهای بیوکلیک">
            <div className={styles.columnTitle}>بیوکلیک</div>
            {COMPANY_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className={`${styles.link} bc-tap`}>
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
