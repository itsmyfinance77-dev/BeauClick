import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { returningRows } from '@beauclick/events';
import { uuidv7 } from 'uuidv7';
import { RefreshTokenEntity } from '../entities/refresh-token.entity';
import { UserEntity } from '../entities/user.entity';
import { RoleService } from '../rbac/role.service';

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
  /**
   * How long after a rotation a re-presentation of the old token is treated
   * as a benign race rather than a replay attack.
   *
   * Short on purpose. Long enough to absorb a concurrent client (which races
   * within milliseconds), short enough that it is not a usable window for
   * someone replaying a captured credential. Either way the request is
   * DENIED -- the grace period only decides whether the rest of the session
   * survives.
   */
  private static readonly REPLAY_GRACE_MS = 10_000;

  private readonly refreshTtlDays: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(RefreshTokenEntity) private readonly refreshRepo: Repository<RefreshTokenEntity>,
    private readonly roles: RoleService,
  ) {
    this.refreshTtlDays = Number(this.config.get('REFRESH_TOKEN_TTL_DAYS') ?? 30);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issuePair(user: UserEntity, deviceLabel: string | null, userAgent: string | null): Promise<TokenPair> {
    // Roles and capabilities come from `identity.user_roles` /
    // `identity.role_capabilities`, not from the static map and not from the
    // denormalized `users.roles` column. This is the point at which a grant or
    // revocation made since the last token becomes effective -- see the
    // session-invalidation window in V3_SECURITY_MODEL.md §9a.
    const access = await this.roles.resolveAccess(user.id);
    const accessToken = this.jwt.sign({
      sub: user.id,
      roles: access.roles,
      capabilities: access.capabilities,
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

    /**
     * CLAIM the token with a conditional UPDATE before doing anything else.
     *
     * This was a read-then-write, and that was a real concurrency hole: two
     * simultaneous refreshes both loaded the row, both saw `revoked_at IS
     * NULL`, and both issued a new pair -- so ONE refresh token produced TWO
     * live sessions. Proved by firing two genuinely concurrent refreshes with
     * the same cookie and getting `200` twice.
     *
     * Under READ COMMITTED a second concurrent UPDATE of this row blocks on
     * the first transaction's lock and, on release, re-evaluates its WHERE
     * against the newly committed row -- so `revoked_at IS NULL` is false for
     * the loser and it matches zero rows. That re-check is specific to
     * UPDATE/DELETE, which is exactly why the claim is one statement rather
     * than SELECT-then-UPDATE. The same mechanism booking-service's slot claim
     * rests on.
     */
    const raw = await this.refreshRepo.query(
        `UPDATE identity.refresh_tokens
            SET revoked_at = now(), last_used_at = now()
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, user_id, device_label, user_agent`,
      [tokenHash],
    );

    // `returningRows` because TypeORM returns `[rows, rowCount]` for an
    // UPDATE, so a naive `raw.length === 0` check is ALWAYS false and a
    // revoked token would mint a new session. See sql-result.ts.
    const claimed = returningRows<{
      id: string;
      user_id: string;
      device_label: string | null;
      user_agent: string | null;
    }>(raw);

    if (claimed.length === 0) {
      await this.handleUnclaimableToken(tokenHash);
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'نشست شما نامعتبر است. دوباره وارد شوید.' });
    }

    const claim = claimed[0];
    const user = await this.refreshRepo.manager.findOne(UserEntity, { where: { id: claim.user_id } });
    if (!user) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'نشست شما نامعتبر است. دوباره وارد شوید.' });
    }

    const next = await this.issuePair(user, deviceLabel ?? claim.device_label, userAgent ?? claim.user_agent);

    // The rotation chain, written after the replacement exists so the pointer
    // is never dangling.
    await this.refreshRepo.update({ id: claim.id }, { replacedByTokenId: next.refreshTokenId });

    return next;
  }

  /**
   * Decides what a token we could NOT claim means.
   *
   * Three cases reach here, and they must not be treated alike:
   *
   *   * **Unknown token** -- nothing to revoke; deny and stop.
   *
   *   * **Rotated moments ago** -- a benign RACE. Two tabs, or two API calls
   *     that 401 at the same instant, both present the same cookie; one wins
   *     the claim above and the other arrives holding what is now an old
   *     token. Revoking the chain here would sign a legitimate user out for
   *     doing nothing wrong -- reproduced live, with the browser's own network
   *     log showing `refresh -> 200` immediately followed by `refresh -> 401`
   *     and the user bounced to the sign-in page.
   *
   *   * **Rotated long ago, or explicitly revoked** -- a genuine replay. The
   *     token is presumed compromised and the WHOLE session chain goes.
   *
   * Either way the request is denied. The window only decides whether the
   * rest of the session survives, and it is deliberately tiny: a client race
   * resolves in milliseconds, while someone replaying a captured credential
   * is not typically doing so within seconds of the legitimate rotation.
   * Clients also single-flight their refreshes, so this is the second line of
   * defence rather than the first.
   */
  private async handleUnclaimableToken(tokenHash: string): Promise<void> {
    const existing = await this.refreshRepo.findOne({ where: { tokenHash } });
    if (!existing) return;

    const rotatedRecently =
      existing.revokedAt !== null &&
      Date.now() - existing.revokedAt.getTime() < TokenService.REPLAY_GRACE_MS;

    if (!rotatedRecently) {
      await this.revokeAllForUser(existing.userId);
    }
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
