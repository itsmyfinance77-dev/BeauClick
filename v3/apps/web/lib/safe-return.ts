/**
 * Narrows a caller-supplied "return here after login" value to something safe
 * to hand to the router.
 *
 * ## Why this is not just `router.replace(next)`
 *
 * `?next=` is an open-redirect vector, and a login page is the single most
 * valuable place to have one: a link of the form
 * `beauclick.example/auth?next=https://evil.example/login` is a phishing page
 * a customer arrives at THROUGH THE REAL SITE, immediately after typing a real
 * OTP, with the real domain in their history. The redirect happens after
 * authentication, so it also carries whatever the destination can read from a
 * referrer.
 *
 * The rule here is deliberately the strictest one that still does the job:
 * **an absolute path on this origin, and nothing else.** Not "same host after
 * parsing" — parsing is where the interesting bugs live (`//evil.example`,
 * `https:/\/evil.example`, `/\evil.example`, backslashes that browsers
 * normalise to slashes) — but a positive allow-pattern on the string itself.
 *
 * This mirrors `isAllowedCallback` in `sandbox-callback.ts`, which exists for
 * the same class of problem on the sandbox gateway's return leg, and whose
 * suite records the lookalike-host and protocol-relative cases that motivated
 * it. Sharing that file's reasoning rather than its code, because the two
 * answer different questions: that one validates an ABSOLUTE URL against a
 * configured origin, this one refuses absolute URLs entirely.
 *
 * Returns `null` for anything it does not positively recognise, so a caller's
 * `?? '/dashboard'` is the only fallback and there is no path where a rejected
 * value is used anyway.
 */

/**
 * Path, optional query, optional fragment. No scheme, no authority, no
 * backslash, no whitespace, no control characters.
 *
 * Anchored at both ends: a partial match is what lets
 * `/dashboard\n\rLocation: https://evil.example` through in a laxer check.
 */
const SAFE_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]*$/;

export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  const value = raw.trim();
  if (value === '') return null;

  // Must be an absolute PATH. A value not starting with `/` could be a
  // scheme-relative or bare-host reference the router would resolve
  // unpredictably.
  if (!value.startsWith('/')) return null;

  // `//host` and `/\host` are protocol-relative: the browser reads them as
  // "same scheme, THAT host". Both are caught here rather than by the pattern,
  // because a backslash is normalised to a slash by browsers but is not a
  // slash to a regex.
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (value.includes('\\')) return null;

  // A colon before the first slash would make this parse as a scheme, and
  // `/..` traversal has no meaning in a client-side route but is a signal that
  // the value was built for something else.
  if (value.includes('..')) return null;

  if (!SAFE_PATH.test(value)) return null;

  // Final proof rather than final assertion: resolved against an arbitrary
  // origin, the result must still be on that origin. If any of the checks
  // above missed a normalisation quirk in this browser's URL parser, this
  // catches it.
  try {
    const probe = new URL(value, 'https://beauclick.invalid');
    if (probe.origin !== 'https://beauclick.invalid') return null;
    return `${probe.pathname}${probe.search}${probe.hash}`;
  } catch {
    return null;
  }
}

/**
 * Builds the login link that returns to `here` afterwards.
 *
 * Encodes the destination, and drops it entirely when it is not safe — so a
 * tampered current URL produces a plain login link rather than no link.
 */
export function loginHrefReturningTo(here: string): string {
  const safe = safeReturnPath(here);
  return safe ? `/auth?next=${encodeURIComponent(safe)}` : '/auth';
}
