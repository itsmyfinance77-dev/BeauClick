import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STAFF_ROLE_LABEL,
  STAFF_STATUS_LABEL,
  STAFF_STATUS_TONE,
  UNKNOWN_STAFF_ROLE_LABEL,
  UNKNOWN_STAFF_STATUS_LABEL,
  staffRoleLabel,
  staffStatusLabel,
  staffStatusTone,
} from '@/lib/business-labels';

const ENTITY = join(__dirname, '../../../services/business/src/entities/business-staff.entity.ts');

/** The members of a server `export const NAME = [...] as const;` tuple. */
function serverList(name: string): string[] {
  const source = readFileSync(ENTITY, 'utf8');
  const start = source.indexOf(`export const ${name} = [`);
  const end = start < 0 ? -1 : source.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found — did the server list move?`);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('staff roles', () => {
  it('labels exactly the roles the server has', () => {
    const server = serverList('BUSINESS_STAFF_ROLES');
    expect(server.length).toBeGreaterThanOrEqual(2); // guards an empty parse
    expect(Object.keys(STAFF_ROLE_LABEL).sort()).toEqual(server);
  });

  it('shows a neutral word for a role it has never heard of, not a blank or the raw key', () => {
    expect(staffRoleLabel('owner')).toBe(UNKNOWN_STAFF_ROLE_LABEL);
    expect(staffRoleLabel('manager')).toBe('مدیر');
  });
});

describe('membership statuses', () => {
  it('labels and tones exactly the statuses the server has — including `removed`, which once rendered blank', () => {
    const server = serverList('BUSINESS_STAFF_STATUSES');
    expect(server).toContain('removed');
    expect(Object.keys(STAFF_STATUS_LABEL).sort()).toEqual(server);
    expect(Object.keys(STAFF_STATUS_TONE).sort()).toEqual(server);
  });

  it('shows a neutral word and tone for a status it has never heard of', () => {
    expect(staffStatusLabel('suspended')).toBe(UNKNOWN_STAFF_STATUS_LABEL);
    expect(staffStatusTone('suspended')).toBe('neutral');
    expect(staffStatusTone('declined')).toBe('error');
  });
});
