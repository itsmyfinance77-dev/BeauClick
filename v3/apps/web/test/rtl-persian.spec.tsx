import { render, screen } from '@testing-library/react';
import { Input, Button, Alert, LoadingState } from '@/components/ui';
import { formatFullJalaliDate, toPersianDigits, formatToman } from '@beauclick/persian-utils';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Persian/RTL + accessibility baseline for the V3 frontend foundation.
 * These assert the STRUCTURAL guarantees (logical properties, associated
 * labels, announced errors, Persian utilities wired in) rather than pixel
 * appearance.
 */
describe('Persian utilities are wired into the frontend', () => {
  it('renders Jalali dates, not Gregorian', () => {
    // 2024-03-20 Gregorian = 1403-01-01 Jalali (Nowruz).
    //
    // An absolute instant, not `new Date(2024, 2, 20)`. The helpers read the
    // PLATFORM timezone (R31-09), so a local-time constructor would build a
    // different instant on every host and this assertion would hold in Tehran,
    // hold in UTC by luck, and fail anywhere east of Iran.
    expect(formatFullJalaliDate(new Date(Date.UTC(2024, 2, 20, 12, 0)))).toBe('چهارشنبه، ۱ فروردین ۱۴۰۳');
  });

  it('renders Persian digits', () => {
    expect(toPersianDigits('09123456789')).toBe('۰۹۱۲۳۴۵۶۷۸۹');
  });

  it('formats Toman amounts in Persian digits with the Persian separator', () => {
    expect(formatToman(350000)).toBe('۳۵۰٬۰۰۰');
  });
});

describe('RTL discipline', () => {
  const rawCss = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf-8');
  // Strip /* ... */ comments before scanning: the file's own docblock
  // NAMES the banned properties in prose ("never margin-left/right"), which
  // would otherwise trip the very check it documents.
  const globalsCss = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

  it('uses CSS logical properties, never physical left/right, in base styles', () => {
    // The rule V2 proved and V3_MIGRATION_MATRIX.md carries forward as a
    // DIRECT REUSE pattern: physical properties silently break under RTL.
    expect(globalsCss).not.toMatch(/margin-(left|right)\s*:/);
    expect(globalsCss).not.toMatch(/padding-(left|right)\s*:/);
    expect(globalsCss).not.toMatch(/text-align\s*:\s*(left|right)/);
    expect(globalsCss).toMatch(/inset-inline-start/); // proves logical properties ARE in use
  });

  it('sets tabular numerals so Persian digits align in columns', () => {
    expect(globalsCss).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('keeps numeric inputs LTR-ordered inside the RTL document', () => {
    render(<Input label="شماره موبایل" inputMode="numeric" />);
    const input = screen.getByLabelText('شماره موبایل');
    expect(input).toHaveStyle({ direction: 'ltr' });
  });
});

describe('Accessibility baseline', () => {
  it('associates every input with its visible label', () => {
    render(<Input label="کد تأیید" />);
    expect(screen.getByLabelText('کد تأیید')).toBeInTheDocument();
  });

  it('announces field errors to assistive tech and links them to the field', () => {
    render(<Input label="شماره موبایل" error="شماره موبایل نامعتبر است." />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('شماره موبایل نامعتبر است.');

    const input = screen.getByLabelText('شماره موبایل');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('marks a busy button with aria-busy rather than only changing its text', () => {
    render(<Button loading>ارسال</Button>);
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
  });

  it('gives every button a comfortable touch target (>=44px)', () => {
    render(<Button>تأیید</Button>);
    expect(screen.getByRole('button')).toHaveStyle({ minHeight: '44px' });
  });

  it('exposes alerts and loading states as live regions', () => {
    const { unmount } = render(<Alert>خطا</Alert>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    unmount();

    render(<LoadingState />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('respects prefers-reduced-motion', () => {
    const globalsCss = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf-8');
    expect(globalsCss).toMatch(/prefers-reduced-motion/);
  });
});
