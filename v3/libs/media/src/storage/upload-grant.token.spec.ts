import { InvalidUploadTokenError, signUploadToken, verifyUploadToken } from './upload-grant.token';

const SECRET = 'test-only-upload-secret';
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

function claims(overrides: Partial<Parameters<typeof signUploadToken>[0]> = {}) {
  return {
    k: 'public/portfolio/0192f000-0000-7000-8000-000000000001',
    m: '0192f000-0000-7000-8000-000000000001',
    c: 'image/png',
    n: 1024,
    e: Math.floor(NOW / 1000) + 900,
    ...overrides,
  };
}

/**
 * The local driver's upload credential.
 *
 * The property under test is that this is NOT WEAKER than the presigned S3
 * URL it stands in for. A presigned PUT authorizes one key, pins the content
 * type, and expires; if this token did less, the local driver would be passing
 * tests the real driver would fail, which is the exact failure mode the
 * payment sandbox's own gate exists to prevent.
 */
describe('upload grant token', () => {
  it('round-trips the claims it was signed with', () => {
    const token = signUploadToken(claims(), SECRET);
    expect(verifyUploadToken(token, SECRET, NOW)).toEqual(claims());
  });

  it('refuses a token signed with a different secret', () => {
    const token = signUploadToken(claims(), 'some-other-secret');
    expect(() => verifyUploadToken(token, SECRET, NOW)).toThrow(InvalidUploadTokenError);
  });

  it('refuses a token whose claims were edited after signing', () => {
    // The attack: take a legitimate grant for your own 1 KB avatar and rewrite
    // the object key to somebody else's, or the size to 500 MB. Both are one
    // base64 decode away in a browser's dev tools.
    const token = signUploadToken(claims(), SECRET);
    const [body, mac] = token.split('.');
    const tampered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    tampered.k = 'public/portfolio/somebody-elses-object';
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${mac}`;

    expect(() => verifyUploadToken(forged, SECRET, NOW)).toThrow(InvalidUploadTokenError);
  });

  it('refuses an expired token', () => {
    const token = signUploadToken(claims({ e: Math.floor(NOW / 1000) - 1 }), SECRET);
    expect(() => verifyUploadToken(token, SECRET, NOW)).toThrow(InvalidUploadTokenError);
  });

  it('treats the expiry boundary as expired rather than valid', () => {
    const token = signUploadToken(claims({ e: Math.floor(NOW / 1000) }), SECRET);
    expect(() => verifyUploadToken(token, SECRET, NOW)).toThrow(InvalidUploadTokenError);
  });

  it('refuses structurally malformed tokens without throwing anything but its own error', () => {
    // `timingSafeEqual` throws a RangeError on a length mismatch rather than
    // returning false, so a signature of the wrong length would escape as an
    // unhandled 500 -- and the difference between a 500 and a 404 is an oracle
    // for whoever is probing.
    for (const bad of ['', '.', 'nodot', 'a.b', 'a.b.c', 'êêê.êêê']) {
      expect(() => verifyUploadToken(bad, SECRET, NOW)).toThrow(InvalidUploadTokenError);
    }
  });

  it('gives every failure the same message, so nothing can be learned from which one it was', () => {
    const messages = new Set<string>();
    for (const token of [
      'malformed',
      signUploadToken(claims(), 'wrong-secret'),
      signUploadToken(claims({ e: Math.floor(NOW / 1000) - 60 }), SECRET),
    ]) {
      try {
        verifyUploadToken(token, SECRET, NOW);
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });
});
