import { Injectable, Logger } from '@nestjs/common';
import { DomainException } from '@beauclick/http';
import { HttpStatus } from '@nestjs/common';
import { OtpService } from '../otp/otp.service';
import { AccountResolverService } from '../account/account-resolver.service';
import { TokenService, TokenPair } from '../token/token.service';
import { canonicalizePhone } from './phone.util';
import { UserEntity } from '../entities/user.entity';
import { capabilitiesForRoles } from '../rbac/capabilities';

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

export interface LoginResult {
  user: { id: string; phone: string; roles: string[]; capabilities: string[] };
  tokens: TokenPair;
}

@Injectable()
export class AuthService {
  private readonly auditLog = new Logger('AUDIT:identity');

  constructor(
    private readonly otp: OtpService,
    private readonly accountResolver: AccountResolverService,
    private readonly tokens: TokenService,
  ) {}

  async requestOtp(rawPhone: string, purpose: 'login' | 'change_phone' | 'confirm_deletion', ip: string, sessionUserId: string | null): Promise<void> {
    const phone = canonicalizePhone(rawPhone);
    if (!phone) throw new InvalidPhoneException();
    // No branch on "does this phone have an account" anywhere in this
    // method -- the identical requestOtp() call happens either way
    // (V3_SECURITY_MODEL.md §2 anti-enumeration).
    await this.otp.requestOtp(phone, purpose, ip, sessionUserId);
    this.auditLog.log({ action: 'otp.requested', purpose, ip });
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

    return {
      user: { id: user.id, phone: user.phone, roles: user.roles, capabilities: capabilitiesForRoles(user.roles) },
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
