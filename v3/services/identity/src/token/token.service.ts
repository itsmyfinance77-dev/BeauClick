import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { uuidv7 } from 'uuidv7';
import { RefreshTokenEntity } from '../entities/refresh-token.entity';
import { UserEntity } from '../entities/user.entity';
import { capabilitiesForRoles } from '../rbac/capabilities';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  refreshTokenId: string;
}

/**
 * ADR-014 / ADR-008: short-lived JWT access token (15 min), long-lived
 * ROTATING refresh token (30 days), stored hashed, one row per device --
 * real infrastructure V2 never had at all. Rotation-with-replay-detection:
 * reusing an already-rotated refresh token revokes the ENTIRE session
 * chain, not just that one request, per ADR-014's consequence note.
 */
@Injectable()
export class TokenService {
  private readonly refreshTtlDays: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(RefreshTokenEntity) private readonly refreshRepo: Repository<RefreshTokenEntity>,
  ) {
    this.refreshTtlDays = Number(this.config.get('REFRESH_TOKEN_TTL_DAYS') ?? 30);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issuePair(user: UserEntity, deviceLabel: string | null, userAgent: string | null): Promise<TokenPair> {
    const accessToken = this.jwt.sign({
      sub: user.id,
      roles: user.roles,
      capabilities: capabilitiesForRoles(user.roles),
    });

    const rawRefreshToken = randomBytes(48).toString('base64url');
    const refreshTokenId = uuidv7();
    await this.refreshRepo.save(
      this.refreshRepo.create({
        id: refreshTokenId,
        userId: user.id,
        tokenHash: this.hashToken(rawRefreshToken),
        deviceLabel,
        userAgent,
        replacedByTokenId: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + this.refreshTtlDays * 24 * 60 * 60 * 1000),
        lastUsedAt: null,
      }),
    );

    return { accessToken, refreshToken: rawRefreshToken, refreshTokenId };
  }

  /**
   * Rotates the presented refresh token: the old row is marked revoked +
   * pointed at the new row (`replacedByTokenId`); a NEW opaque token is
   * issued. If the presented token is already revoked (either because it
   * was already rotated once, or explicitly logged out), that is treated
   * as a real security event -- every other live session for this user is
   * revoked too, not just this request denied.
   */
  async rotate(rawRefreshToken: string, deviceLabel: string | null, userAgent: string | null): Promise<TokenPair> {
    const tokenHash = this.hashToken(rawRefreshToken);
    const existing = await this.refreshRepo.findOne({ where: { tokenHash } });

    if (!existing) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'نشست شما نامعتبر است. دوباره وارد شوید.' });
    }

    if (existing.revokedAt || existing.expiresAt.getTime() < Date.now()) {
      // Replay of an already-rotated (or expired) token -- revoke the
      // entire chain for this user as a precaution, not just this token.
      await this.revokeAllForUser(existing.userId);
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'نشست شما نامعتبر است. دوباره وارد شوید.' });
    }

    const user = await this.refreshRepo.manager.findOne(UserEntity, { where: { id: existing.userId } });
    if (!user) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'نشست شما نامعتبر است. دوباره وارد شوید.' });
    }

    const next = await this.issuePair(user, deviceLabel ?? existing.deviceLabel, userAgent ?? existing.userAgent);

    existing.revokedAt = new Date();
    existing.replacedByTokenId = next.refreshTokenId;
    existing.lastUsedAt = new Date();
    await this.refreshRepo.save(existing);

    return next;
  }

  async revoke(rawRefreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawRefreshToken);
    await this.refreshRepo.update({ tokenHash }, { revokedAt: new Date() });
  }

  async revokeById(id: string): Promise<void> {
    await this.refreshRepo.update({ id }, { revokedAt: new Date() });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.refreshRepo
      .createQueryBuilder()
      .update(RefreshTokenEntity)
      .set({ revokedAt: new Date() })
      // Real snake_case columns (user_id, revoked_at per SnakeNamingStrategy)
      // -- same class of bug as OtpService's consumed_at fix, same fix.
      .where('user_id = :userId AND revoked_at IS NULL', { userId })
      .execute();
  }

  async listSessionsForUser(userId: string): Promise<RefreshTokenEntity[]> {
    return this.refreshRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }
}
