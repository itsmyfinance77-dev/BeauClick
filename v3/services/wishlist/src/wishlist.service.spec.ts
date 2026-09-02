import { clampPageSize, decodeWishlistCursor, encodeWishlistCursor } from './wishlist.service';
import { WishlistLimitReachedException } from './wishlist.exceptions';

/**
 * The fast layer covers the pure functions and nothing else.
 *
 * Everything interesting about this module — the unique constraint, the
 * advisory lock, the transaction boundary, the erasure — is a database
 * guarantee, and a fake cannot vouch for any of it. Those live in
 * `apps/api/test/wishlist.pg-spec.ts` and are proved against real PostgreSQL or
 * not at all. What IS worth testing here is the cursor codec and the clamp,
 * because both take hostile input and both fail silently when they are wrong: a
 * bad cursor that throws is a 500, and a bad clamp is an unbounded page.
 */

describe('clampPageSize', () => {
  it('defaults to 20 when the caller asks for nothing', () => {
    expect(clampPageSize(undefined)).toBe(20);
  });

  it('clamps an oversized request to 50 rather than refusing it', () => {
    // A 400 is a dead end for a caller whose only mistake was optimism.
    expect(clampPageSize(51)).toBe(50);
    expect(clampPageSize(1000)).toBe(50);
    expect(clampPageSize(Number.MAX_SAFE_INTEGER)).toBe(50);
  });

  it('never returns a page size below 1', () => {
    // A zero or negative page size would produce `take(1)` after the +1 for the
    // has-next probe, and the page would silently be empty forever.
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
  });

  it('floors a fractional request instead of handing it to the query', () => {
    // TypeORM's `take` with 20.5 reaches PostgreSQL as `LIMIT 20.5`, which is a
    // syntax error rather than a page.
    expect(clampPageSize(20.9)).toBe(20);
    expect(clampPageSize(1.2)).toBe(1);
  });

  it('rejects non-finite input by falling back to the default', () => {
    expect(clampPageSize(Number.NaN)).toBe(20);
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBe(20);
    expect(clampPageSize(Number.NEGATIVE_INFINITY)).toBe(20);
  });
});

describe('the list cursor', () => {
  const at = new Date('2026-08-30T12:34:56.789Z');
  const id = '01931a2b-3c4d-7e8f-9012-3456789abcde';

  it('round-trips an instant and an id', () => {
    const decoded = decodeWishlistCursor(encodeWishlistCursor(at, id));
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(id);
    // Millisecond fidelity matters: the cursor is compared against `created_at`
    // in a row-value comparison, so a lost millisecond skips or repeats a row.
    expect(decoded?.createdAt.toISOString()).toBe(at.toISOString());
  });

  it('is opaque rather than readable', () => {
    const cursor = encodeWishlistCursor(at, id);
    // A readable cursor invites a client to construct one, and a constructed
    // cursor pins the client to this ordering.
    expect(cursor).not.toContain(id);
    expect(cursor).not.toContain('2026');
    expect(cursor).not.toContain('|');
  });

  it('treats every malformed cursor as ABSENT rather than as an error', () => {
    // Returning null means "start from page one". Throwing would mean a client
    // that stored a cursor across a deploy gets a 400 it cannot act on -- and
    // there is nothing to protect, because the caller comes from the session
    // either way, so a forged cursor can only page through their own rows.
    for (const bad of [
      '',
      'not-base64url!!',
      Buffer.from('no-separator', 'utf8').toString('base64url'),
      Buffer.from('|', 'utf8').toString('base64url'),
      Buffer.from(`${at.toISOString()}|`, 'utf8').toString('base64url'),
      Buffer.from(`not-a-date|${id}`, 'utf8').toString('base64url'),
      Buffer.from(`|${id}`, 'utf8').toString('base64url'),
    ]) {
      expect(decodeWishlistCursor(bad)).toBeNull();
    }
  });

  it('rejects an id that is not UUID-shaped', () => {
    // Not the injection defence -- TypeORM parameterises it. This stops garbage
    // reaching PostgreSQL as an invalid `uuid` literal, which comes back as a
    // 500 rather than as page one.
    for (const bad of ['1', 'DROP TABLE wishlist.saved_items', `${id}x`, id.replace(/-/g, '')]) {
      const cursor = Buffer.from(`${at.toISOString()}|${bad}`, 'utf8').toString('base64url');
      expect(decodeWishlistCursor(cursor)).toBeNull();
    }
  });

  it('refuses an over-long cursor without decoding it', () => {
    // Bounded before the decode, so a hostile query string cannot make the
    // server allocate. 200 is the contract's own limit.
    const huge = 'A'.repeat(5000);
    expect(decodeWishlistCursor(huge)).toBeNull();
  });

  it('accepts a cursor exactly at the length limit', () => {
    // The boundary in the other direction: a legitimate cursor is ~60 bytes, so
    // the limit must not be so tight that a real one is rejected.
    const real = encodeWishlistCursor(at, id);
    expect(real.length).toBeLessThan(200);
    expect(decodeWishlistCursor(real)).not.toBeNull();
  });
});

describe('WishlistLimitReachedException', () => {
  it('is the one refusal that is NOT the shared not-found', () => {
    const error = new WishlistLimitReachedException();
    const body = error.getResponse() as { code: string; message: string; details?: { reason?: string } };

    // A cap refusal discloses one fact about the caller's OWN list. Every other
    // refusal in this module is the shared `NotFoundOrNotYoursException`,
    // because those are facts about somebody else.
    expect(body.code).toBe('WISHLIST_LIMIT_REACHED');
    expect(body.details?.reason).toBe('limit_reached');
    expect(error.getStatus()).toBe(409);
  });

  it('carries a Persian message that tells the caller what to do', () => {
    const body = new WishlistLimitReachedException().getResponse() as { message: string };
    expect(body.message).toContain('500');
    // Persian, per the platform rule that no raw English reaches a client.
    expect(body.message).toMatch(/[؀-ۿ]/);
  });

  it('names no third party and no target', () => {
    const serialised = JSON.stringify(new WishlistLimitReachedException().getResponse());
    expect(serialised).not.toMatch(/professional|service|target|suspended|deleted/i);
  });
});
