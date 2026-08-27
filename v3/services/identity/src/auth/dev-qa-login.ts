/**
 * Development-only QA login policy.
 *
 * WHY THIS EXISTS. The product authenticates by OTP, and the environment a
 * QA run executes in deliberately never exposes the generated code
 * (`V3_SECURITY_MODEL.md` §2: never log, return, or persist a plaintext code).
 * That is correct, and it is also why the authenticated browser
 * Definition-of-Done could not be run without SOME sanctioned dev seam. This
 * is that seam, and its entire design is about being impossible to activate
 * anywhere it should not be. Full rationale in `V3.1_DEV_QA_AUTH.md`.
 *
 * THE PRODUCTION GUARANTEE, stated as the one property everything else serves:
 * when `NODE_ENV === 'production'`, this is OFF, unconditionally, regardless of
 * any other variable. `DEV_QA_LOGIN=1` in a production environment does
 * nothing. The two conditions are AND-ed, and the production check is the one
 * that cannot be overridden — there is no env var, header, or body field that
 * turns it back on. A regression test pins exactly that.
 *
 * WHAT IT DOES NOT DO. It does not weaken `verifyOtp`, touch the normal OTP
 * flow, mint a parallel token type, or bypass any authorization. The session
 * it produces is issued by the SAME `TokenService.issuePair` a real login
 * uses, so `req.user`, every ownership resolver, and every capability guard
 * operate on it identically and cannot tell it apart. It only skips the ONE
 * step it must — proving possession of an SMS code nobody can read here — and
 * only for an explicit allow-list of QA phone numbers, so it cannot be used to
 * mint arbitrary identities even in development.
 */
export interface DevQaLoginPolicy {
  /** True ONLY when not production AND the explicit flag is set. */
  enabled: boolean;
  /** The exact phone numbers this seam may authenticate. Empty unless configured. */
  allowedPhones: string[];
}

export function devQaLoginPolicyFromEnv(env: NodeJS.ProcessEnv): DevQaLoginPolicy {
  // The production check is first and load-bearing: it is evaluated on every
  // request, and nothing downstream can re-enable the seam once this is true.
  const isProduction = env.NODE_ENV === 'production';
  const flagged = env.DEV_QA_LOGIN === '1';

  return {
    enabled: !isProduction && flagged,
    // Comma-separated, trimmed, empties dropped. With no list configured the
    // seam authenticates NOBODY even when enabled — a positive allow-list, so
    // the failure mode of a forgotten variable is "nothing works", never
    // "anything works".
    allowedPhones: (env.DEV_QA_LOGIN_PHONES ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
  };
}
