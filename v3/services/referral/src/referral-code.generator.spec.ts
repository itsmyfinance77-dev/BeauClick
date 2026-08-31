import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH, isReferralCodeShape } from '@beauclick/referral-contract';

import { generateReferralCode } from './referral-code.generator';

/**
 * The generator is the security core of Story #11, and almost everything worth
 * proving about it is provable without a database.
 *
 * What is NOT here, deliberately: uniqueness, collision retry, and concurrency.
 * Those are database guarantees — the unique index is the mechanism and pg-mem
 * cannot vouch for it — so they live in `apps/api/test/referral.pg-spec.ts` and
 * are proved against real PostgreSQL or not at all.
 */

/**
 * The generator's source with every comment removed.
 *
 * The structural assertions below are about what the CODE does, and scanning the
 * raw file would make them fail on a docblock that merely names the mistake it
 * is avoiding. Stripping block and line comments is crude — it would mangle a
 * `//` inside a string literal — and it is exact enough here, because this file
 * contains no string literals at all beyond the two import specifiers.
 */
function codeWithoutComments(): string {
  return readFileSync(join(__dirname, 'referral-code.generator.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('generateReferralCode', () => {
  it('produces a code of the contract length from the contract alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateReferralCode();
      expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
      expect(isReferralCodeShape(code)).toBe(true);
    }
  });

  it('never emits a character outside the alphabet across a large sample', () => {
    // 20,000 characters. The excluded glyphs are the ones a reader supplies from
    // memory, so a single leaked `O` is a support ticket rather than a curiosity.
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      for (const character of generateReferralCode()) seen.add(character);
    }
    for (const character of seen) {
      expect(REFERRAL_CODE_ALPHABET).toContain(character);
    }
    for (const excluded of ['I', 'L', 'O', 'U', '0']) {
      expect(seen.has(excluded)).toBe(false);
    }
  });

  it('eventually emits every character in the alphabet', () => {
    // The other direction, and it is what catches a broken rejection bound: if
    // `REJECT_AT` were wrong in the tightening direction the tail of the
    // alphabet would simply never appear, and every assertion above would still
    // pass.
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i += 1) {
      for (const character of generateReferralCode()) seen.add(character);
    }
    expect(seen.size).toBe(REFERRAL_CODE_ALPHABET.length);
  });

  it('is roughly uniform, which is what rejection sampling buys over modulo', () => {
    // With `byte % 31` the first eight characters of the alphabet get 9 of the
    // 256 byte values and the remaining twenty-three get 8 -- about 12% more
    // often. This asserts no such split exists.
    const counts = new Map<string, number>();
    const draws = 20_000;
    for (let i = 0; i < draws; i += 1) {
      for (const character of generateReferralCode()) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    const total = draws * REFERRAL_CODE_LENGTH;
    const expected = total / REFERRAL_CODE_ALPHABET.length;
    const frequencies = [...counts.values()];

    // A generous band -- this is a randomness check, not a statistics exam, and
    // a flaky test here would be worse than a slightly loose one. The 12% modulo
    // bias sits well outside it; ordinary sampling noise at this sample size sits
    // well inside.
    for (const frequency of frequencies) {
      expect(frequency).toBeGreaterThan(expected * 0.9);
      expect(frequency).toBeLessThan(expected * 1.1);
    }

    // And the first eight characters must not be systematically ahead of the
    // rest, which is the specific shape a modulo bias takes.
    const head = REFERRAL_CODE_ALPHABET.slice(0, 8);
    const tail = REFERRAL_CODE_ALPHABET.slice(8);
    const mean = (chars: string) =>
      [...chars].reduce((sum, c) => sum + (counts.get(c) ?? 0), 0) / chars.length;
    expect(mean(head) / mean(tail)).toBeGreaterThan(0.95);
    expect(mean(head) / mean(tail)).toBeLessThan(1.05);
  });

  it('does not repeat itself', () => {
    // Not a uniqueness guarantee -- that is the database's job -- but a smoke
    // test that the generator is not seeded per process or memoised. At ~49.5
    // bits, 5,000 draws colliding even once would be astronomically unlikely.
    const codes = new Set<string>();
    for (let i = 0; i < 5000; i += 1) codes.add(generateReferralCode());
    expect(codes.size).toBe(5000);
  });

  it('takes no arguments, so it cannot be given anything about the owner', () => {
    // The signature IS the property (ADR-035 §3). A generator that accepted a
    // `userId` "for entropy" is exactly the mistake this shape makes
    // unavailable, and `Function.length` is how that stays true after an edit.
    expect(generateReferralCode).toHaveLength(0);
  });

  it('reads no user-derived material and no clock in its source', () => {
    // Structural, and stronger than the arity check alone: a module-scoped
    // import of a clock or a hash would not change the arity but would let
    // user-derived or time-derived material in.
    //
    // Scanned with COMMENTS STRIPPED, which is the difference between testing
    // the implementation and testing the prose around it. The docblock
    // legitimately discusses `Math.random` and a `userId` parameter -- as the
    // mistakes this shape avoids -- and an assertion that failed on the
    // explanation of a rule rather than on a breach of it would train the next
    // reader to delete the explanation.
    const code = codeWithoutComments();
    expect(code).toMatch(/randomBytes/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now|new Date|hrtime/);
    expect(code).not.toMatch(/createHash|createHmac/);
    expect(code).not.toMatch(/userId|ownerUserId|phone/);
  });

  it('never performs a read-before-write availability check', () => {
    // ADR-035 §4. The generator cannot query anything -- it has no repository,
    // no manager, and no import that could reach one -- so "is this code taken"
    // is unrepresentable here rather than merely absent.
    const code = codeWithoutComments();
    expect(code).not.toMatch(/SELECT|findOne|findBy|Repository|EntityManager|DataSource/i);
  });

  it('imports only the CSPRNG and the contract', () => {
    // The import list is the whole attack surface for "where could user-derived
    // material come from". Two imports, both named.
    const imports = codeWithoutComments().match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toHaveLength(2);
    expect(imports.join('\n')).toContain("from 'node:crypto'");
    expect(imports.join('\n')).toContain("from '@beauclick/referral-contract'");
  });
});
