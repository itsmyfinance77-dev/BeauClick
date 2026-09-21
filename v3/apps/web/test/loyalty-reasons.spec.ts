import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOYALTY_REASON_LABEL, UNKNOWN_REASON_LABEL, loyaltyReasonLabel } from '@/lib/loyalty-reasons';

const CONFIG = join(__dirname, '../../../services/loyalty/src/loyalty.config.ts');

/** The values of the server's `LOYALTY_REASONS` object. */
function serverReasons(): string[] {
  const source = readFileSync(CONFIG, 'utf8');
  const block = source.match(/export const LOYALTY_REASONS = \{([\s\S]*?)\n\} as const;/);
  if (!block) throw new Error('LOYALTY_REASONS not found — did the server table move?');
  return [...block[1].matchAll(/^\s*\w+:\s*'([a-z_]+)'/gm)].map((m) => m[1]).sort();
}

describe('loyalty reasons', () => {
  it('labels every reason the server can write — the two tables must not drift', () => {
    const reasons = serverReasons();
    // Guards against passing forever on an empty parse.
    expect(reasons.length).toBeGreaterThan(6);
    expect(reasons.filter((r) => !(r in LOYALTY_REASON_LABEL))).toEqual([]);
  });

  it('does not keep a label for a reason the server never writes', () => {
    const server = new Set(serverReasons());
    expect(Object.keys(LOYALTY_REASON_LABEL).filter((r) => !server.has(r))).toEqual([]);
  });

  it('never shows a raw key for a reason it does not know', () => {
    expect(loyaltyReasonLabel('some_future_reason')).toBe(UNKNOWN_REASON_LABEL);
    expect(loyaltyReasonLabel('booking_completed')).toBe('انجام خدمت');
  });
});
