import { daysLeftLabel } from '@/lib/privacy-time';

const NOW = new Date('2026-09-21T10:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const DAY = 86_400_000;

describe('daysLeftLabel', () => {
  it('reads a window that has just begun as seven days, not six', () => {
    expect(daysLeftLabel(at(7 * DAY - 1000), NOW)).toBe('۷ روز دیگر');
  });

  it('rounds a part-day up, so it never promises less time than there is', () => {
    expect(daysLeftLabel(at(3.5 * DAY), NOW)).toBe('۴ روز دیگر');
    expect(daysLeftLabel(at(2 * DAY), NOW)).toBe('۲ روز دیگر');
  });

  it('says less than a day for the last 24 hours, and once the moment has passed', () => {
    expect(daysLeftLabel(at(DAY - 1), NOW)).toBe('کمتر از یک روز دیگر');
    expect(daysLeftLabel(at(3_600_000), NOW)).toBe('کمتر از یک روز دیگر');
    expect(daysLeftLabel(at(-3_600_000), NOW)).toBe('کمتر از یک روز دیگر');
  });
});
