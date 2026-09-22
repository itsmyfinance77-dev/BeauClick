import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiRequestError } from '@/lib/api-client';
import type { LifecycleVersion } from '@/lib/commercial-admin-api';
import {
  activeVersion,
  derivedState,
  isoToLocalInput,
  localInputToIso,
  parseWhole,
  refusalFrom,
  refusalMeansStale,
} from '@/lib/commercial-lifecycle';

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

describe('datetime-local round trip', () => {
  it('keeps the instant', () => {
    const iso = '2026-09-22T09:30:00.000Z';
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
    expect(localInputToIso('')).toBeNull();
    expect(isoToLocalInput(null)).toBe('');
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
