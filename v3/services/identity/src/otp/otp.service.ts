import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { uuidv7 } from 'uuidv7';
import { RateLimitedException } from '@beauclick/http';
import { OtpPurpose, OtpRequestEntity } from '../entities/otp-request.entity';
import { NoopOtpDebugObserver, OTP_DEBUG_OBSERVER, OtpDebugObserver } from './otp-debug-observer';

export type OtpVerifyResult = { ok: true } | { ok: false; reason: 'invalid_or_expired' | 'too_many_attempts' };

/**
 * What a successful request tells the caller (`QA-19`).
 *
 * `cooldownRemaining` is how many seconds until a RESEND would be accepted --
 * not how long the code is valid. The two are different numbers and confusing
 * them is the bug this exists to prevent: a UI counting the expiry down would
 * enable its resend button while the cooldown is still running, and the user
 * would tap it into a 429.
 *
 * `expiresInSeconds` is the other one, returned alongside so a client never
 * has to guess either.
 */
export interface OtpRequestResult {
  cooldownRemaining: number;
  expiresInSeconds: number;
}

/**
 * V3_SECURITY_MODEL.md §2 -- every rule below is a REQUIRED baseline
 * extracted from V2's proven design (GAP-10: the exact numeric values are
 * provisional, not the shape). Preserved exactly:
 *  - 6-digit code, crypto-secure random (randomInt, not Math.random).
 *  - Never store plaintext -- HMAC-SHA256(code, serverSecret), constant-
 *    time compare on verify.
 *  - Expiry: short fixed window (120s default).
 *  - Verify-attempt lockout: 5 wrong attempts kills the code.
 *  - Resend cooldown: 60s before the same phone can request again.
 *  - Rate limits: 5/phone/hour AND 10/IP/hour, independently.
 *  - Anti-enumeration: requesting never reveals account existence; verify
 *    against an expired code and verify against a phone that never had a
 *    code requested return the IDENTICAL error.
 *  - Replay prevention: atomic single-use consumption (WHERE consumedAt IS
 *    NULL in the update, not read-then-write).
 *  - Purpose-scoping: a code for one purpose never verifies for another;
 *    sensitive purposes are additionally scoped to the requesting session.
 */
@Injectable()
export class OtpService {
  private readonly expirySeconds: number;
  private readonly maxAttempts: number;
  private readonly resendCooldownSeconds: number;
  private readonly maxPerPhonePerHour: number;
  private readonly maxPerIpPerHour: number;
  private readonly serverSecret: string;

  constructor(
    @InjectRepository(OtpRequestEntity) private readonly otpRepo: Repository<OtpRequestEntity>,
    private readonly config: ConfigService,
    @Optional() @Inject(OTP_DEBUG_OBSERVER) private readonly debugObserver: OtpDebugObserver = new NoopOtpDebugObserver(),
  ) {
    this.expirySeconds = Number(this.config.get('OTP_EXPIRY_SECONDS') ?? 120);
    this.maxAttempts = Number(this.config.get('OTP_MAX_ATTEMPTS') ?? 5);
    this.resendCooldownSeconds = Number(this.config.get('OTP_RESEND_COOLDOWN_SECONDS') ?? 60);
    this.maxPerPhonePerHour = Number(this.config.get('OTP_MAX_PER_PHONE_PER_HOUR') ?? 5);
    this.maxPerIpPerHour = Number(this.config.get('OTP_MAX_PER_IP_PER_HOUR') ?? 10);
    this.serverSecret = this.config.get('OTP_HMAC_SECRET') ?? 'dev-only-insecure-secret-override-in-env';
  }

  private hash(code: string, phone: string, purpose: OtpPurpose): string {
    return createHmac('sha256', this.serverSecret).update(`${phone}:${purpose}:${code}`).digest('hex');
  }

  /**
   * Always resolves the same way regardless of whether the phone has an
   * account (anti-enumeration) -- the caller (AuthController) returns an
   * identical response either way. Throws RateLimitedException if either
   * the phone or IP window is exceeded -- this IS visible to the caller
   * (rate-limit disclosure is an accepted, standard tradeoff; it does not
   * reveal account existence, only request volume).
   */
  async requestOtp(
    phone: string,
    purpose: OtpPurpose,
    ip: string,
    sessionUserId: string | null = null,
  ): Promise<OtpRequestResult> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [phoneCount, ipCount, recentForCooldown] = await Promise.all([
      this.otpRepo.count({ where: { phone, purpose, createdAt: MoreThan(oneHourAgo) } }),
      this.otpRepo.count({ where: { requestIp: ip, createdAt: MoreThan(oneHourAgo) } }),
      this.otpRepo.find({ where: { phone, purpose }, order: { createdAt: 'DESC' }, take: 1 }),
    ]);

