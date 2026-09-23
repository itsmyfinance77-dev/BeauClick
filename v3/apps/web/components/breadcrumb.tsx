import Link from 'next/link';
import { Fragment } from 'react';
import styles from './breadcrumb.module.css';

/**
 * Where this page sits — `V3_COMPONENT_INVENTORY.md`'s `Breadcrumb`.
 *
 * The last step is the page you are on and carries no `href`: a link to the
 * page you are already reading is a control that does nothing. Everything
 * before it links.
 *
 * The separators are `aria-hidden`, so a screen reader announces the trail as
 * the list of links it is rather than reading a slash between each pair. They
 * are also direct children of the flex row rather than wrapped with their
 * link, so the 8px gap falls on both sides of each slash the way it does when
 * the trail is written out by hand.
 */
export interface BreadcrumbStep {
  label: string;
  /** Omitted for the final step — the current page. */
  href?: string;
}

export function Breadcrumb({ trail }: { trail: BreadcrumbStep[] }) {
  return (
    <nav aria-label="مسیر" className={styles.breadcrumb}>
      {trail.map((step, index) => (
        <Fragment key={`${step.href ?? ''}${step.label}`}>
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          {step.href ? (
            <Link href={step.href}>{step.label}</Link>
          ) : (
            <span className={styles.current}>{step.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
