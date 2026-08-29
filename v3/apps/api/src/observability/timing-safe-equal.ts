import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` requires equal-length buffers and THROWS otherwise, which
 * would both leak the expected length and turn a wrong-length token into a
 * 500. Hashing both sides first fixes each: SHA-256 digests are always 32
 * bytes, so the comparison is always well-formed and its duration carries no
 * information about the input lengths.
 *
 * Hashing does not weaken the comparison. The digest is not stored, not
 * transmitted, and not used as a credential -- it exists for the length of one
 * comparison, so a preimage attack against it would be an attack against a
 * value the attacker already holds.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}
