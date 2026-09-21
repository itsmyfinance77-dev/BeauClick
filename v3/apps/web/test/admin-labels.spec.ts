import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARTY_TYPE_LABEL, UNKNOWN_PARTY_TYPE_LABEL, partyTypeLabel } from '@/lib/admin-labels';

const FINANCIAL = join(__dirname, '../../../services/financial/src');

/** The members of a server `export const NAME = [...] as const;` tuple. */
function serverList(file: string, name: string): string[] {
  const source = readFileSync(join(FINANCIAL, file), 'utf8');
  const start = source.indexOf(`export const ${name} = [`);
  const end = start < 0 ? -1 : source.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found in ${file} — did the server list move?`);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('settlement party types', () => {
  const server = () => serverList('entities/fund-posting.entity.ts', 'FUND_POSTING_SELLER_PARTY_TYPES');

  it('labels exactly the seller party types the server settles', () => {
    expect(server().length).toBeGreaterThanOrEqual(2); // guards an empty parse
    expect(Object.keys(PARTY_TYPE_LABEL).sort()).toEqual(server());
  });

  it('shows a neutral word, never the raw key, for a type it has never heard of', () => {
    expect(partyTypeLabel('platform')).toBe(UNKNOWN_PARTY_TYPE_LABEL);
    expect(partyTypeLabel('platform')).not.toContain('platform');
    expect(partyTypeLabel('business')).toBe('کسب‌وکار');
  });
});
