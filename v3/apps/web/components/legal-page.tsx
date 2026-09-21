import type { ReactNode } from 'react';
import { formatFullJalaliDate } from '@beauclick/persian-utils';
import { Alert, Card } from './ui';
import { PageHeader } from './kit';
import styles from './legal-page.module.css';

/**
 * The one template behind `/terms`, `/privacy-policy`, `/contact` and
 * `/support` -- `33_FOOTER_LEGAL.md`.
 *
 * ## What this file does not contain, on purpose
 *
 * Any legal wording, any contact detail, and any section heading. The spec is
 * explicit that the final text and the contact information are business
 * decisions and that a sample would be mistaken for the real thing, which is
 * worse than nothing. So every page ships with the labelled placeholder below
 * and no headings: a heading list is itself a table of contents for a
 * document nobody has written.
 *
 * When the text is approved, a page passes `sections` and the table of
 * contents, the h2/h3 hierarchy and the reading width already exist -- "only
 * the body inside the placeholder is replaced; the template and navigation do
 * not change", as the spec puts it. `contact` and `support` do the same with
 * `contactDetails`.
 *
 * A server component: the content is static, and this lets each route export
 * its own `metadata`.
 */

/** The wording `33_FOOTER_LEGAL.md` gives, verbatim. A test pins it. */
export const LEGAL_PLACEHOLDER = '[محتوایِ این بخش در انتظارِ تأییدِ مالکِ کسب‌وکار است — BUSINESS DECISION REQUIRED]';

export interface LegalSubsection {
  id: string;
  heading: string;
  body: ReactNode;
}

export interface LegalSection {
  id: string;
  heading: string;
  body: ReactNode;
  subsections?: LegalSubsection[];
}

export interface LegalPageProps {
  title: string;
  /** When the approved text was last changed. Absent while the page is a placeholder: there is no text to have been updated. */
  updatedAt?: Date | string;
  /** Approved content. Omitted while the page is a placeholder. */
  sections?: LegalSection[];
  /** Renders the contact block above the body (`/contact`, `/support`). */
  withContactBlock?: boolean;
  /** Approved contact details for that block. Omitted while they are a placeholder. */
  contactDetails?: ReactNode;
}

function Placeholder() {
  return <Alert tone="info">{LEGAL_PLACEHOLDER}</Alert>;
}

export function LegalPage({ title, updatedAt, sections = [], withContactBlock = false, contactDetails }: LegalPageProps) {
  const updated = updatedAt === undefined ? null : new Date(updatedAt);
  const hasToc = sections.length > 0;

  return (
    <div className={styles.page}>
      <PageHeader title={title} />

      {updated && !Number.isNaN(updated.getTime()) ? (
        <p className={styles.updated}>
          آخرین به‌روزرسانی: <time dateTime={updated.toISOString()}>{formatFullJalaliDate(updated)}</time>
        </p>
      ) : null}

      {withContactBlock ? (
        <div className={styles.contact}>
          <Card>
            <h2 className={styles.contactTitle}>اطلاعات تماس</h2>
            {contactDetails ?? <p className={styles.contactBody}>{LEGAL_PLACEHOLDER}</p>}
          </Card>
        </div>
      ) : null}

      <div className={hasToc ? `${styles.layout} ${styles.layoutWithToc}` : styles.layout}>
        {hasToc ? (
          <nav className={styles.toc} aria-label="فهرست محتوا">
            <ol className={styles.tocList}>
              {sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className={`${styles.tocLink} bc-tap`}>
                    {section.heading}
                  </a>
                  {section.subsections && section.subsections.length > 0 ? (
                    <ol className={styles.tocSubList}>
                      {section.subsections.map((sub) => (
                        <li key={sub.id}>
                          <a href={`#${sub.id}`} className={`${styles.tocLink} bc-tap`}>
                            {sub.heading}
                          </a>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        <div className={styles.body}>
          {hasToc ? (
            sections.map((section) => (
              <section key={section.id} aria-labelledby={section.id} className={styles.section}>
                <h2 id={section.id} className={styles.h2}>
                  {section.heading}
                </h2>
                {section.body}
                {(section.subsections ?? []).map((sub) => (
                  <div key={sub.id} className={styles.subsection}>
                    <h3 id={sub.id} className={styles.h3}>
                      {sub.heading}
                    </h3>
                    {sub.body}
                  </div>
                ))}
              </section>
            ))
          ) : (
            <Placeholder />
          )}
        </div>
      </div>
    </div>
  );
}
