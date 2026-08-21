import { addDays, normalizeRange, platformCalendarDay } from './platform-day';

describe('platformCalendarDay', () => {
  it('buckets by the Tehran calendar day, not the UTC one', () => {
    // 2026-08-20T21:30:00Z is 2026-08-21 01:00 in Tehran (+03:30).
    // Bucketing in UTC would file this under the 20th and quietly move a
    // booking into the previous day's numbers for an operator in Tehran.
    expect(platformCalendarDay(new Date('2026-08-20T21:30:00.000Z'))).toBe('2026-08-21');
  });

  it('keeps a late-evening Tehran instant on its own day', () => {
    // 2026-08-20T19:00:00Z is 22:30 Tehran, still the 20th.
    expect(platformCalendarDay(new Date('2026-08-20T19:00:00.000Z'))).toBe('2026-08-20');
  });

  it('produces an ISO-ordered string a date column accepts', () => {
    expect(platformCalendarDay(new Date('2026-01-05T08:00:00.000Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('crosses a year boundary backwards', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('normalizeRange', () => {
  it('defaults to the last 30 days', () => {
    const { from, to } = normalizeRange();
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    expect(span).toBe(29);
  });

  it('swaps a reversed range instead of returning nothing', () => {
    expect(normalizeRange('2026-08-20', '2026-08-01')).toEqual({ from: '2026-08-01', to: '2026-08-20' });
  });

  it('CLAMPS an absurd range to 366 days', () => {
    // Without the clamp, a mistyped or adversarial `from` turns every metric
    // query into an unbounded scan of the whole fact table.
    const { from, to } = normalizeRange('0001-01-01', '2026-08-20');
    expect(to).toBe('2026-08-20');
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    expect(span).toBe(366);
  });

  it('ignores a malformed date rather than trusting it', () => {
    const { to } = normalizeRange(undefined, 'not-a-date');
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects a SQL-shaped string by falling back to the default', () => {
    // The value reaches a parameterised query, so this is not about injection
    // -- it is that a non-date must never become a range boundary.
    const { from } = normalizeRange("2026-01-01' OR '1'='1", '2026-08-20');
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
