import { hoursBetween, tehranCalendarDay, tehranDayResetsAt } from './ai-clock';

/**
 * The Tehran calendar day, and the instant the quota resets.
 *
 * `V32-DEC-008` says twenty messages per TEHRAN calendar day. That is a promise
 * to a person, and the only way to know it is kept is to stand on both sides of
 * a boundary the tests can actually move — which is why the clock is injected
 * and the day is computed in TypeScript rather than as
 * `now() AT TIME ZONE 'Asia/Tehran'` inside the quota statement. See
 * `ai-clock.ts` for that trade.
 */
describe('tehranCalendarDay', () => {
  it('buckets an instant into the Tehran day, not the UTC one', () => {
    // 2026-03-15 21:00 UTC is 2026-03-16 00:30 in Tehran (+03:30).
    // A customer sending their twentieth message at half past midnight has used
    // TODAY's allowance, and telling them otherwise would contradict the date on
    // their own phone.
    expect(tehranCalendarDay(new Date('2026-03-15T21:00:00.000Z'))).toBe('2026-03-16');
    // Thirty minutes earlier is still the previous Tehran day.
    expect(tehranCalendarDay(new Date('2026-03-15T20:29:00.000Z'))).toBe('2026-03-15');
  });

  it('agrees with UTC in the middle of the day, where there is nothing to get wrong', () => {
    expect(tehranCalendarDay(new Date('2026-06-01T09:00:00.000Z'))).toBe('2026-06-01');
  });

  it('produces the ISO-ordered shape a PostgreSQL date column accepts', () => {
    expect(tehranCalendarDay(new Date('2026-01-05T12:00:00.000Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('tehranDayResetsAt', () => {
  /**
   * The exact instant a browser counts down to.
   *
   * Returned as an absolute instant rather than a duration: a duration computed
   * server-side is stale by the time it renders, and a client counting down to a
   * moment it calculated in its own timezone counts down to the wrong one.
   */
  it('returns the start of the next Tehran day, as a UTC instant', () => {
    // Midnight Tehran on 2026-03-17 is 20:30 UTC on 2026-03-16.
    expect(tehranDayResetsAt('2026-03-16').toISOString()).toBe('2026-03-16T20:30:00.000Z');
  });

  it('always lands strictly after every instant belonging to that day', () => {
    const day = '2026-06-10';
    const resetsAt = tehranDayResetsAt(day);

    // The last instant of the Tehran day, and the first of the next one.
    const lastMoment = new Date(resetsAt.getTime() - 1);
    expect(tehranCalendarDay(lastMoment)).toBe(day);
    expect(tehranCalendarDay(resetsAt)).not.toBe(day);
  });

  /**
   * The offset is derived from the runtime's IANA database rather than
   * hardcoded, because Iran observed daylight saving until 2022 and could
   * resume. This asserts the derivation is self-consistent across the year --
   * whatever the rules are, the reset is always the first instant of the next
   * day.
   */
  it('is self-consistent across the whole year, whatever the offset rules are', () => {
    for (let month = 1; month <= 12; month += 1) {
      const day = `2026-${String(month).padStart(2, '0')}-15`;
      const resetsAt = tehranDayResetsAt(day);
      expect(tehranCalendarDay(new Date(resetsAt.getTime() - 1))).toBe(day);
      expect(tehranCalendarDay(resetsAt)).not.toBe(day);
    }
  });

  it('rolls a month boundary correctly', () => {
    const resetsAt = tehranDayResetsAt('2026-01-31');
    expect(tehranCalendarDay(resetsAt)).toBe('2026-02-01');
  });

  it('rolls a year boundary correctly', () => {
    const resetsAt = tehranDayResetsAt('2026-12-31');
    expect(tehranCalendarDay(resetsAt)).toBe('2027-01-01');
  });
});

describe('hoursBetween', () => {
  it('measures the inactivity horizon in fractional hours', () => {
    const earlier = new Date('2026-05-01T00:00:00.000Z');
    expect(hoursBetween(earlier, new Date('2026-05-02T00:00:00.000Z'))).toBe(24);
    expect(hoursBetween(earlier, new Date('2026-05-01T23:59:00.000Z'))).toBeLessThan(24);
    expect(hoursBetween(earlier, new Date('2026-05-02T00:01:00.000Z'))).toBeGreaterThan(24);
  });
});
