import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { CurrentUser, AuthenticatedUser } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { Public, policy } from '@beauclick/auth';
import { AuthService } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshDto } from './dto/refresh.dto';
import { DevQaLoginDto } from './dto/dev-qa-login.dto';
import { TokenService } from '../token/token.service';
import {
  CookieSettings,
  clearAuthCookies,
  cookieSettingsFromEnv,
  issueCsrfToken,
  readRefreshCookie,
  setRefreshCookie,
} from './refresh-cookie';
import { CsrfPolicy, csrfPolicyFromEnv, evaluateCsrf } from './csrf';
import { DevQaLoginPolicy, devQaLoginPolicyFromEnv } from './dev-qa-login';
import { DevQaLoginNotAvailableException } from './auth.service';
import { canonicalizePhone } from './phone.util';

/**
 * V3_API_CONTRACT_BLUEPRINT.md §2 -- the authentication flow. Every route
 * here is @Public() (no JWT required to call it), which is the deliberate
 * exception to "every route requires auth by default" -- these ARE the
 * routes that establish auth in the first place.
 *
 * Phase 3 adds the httpOnly refresh cookie (ADR-020). The refresh token is
 * carried in a cookie for browser clients and MAY still be supplied in the
 * body -- but the two are not equivalent, and the difference is enforced:
 *
 *   * A request presenting the COOKIE is CSRF-checked, because a cookie is
 *     sent ambiently and is therefore forgeable cross-site. See `csrf.ts`.
 *   * A request presenting the token in the BODY needs no CSRF check, because
 *     a cross-site attacker cannot read the token to put it there in the
 *     first place. This is the path a native mobile client uses.
 *
 * The cookie is preferred when both are present: a client that has a cookie
 * is a browser, and honouring a body token in that case would let a page with
 * XSS downgrade itself out of CSRF protection.
 */
@Controller('v1/auth')
export class AuthController {
  private readonly cookieSettings: CookieSettings;
  private readonly csrfPolicy: CsrfPolicy;

  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {
    this.cookieSettings = cookieSettingsFromEnv(process.env);
    this.csrfPolicy = csrfPolicyFromEnv(process.env);
  }

  // Route-level throttle is a coarse DoS backstop only -- the REAL business
  // rate limit (5/phone/hour, 10/IP/hour, V3_SECURITY_MODEL.md §2) lives in
  // OtpService itself and is what enforces the actual product rule. Set
  // high enough here that it never fires before OtpService's own limit
  // does under realistic traffic.
  @Public()
  @Throttle(policy('auth'))
  @Post('request-otp')
  @HttpCode(HttpStatus.OK)
  async requestOtp(
    @Body() dto: RequestOtpDto,
    @Ip() ip: string,
  ): Promise<{ requested: true; cooldownRemaining: number; expiresInSeconds: number }> {
    const result = await this.auth.requestOtp(dto.phone, dto.purpose, ip, null);
    // Always the same shape/status regardless of whether the phone has an
    // account -- anti-enumeration (V3_SECURITY_MODEL.md §2).
    //
    // `cooldownRemaining` and `expiresInSeconds` are QA-19's additive fields.
    // Both are constants of the OTP policy, identical for every caller, so
    // neither varies with account existence and neither is an oracle. What
    // they buy is a resend button that counts down instead of failing into an
    // unanticipated 429 -- which is the reason QA-19 was excluded from v3.0.1
    // rather than fixed cheaply.
    return { requested: true, cooldownRemaining: result.cooldownRemaining, expiresInSeconds: result.expiresInSeconds };
  }

  @Public()
  @Throttle(policy('auth'))
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.verifyOtpAndLogin(
      dto.phone,
      dto.code,
      dto.purpose,
      (req.headers['x-device-label'] as string) ?? null,
      req.headers['user-agent'] ?? null,
    );

    setRefreshCookie(res, result.tokens.refreshToken, this.cookieSettings);
    const csrfToken = issueCsrfToken(res, this.cookieSettings);

