import { Injectable } from '@nestjs/common';
import { DomainException } from '@beauclick/http';
import { HttpStatus } from '@nestjs/common';
import { OtpService, OtpRequestResult } from '../otp/otp.service';
import { AccountResolverService } from '../account/account-resolver.service';
import { TokenService, TokenPair } from '../token/token.service';
import { canonicalizePhone } from './phone.util';
import { UserEntity } from '../entities/user.entity';
import { RoleService } from '../rbac/role.service';
import { AuditLogger } from '@beauclick/events';

export class InvalidPhoneException extends DomainException {
  constructor() {
    super('VALIDATION_ERROR', 'شماره موبایل نامعتبر است.', HttpStatus.BAD_REQUEST);
  }
}

export class InvalidOtpException extends DomainException {
  constructor() {
    // Deliberately the SAME code/message for expired, never-requested, and
    // wrong-code -- V3_SECURITY_MODEL.md §2's anti-enumeration requirement.
    super('VALIDATION_ERROR', 'کد وارد شده نامعتبر یا منقضی شده است.', HttpStatus.BAD_REQUEST);
  }
}

export class TooManyAttemptsException extends DomainException {
  constructor() {
    super('RATE_LIMITED', 'تعداد تلاش‌های ناموفق بیش از حد مجاز است. کد جدید درخواست کنید.', HttpStatus.TOO_MANY_REQUESTS);
  }
}

export class DevQaLoginNotAvailableException extends DomainException {
  constructor() {
    // 404, not 403: a route that only exists in development should not even
    // confirm it exists in production. Same reasoning as an ownership miss.
    super('NOT_FOUND', 'یافت نشد.', HttpStatus.NOT_FOUND);
  }
}

export interface LoginResult {
  user: { id: string; phone: string; roles: string[]; capabilities: string[] };
  tokens: TokenPair;
}

@Injectable()
export class AuthService {
  private readonly auditLog = new AuditLogger('identity');

  constructor(
    private readonly otp: OtpService,
    private readonly accountResolver: AccountResolverService,
    private readonly tokens: TokenService,
    private readonly roles: RoleService,
  ) {}

  async requestOtp(
    rawPhone: string,
    purpose: 'login' | 'change_phone' | 'confirm_deletion',
    ip: string,
    sessionUserId: string | null,
  ): Promise<OtpRequestResult> {
    const phone = canonicalizePhone(rawPhone);
    if (!phone) throw new InvalidPhoneException();
    // No branch on "does this phone have an account" anywhere in this
    // method -- the identical requestOtp() call happens either way
    // (V3_SECURITY_MODEL.md §2 anti-enumeration). The returned cooldown is
    // likewise derived only from request TIMING, never from whether an account
    // exists, so QA-19's additive field cannot become an enumeration oracle.
    const result = await this.otp.requestOtp(phone, purpose, ip, sessionUserId);
    this.auditLog.log({ action: 'otp.requested', purpose, ip });
    return result;
  }

  async verifyOtpAndLogin(rawPhone: string, code: string, purpose: 'login' | 'change_phone' | 'confirm_deletion', deviceLabel: string | null, userAgent: string | null): Promise<LoginResult> {
    const phone = canonicalizePhone(rawPhone);
    if (!phone) throw new InvalidPhoneException();

    const result = await this.otp.verifyOtp(phone, code, purpose, null);
    if (!result.ok) {
      if (result.reason === 'too_many_attempts') throw new TooManyAttemptsException();
      throw new InvalidOtpException();
    }

    const user: UserEntity = await this.accountResolver.resolveOrCreate(phone);
    const tokenPair = await this.tokens.issuePair(user, deviceLabel, userAgent);
    this.auditLog.log({ action: 'auth.login', userId: user.id });

    // Resolved from the database, so the login response and the token it comes
    // with can never disagree about what the user may do.
    const access = await this.roles.resolveAccess(user.id);

    return {
      user: { id: user.id, phone: user.phone, roles: access.roles, capabilities: access.capabilities },
      tokens: tokenPair,
    };
  }

  /**
   * DEVELOPMENT-ONLY. Establishes a normal session for a QA account WITHOUT an
   * OTP, so the authenticated browser Definition-of-Done can be run in an
   * environment that (correctly) never exposes OTP codes.
   *
   * It is deliberately identical to `verifyOtpAndLogin` from the account
   * resolution onward -- same `resolveOrCreate`, same `issuePair`, same
   * `resolveAccess` -- so the session it returns is indistinguishable from a
   * real one to every guard and resolver downstream. The ONLY thing it omits
   * is `otp.verifyOtp`, which is the single step that cannot run here.
   *
   * The caller (AuthController) is responsible for the production guard and the
   * allow-list; this method refuses to act on a phone the controller did not
   * vet, as a second line of defence. It audits under a distinct action so a
   * QA session is never mistaken for a real login in any trail.
   */
  async devLoginForQa(
    rawPhone: string,
    allowedPhones: string[],
    deviceLabel: string | null,
    userAgent: string | null,
  ): Promise<LoginResult> {
    const phone = canonicalizePhone(rawPhone);
    if (!phone) throw new InvalidPhoneException();
    // Second check of the allow-list, on the CANONICAL phone. The controller
    // checks the raw input; this checks what it actually resolves to, so a
    // formatting trick cannot smuggle a non-QA number past the list.
    const allowedCanonical = allowedPhones.map((p) => canonicalizePhone(p)).filter(Boolean);
    if (!allowedCanonical.includes(phone)) throw new DevQaLoginNotAvailableException();

    const user: UserEntity = await this.accountResolver.resolveOrCreate(phone);
    const tokenPair = await this.tokens.issuePair(user, deviceLabel, userAgent);
    // A DISTINCT audit action, never `auth.login`, so a QA session is
    // traceable as one and never pollutes a real authentication trail.
    this.auditLog.log({ action: 'auth.dev_qa_login', userId: user.id });

    const access = await this.roles.resolveAccess(user.id);
    return {
      user: { id: user.id, phone: user.phone, roles: access.roles, capabilities: access.capabilities },
      tokens: tokenPair,
    };
  }

  async refresh(rawRefreshToken: string, deviceLabel: string | null, userAgent: string | null): Promise<TokenPair> {
    return this.tokens.rotate(rawRefreshToken, deviceLabel, userAgent);
  }

  async logout(rawRefreshToken: string, userId: string): Promise<void> {
    await this.tokens.revoke(rawRefreshToken);
    this.auditLog.log({ action: 'auth.logout', userId });
  }

  async logoutAllDevices(userId: string): Promise<void> {
    await this.tokens.revokeAllForUser(userId);
    this.auditLog.log({ action: 'auth.logout_all_devices', userId });
  }
}
