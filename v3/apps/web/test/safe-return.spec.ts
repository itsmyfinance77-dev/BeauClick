import { loginHrefReturningTo, safeReturnPath } from '@/lib/safe-return';

/**
 * The `?next=` return path.
 *
 * A login page is the single most valuable place in a product to have an open
 * redirect: `beauclick.example/auth?next=https://evil.example/login` is a
 * phishing page a customer reaches THROUGH the real site, immediately after
 * typing a real OTP, with the real domain in their history — and the redirect
 * happens after authentication, so the destination also gets whatever a
 * referrer carries.
 *
 * `sandbox-callback.spec.ts` records the same class of finding for the sandbox
 * gateway's return leg. These cases are its counterpart for the login flow.
 */
describe('safeReturnPath', () => {
  describe('accepts an absolute path on this origin', () => {
    it.each([
      ['/dashboard'],
      ['/checkout/result?status=succeeded&orderId=o1'],
      ['/bookings#upcoming'],
      ['/providers/01a04a62-7578-7a6f-ad3e-41398619a2f6'],
      ['/search?q=%D9%85%DB%8C%DA%A9%D8%A7%D9%BE'],
      ['/'],
    ])('%s', (path) => {
      expect(safeReturnPath(path)).toBe(path);
    });
  });

  describe('refuses anything that could leave this origin', () => {
    it('refuses an absolute URL', () => {
      expect(safeReturnPath('https://evil.example/login')).toBeNull();
      expect(safeReturnPath('http://evil.example')).toBeNull();
    });

    it('refuses a protocol-relative URL, which resolves off-origin', () => {
      // `//evil.example` is read by the browser as "same scheme, THAT host".
      // The single most commonly missed case.
      expect(safeReturnPath('//evil.example/login')).toBeNull();
      expect(safeReturnPath('///evil.example')).toBeNull();
    });

    it('refuses a backslash, which browsers normalise to a slash and regexes do not', () => {
      expect(safeReturnPath('/\\evil.example')).toBeNull();
      expect(safeReturnPath('\\\\evil.example')).toBeNull();
      expect(safeReturnPath('/dashboard\\..\\..')).toBeNull();
    });

    it('refuses a non-http scheme that `new URL()` parses happily', () => {
      expect(safeReturnPath('javascript:alert(1)')).toBeNull();
      expect(safeReturnPath('data:text/html,<script>alert(1)</script>')).toBeNull();
      expect(safeReturnPath('mailto:someone@example.com')).toBeNull();
    });

    it('refuses a value that does not start with a slash', () => {
      expect(safeReturnPath('dashboard')).toBeNull();
      expect(safeReturnPath('evil.example/login')).toBeNull();
    });

    it('refuses traversal', () => {
      expect(safeReturnPath('/../admin')).toBeNull();
      expect(safeReturnPath('/dashboard/../../etc')).toBeNull();
    });

    it('refuses an INTERIOR control character, which is how a header injection starts', () => {
      // Anchoring the pattern at both ends is what catches these; a partial
      // match would let `/dashboard\n\rLocation: ...` through.
      expect(safeReturnPath('/dashboard\nLocation: https://evil.example')).toBeNull();
      expect(safeReturnPath('/dash\rboard')).toBeNull();
      expect(safeReturnPath('/dash board')).toBeNull();
      expect(safeReturnPath('/dash\tboard')).toBeNull();
    });

    it('strips SURROUNDING whitespace rather than refusing it', () => {
      // Deliberately different from the case above, and worth stating: leading
      // and trailing whitespace in a query parameter is ordinary and harmless
      // once removed, and refusing it would break a link somebody copied with a
      // trailing newline. What must never survive is a control character INSIDE
      // the value, which is the one that could split a header.
      expect(safeReturnPath('  /dashboard  ')).toBe('/dashboard');
      expect(safeReturnPath('/dashboard\r\n')).toBe('/dashboard');
      expect(safeReturnPath('\n/dashboard')).toBe('/dashboard');
    });

    it('refuses junk rather than throwing', () => {
      expect(safeReturnPath('')).toBeNull();
      expect(safeReturnPath('   ')).toBeNull();
      expect(safeReturnPath(null)).toBeNull();
      expect(safeReturnPath(undefined)).toBeNull();
      expect(safeReturnPath(42 as unknown as string)).toBeNull();
      expect(safeReturnPath({} as unknown as string)).toBeNull();
    });

    it('refuses a lookalike that merely CONTAINS an allowed prefix', () => {
      expect(safeReturnPath('https://beauclick.example.evil.example/dashboard')).toBeNull();
      expect(safeReturnPath('//beauclick.example@evil.example/')).toBeNull();
    });
  });
});

describe('loginHrefReturningTo', () => {
  it('encodes a safe destination into the login link', () => {
    const href = loginHrefReturningTo('/checkout/result?status=failed&orderId=o1');
    expect(href.startsWith('/auth?next=')).toBe(true);
    expect(decodeURIComponent(href)).toContain('/checkout/result?status=failed&orderId=o1');
  });

  it('drops an unsafe destination rather than producing no link at all', () => {
    // The customer still gets to a login page; they simply land on the
    // default afterwards. Failing closed here must not mean failing shut.
    expect(loginHrefReturningTo('https://evil.example/login')).toBe('/auth');
    expect(loginHrefReturningTo('//evil.example')).toBe('/auth');
  });

  it('never emits a raw off-origin URL in the link it builds', () => {
    for (const hostile of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
      expect(loginHrefReturningTo(hostile)).not.toContain('evil.example');
      expect(loginHrefReturningTo(hostile)).not.toContain('javascript');
    }
  });
});