    // NO `retryAfterSeconds` on the hourly windows, deliberately. When the
    // limit resets depends on when each of up to five earlier requests landed,
    // and the honest answer here is "not known". Reporting a plausible number
    // would have the client count down to a moment that still fails -- worse
    // than reporting nothing, because it looks reliable.
    if (phoneCount >= this.maxPerPhonePerHour || ipCount >= this.maxPerIpPerHour) {
      throw new RateLimitedException();
    }

    const mostRecent = recentForCooldown[0];
    if (mostRecent) {
      const secondsSinceLast = (Date.now() - mostRecent.createdAt.getTime()) / 1000;
      if (secondsSinceLast < this.resendCooldownSeconds) {
        // The cooldown CAN answer it exactly -- one timestamp, one constant --
        // which is the whole of QA-19. Rounded UP so a client that counts down
        // and retries at zero is never one millisecond early.
        throw new RateLimitedException(Math.ceil(this.resendCooldownSeconds - secondsSinceLast));
      }
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const entity = this.otpRepo.create({
      id: uuidv7(),
      phone,
      purpose,
      codeHash: this.hash(code, phone, purpose),
      expiresAt: new Date(Date.now() + this.expirySeconds * 1000),
      attemptsRemaining: this.maxAttempts,
      consumedAt: null,
      sessionUserId,
      requestIp: ip,
    });
    await this.otpRepo.save(entity);

    // Deliberately no real SMS send in Phase 1 (net-new, GAP-11 --
    // real gateway integration is out of this phase's scope). The
    // generated code is intentionally never logged or returned from this
    // method -- this debug hook is the ONE seam that can observe it, and
    // it is a real no-op in every environment except a test module that
    // explicitly overrides OTP_DEBUG_OBSERVER (mirrors V2's own
    // `beauclick/auth/otp_generated`, confirmed zero production
    // subscribers -- same shape, same guarantee).
    this.debugObserver.onCodeGenerated(phone, code);

    return { cooldownRemaining: this.resendCooldownSeconds, expiresInSeconds: this.expirySeconds };
  }

  /**
   * Atomic, single-use, constant-time, identical-error-for-every-failure-
   * mode verification. `purpose` and (for sensitive purposes) `sessionUserId`
   * must match exactly or the lookup finds nothing -- indistinguishable from
   * "no code was ever requested."
   */
  async verifyOtp(phone: string, code: string, purpose: OtpPurpose, sessionUserId: string | null = null): Promise<OtpVerifyResult> {
    const candidate = await this.otpRepo.findOne({
      where: { phone, purpose, consumedAt: undefined as never },
      order: { createdAt: 'DESC' },
    });

    // No candidate, OR it's expired, OR it's for a different session than
    // the one that requested it (sensitive purposes) -- all collapse to the
    // same generic failure, never distinguished.
    if (!candidate || candidate.consumedAt !== null || candidate.expiresAt.getTime() < Date.now()) {
      return { ok: false, reason: 'invalid_or_expired' };
    }
    if (candidate.sessionUserId !== null && candidate.sessionUserId !== sessionUserId) {
      return { ok: false, reason: 'invalid_or_expired' };
    }

    if (candidate.attemptsRemaining <= 0) {
      return { ok: false, reason: 'too_many_attempts' };
    }

    const expectedHash = this.hash(code, phone, purpose);
    const matches = safeCompare(expectedHash, candidate.codeHash);

    if (!matches) {
      // Decrement atomically -- a losing WHERE clause here would mean two
      // concurrent wrong guesses both get a "fresh" attempt; guard against
      // that by decrementing via the DB, not by mutating the in-memory
      // entity and saving it back.
      await this.otpRepo.decrement({ id: candidate.id }, 'attemptsRemaining', 1);
      return { ok: false, reason: 'invalid_or_expired' };
    }

    // Atomic consume-on-success: the WHERE clause requires consumedAt IS
    // NULL, so a replayed verify (the exact same correct code sent twice
    // concurrently) can only ever win this update once.
    const result = await this.otpRepo
      .createQueryBuilder()
      .update(OtpRequestEntity)
      .set({ consumedAt: new Date() })
      // Raw identifier here MUST be the real snake_case column
      // (consumed_at, per SnakeNamingStrategy) -- a raw WHERE-clause
      // fragment is not auto-translated from the entity property name the
      // way .set({...}) is; a real bug (a stale camelCase "consumedAt"
      // reference) was caught here by the Phase 1 completion pass's real
      // PostgreSQL verification.
      .where('id = :id AND consumed_at IS NULL', { id: candidate.id })
      .execute();

    if (!result.affected) {
      // Someone else's concurrent verify already consumed it first.
      return { ok: false, reason: 'invalid_or_expired' };
    }

    return { ok: true };
  }
}

/** Constant-time hex-string comparison -- never a plain `===` on secret material. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
