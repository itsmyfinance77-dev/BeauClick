import { jalaliMonthLength } from '@beauclick/persian-utils';

import { jalaliMonthStart, settlementMonthWindows } from './settlement-months';

/**
 * #255's month windows: Solar Hijri months, beginning at 00:00 Tehran.
 *
 * Every expected instant below is written out by hand from the calendar, not
 * computed with the code under test: 1 Farvardin 1405 is 21 March 2026, the
 * first six months have 31 days, the next five 30, and Tehran is +03:30 --
 * except before 2023, when it kept +04:30 summer time.
 */
describe('settlement month windows (#255)', () => {
  it('ends with the month now falls in, oldest first, four of them', () => {
    // 2026-09-26 12:00 UTC is 4 Mehr 1405 in Tehran.
    const windows = settlementMonthWindows(new Date('2026-09-26T12:00:00.000Z'), 4);
    expect(windows.map((w) => w.month)).toEqual(['1405-04', '1405-05', '1405-06', '1405-07']);
    expect(windows.map((w) => w.startsAt.toISOString())).toEqual([
      '2026-06-21T20:30:00.000Z', // 1 Tir     = 22 June, 00:00 Tehran
      '2026-07-22T20:30:00.000Z', // 1 Mordad  = 23 July
      '2026-08-22T20:30:00.000Z', // 1 Shahrivar = 23 August
      '2026-09-22T20:30:00.000Z', // 1 Mehr    = 23 September
    ]);
    // The current month runs to 1 Aban = 23 October, 00:00 Tehran.
    expect(windows[3].endsAt.toISOString()).toBe('2026-10-22T20:30:00.000Z');
  });

  it('puts the last millisecond before Tehran midnight in the old month, and midnight itself in the new one', () => {
    expect(settlementMonthWindows(new Date('2026-09-22T20:29:59.999Z'), 1)[0].month).toBe('1405-06');
    expect(settlementMonthWindows(new Date('2026-09-22T20:30:00.000Z'), 1)[0].month).toBe('1405-07');
  });

  it('is not a Gregorian month: 1 October UTC is still Mehr, and 22 September is still Shahrivar', () => {
    expect(settlementMonthWindows(new Date('2026-10-01T00:00:00.000Z'), 1)[0].month).toBe('1405-07');
    expect(settlementMonthWindows(new Date('2026-09-22T12:00:00.000Z'), 1)[0].month).toBe('1405-06');
  });

  it('crosses the Jalali new year', () => {
    // 2 Farvardin 1406 = 22 March 2027.
    const windows = settlementMonthWindows(new Date('2027-03-22T12:00:00.000Z'), 4);
    expect(windows.map((w) => w.month)).toEqual(['1405-10', '1405-11', '1405-12', '1406-01']);
    expect(windows[3].startsAt.toISOString()).toBe('2027-03-20T20:30:00.000Z'); // 1 Farvardin 1406 = 21 March 2027
  });

  it('reads the offset at the instant: a 2021 summer month began at 19:30 UTC, when Tehran was +04:30', () => {
    // 1 Mordad 1400 = 23 July 2021.
    expect(jalaliMonthStart(1400, 5).toISOString()).toBe('2021-07-22T19:30:00.000Z');
    // 1 Dey 1399 = 21 December 2020, winter, +03:30.
    expect(jalaliMonthStart(1399, 10).toISOString()).toBe('2020-12-20T20:30:00.000Z');
  });

  it('chains without gap or overlap, each window exactly its month long', () => {
    const windows = settlementMonthWindows(new Date('2027-05-10T08:00:00.000Z'), 12);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i].startsAt.getTime()).toBe(windows[i - 1].endsAt.getTime());
    }
    for (const w of windows) {
      const [jy, jm] = w.month.split('-').map(Number);
      expect((w.endsAt.getTime() - w.startsAt.getTime()) / 86_400_000).toBe(jalaliMonthLength(jy, jm));
    }
  });
});
