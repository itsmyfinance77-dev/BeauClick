import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUser, AuthenticatedUser } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { Public } from '@beauclick/auth';
import { AuthService } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshDto } from './dto/refresh.dto';
import { TokenService } from '../token/token.service';

/**
 * V3_API_CONTRACT_BLUEPRINT.md §2 -- the authentication flow. Every route
 * here is @Public() (no JWT required to call it), which is the deliberate
 * exception to "every route requires auth by default" -- these ARE the
 * routes that establish auth in the first place.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  // Route-level throttle is a coarse DoS backstop only -- the REAL business
  // rate limit (5/phone/hour, 10/IP/hour, V3_SECURITY_MODEL.md §2) lives in
  // OtpService itself and is what enforces the actual product rule. Set
  // high enough here that it never fires before OtpService's own limit
  // does under realistic traffic.
  @Public()
  @Throttle({ default: { limit: 100, ttl: 60_000 } })
  @Post('request-otp')
  @HttpCode(HttpStatus.OK)
  async requestOtp(@Body() dto: RequestOtpDto, @Ip() ip: string): Promise<{ requested: true }> {
    await this.auth.requestOtp(dto.phone, dto.purpose, ip, null);
    // Always the same shape/status regardless of whether the phone has an
    // account -- anti-enumeration (V3_SECURITY_MODEL.md §2).
    return { requested: true };
  }

  @Public()
  @Throttle({ default: { limit: 100, ttl: 60_000 } })
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    const result = await this.auth.verifyOtpAndLogin(
      dto.phone,
      dto.code,
      dto.purpose,
      (req.headers['x-device-label'] as string) ?? null,
      req.headers['user-agent'] ?? null,
    );
    return {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      user: result.user,
    };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    const pair = await this.auth.refresh(dto.refreshToken, (req.headers['x-device-label'] as string) ?? null, req.headers['user-agent'] ?? null);
    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() dto: RefreshDto, @CurrentUser() user: AuthenticatedUser): Promise<{ loggedOut: true }> {
    await this.auth.logout(dto.refreshToken, user.userId);
    return { loggedOut: true };
  }

  @Post('logout-all-devices')
  @HttpCode(HttpStatus.OK)
  async logoutAllDevices(@CurrentUser() user: AuthenticatedUser): Promise<{ loggedOut: true }> {
    await this.auth.logoutAllDevices(user.userId);
    return { loggedOut: true };
  }

  /** Device management (this task's item 7): a self-scoped list of the caller's own live/past sessions -- never another user's. */
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
