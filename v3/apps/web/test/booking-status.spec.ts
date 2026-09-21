import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOOKING_HISTORY_EVENT_LABEL,
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_TONE,
  UNKNOWN_BOOKING_STATUS_LABEL,
  bookingHistoryLabel,
  bookingStatusLabel,
  bookingStatusTone,
} from '@/lib/booking-status';

const ENTITIES = join(__dirname, '../../../services/booking/src/entities');

/** The members of a server `export const NAME = [...] as const;` tuple. */
function serverList(file: string, name: string): string[] {
  const source = readFileSync(join(ENTITIES, file), 'utf8');
  const start = source.indexOf(`export const ${name} = [`);
  const end = start < 0 ? -1 : source.indexOf('] as const;', start);
  const block = start < 0 || end < 0 ? null : [source, source.slice(start, end)];
  if (!block) throw new Error(`${name} not found in ${file} — did the server list move?`);
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('booking statuses', () => {
  const statuses = () => serverList('booking.entity.ts', 'BOOKING_STATUSES');

  it('labels and tones every status the server can send — the lists must not drift', () => {
    expect(statuses().length).toBeGreaterThan(4); // guards an empty parse
    expect(statuses().filter((s) => !(s in BOOKING_STATUS_LABEL))).toEqual([]);
    expect(statuses().filter((s) => !(s in BOOKING_STATUS_TONE))).toEqual([]);
  });

  it('keeps nothing for a status the server does not have', () => {
    const server = new Set(statuses());
    expect(Object.keys(BOOKING_STATUS_LABEL).filter((s) => !server.has(s))).toEqual([]);
    expect(Object.keys(BOOKING_STATUS_TONE).filter((s) => !server.has(s))).toEqual([]);
  });

  it('never shows a raw key for an unknown status', () => {
    expect(bookingStatusLabel('refunded_partially')).toBe(UNKNOWN_BOOKING_STATUS_LABEL);
    expect(bookingStatusTone('refunded_partially')).toBe('neutral');
  });
});

describe('booking history events', () => {
  const events = () => serverList('booking-history.entity.ts', 'BOOKING_HISTORY_EVENTS');

  it('labels every event the server can write', () => {
    expect(events().length).toBeGreaterThan(5);
    expect(events().filter((e) => !(e in BOOKING_HISTORY_EVENT_LABEL))).toEqual([]);
  });

  it('keeps no label for an event the server does not write', () => {
    const server = new Set(events());
    expect(Object.keys(BOOKING_HISTORY_EVENT_LABEL).filter((e) => !server.has(e))).toEqual([]);
  });

  it('falls back to the transition, then to a neutral phrase — never the raw key', () => {
    expect(bookingHistoryLabel({ event: 'auto_released', toStatus: 'expired' })).toBe('انقضای رزرو');
    expect(bookingHistoryLabel({ event: 'auto_released', toStatus: null })).toBe('تغییر وضعیت رزرو');
    expect(bookingHistoryLabel({ event: 'rescheduled', toStatus: null })).toBe('تغییر زمان');
  });
});
