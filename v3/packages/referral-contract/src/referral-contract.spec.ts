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
 * failing. Some are owner decisions (`V32-DEC-033`'s invite format and share
 * channels); the alphabet and length are the parameters ADR-035 §3 chose and
 * flagged for ratification, which makes pinning them here more important rather
 * than less — an unratified constant that drifts silently is the worst of both.
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
    // that control belongs to Story #12 and does not exist yet, and a foundation
    // must not depend on a guard a later story owns.
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

  it('has no attribution or lifecycle vocabulary — that is Story #27 onward', () => {
    const exported = Object.keys(contract);
    for (const forbidden of [
      'REFERRAL_STATES',
      'ReferralState',
      'REFERRAL_CLAIM_REASONS',
      'ReferralAttribution',
      'REFERRAL_QUALIFICATION',
    ]) {
      expect(exported).not.toContain(forbidden);
    }
    for (const name of exported) {
      expect(name).not.toMatch(/attribut|qualif|referee|referrer|claim|revers/i);
    }
  });

  it('has no count, expiry, or share-tracking export of any kind', () => {
    for (const name of Object.keys(contract)) {
      expect(name).not.toMatch(/count|total|expir|ttl|tracking|pixel/i);
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
