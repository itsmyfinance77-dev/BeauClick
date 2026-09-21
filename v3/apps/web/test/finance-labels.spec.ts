import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCESS_MODE_LABEL,
  LEDGER_ENTRY_LABEL,
  SETTLEMENT_KIND_LABEL,
  SETTLEMENT_KIND_TONE,
  UNKNOWN_LEDGER_ENTRY_LABEL,
  UNKNOWN_SETTLEMENT_KIND_LABEL,
  ledgerEntryLabel,
  settlementKindLabel,
  settlementKindTone,
} from '@/lib/finance-labels';

const FINANCIAL = join(__dirname, '../../../services/financial/src');

/** The members of a server `export const NAME = [...] as const;` tuple. */
function serverList(file: string, name: string): string[] {
  const source = readFileSync(join(FINANCIAL, file), 'utf8');
  const start = source.indexOf(`export const ${name} = [`);
  const end = start < 0 ? -1 : source.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found in ${file} — did the server list move?`);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('ledger entry types', () => {
  const server = () => serverList('entities/ledger-entry.entity.ts', 'LEDGER_ENTRY_TYPES');

  it('labels exactly the entry types the server writes', () => {
    expect(server().length).toBeGreaterThanOrEqual(2); // guards an empty parse
    expect(Object.keys(LEDGER_ENTRY_LABEL).sort()).toEqual(server());
  });

  it('never calls an unknown entry the seller’s share, and never shows its raw key', () => {
    expect(ledgerEntryLabel('advance')).toBe(UNKNOWN_LEDGER_ENTRY_LABEL);
    expect(ledgerEntryLabel('advance')).not.toBe(LEDGER_ENTRY_LABEL.receivable);
    expect(ledgerEntryLabel('commission')).toBe('کارمزد پلتفرم');
  });
});

describe('settlement kinds', () => {
  const server = () => serverList('entities/settlement.entity.ts', 'SETTLEMENT_KINDS');

  it('labels and tones exactly the kinds the server writes', () => {
    expect(server().length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(SETTLEMENT_KIND_LABEL).sort()).toEqual(server());
    expect(Object.keys(SETTLEMENT_KIND_TONE).sort()).toEqual(server());
  });

  it('shows a neutral word, never the raw key, for an unknown kind', () => {
    expect(settlementKindLabel('chargeback')).toBe(UNKNOWN_SETTLEMENT_KIND_LABEL);
    expect(settlementKindTone('chargeback')).toBe('neutral');
    expect(settlementKindTone('reversal')).toBe('error');
  });
});

describe('access modes', () => {
  it('labels exactly the access modes the server issues', () => {
    const server = serverList('ports.ts', 'FINANCE_ACCESS_MODES');
    expect(server.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(ACCESS_MODE_LABEL).sort()).toEqual(server);
  });
});
