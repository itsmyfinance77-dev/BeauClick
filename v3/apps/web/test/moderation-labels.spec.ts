import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_REPORT_REASON_LABEL, UNKNOWN_REASON_LABEL, mediaReportReasonLabel } from '@/lib/moderation-labels';

/**
 * The operator queues' label tables against the server lists they name (#238).
 *
 * Each list is read from the server's SOURCE rather than imported, because the
 * web app does not depend on the server packages — so an added or dropped value
 * is caught here rather than reaching an operator as an English key.
 */

const V3 = join(__dirname, '../../..');

/** The members of a server `export const NAME = [...] as const;` tuple. */
function serverList(file: string, name: string): string[] {
  const source = readFileSync(join(V3, file), 'utf8');
  const start = source.indexOf(`export const ${name} = [`);
  const end = start < 0 ? -1 : source.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found in ${file} — did the server list move?`);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('media report reasons', () => {
  const server = () => serverList('libs/media/src/entities/media-abuse-report.entity.ts', 'ABUSE_REPORT_REASONS');

  it('name exactly the reasons a report can carry', () => {
    expect(server().length).toBeGreaterThanOrEqual(4); // guards an empty parse
    expect(Object.keys(MEDIA_REPORT_REASON_LABEL).sort()).toEqual(server());
  });

  it('show a neutral word, never the raw key, for a reason they have never heard of', () => {
    expect(mediaReportReasonLabel('deepfake')).toBe(UNKNOWN_REASON_LABEL);
    expect(mediaReportReasonLabel('explicit')).toBe('محتوای نامناسب');
  });
});
