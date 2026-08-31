import { randomBytes } from 'node:crypto';

import { REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH } from '@beauclick/referral-contract';

/**
 * Draws a referral code from a CSPRNG (ADR-035 §3).
 *
 * ## Why this is a free function and takes no arguments
 *
 * The signature is the security property. This function **cannot** be passed the
 * owner's id, their phone, a timestamp, or a sequence, because it accepts
 * nothing — so "the code reveals nothing about its owner" is checkable by
 * reading one line rather than by auditing a body. A generator that took a
 * `userId` "for entropy" is exactly the mistake this shape makes unavailable.
 *
 * ## Why `randomBytes` and not `Math.random`
 *
 * `Math.random` is seeded per process and is not cryptographically secure: its
 * output is predictable given enough samples, and a referral code is a **bearer
 * credential** — whoever holds the string can, once attribution exists, claim to
 * have been invited by its owner. `identity`'s OTP service records the same
 * reasoning for the same reason and uses `randomInt` rather than `Math.random`.
 *
 * ## Why rejection sampling and not modulo
 *
 * The alphabet has 31 characters and a byte holds 256 values. `byte % 31` maps
 * 256 values onto 31 buckets unevenly: bytes 0..255 give 9 draws to each of the
 * first eight characters and 8 to the remaining twenty-three, making those eight
 * roughly 12% likelier. Over a ten-character code that is a measurable loss of
 * entropy for a bias nobody would accept if it were stated out loud, and the fix
 * is three lines.
 *
 * So: bytes at or above `REJECT_AT` — the largest multiple of 31 that fits in a
 * byte, 248 — are **discarded and redrawn**. Every accepted byte is uniform over
 * 0..247, which is exactly 8 complete cycles of 31.
 */

/**
 * The first byte value that must be rejected.
 *
 * `256 - (256 % 31)` = `256 - 8` = **248**. Bytes 248..255 would map onto only
 * the first eight characters of the alphabet, so they are thrown away rather
 * than folded in. Computed rather than written as `248` so that ratifying a
 * different alphabet length (ADR-035 §3 flags the parameter) cannot leave a
 * stale constant behind that reintroduces the bias silently.
 */
const REJECT_AT = 256 - (256 % REFERRAL_CODE_ALPHABET.length);

/**
 * How many bytes to draw per attempt.
 *
 * More than the code length on purpose: with a rejection rate of 8/256 (about
 * 3.1%), asking for exactly ten bytes would need a second syscall on roughly
 * one code in four. Drawing a comfortable surplus makes a second draw rare
 * without making the first draw expensive — `randomBytes` costs essentially the
 * same for 10 bytes as for 32.
 *
 * The loop below still handles exhaustion correctly rather than assuming the
 * surplus is always enough, because "rare" is not "never" and a generator that
 * silently returned a short code would produce a value the CHECK constraint
 * rejects at insert time, which reads as a database bug.
 */
const BYTES_PER_DRAW = 32;

/**
 * One freshly generated referral code.
 *
 * Uppercase, `REFERRAL_CODE_LENGTH` characters, drawn uniformly from
 * `REFERRAL_CODE_ALPHABET`. Carries no user-derived material of any kind.
 *
 * This function does **not** check whether the code is already taken, and that
 * is deliberate rather than an omission: a read-then-write availability check is
 * `GAP-04` in miniature, because two concurrent generations that draw the same
 * code both observe it free under `READ COMMITTED` and both proceed. Uniqueness
 * is the database's job, enforced by `uq_referral_codes_code`, and the caller
 * retries on the violation (ADR-035 §4).
 */
export function generateReferralCode(): string {
  let code = '';
  let buffer = randomBytes(BYTES_PER_DRAW);
  let cursor = 0;

  while (code.length < REFERRAL_CODE_LENGTH) {
    if (cursor >= buffer.length) {
      // The surplus ran out to rejections. Rare, and handled rather than
      // assumed away.
      buffer = randomBytes(BYTES_PER_DRAW);
      cursor = 0;
    }

    const byte = buffer[cursor];
    cursor += 1;

    // The rejection. Folding these bytes in with `%` would bias the first eight
    // characters of the alphabet upward.
    if (byte >= REJECT_AT) continue;

    code += REFERRAL_CODE_ALPHABET[byte % REFERRAL_CODE_ALPHABET.length];
  }

  return code;
}

/**
 * The generator, as something the module can inject and a test can substitute.
 *
 * ## Why a token exists for a pure function
 *
 * `generateReferralCode` above is pure and needs no injection to work. What
 * needs the seam is the **collision-retry path**: at ~49.5 bits a natural
 * collision will never be observed, so the only way to prove the retry works is
 * to force one — and forcing one means making the next draw return a value the
 * test chose.
 *
 * A test could instead reach into this module's compiled exports and patch the
 * binding, and an earlier version of the suite did exactly that. It required a
 * relative cross-project import, which `@nx/enforce-module-boundaries` refuses
 * for a good reason: a test that reaches around the package boundary is a test
 * that breaks when the package is restructured, and it is not how any other
 * consumer reaches this code.
 *
 * So the seam is explicit and follows the two the repository already has:
 * `CHAT_CLOCK`, so a test can freeze time without the rule reading a different
 * clock, and `OTP_DEBUG_OBSERVER`, which exists solely so a test can learn a
 * generated code. Same shape, same reason.
 *
 * **It is not a port.** Nothing outside this module implements it, the
 * composition root does not bind it, and `ReferralModule` provides the real
 * implementation by default — so a composition that ignores it entirely gets
 * correct behaviour, which is the opposite of the fail-closed treatment a
 * genuine cross-domain port gets.
 */
export interface ReferralCodeGenerator {
  /** One fresh code. Takes nothing, for the reason `generateReferralCode` records. */
  next(): string;
}

export const REFERRAL_CODE_GENERATOR = Symbol('BEAUCLICK_REFERRAL_CODE_GENERATOR');

/** The real generator, and the module's default binding. */
export const defaultReferralCodeGenerator: ReferralCodeGenerator = {
  next: generateReferralCode,
};
