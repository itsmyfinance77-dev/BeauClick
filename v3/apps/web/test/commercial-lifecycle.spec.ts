/**
 * @jest-environment ./test/ambient-zone-environment.js
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiRequestError } from '@/lib/api-client';
import type { LifecycleVersion } from '@/lib/commercial-admin-api';
import { PLATFORM_TIMEZONE } from '@beauclick/persian-utils';
import {
  ACTIVATION_END_LABEL,
  ACTIVATION_START_LABEL,
  activeVersion,
  derivedState,
  isoToLocalInput,
  localInputToIso,
  parseWhole,
  refusalFrom,
  refusalMeansStale,
} from '@/lib/commercial-lifecycle';
import { ambientZone, withAmbientZone } from './ambient-zone';

/** The shared lifecycle helpers (#239). */

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const v = (over: Partial<LifecycleVersion>): LifecycleVersion => ({
  version: 1,
  lifecycleState: 'published',
  activationStartsAt: '2026-09-01T00:00:00.000Z',
  activationEndsAt: null,
  publishedAt: '2026-09-01T00:00:00.000Z',
  retiredAt: null,
  ...over,
});

describe('derivedState — the commission page’s own rule, on a published version only', () => {
  it('is active inside the window, open-ended or not', () => {
    expect(derivedState(v({}), NOW)).toBe('active');
    expect(derivedState(v({ activationEndsAt: '2026-10-01T00:00:00.000Z' }), NOW)).toBe('active');
  });

  it('is scheduled before its start, and superseded at or after its end', () => {
    expect(derivedState(v({ activationStartsAt: '2026-10-01T00:00:00.000Z' }), NOW)).toBe('scheduled');
    expect(derivedState(v({ activationEndsAt: '2026-09-22T12:00:00.000Z' }), NOW)).toBe('superseded');
  });

  it('is nothing for a draft or a retired version — only a published one has a window position', () => {
    expect(derivedState(v({ lifecycleState: 'draft', activationStartsAt: null }), NOW)).toBeNull();
    expect(derivedState(v({ lifecycleState: 'retired' }), NOW)).toBeNull();
  });

  it('finds the one active version among several', () => {
    const rows = [v({ version: 1, activationEndsAt: '2026-09-10T00:00:00.000Z' }), v({ version: 2, activationStartsAt: '2026-09-10T00:00:00.000Z' })];
    expect(activeVersion(rows, NOW)?.version).toBe(2);
  });
});

describe('parseWhole — an integer or nothing, never a rounded one', () => {
  it.each([
    ['12', 12],
    ['0', 0],
    [' 7 ', 7],
  ])('%j is %p', (text, value) => expect(parseWhole(text)).toBe(value));

  it.each(['', '1.5', '1e3', '-3', '۱۲', 'abc', '9007199254740993'])('%j is not a whole number the server would take', (text) => {
    expect(parseWhole(text)).toBeNull();
  });
});

/*
 * #321: an activation field means Tehran's wall clock, whatever zone the
 * operator's machine is on. Each case runs under four ambient zones -- UTC,
 * one west, the platform's own, and the furthest east -- so a conversion that
 * fell back to the browser's zone fails in at least three of them.
 */
