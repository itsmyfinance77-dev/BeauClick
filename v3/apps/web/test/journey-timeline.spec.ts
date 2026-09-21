import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIMELINE_KIND_BY_TYPE, UNKNOWN_EVENT_LABEL, timelineKind, timelineLabel } from '@/lib/journey-timeline';

const CONTROLLER = join(__dirname, '../../../services/journey/src/journey.controller.ts');

/** The keys of the server's `TIMELINE_LABELS` table. */
function serverEventTypes(): string[] {
  const source = readFileSync(CONTROLLER, 'utf8');
  const table = source.match(/const TIMELINE_LABELS[^{]*\{([\s\S]*?)\n\};/);
  if (!table) throw new Error('TIMELINE_LABELS not found — did the server table move?');
  return [...table[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]).sort();
}

describe('journey timeline naming', () => {
  it('knows the kind of every event type the server can send — the two tables must not drift', () => {
    const types = serverEventTypes();
    // Guards against passing forever on an empty parse.
    expect(types.length).toBeGreaterThan(5);
    expect(types.filter((t) => !(t in TIMELINE_KIND_BY_TYPE))).toEqual([]);
  });

  it('does not keep a kind for a type the server no longer sends', () => {
    const server = new Set(serverEventTypes());
    expect(Object.keys(TIMELINE_KIND_BY_TYPE).filter((t) => !server.has(t))).toEqual([]);
  });

  it('returns null for an unknown type rather than guessing a kind', () => {
    expect(timelineKind('booking_refunded')).toBeNull();
    expect(timelineKind('goal_created')).toBe('goal');
  });

  it('shows the server’s Persian label as it is', () => {
    expect(timelineLabel({ type: 'goal_created', label: 'هدف زیبایی تعریف شد' })).toBe('هدف زیبایی تعریف شد');
  });

  it('never shows a raw enum key to a customer', () => {
    // The server's own fallback for an unmapped type is to echo the key.
    expect(timelineLabel({ type: 'booking_refunded', label: 'booking_refunded' })).toBe(UNKNOWN_EVENT_LABEL);
    expect(timelineLabel({ type: 'x', label: 'some_other_key' })).toBe(UNKNOWN_EVENT_LABEL);
  });
});
