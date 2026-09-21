import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORDER_STATUS_LABEL, UNKNOWN_ORDER_STATUS_LABEL, orderStatusLabel } from '@/lib/order-status';

const ENTITY = join(__dirname, '../../../services/commerce/src/entities/order.entity.ts');

/** The members of the server's `ORDER_STATUSES` tuple. */
function serverStatuses(): string[] {
  const source = readFileSync(ENTITY, 'utf8');
  const block = source.match(/export const ORDER_STATUSES = \[([\s\S]*?)\] as const;/);
  if (!block) throw new Error('ORDER_STATUSES not found — did the server list move?');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('order status labels', () => {
  it('labels every status the server can send — the two lists must not drift', () => {
    const statuses = serverStatuses();
    expect(statuses.length).toBeGreaterThan(4); // guards an empty parse
    expect(statuses.filter((s) => !(s in ORDER_STATUS_LABEL))).toEqual([]);
  });

  it('keeps no label for a status the server no longer sends', () => {
    const server = new Set(serverStatuses());
    expect(Object.keys(ORDER_STATUS_LABEL).filter((s) => !server.has(s))).toEqual([]);
  });

  it('never shows a raw key for an unknown status', () => {
    expect(orderStatusLabel('brand_new_status')).toBe(UNKNOWN_ORDER_STATUS_LABEL);
    expect(orderStatusLabel('paid')).toBe('پرداخت‌شده');
  });
});