describe.each(['UTC', 'America/Los_Angeles', 'Asia/Tehran', 'Pacific/Kiritimati'])('activation fields, operator on %s', (zone) => {
  withAmbientZone(zone);

  it('really is running on that zone', () => {
    expect(ambientZone()).toBe(zone);
  });

  it('reads 09:00 as 09:00 Tehran — 05:30 UTC — and shows it back as 09:00', () => {
    expect(localInputToIso('2026-01-01T09:00')).toBe('2026-01-01T05:30:00.000Z');
    expect(isoToLocalInput('2026-01-01T05:30:00.000Z')).toBe('2026-01-01T09:00');
  });

  it.each([
    ['Tehran midnight is the previous UTC day', '2026-01-01T00:00', '2025-12-31T20:30:00.000Z'],
    ['the last minute of a Tehran day', '2025-12-31T23:59', '2025-12-31T20:29:00.000Z'],
    ['Nowruz, 02:00', '2026-03-21T02:00', '2026-03-20T22:30:00.000Z'],
    ['a leap day', '2028-02-29T12:00', '2028-02-29T08:30:00.000Z'],
    // Iran kept summer time until 2022: +04:30, not a hardcoded +03:30.
    ['a 2021 summer date, when Tehran was +04:30', '2021-06-01T09:00', '2021-06-01T04:30:00.000Z'],
  ])('%s: %s → %s, and back', (_label, local, iso) => {
    expect(localInputToIso(local)).toBe(iso);
    expect(isoToLocalInput(iso)).toBe(local);
  });

  it('keeps seconds and milliseconds typed with a finer step', () => {
    expect(localInputToIso('2026-01-01T09:00:30')).toBe('2026-01-01T05:30:30.000Z');
    expect(localInputToIso('2026-01-01T09:00:30.5')).toBe('2026-01-01T05:30:30.500Z');
  });

  it.each(['', 'abc', '2026-02-30T09:00', '2026-13-01T09:00', '2026-01-01T24:00', '2026-01-01T09:60', '2026-01-01 09:00', '2026-01-01T09:00Z', '2026-01-01T09:00+03:30'])(
    '%j is not a date and time, so it is no instant at all',
    (value) => expect(localInputToIso(value)).toBeNull(),
  );

  it('shows nothing for no instant', () => {
    expect(isoToLocalInput(null)).toBe('');
    expect(isoToLocalInput('not a date')).toBe('');
  });
});

describe('the activation field labels', () => {
  it('name the zone the fields mean, which is the platform’s', () => {
    expect(PLATFORM_TIMEZONE).toBe('Asia/Tehran');
    expect(ACTIVATION_START_LABEL).toBe('شروع فعال‌سازی (به وقت تهران)');
    expect(ACTIVATION_END_LABEL).toBe('پایان فعال‌سازی (اختیاری، به وقت تهران)');
  });
});

describe('refusalFrom', () => {
  it('keeps the server’s own words and its structured details', () => {
    const terms = refusalFrom(new ApiRequestError('COMMERCIAL_TERMS_INVALID', 'شرایط واردشده معتبر نیست.', 422, { problems: ['tiers must be contiguous'] }));
    expect(terms).toMatchObject({ message: 'شرایط واردشده معتبر نیست.', problems: ['tiers must be contiguous'] });

    const conflict = refusalFrom(new ApiRequestError('COMMERCIAL_LIFECYCLE_CONFLICT', 'x', 409, { detail: 'published' }));
    expect(conflict.detail).toBe('published');
    expect(refusalMeansStale(conflict)).toBe(true);
    expect(refusalMeansStale(refusalFrom(new ApiRequestError('COMMERCIAL_ACTIVATION_OVERLAP', 'x', 409)))).toBe(false);
  });

  it('carries the activation refusal’s counts', () => {
    const refused = refusalFrom(
      new ApiRequestError('COMMERCIAL_ENFORCEMENT_ACTIVATION_REFUSED', 'x', 409, { rolloutState: 'inactive', unresolved: 3, eligible: 10 }),
    );
    expect(refused.counts).toEqual({ unresolved: 3, eligible: 10 });
  });

  it('handles exactly the codes the server can send', () => {
    const exceptions = readFileSync(join(__dirname, '../../../services/commercial-policy/src/catalogue/commercial-catalogue.exceptions.ts'), 'utf8');
    for (const code of ['COMMERCIAL_TERMS_INVALID', 'COMMERCIAL_LIFECYCLE_CONFLICT', 'COMMERCIAL_NOT_FOUND', 'COMMERCIAL_ENFORCEMENT_ACTIVATION_REFUSED']) {
      expect(exceptions).toContain(`'${code}'`);
    }
    expect(exceptions).toMatch(/COMMERCIAL_TERMS_INVALID[\s\S]{0,200}problems/);
    expect(exceptions).toMatch(/COMMERCIAL_LIFECYCLE_CONFLICT[\s\S]{0,200}detail/);
  });
});
