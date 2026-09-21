import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FUNNEL_LABEL,
  REVENUE_LABEL,
  SERIES_EVENT_LABEL,
  UNKNOWN_REVENUE_LABEL,
  revenueIsMoney,
  revenueLabel,
  seriesMeasure,
} from '@/lib/analytics-labels';
import { SERIES_EVENTS } from '@/lib/pro-api';

const SERVICE = join(__dirname, '../../../services/analytics/src');

/** The quoted members of `const SERIES_EVENTS = [...]` in the server controller. */
function serverSeriesEvents(): string[] {
  const source = readFileSync(join(SERVICE, 'analytics.controller.ts'), 'utf8');
  const start = source.indexOf('const SERIES_EVENTS = [');
  const end = source.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error('SERIES_EVENTS not found — did the server list move?');
  return [...source.slice(start, end).matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort();
}

/** The property names inside one `name: { … }` block of the ProviderMetrics interface. */
function metricKeys(block: 'funnel' | 'revenue'): string[] {
  const source = readFileSync(join(SERVICE, 'metrics.service.ts'), 'utf8');
  const iface = source.slice(source.indexOf('export interface ProviderMetrics'));
  const start = iface.indexOf(`${block}: {`);
  const end = iface.indexOf('}', start);
  if (start < 0 || end < 0) throw new Error(`${block} not found in ProviderMetrics`);
  return [...iface.slice(start + block.length + 3, end).matchAll(/(\w+):\s*Metric/g)].map((m) => m[1]).sort();
}

describe('analytics labels — the tables must not drift from the server', () => {
  it('offers exactly the series events the server accepts', () => {
    const server = serverSeriesEvents();
    expect(server.length).toBeGreaterThan(4); // guards an empty parse
    expect([...SERIES_EVENTS].sort()).toEqual(server);
    expect(Object.keys(SERIES_EVENT_LABEL).sort()).toEqual(server);
  });

  it('labels every revenue figure the server sends, and none it does not (netToman and averageOrderToman never existed)', () => {
    const server = metricKeys('revenue');
    expect(server.length).toBe(3);
    expect(Object.keys(REVENUE_LABEL).sort()).toEqual(server);
  });

  it('labels every funnel counter the page shows as a card', () => {
    const server = new Set(metricKeys('funnel'));
    // The cards are the counters; the rates are shown separately.
    expect(Object.keys(FUNNEL_LABEL).filter((k) => !server.has(k))).toEqual([]);
    for (const counter of ['created', 'confirmed', 'completed', 'cancelled', 'expired', 'profileViews']) {
      expect(FUNNEL_LABEL[counter]).toBeTruthy();
    }
  });

  it('never shows a raw key for an unknown revenue figure', () => {
    expect(revenueLabel('mysteryToman')).toBe(UNKNOWN_REVENUE_LABEL);
    expect(revenueLabel('grossToman')).toBe('فروش ناخالص');
  });

  it('treats the Toman measures as money and a count as not', () => {
    expect(revenueIsMoney('grossToman')).toBe(true);
    expect(revenueIsMoney('refundedToman')).toBe(true);
    expect(revenueIsMoney('paidOrders')).toBe(false);
  });
});

describe('what a bar of the daily trend measures', () => {
  it('plots money (the daily sum) for a paid order, and a count for everything else', () => {
    expect(seriesMeasure('OrderPaid')).toEqual({ field: 'sum', money: true });
    for (const event of SERIES_EVENTS.filter((e) => e !== 'OrderPaid')) {
      expect(seriesMeasure(event)).toEqual({ field: 'count', money: false });
    }
  });
});