    return {
      accessToken: result.tokens.accessToken,
      // The refresh token is STILL returned in the body, for non-browser
      // clients that have no cookie jar. A browser client must ignore it and
      // keep nothing in localStorage -- and apps/web does exactly that, which
      // is asserted by its own test rather than left to convention.
      refreshToken: result.tokens.refreshToken,
      csrfToken,
      user: result.user,
    };
  }

  /**
   * DEVELOPMENT-ONLY QA login. Establishes a normal session for a configured QA
   * phone without an OTP, so the authenticated browser Definition-of-Done can be
   * run where OTP codes are (correctly) never exposed. Full rationale and the
   * security boundary in `V3.1_DEV_QA_AUTH.md`.
   *
   * The production guarantee is enforced HERE, on every request, by re-reading
   * the policy from the environment rather than trusting a cached flag: when
   * `NODE_ENV === 'production'` the policy is disabled unconditionally and this
   * route responds exactly as if it did not exist (404), so it can neither be
   * probed nor activated in production by any means. The allow-list is checked
   * here and again in the service on the canonical phone.
   */
  @Public()
  @Throttle(policy('auth'))
  @Post('dev-login')
  @HttpCode(HttpStatus.OK)
  async devLogin(@Body() dto: DevQaLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Re-evaluated per request: no cached flag can outlive a config change, and
    // production is checked first inside the policy.
    const policyNow: DevQaLoginPolicy = devQaLoginPolicyFromEnv(process.env);
    if (!policyNow.enabled) throw new DevQaLoginNotAvailableException();
    // Allow-list check on the CANONICAL phone, so the list is form-independent:
    // an operator may list `+98912...` or `0912...` and either works, and the
    // raw request form cannot slip past by not matching the list's spelling.
    // The service re-checks canonically too (defence in depth).
    const canonical = canonicalizePhone(dto.phone);
    if (!canonical || !policyNow.allowedPhones.map((p) => canonicalizePhone(p)).includes(canonical)) {
      throw new DevQaLoginNotAvailableException();
    }

    const result = await this.auth.devLoginForQa(
      dto.phone,
      policyNow.allowedPhones,
      (req.headers['x-device-label'] as string) ?? null,
      req.headers['user-agent'] ?? null,
    );

    // Identical session establishment to verifyOtp: same refresh cookie, same
    // CSRF token, same response shape. Nothing about the produced session is
    // special.
    setRefreshCookie(res, result.tokens.refreshToken, this.cookieSettings);
    const csrfToken = issueCsrfToken(res, this.cookieSettings);

    return {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      csrfToken,
      user: result.user,
    };
  }

  @Public()
  @Throttle(policy('refresh'))
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const cookieToken = readRefreshCookie(req);
    const presentedToken = cookieToken ?? dto.refreshToken;

    if (!presentedToken) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'نشست شما نامعتبر است. دوباره وارد شوید.' });
    }

    // CSRF is checked only on the cookie path -- a body-supplied token is not
    // vulnerable to it. See `csrf.ts` for why this is Origin validation rather
    // than pure double-submit.
    if (cookieToken) {
      const verdict = evaluateCsrf(req, this.csrfPolicy);
      if (!verdict.ok) {
        throw new ForbiddenException({ code: 'CSRF_FAILED', message: 'درخواست نامعتبر است. صفحه را تازه‌سازی کنید.' });
      }
    }

    const pair = await this.auth.refresh(
      presentedToken,
      (req.headers['x-device-label'] as string) ?? null,
      req.headers['user-agent'] ?? null,
    );

    // Rotation means the cookie MUST be rewritten: the old token was revoked
    // by `rotate()`, and leaving the stale cookie in place would make the
    // next refresh look like a replay and revoke the entire session chain.
    setRefreshCookie(res, pair.refreshToken, this.cookieSettings);
    const csrfToken = issueCsrfToken(res, this.cookieSettings);

    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken, csrfToken };
  }

  /**
   * Ends one session.
   *
   * `@Public()` at the guard level, and NOT unauthenticated -- #310. This route
   * used to require a bearer, and `apps/web` does not send one on it: its
   * credentialed client carries the refresh cookie and the CSRF header and no
   * `Authorization`. So the global guard rejected every browser logout before
   * the handler ran, `clearAuthCookies` never executed, and the refresh chain
   * was never revoked. A user who signed out -- on a shared device especially
   * -- had not signed out, and the web swallowed the error and cleared locally,
   * so nothing on screen or in any log said so.
   *
   * Requiring a bearer was the wrong bar anyway, and not only because the web
   * omitted it: the access token has often EXPIRED at the moment someone signs
   * out, which is one of the commonest times to press it. A logout that works
   * only while you are still signed in is not a logout.
   *
   * The authentication is therefore the one `refresh` above already uses and
   * this codebase already reviewed -- the refresh cookie proves the session and
   * CSRF is checked on the cookie path only. Deliberately not a new scheme. The
   * exposure is strictly LOWER than `refresh`'s, which is public on the same
   * controller under the same rules and MINTS tokens; the worst a forged call
   * here achieves is ending a session whose cookie the caller already had.
   *
   * A bearer is still honoured when present, so a native client keeping the
   * body/bearer contract is unaffected.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() dto: RefreshDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    const cookieToken = readRefreshCookie(req);
    const token = cookieToken ?? dto.refreshToken;

    // CSRF applies to the cookie path, and only when the cookie is the ONLY
    // thing authenticating the call.
    //
    // A body-supplied token is not CSRF-vulnerable, which is `refresh`'s rule
    // above. A verified bearer is not either, and that is worth stating because
    // it is a property of `JwtAuthGuard` rather than an assumption: on a public
    // route the guard still VERIFIES a presented bearer and sets `request.user`
    // from the signed payload, and silently leaves `user` unset when the token
    // is absent or invalid. So `user` being present here means a
    // cryptographically valid access token -- something a cross-site attacker
    // cannot obtain by making a browser send a cookie.
    //
    // Without this exception the native/bearer contract would newly require a
    // CSRF header it has never sent, which is a breaking change to a path that
    // was never broken.
    if (cookieToken && !user) {
      const verdict = evaluateCsrf(req, this.csrfPolicy);
      if (!verdict.ok) {
        throw new ForbiddenException({ code: 'CSRF_FAILED', message: 'درخواست نامعتبر است. صفحه را تازه‌سازی کنید.' });
      }
    }

    // `user` may be absent now that the route is public, and its absence is
    // never an error: the token identifies the session, and `logout` resolves
    // the user from the revoked row for the audit entry.
    if (token) await this.auth.logout(token, user?.userId);

    // Cookies are cleared even when no token was presented. A logout that
    // leaves a live cookie behind because the body happened to be empty is
    // the worst possible outcome of this route.
    clearAuthCookies(res, this.cookieSettings);
    return { loggedOut: true };
  }

  @Post('logout-all-devices')
  @HttpCode(HttpStatus.OK)
  async logoutAllDevices(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    await this.auth.logoutAllDevices(user.userId);
    clearAuthCookies(res, this.cookieSettings);
    return { loggedOut: true };
  }

  /**
   * Device management: a self-scoped list of the caller's own sessions -- never
   * another user's.
   *
   * `current` is real now (`QA-20`). It was hardcoded `false`, which made the
   * list a set of indistinguishable rows and the one action that matters --
   * "sign out my other devices" -- impossible to offer without the user risking
   * signing themselves out. It compares the `sid` claim on the presented access
   * token against each row; see `AccessTokenPayload.sid` for why that claim is
   * safe to carry and why it is optional.
   *
   * `current: false` on EVERY row is still a legitimate outcome, for a token
   * minted before the claim existed. That is the honest answer -- it is not
   * known -- and it corrects itself on the next refresh rather than guessing.
   */
  @Get('sessions')
  async listSessions(@CurrentUser() user: AuthenticatedUser) {
    const sessions = await this.tokens.listSessionsForUser(user.userId);
    return sessions.map((s) => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      userAgent: s.userAgent,
      // When this DEVICE first signed in, carried across every rotation --
      // not when the current token was minted 12 minutes ago. See
      // `TokenService.issuePair`.
      createdAt: s.sessionStartedAt ?? s.createdAt,
      lastUsedAt: s.lastUsedAt,
      revoked: Boolean(s.revokedAt),
      current: user.sessionId !== null && s.id === user.sessionId,
    }));
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  async revokeSession(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<{ revoked: true }> {
    const sessions = await this.tokens.listSessionsForUser(user.userId);
    const owned = sessions.find((s) => s.id === id);
    // Ownership re-checked here, independent of the route existing at all --
    // a session id belonging to another user resolves identically to a
    // nonexistent one (V3_SECURITY_MODEL.md §3).
    if (!owned) throw new NotFoundOrNotYoursException();
    await this.tokens.revokeById(id);
    return { revoked: true };
  }
}
