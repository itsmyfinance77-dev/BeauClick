import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as contract from './wishlist-contract';
import {
  WISHLIST_DEFAULT_PAGE_SIZE,
  WISHLIST_MAX_CURSOR_LENGTH,
  WISHLIST_MAX_PAGE_SIZE,
  WISHLIST_MAX_SAVED_ITEMS,
  WISHLIST_REFUSAL_REASONS,
  WISHLIST_TARGET_STATES,
  WISHLIST_TARGET_TYPES,
  isWishlistTargetState,
  isWishlistTargetType,
  wishlistTargetKey,
} from './wishlist-contract';

/**
 * These assertions look trivial and are not.
 *
 * Each one pins a number or a member that an owner decided and that a later
 * edit could change without anything else failing. `V32-DEC-020` and
 * `V32-DEC-021` are the authority; this file is where a silent drift away from
 * them becomes a red test rather than a shipped behaviour change.
 */
describe('wishlist contract vocabularies', () => {
  it('offers exactly the two approved target types', () => {
    // Compared against a LITERAL rather than against a derived value: a test
    // that reads the constant it is checking proves only that the constant
    // equals itself. `business` and `portfolio` are absent by decision --
    // businesses have no public route or search document at all, and a
    // portfolio item id does not survive a remove-and-re-add.
    expect([...WISHLIST_TARGET_TYPES]).toEqual(['professional', 'service']);
  });

  it('recognises approved target types and rejects everything else', () => {
    expect(isWishlistTargetType('professional')).toBe(true);
    expect(isWishlistTargetType('service')).toBe(true);
    expect(isWishlistTargetType('business')).toBe(false);
    expect(isWishlistTargetType('portfolio')).toBe(false);
    expect(isWishlistTargetType('PROFESSIONAL')).toBe(false);
    expect(isWishlistTargetType('')).toBe(false);
    expect(isWishlistTargetType(null)).toBe(false);
    expect(isWishlistTargetType(undefined)).toBe(false);
    expect(isWishlistTargetType(7)).toBe(false);
    // `Object.prototype` members must not pass a membership check written with
    // `includes` on an array -- they would with a naive object-key lookup.
    expect(isWishlistTargetType('toString')).toBe(false);
    expect(isWishlistTargetType('constructor')).toBe(false);
  });

  it('carries the owner-decided limits verbatim', () => {
    expect(WISHLIST_MAX_SAVED_ITEMS).toBe(500);
    expect(WISHLIST_DEFAULT_PAGE_SIZE).toBe(20);
    expect(WISHLIST_MAX_PAGE_SIZE).toBe(50);
  });

  it('keeps the default page size inside the maximum', () => {
    // A default above the maximum is a contract that refuses its own default.
    expect(WISHLIST_DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(WISHLIST_MAX_PAGE_SIZE);
    expect(WISHLIST_MAX_PAGE_SIZE).toBeLessThan(WISHLIST_MAX_SAVED_ITEMS);
    expect(WISHLIST_MAX_CURSOR_LENGTH).toBeGreaterThan(0);
  });

  it('exposes no refusal reason that distinguishes WHY a target is unavailable', () => {
    expect([...WISHLIST_REFUSAL_REASONS]).toEqual(['target_unavailable', 'limit_reached']);

    // The load-bearing half. Deleted, suspended, revoked, and never-existed all
    // collapse into one reason, because distinguishing them would tell a caller
    // what the platform has decided about a named third party.
    for (const forbidden of [
      'target_deleted',
      'target_suspended',
      'target_revoked',
      'target_not_found',
      'target_unverified',
      'professional_suspended',
    ]) {
      expect(WISHLIST_REFUSAL_REASONS as readonly string[]).not.toContain(forbidden);
    }
  });
});

/**
 * The target-state vocabulary Story #8 refused to declare and Story #9 owns.
 *
 * Story #8's spec asserted these names were ABSENT, so adding them required
 * editing that assertion — which is the reviewable act it existed to force. The
 * assertions below are its replacement, and they are the stricter half: the
 * vocabulary now exists, so what matters is that it stays two-valued.
 */
describe('target state (V3.2-C Story #9)', () => {
  it('offers exactly two states, and neither carries a cause', () => {
    // Against a LITERAL, independently written. A third member — `deleted`,
    // `suspended`, `revoked`, or anything else naming WHY — would turn every
    // customer's saved list into a live feed of moderation and verification
    // decisions about named third parties.
    expect([...WISHLIST_TARGET_STATES]).toEqual(['available', 'unavailable']);
    expect(WISHLIST_TARGET_STATES).toHaveLength(2);
  });

  it('recognises the two states and rejects every cause-bearing value', () => {
    expect(isWishlistTargetState('available')).toBe(true);
    expect(isWishlistTargetState('unavailable')).toBe(true);

    for (const forbidden of [
      'deleted',
      'suspended',
      'revoked',
      'not_found',
      'unverified',
      'pending',
      'rejected',
      'unavailable_deleted',
      'AVAILABLE',
      '',
    ]) {
      expect(isWishlistTargetState(forbidden)).toBe(false);
    }
    expect(isWishlistTargetState(null)).toBe(false);
    expect(isWishlistTargetState(undefined)).toBe(false);
    expect(isWishlistTargetState(true)).toBe(false);
    // `Object.prototype` members must not pass a membership check written with
    // `includes` on an array.
    expect(isWishlistTargetState('toString')).toBe(false);
  });

  it('has exactly one unavailable state for every unavailable cause', () => {
    // The property stated as the test the implementation must satisfy: however
    // many internal situations mean "gone", the contract can express one.
    const causes = ['soft-deleted', 'owner soft-deleted', 'owner suspended', 'owner revoked', 'never existed'];
    const renderable = new Set(causes.map(() => 'unavailable' as const));
    expect(renderable.size).toBe(1);
    expect(WISHLIST_TARGET_STATES.filter((s) => s !== 'available')).toEqual(['unavailable']);
  });

  it('keys a target by type AND id, so the two id spaces cannot collide', () => {
    // A professional id and a service id are both UUIDv7 from the same
    // generator. Keyed by id alone, a service saved by one customer would mark a
    // professional as saved for them the moment the two ids matched.
    const id = '01931a2b-3c4d-7e8f-9012-3456789abcde';
    expect(wishlistTargetKey({ targetType: 'professional', targetId: id })).toBe(`professional:${id}`);
    expect(wishlistTargetKey({ targetType: 'service', targetId: id })).toBe(`service:${id}`);
    expect(wishlistTargetKey({ targetType: 'professional', targetId: id })).not.toBe(
      wishlistTargetKey({ targetType: 'service', targetId: id }),
    );
  });
});

describe('what the contract deliberately does not expose', () => {
  it('exposes no cause, reason, or timestamp beside the target state', () => {
    // Namespace import, so this asserts the MODULE's whole export surface
    // rather than whatever names this file happened to destructure.
    const exported = Object.keys(contract);

    for (const forbidden of [
      'WISHLIST_UNAVAILABLE_REASONS',
      'WishlistUnavailableReason',
      'WISHLIST_TARGET_STATE_CAUSES',
      'WishlistTargetStateDetail',
      'WISHLIST_VERIFICATION_STATUSES',
    ]) {
      expect(exported).not.toContain(forbidden);
    }

    // Nothing exported may name an internal provider state or a moment the
    // platform acted, in any casing.
    //
    // `reason` is NOT in this pattern, and the exception is deliberate rather
    // than an oversight: `WISHLIST_REFUSAL_REASONS` legitimately carries the
    // word, and its own test above proves it collapses every unavailable cause
    // into `target_unavailable`. A pattern that forbade the word outright would
    // have to be weakened the moment somebody read it, which is worse than one
    // that forbids exactly the things that must not exist.
    for (const name of exported) {
      expect(name).not.toMatch(/suspend|revok|verification|deletedat|unavailableat/i);
    }
  });

  it('has no count, popularity, or display export of any kind', () => {
    const exported = Object.keys(contract);

    // A popularity count is refused outright by `V32-DEC-021`, and a display
    // field would make this package a second definition of the catalogue's
    // public shape. Neither can appear here without failing this test first.
    for (const name of exported) {
      expect(name).not.toMatch(/count|popular|saves|display|avatar|price|rating/i);
    }
  });

  it('declares no runtime dependency', () => {
    // The whole reason this package exists. If somebody adds a dependency, every
    // test above still passes and the browser bundle grows silently -- so the
    // assertion is on the manifest, read from disk rather than imported, so it
    // sees what pnpm and the bundler see.
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });
});
