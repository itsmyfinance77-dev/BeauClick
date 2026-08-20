import {
  PLATFORM_TIMEZONE,
  isIsoDate,
  isIsoTime,
  localDateTimeToInstant,
  wallClockPartsIn,
  zoneOffsetMinutes,
  zonedWeekday,
} from './platform-time';

/**
 * Wall-clock <-> instant conversion.
 *
 * These matter more than they look: a professional publishes availability in
 * local terms ("Saturdays 09:00-17:00") and a slot is stored as a real
 * instant. Get this wrong by an hour and every generated slot in the country
 * is at the wrong time.
 */
describe('platform time', () => {
  it('reads Tehran wall-clock parts from an instant', () => {
    // 2026-09-01T05:30:00Z is 09:00 in Tehran (UTC+03:30).
    const parts = wallClockPartsIn(new Date('2026-09-01T05:30:00Z'));
    expect(parts).toMatchObject({ year: 2026, month: 9, day: 1, hour: 9, minute: 0 });
  });

  it('reports the real zone offset, read from the IANA database rather than hard-coded', () => {
    // Iran abolished DST in 2022, so this is +03:30 year-round today. Reading
    // it from the zone rules rather than hard-coding it means a future policy
    // change does not silently produce hour-wrong slots.
    expect(zoneOffsetMinutes(new Date('2026-01-15T00:00:00Z'))).toBe(210);
    expect(zoneOffsetMinutes(new Date('2026-07-15T00:00:00Z'))).toBe(210);
  });

  it('converts a local date+time to the correct instant', () => {
    expect(localDateTimeToInstant('2026-09-01', '09:00').toISOString()).toBe('2026-09-01T05:30:00.000Z');
    expect(localDateTimeToInstant('2026-09-01', '00:00').toISOString()).toBe('2026-08-31T20:30:00.000Z');
  });

  it('round-trips a local time through an instant and back', () => {
    for (const time of ['00:00', '09:30', '12:00', '23:45']) {
      const instant = localDateTimeToInstant('2026-09-01', time);
      const parts = wallClockPartsIn(instant);
      const [h, m] = time.split(':').map(Number);
      expect(parts).toMatchObject({ year: 2026, month: 9, day: 1, hour: h, minute: m });
    }
  });

  it('reads the weekday in the PLATFORM zone, not the server zone', () => {
    // 2026-09-05 is a Saturday. A slot at 00:30 Tehran on that day is
    // 2026-09-04T21:00Z -- a server reading getDay() in UTC would call it
    // Friday and generate the whole pattern a day off.
    const saturdayEarly = localDateTimeToInstant('2026-09-05', '00:30');
    expect(saturdayEarly.toISOString()).toBe('2026-09-04T21:00:00.000Z');
    expect(zonedWeekday(saturdayEarly)).toBe(6); // Saturday, 0 = Sunday
  });

  it('maps each weekday to V2s 0=Sunday convention, which every client already speaks', () => {
    expect(zonedWeekday(localDateTimeToInstant('2026-09-06', '12:00'))).toBe(0); // Sunday
    expect(zonedWeekday(localDateTimeToInstant('2026-09-07', '12:00'))).toBe(1); // Monday
    expect(zonedWeekday(localDateTimeToInstant('2026-09-11', '12:00'))).toBe(5); // Friday
  });

  it('names the platform timezone explicitly', () => {
    expect(PLATFORM_TIMEZONE).toBe('Asia/Tehran');
  });

  describe('input validation', () => {
    it('accepts well-formed dates and times', () => {
      expect(isIsoDate('2026-09-01')).toBe(true);
      expect(isIsoTime('09:30')).toBe(true);
      expect(isIsoTime('23:59')).toBe(true);
      expect(isIsoTime('00:00')).toBe(true);
    });

    it('rejects malformed dates', () => {
      expect(isIsoDate('2026-9-1')).toBe(false);
      expect(isIsoDate('01-09-2026')).toBe(false);
      expect(isIsoDate('not-a-date')).toBe(false);
      expect(isIsoDate('2026-13-01')).toBe(false);
    });

    it('rejects out-of-range times', () => {
      expect(isIsoTime('24:00')).toBe(false);
      expect(isIsoTime('09:60')).toBe(false);
      expect(isIsoTime('9:30')).toBe(false);
      expect(isIsoTime('')).toBe(false);
    });
  });
});
