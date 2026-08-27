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
  async requestOtp(@Body() dto: RequestOtpDto, @Ip() ip: string): Promise<{ requested: true }> {
    await this.auth.requestOtp(dto.phone, dto.purpose, ip, null);
    // Always the same shape/status regardless of whether the phone has an
    // account -- anti-enumeration (V3_SECURITY_MODEL.md §2).
    return { requested: true };
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

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() dto: RefreshDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: true }> {
    const token = readRefreshCookie(req) ?? dto.refreshToken;
    if (token) await this.auth.logout(token, user.userId);

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

  /** Device management: a self-scoped list of the caller's own live/past sessions -- never another user's. */
  @Get('sessions')
  async listSessions(@CurrentUser() user: AuthenticatedUser) {
    const sessions = await this.tokens.listSessionsForUser(user.userId);
    return sessions.map((s) => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      revoked: Boolean(s.revokedAt),
      current: false,
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
