import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as contract from './referral-contract';
import {
  REFERRAL_CODE_ALPHABET,
  REFERRAL_CODE_LENGTH,
  REFERRAL_FALLBACK_SHARE_CHANNELS,
  REFERRAL_INVITE_PATH_SEGMENT,
  REFERRAL_SHARE_CHANNELS,
  REFERRAL_SHARE_TITLE,
  buildReferralInviteUrl,
  buildReferralShareText,
  isReferralCodeShape,
} from './referral-contract';

/**
 * These assertions look trivial and are not.
 *
 * Each pins a value that a later edit could change without anything else
 * failing. All of them are owner decisions: `V32-DEC-033` fixes the invite
 * format and the share channels, and `V32-DEC-034` ratified the alphabet and
 * the length on 2026-08-31 (ADR-035 §3). They are binding contract values, which
 * makes pinning them here more important rather than less — a ratified constant
 * that drifted silently would put this package in contradiction with a closed
 * decision, and nothing else would notice.
 */
describe('the referral code alphabet and length', () => {
  it('is Crockford Base32 minus the ambiguous glyphs, as a literal', () => {
    // Compared against a LITERAL rather than a derived value: a test that
    // reconstructs the constant it is checking proves only that the constant
    // equals itself.
    expect(REFERRAL_CODE_ALPHABET).toBe('123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(REFERRAL_CODE_LENGTH).toBe(10);
  });

  it('excludes every glyph a reader confuses, and keeps the one that is now safe', () => {
    // `I`/`L` are out because of `1`; `O` is out because of `0`, and `0` is then
    // out too; `U` is out to avoid accidental obscenity in a string a customer
    // sends to a friend.
    for (const ambiguous of ['I', 'L', 'O', 'U', '0']) {
      expect(REFERRAL_CODE_ALPHABET).not.toContain(ambiguous);
    }
    // `1` is KEPT. With `I` and `L` gone there is nothing left to confuse it
    // with, and dropping it would cost entropy for no reader benefit.
    expect(REFERRAL_CODE_ALPHABET).toContain('1');
  });

  it('is uppercase only and has no duplicate character', () => {
    expect(REFERRAL_CODE_ALPHABET).toBe(REFERRAL_CODE_ALPHABET.toUpperCase());
    // A duplicated character would silently bias generation toward it while
    // every other assertion here still passed.
    expect(new Set(REFERRAL_CODE_ALPHABET).size).toBe(REFERRAL_CODE_ALPHABET.length);
    expect(REFERRAL_CODE_ALPHABET).toHaveLength(31);
  });

  it('carries enough entropy to survive an UNTHROTTLED attacker', () => {
    // The reason the length is 10 rather than 8. `V32-DEC-019` throttles the
    // claim route at 10 attempts per hour, which would make 8 comfortable -- but
    // Story #11 generated codes BEFORE that control existed, so the format had
    // to stand on its own. Story #27 has since built the throttle (see
    // `REFERRAL_CLAIM_ATTEMPTS_PER_HOUR`), and this assertion deliberately still
    // ignores it: the length is justified WITHOUT the guard, which is the
    // property that mattered and the reason eight was refused.
    const bits = REFERRAL_CODE_LENGTH * Math.log2(REFERRAL_CODE_ALPHABET.length);
    expect(bits).toBeGreaterThan(48);
  });
});

describe('isReferralCodeShape', () => {
  const valid = 'A1B2C3D4E5';

  it('accepts a well-formed code', () => {
    expect(valid).toHaveLength(REFERRAL_CODE_LENGTH);
    expect(isReferralCodeShape(valid)).toBe(true);
  });

  it('rejects the wrong length in both directions', () => {
    expect(isReferralCodeShape(valid.slice(0, 9))).toBe(false);
    expect(isReferralCodeShape(`${valid}A`)).toBe(false);
    expect(isReferralCodeShape('')).toBe(false);
  });

  it('rejects a character outside the alphabet, including the excluded glyphs', () => {
    for (const bad of ['I', 'L', 'O', 'U', '0', '-', ' ', 'a']) {
      expect(isReferralCodeShape(`${bad}23456789A`)).toBe(false);
    }
  });

  it('is case-sensitive rather than quietly upper-casing', () => {
    // Quietly upper-casing would mean the client and the server disagreed about
    // what the caller actually typed, which is how a claim route starts
    // accepting a code the customer never had.
    expect(isReferralCodeShape(valid.toLowerCase())).toBe(false);
  });

  it('rejects non-strings without throwing', () => {
    for (const bad of [null, undefined, 7, {}, [], true]) {
      expect(isReferralCodeShape(bad)).toBe(false);
    }
    // `Object.prototype` members must not pass a membership check.
    expect(isReferralCodeShape('constructor')).toBe(false);
  });

  it('says nothing about existence or ownership', () => {
    // Shape only. A well-formed string that was never issued still passes, and
    // that is correct: whether a code exists is a question only the server can
    // answer, and Story #27 owns the route that answers it.
    expect(isReferralCodeShape('ZZZZZZZZZZ')).toBe(true);
  });
});

describe('the invite link', () => {
  it('is {origin}/invite/{code}, exactly as V32-DEC-033 fixes it', () => {
    expect(REFERRAL_INVITE_PATH_SEGMENT).toBe('invite');
    expect(buildReferralInviteUrl('https://beauclick.example', 'A1B2C3D4E5')).toBe(
      'https://beauclick.example/invite/A1B2C3D4E5',
    );
  });

  it('tolerates a trailing slash on the origin rather than doubling it', () => {
    // The single most common way a deployment gets PUBLIC_WEB_BASE_URL slightly
    // wrong, and a doubled slash in a customer-visible link is worse than a
    // lenient join.
    expect(buildReferralInviteUrl('https://beauclick.example/', 'A1B2C3D4E5')).toBe(
      'https://beauclick.example/invite/A1B2C3D4E5',
    );
  });

  it('carries the code and nothing else — no id, phone, name, or signature', () => {
    const url = buildReferralInviteUrl('https://beauclick.example', 'A1B2C3D4E5');
    // No query string at all is the strongest form of this: there is nowhere for
    // a tracking parameter or a signature to be added without failing here.
    expect(url).not.toContain('?');
    expect(url).not.toContain('#');
    expect(new URL(url).pathname).toBe('/invite/A1B2C3D4E5');
  });
});

describe('sharing', () => {
  it('offers exactly the three approved channels', () => {
    expect([...REFERRAL_SHARE_CHANNELS]).toEqual(['copy_code', 'copy_link', 'native_share']);
  });

  it('names no vendor channel, because every one of them is externally gated', () => {
    // Platform-sent SMS and email are dependency-ledger rows 6 and 7, push is
    // V3.3-B/V3.4-A, and social-network APIs plus share-tracking pixels are
    // refused outright. A member here would be a button somebody builds.
    for (const gated of ['sms', 'email', 'push', 'whatsapp', 'telegram', 'instagram', 'twitter', 'facebook']) {
      expect(REFERRAL_SHARE_CHANNELS as readonly string[]).not.toContain(gated);
    }
  });

  it('keeps native share OUT of the unconditional fallbacks', () => {
    // `navigator.share` is absent on most desktop browsers and refused outside a
    // user gesture where it exists. A surface that degraded to it would have no
    // share capability at all on the platforms most used for pasting a link into
    // a chat window.
    expect([...REFERRAL_FALLBACK_SHARE_CHANNELS]).toEqual(['copy_code', 'copy_link']);
    expect(REFERRAL_FALLBACK_SHARE_CHANNELS).not.toContain('native_share');
  });

  it('builds share text from a fixed template plus the code, and nothing else', () => {
    const text = buildReferralShareText('A1B2C3D4E5');
    expect(text).toContain('A1B2C3D4E5');
    // Same template, different code -> the ONLY difference is the code.
    expect(buildReferralShareText('ZZZZZZZZZZ')).toBe(text.replace('A1B2C3D4E5', 'ZZZZZZZZZZ'));
  });

  it('never claims the platform sent the invitation', () => {
    // `V32-DEC-033`: no milestone artefact may state or imply that BeauClick
    // sent an invite. The referrer sends it.
    const text = buildReferralShareText('A1B2C3D4E5');
    for (const forbidden of ['فرستاد', 'ارسال کرد', 'دعوت کرد', 'برای شما ارسال']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('promises no reward, because both values are zero', () => {
    // `V32-DEC-016` sets both sides to 0 as an honest disabled state. Copy
    // promising a benefit that pays nothing is the dishonest version of it.
    const text = `${REFERRAL_SHARE_TITLE} ${buildReferralShareText('A1B2C3D4E5')}`;
    for (const forbidden of ['امتیاز', 'جایزه', 'هدیه', 'تخفیف', 'پاداش']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('is Persian, per the platform rule that no raw English reaches a client', () => {
    expect(REFERRAL_SHARE_TITLE).toMatch(/[؀-ۿ]/);
    expect(buildReferralShareText('A1B2C3D4E5')).toMatch(/[؀-ۿ]/);
  });
});

describe('what the contract deliberately does not expose', () => {
  it('has no reward, point, or cap export', () => {
    // Namespace import, so this asserts the MODULE's whole export surface rather
    // than whatever names this file happened to destructure.
    for (const name of Object.keys(contract)) {
      expect(name).not.toMatch(/reward|point|cap|bonus|credit|discount/i);
    }
  });

  it('has no QUALIFICATION or REVERSAL vocabulary — that is Story #12 onward', () => {
    // Until Story #27 this case also refused `attribut|referee|referrer|claim`,
    // and its own title said "that is Story #27 onward". This IS that story, so
    // the attribution half is lifted deliberately rather than by accident — and
    // the rest is kept, because #12 and #28 are still ahead.
    //
    // What remains forbidden is narrower and sharper than the old blanket rule:
    // no lifecycle STATE vocabulary of any kind. `V32-DEC-019` permits a
    // capped-or-refused enum on the referral ROW, which is a column in Story
    // #12's migration and not a thing a browser is told.
    const exported = Object.keys(contract);
    for (const forbidden of [
      'REFERRAL_STATES',
      'ReferralState',
      'REFERRAL_CLAIM_REASONS',
      'ReferralClaimRefusalReason',
      'REFERRAL_QUALIFICATION',
      'ReferralQualified',
      'ReferralReversed',
      'ReferralAttributed',
    ]) {
      expect(exported).not.toContain(forbidden);
    }
    for (const name of exported) {
      expect(name).not.toMatch(/qualif|revers|clawback|refund/i);
    }
  });

  /**
   * An export name, split into whole lowercase words.
   *
   * `REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS` -> ['referral','claim','max','account','age','days']
   *
   * Written because the substring form of the case below asserted
   * `not.toMatch(/count/i)` and failed on **ACCOUNT** — a false positive that
   * would have been "fixed" by weakening the rule that catches `SHARE_COUNT`.
   * Splitting on `_` and on camelCase boundaries first means the rule can stay
   * strict about the word it actually means.
   */
  const wordsOf = (name: string): string[] =>
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .split('_')
      .filter(Boolean);

  it('has no count or share-tracking export of any kind', () => {
    // `V32-DEC-033` refuses share-tracking outright, and no story exports a
    // number of people, invites, or shares.
    const forbidden = new Set(['count', 'counts', 'counter', 'counters', 'total', 'totals', 'tracking', 'pixel', 'funnel', 'conversion', 'conversions']);

    for (const name of Object.keys(contract)) {
      for (const word of wordsOf(name)) {
        expect(forbidden.has(word)).toBe(false);
      }
    }

    // Non-vacuity: the splitter must actually produce the words the rule tests,
    // or the loop above passes by finding nothing to check.
    expect(wordsOf('REFERRAL_SHARE_COUNT')).toContain('count');
    expect(wordsOf('referralShareCount')).toContain('count');
    // ...and must NOT report the false positive that motivated it.
    expect(wordsOf('REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS')).not.toContain('count');
  });

  it('exports exactly ONE expiry, and it is the attribution one', () => {
    // This assertion was `not.toMatch(/expir|ttl/i)` across every export until
    // Story #27, and narrowing it rather than deleting it is the point.
    //
    // Story #11's blanket refusal was really about ONE thing: `V32-DEC-033`
    // gives the invite link and the code no independent expiry, and a constant
    // here would have been the third clock that decision refuses. Story #27
    // introduces a genuinely different object — a PENDING ATTRIBUTION, which
    // `V32-DEC-017` expires at 90 days — so the blanket rule would now forbid a
    // ratified value.
    //
    // Narrowed, so the original guarantee still holds where it was aimed: the
    // only expiry in this package is the attribution's, and a `CODE_EXPIRY` or
    // `INVITE_TTL` slipping in later still fails.
    const expiryExports = Object.keys(contract).filter((name) => /expir|ttl/i.test(name));
    expect(expiryExports).toEqual(['REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS']);

    for (const name of Object.keys(contract)) {
      expect(name).not.toMatch(/code_expir|invite_expir|link_expir|code_ttl|invite_ttl|link_ttl/i);
    }
  });

  it('declares no runtime dependency', () => {
    // The whole reason this package exists. If somebody adds a dependency every
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

  it('imports nothing at all', () => {
    // Stronger than the manifest check and independent of it: a relative import
    // of a domain file would not appear in `dependencies` yet would still drag
    // the domain into a browser bundle.
    const source = readFileSync(join(__dirname, 'referral-contract.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

/**
 * The attribution claim contract (V3.2-C Story #27, ADR-036).
 *
 * Every constant below is an owner decision, so each is pinned against a
 * LITERAL rather than against a derived value: a test that reconstructs the
 * constant it is checking proves only that the constant equals itself.
 */
describe('the attribution claim contract', () => {
  it('pins the three ratified limits as literals', () => {
    expect(contract.REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS).toBe(30);
    expect(contract.REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS).toBe(90);
    expect(contract.REFERRAL_CLAIM_ATTEMPTS_PER_HOUR).toBe(10);
  });

  it('keeps the throttle at the rate V32-DEC-034 priced the code length against', () => {
    // Not a decorative cross-check. `V32-DEC-034` justifies ten characters
    // rather than eight by pricing 31^10 against EXACTLY this rate, and quotes
    // the result: an exhaustive search of about 9.35 billion years. If somebody
    // raised the throttle without reopening that decision, the ratified code
    // length would silently lose the argument that produced it.
    const keyspace = Math.pow(REFERRAL_CODE_ALPHABET.length, REFERRAL_CODE_LENGTH);
    const yearsToExhaust = keyspace / (contract.REFERRAL_CLAIM_ATTEMPTS_PER_HOUR * 24 * 365);

    expect(keyspace).toBeCloseTo(8.196e14, -12);
    // Billions of years, as the decision states. The bound is what matters, not
    // the exact figure, so this is asserted as an order of magnitude.
    expect(yearsToExhaust).toBeGreaterThan(9e9);
  });

  it('exports ONE refusal code and no refusal vocabulary', () => {
    // The security property, asserted structurally. `V32-DEC-019` collapses all
    // six refusal cases into one answer, so a union of reasons here would be a
    // set of names for distinctions the server is forbidden to make.
    expect(contract.REFERRAL_CLAIM_REFUSED_CODE).toBe('REFERRAL_CLAIM_REFUSED');

    for (const name of Object.keys(contract)) {
      // No `REFERRAL_CLAIM_REFUSAL_REASONS`, no `..._REASON`, no plural set.
      expect(name).not.toMatch(/reason|refusals|_CAUSES?$/i);
    }
  });

  it('names no eligibility cause anywhere in the package source', () => {
    // Stronger than the export check and independent of it: a cause that leaked
    // as a doc-visible string constant would not be an export name.
    //
    // Deliberately scoped to STRING LITERALS rather than the whole file, because
    // the prose necessarily discusses the six cases by name — explaining why
    // they are indistinguishable requires naming them, and a rule that forbade
    // that would forbid the explanation rather than the leak.
    const source = readFileSync(join(__dirname, 'referral-contract.ts'), 'utf8');
    const literals = source.match(/'[^']*'/g) ?? [];

    for (const literal of literals) {
      expect(literal).not.toMatch(/unknown_code|own_code|already_attributed|account_too_old|already_booked|revoked/i);
    }
  });

  it('carries no reward, qualification, reversal, or review vocabulary', () => {
    // Stories #12 and #28. `V32-DEC-016` sets both reward values to 0, and a
    // field here would be a promise a client renders before anything can keep
    // it. `V32-DEC-019` refuses manual review, appeals, and overrides outright.
    for (const name of Object.keys(contract)) {
      expect(name).not.toMatch(/reward|qualif|revers|clawback|points|capped|appeal|review|override/i);
    }
  });

  it('carries no device, IP, or fingerprint vocabulary', () => {
    // `V32-DEC-019` refuses alternative (c) outright. The absence is structural:
    // there is no exported name a signal could travel under.
    for (const name of Object.keys(contract)) {
      expect(name).not.toMatch(/device|fingerprint|\bip\b|user_?agent|browser_?id/i);
    }
  });

  it('exposes no referrer identity on a successful claim', () => {
    // A type-level guarantee made observable. `ReferralClaimResult` is an
    // interface and erases at runtime, so the assertion is on the SOURCE of the
    // declaration: the result block must not declare a referrer, referee, user,
    // phone, or code field.
    const source = readFileSync(join(__dirname, 'referral-contract.ts'), 'utf8');
    const block = source.slice(source.indexOf('export interface ReferralClaimResult'));
    const body = block.slice(0, block.indexOf('\n}'));

    // Only the two fields, and both are the caller's own.
    expect(body).toMatch(/readonly attributedAt: string;/);
    expect(body).toMatch(/readonly expiresAt: string;/);
    expect(body).not.toMatch(/^\s*readonly (referrer|referee|owner|user|phone|displayName|code)\w*[?]?:/m);
  });

  it('accepts the code as the ONLY field of a claim request', () => {
    // The single client-controlled claim credential, asserted on the
    // declaration rather than on a runtime shape an interface does not have.
    const source = readFileSync(join(__dirname, 'referral-contract.ts'), 'utf8');
    const block = source.slice(source.indexOf('export interface ReferralClaimRequest'));
    const body = block.slice(0, block.indexOf('\n}'));

    const fields = [...body.matchAll(/^\s*readonly (\w+)[?]?:/gm)].map((match) => match[1]);
    expect(fields).toEqual(['code']);
  });

  it('still refuses every forged identity field name', () => {
    // The list Issue #27 enumerates, checked against the whole package rather
    // than one interface: no export and no declared field may carry any of them.
    const source = readFileSync(join(__dirname, 'referral-contract.ts'), 'utf8');
    const declaredFields = [...source.matchAll(/^\s*readonly (\w+)[?]?:/gm)].map((match) => match[1]);

    for (const forged of [
      'refereeUserId',
      'referrerUserId',
      'ownerUserId',
      'userId',
      'phone',
      'accountCreatedAt',
      'hasCompletedBooking',
      'rewardAmount',
      'attributionStatus',
      'status',
    ]) {
      expect(declaredFields).not.toContain(forged);
    }
  });
});
