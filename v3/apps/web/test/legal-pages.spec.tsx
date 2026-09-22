import { render, screen, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ContactPage, { metadata as contactMetadata } from '@/app/contact/page';
import PrivacyPolicyPage, { metadata as privacyMetadata } from '@/app/privacy-policy/page';
import SupportPage, { metadata as supportMetadata } from '@/app/support/page';
import TermsPage, { metadata as termsMetadata } from '@/app/terms/page';
import { COMPANY_LINKS } from '@/components/site-footer';
import { LEGAL_PLACEHOLDER, LegalPage } from '@/components/legal-page';

/**
 * `/terms`, `/privacy-policy`, `/contact`, `/support` -- `33_FOOTER_LEGAL.md`.
 *
 * The point of the story is what these pages must NOT contain: legal wording,
 * a phone number, an address, a "sample". So the guards here are mostly
 * negative, and they run against what every page renders.
 */

const PAGES = [
  ['/terms', 'قوانین و مقررات', TermsPage, termsMetadata, false],
  ['/privacy-policy', 'حریم خصوصی', PrivacyPolicyPage, privacyMetadata, false],
  ['/contact', 'تماس', ContactPage, contactMetadata, true],
  ['/support', 'پشتیبانی', SupportPage, supportMetadata, true],
] as const;

describe.each(PAGES)('%s', (_route, title, Page, metadata, hasContactBlock) => {
  it('renders its title as the one h1', () => {
    render(<Page />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title);
  });

  it('publishes the labelled placeholder, verbatim, inside an info alert', () => {
    const { container } = render(<Page />);
    const alert = container.querySelector('[data-bc-alert="info"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toBe(LEGAL_PLACEHOLDER);
    expect(LEGAL_PLACEHOLDER).toBe('[محتوایِ این بخش در انتظارِ تأییدِ مالکِ کسب‌وکار است — BUSINESS DECISION REQUIRED]');
  });

  it('carries no invented content: no phone-like digit run, no address, no link out', () => {
    const { container } = render(<Page />);
    const text = container.textContent ?? '';
    // Latin, Persian and Arabic-Indic digits alike: the placeholder has none,
    // and a phone number or a date would.
    expect(text).not.toMatch(/[0-9۰-۹٠-٩]/);
    expect(text).not.toContain('@');
    expect(container.querySelector('a[href^="tel:"], a[href^="mailto:"]')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('has no last-updated line, because there is no approved text to have been updated', () => {
    render(<Page />);
    expect(screen.queryByText(/آخرین به‌روزرسانی/)).toBeNull();
    expect(document.querySelector('time')).toBeNull();
  });

  it('has no section headings and no table of contents while it is a placeholder', () => {
    render(<Page />);
    expect(screen.queryByRole('navigation', { name: 'فهرست محتوا' })).toBeNull();
    // The contact block's own h2 is the only heading below the title.
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  it(hasContactBlock ? 'shows a contact block that is itself the placeholder' : 'has no contact block', () => {
    render(<Page />);
    const heading = screen.queryByRole('heading', { level: 2, name: 'اطلاعات تماس' });
    if (!hasContactBlock) {
      expect(heading).toBeNull();
      return;
    }
    expect(heading).not.toBeNull();
    const card = heading!.parentElement as HTMLElement;
    expect(within(card).getByText(LEGAL_PLACEHOLDER)).toBeInTheDocument();
  });

  it('asks not to be indexed while it is a placeholder, and is titled for the browser tab', () => {
    expect(metadata.title).toBe(title);
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});

describe('the footer links resolve to real pages', () => {
  it('names the four routes with the spec labels', () => {
    expect(COMPANY_LINKS).toEqual([
      { href: '/terms', label: 'قوانین و مقررات' },
      { href: '/privacy-policy', label: 'حریم خصوصی' },
      { href: '/contact', label: 'تماس' },
      { href: '/support', label: 'پشتیبانی' },
    ]);
  });

  it.each(COMPANY_LINKS.map((l) => [l.href]))('%s has a page.tsx, so the link cannot 404', (href) => {
    expect(existsSync(join(__dirname, '..', 'app', href.slice(1), 'page.tsx'))).toBe(true);
  });

  it('keeps /privacy-policy (the legal page) apart from /account/privacy (the signed-in data page)', () => {
    expect(COMPANY_LINKS.map((l) => l.href)).not.toContain('/account/privacy');
    expect(existsSync(join(__dirname, '..', 'app', 'account', 'privacy', 'page.tsx'))).toBe(true);
  });
});

describe('LegalPage, once content is approved', () => {
  const sections = [
    {
      id: 'one',
      heading: 'بخش نخست',
      body: <p>متن نخست</p>,
      subsections: [{ id: 'one-a', heading: 'زیربخش', body: <p>متن زیربخش</p> }],
    },
    { id: 'two', heading: 'بخش دوم', body: <p>متن دوم</p> },
  ];

  it('replaces the placeholder with the sections, leaving the template as it was', () => {
    const { container } = render(<LegalPage title="عنوان" sections={sections} />);
    expect(screen.getByText('متن نخست')).toBeInTheDocument();
    expect(container.querySelector('[data-bc-alert="info"]')).toBeNull();
    expect(screen.queryByText(LEGAL_PLACEHOLDER)).toBeNull();
  });

  it('keeps a correct heading hierarchy: one h1, h2 per section, h3 only under an h2', () => {
    render(<LegalPage title="عنوان" sections={sections} />);
    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
    expect(levels).toEqual([1, 2, 3, 2]);
  });

  it('builds a table of contents whose every link reaches a real heading', () => {
    const { container } = render(<LegalPage title="عنوان" sections={sections} />);
    const toc = screen.getByRole('navigation', { name: 'فهرست محتوا' });
    const links = within(toc).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['بخش نخست', 'زیربخش', 'بخش دوم']);
    for (const a of links) {
      const target = container.querySelector(`[id="${(a.getAttribute('href') ?? '').slice(1)}"]`);
      expect(target).not.toBeNull();
      expect(target?.textContent).toBe(a.textContent);
    }
  });

  it('shows the last-updated date in the Jalali calendar, in Persian digits', () => {
    render(<LegalPage title="عنوان" sections={sections} updatedAt="2026-03-21T12:00:00.000Z" />);
    const time = document.querySelector('time') as HTMLElement;
    // 2026-03-21 is 1 Farvardin 1405.
    expect(time.textContent).toContain('۱۴۰۵');
    expect(time.textContent).toContain('فروردین');
    expect(time.textContent).not.toMatch(/[0-9]/);
    expect(time.getAttribute('datetime')).toBe('2026-03-21T12:00:00.000Z');
  });

  it('ignores a date it cannot parse rather than printing "Invalid Date"', () => {
    render(<LegalPage title="عنوان" updatedAt="not a date" />);
    expect(screen.queryByText(/آخرین به‌روزرسانی/)).toBeNull();
  });

  it('shows approved contact details in place of the placeholder', () => {
    render(<LegalPage title="تماس" withContactBlock contactDetails={<p>جزئیات تأییدشده</p>} />);
    expect(screen.getByText('جزئیات تأییدشده')).toBeInTheDocument();
    // The body is a placeholder still, but the block no longer is.
    expect(screen.getAllByText(LEGAL_PLACEHOLDER)).toHaveLength(1);
  });
});
