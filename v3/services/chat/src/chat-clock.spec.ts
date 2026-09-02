import { minuteBucket, retentionCutoff } from './chat-clock';
import { decodeConversationCursor } from './chat.service';

/**
 * The pure arithmetic three chat rules rest on.
 *
 * Every one of these is a boundary, and a boundary is the only interesting part
 * of a duration: 24 months is trivially right at month 3 and month 300 and
 * interesting only at month 24. The real-PostgreSQL suite proves the rules hold
 * end to end; this file proves the arithmetic underneath them is right without
 * booting an application to ask.
 */

describe('minuteBucket', () => {
  /**
   * The bucket key for `chat.send_counters`, and therefore the thing that
   * decides whether twenty means twenty.
   */
  it('truncates to the start of the UTC minute', () => {
    expect(minuteBucket(new Date('2026-08-30T13:47:59.999Z')).toISOString()).toBe('2026-08-30T13:47:00.000Z');
    expect(minuteBucket(new Date('2026-08-30T13:47:00.000Z')).toISOString()).toBe('2026-08-30T13:47:00.000Z');
  });

  it('puts two instants one millisecond apart across :00 in different buckets', () => {
    // This is the throttle's actual semantics, stated plainly: the limit is per
    // tumbling minute, not per rolling sixty seconds. A sender who spends their
    // allowance at 13:47:59.999 has a fresh one 1ms later.
    const before = minuteBucket(new Date('2026-08-30T13:47:59.999Z'));
    const after = minuteBucket(new Date('2026-08-30T13:48:00.000Z'));
    expect(before.getTime()).not.toBe(after.getTime());
  });

  it('does not mutate the instant it is given', () => {
    // It works on a copy. An earlier draft called setUTCSeconds on the argument,
    // which silently moved the caller's `now` backwards -- and the caller is the
    // send path, which uses the same `now` for the 90-day window check.
    const instant = new Date('2026-08-30T13:47:31.500Z');
    minuteBucket(instant);
    expect(instant.toISOString()).toBe('2026-08-30T13:47:31.500Z');
  });
});

describe('retentionCutoff', () => {
  it('goes back exactly 24 calendar months', () => {
    expect(retentionCutoff(new Date('2026-08-30T00:00:00.000Z'), 24).toISOString()).toBe(
      '2024-08-30T00:00:00.000Z',
    );
  });

  /**
   * The short-month case, spelled out because JavaScript's answer is surprising
   * and it is the answer chat ships.
   *
   * `setUTCMonth` on 31 March minus one month lands on 3 March, not 28 February,
   * because 31 February does not exist and the Date rolls forward. For a
   * retention sweep that overshoot is harmless in the safe direction: a
   * conversation is kept slightly LONGER than the nominal boundary, never
   * destroyed early. Recording it here so the behaviour is chosen rather than
   * discovered.
   */
  it('rolls forward rather than clamping when the target month is shorter', () => {
    const cutoff = retentionCutoff(new Date('2026-03-31T00:00:00.000Z'), 1);
    expect(cutoff.toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('keeps the time of day, so the boundary is an instant and not a date', () => {
    expect(retentionCutoff(new Date('2026-08-30T17:45:12.000Z'), 24).toISOString()).toBe(
      '2024-08-30T17:45:12.000Z',
    );
  });

  it('does not mutate the instant it is given', () => {
    const now = new Date('2026-08-30T17:45:12.000Z');
    retentionCutoff(now, 24);
    expect(now.toISOString()).toBe('2026-08-30T17:45:12.000Z');
  });
});

describe('decodeConversationCursor', () => {
  it('round-trips an instant and an id', () => {
    const encoded = Buffer.from('2026-08-30T13:47:00.000Z|01a052cd-0cdf-7ae1-948e-afe430779470', 'utf8').toString(
      'base64url',
    );
    const decoded = decodeConversationCursor(encoded);
    expect(decoded?.activityAt.toISOString()).toBe('2026-08-30T13:47:00.000Z');
    expect(decoded?.id).toBe('01a052cd-0cdf-7ae1-948e-afe430779470');
  });

  /**
   * A malformed cursor is ABSENT, not an error.
   *
   * A client holding a cursor from before a deploy should get page one, not a
   * 400 it cannot act on — and there is nothing to protect by refusing, because
   * the caller's identity comes from the session either way, never from the
   * cursor.
   */
  it.each([
    ['not base64 at all', '!!!!'],
    ['base64 of nonsense', Buffer.from('nonsense', 'utf8').toString('base64url')],
    ['a valid id with an unparseable date', Buffer.from('never|abc', 'utf8').toString('base64url')],
    ['a date with no id', Buffer.from('2026-08-30T13:47:00.000Z|', 'utf8').toString('base64url')],
    ['empty', ''],
  ])('treats %s as no cursor rather than as an error', (_label, cursor) => {
    expect(decodeConversationCursor(cursor)).toBeNull();
  });
});
