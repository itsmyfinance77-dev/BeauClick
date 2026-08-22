import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';

/**
 * The named throttler policies. A route selects one with
 * `@Throttle({ <name>: {} })`; anything undecorated gets `default`.
 *
 * Every number here is a provisional ENGINEERING default, not a settled
 * business or infrastructure decision -- the same GAP-10 class as booking's
 * hold window and the commission rate. All are environment-overridable
 * (see `throttlerOptionsFromEnv`) precisely so infrastructure can tune them
 * against real traffic without a code change.
 */
export const THROTTLE_POLICIES = {
  /** Ordinary authenticated app usage. One screen commonly issues several parallel calls. */
  default: { limit: 120, ttl: 60_000 },
  /**
   * Read-heavy discovery: search, autocomplete, provider listing.
   *
   * Grounded in the real client, not guessed: `apps/web/app/search/page.tsx`
   * debounces autocomplete at 250ms, so sustained typing can legitimately
   * produce ~240 requests/minute. A limit below that would break normal
   * usage -- which is exactly why the inert 30/minute default could not
   * simply be switched on as-is.
   */
  read: { limit: 300, ttl: 60_000 },
  /**
   * Side-effecting mutations: booking, checkout, payment, refund, settlement.
   * Deliberately TIGHTER than default -- no legitimate user books thirty
   * times a minute, and every one of these paths costs real work downstream.
   */
  mutation: { limit: 30, ttl: 60_000 },
  /**
   * Auth entry points. Carried over UNCHANGED from the pre-existing
   * (inert) route decorators, including their original reasoning: this is a
   * coarse DoS backstop only. The REAL business rule is OtpService's own
   * 5/phone/hour + 10/IP/hour (V3_SECURITY_MODEL.md §2), and this limit is
   * deliberately set high enough that it never fires before that one does.
   */
  auth: { limit: 100, ttl: 60_000 },
  /** Refresh. Also carried over unchanged from the pre-existing decorator. */
  refresh: { limit: 20, ttl: 60_000 },
} as const;

export type ThrottlePolicyName = keyof typeof THROTTLE_POLICIES;

/** Reads each policy's limit/ttl from the environment, falling back to the default above. */
export function throttlerOptionsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const num = (key: string, fallback: number): number => {
    const raw = Number(env[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };

  return (Object.keys(THROTTLE_POLICIES) as ThrottlePolicyName[]).map((name) => ({
    name,
    limit: num(`THROTTLE_${name.toUpperCase()}_LIMIT`, THROTTLE_POLICIES[name].limit),
    ttl: num(`THROTTLE_${name.toUpperCase()}_TTL_MS`, THROTTLE_POLICIES[name].ttl),
  }));
}

/**
 * Global rate limiting, keyed by the strongest identity the request has
 * actually PROVEN -- never one it merely claims.
 *
 * Two departures from the library default, both load-bearing:
 *
 * **1. Identity.** The stock `getTracker` returns `req.ip` unconditionally,
 * so every authenticated user behind one NAT/corporate egress shares a
 * single bucket and throttles each other. This uses the authenticated user
 * id when one exists, falling back to IP otherwise.
 *
 * The id is read from `req.user`, which is populated by `JwtAuthGuard` from
 * a **cryptographically verified** JWT -- it is not a client-supplied field.
 * A request cannot move itself into another user's bucket by sending a
 * header or body value, because nothing here reads one. This guard is
 * registered AFTER `JwtAuthGuard` in the `APP_GUARD` list for exactly that
 * reason: registered before it, `req.user` would always be undefined and
 * every authenticated request would silently fall back to IP.
 *
 * On `req.ip`: Express returns the direct socket address unless `trust
 * proxy` is enabled, and this application deliberately does NOT enable it.
 * `X-Forwarded-For` is therefore ignored and unspoofable. If a real
 * deployment ever terminates TLS behind a load balancer, enabling `trust
 * proxy` becomes a REQUIRED and security-sensitive change (otherwise every
 * request appears to originate from the balancer and shares one bucket) --
 * and it must be enabled with a specific trusted hop count, never `true`,
 * which would make the header spoofable again. Recorded in
 * V3_SECURITY_MODEL.md rather than left as folklore.
 *
 * **2. Error shape.** The stock guard throws `ThrottlerException` with the
 * English message "ThrottlerException: Too many requests". V3 already
 * defines a 429 contract (`RATE_LIMITED`, Persian) in
 * `BeauClickExceptionFilter`; this throws into that contract instead of
 * around it.
 */
@Injectable()
export class BeauClickThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { userId?: string } | undefined;
    // Namespaced so a user id can never collide with an IP string.
    if (user?.userId) return `user:${user.userId}`;
    return `ip:${(req.ip as string) ?? 'unknown'}`;
  }

  protected async throwThrottlingException(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // Deliberately carries NO retry-after hint, no limit, no remaining
    // count, and no policy name. Those would tell an attacker exactly how
    // much budget they have and which bucket they landed in -- and the
    // library's own `Retry-After` header already covers the legitimate
    // client's need without the body enumerating the policy.
    throw new HttpException(
      { code: 'RATE_LIMITED', message: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً کمی بعد دوباره تلاش کنید.' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
