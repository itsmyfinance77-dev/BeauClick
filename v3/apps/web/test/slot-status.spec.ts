import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SLOT_STATUS_LABEL,
  SLOT_STATUS_TONE,
  UNKNOWN_SLOT_STATUS_LABEL,
  slotStatusLabel,
  slotStatusTone,
} from '@/lib/slot-status';

const ENTITY = join(__dirname, '../../../services/booking/src/entities/availability-slot.entity.ts');

/** The members of the server's `SLOT_STATUSES` tuple. */
function serverStatuses(): string[] {
  const source = readFileSync(ENTITY, 'utf8');
  const block = source.match(/export const SLOT_STATUSES = \[([\s\S]*?)\] as const;/);
  if (!block) throw new Error('SLOT_STATUSES not found — did the server list move?');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('slot statuses', () => {
  it('labels and tones every status the server can send — the lists must not drift', () => {
    const statuses = serverStatuses();
    expect(statuses.length).toBeGreaterThanOrEqual(3); // guards an empty parse
    expect(statuses.filter((s) => !(s in SLOT_STATUS_LABEL))).toEqual([]);
    expect(statuses.filter((s) => !(s in SLOT_STATUS_TONE))).toEqual([]);
  });

  it('keeps no label or tone for a status the server does not have (the old table had «blocked»)', () => {
    const server = new Set(serverStatuses());
    expect(Object.keys(SLOT_STATUS_LABEL).filter((s) => !server.has(s))).toEqual([]);
    expect(Object.keys(SLOT_STATUS_TONE).filter((s) => !server.has(s))).toEqual([]);
  });

  it('never shows a raw key for an unknown status', () => {
    expect(slotStatusLabel('mystery')).toBe(UNKNOWN_SLOT_STATUS_LABEL);
    expect(slotStatusTone('mystery')).toBe('neutral');
    expect(slotStatusLabel('booked')).toBe('رزرو شده');
  });
});
