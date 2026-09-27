import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * V3_API_CONTRACT_BLUEPRINT.md §2: one row per device/session, opaque token
 * stored hashed (never plaintext), rotates on every use. `replacedByTokenId`
 * forms the rotation chain used for replay detection -- if a token whose
 * `replacedByTokenId` is already set is presented again, the whole chain
 * (every token for this session) is revoked, not just this one request
 * denied.
 */
/**
 * `rotated` -- consumed by a refresh (the only reason a later re-presentation
 * can mean theft); the other four are deliberate ends of a session.
 */
export type RefreshTokenRevocationReason = 'rotated' | 'logout' | 'session_revoked' | 'logout_all' | 'replay_response';

/** Reasons that END a session on purpose: presenting such a token again is refused, never escalated. */
export const INTENTIONAL_REVOCATION_REASONS: readonly RefreshTokenRevocationReason[] = [
  'logout',
  'session_revoked',
  'logout_all',
  'replay_response',
];

@Entity({ name: 'refresh_tokens', schema: 'identity' })
@Index(['userId'])
export class RefreshTokenEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 128, unique: true })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  deviceLabel!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'uuid', nullable: true })
  replacedByTokenId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  /**
   * WHY the token was revoked (demo remediation F-9), written in the same
   * statement as `revokedAt` and never overwritten. NULL on live rows and on
   * rows revoked before the column existed -- which replay detection treats
   * exactly like `rotated`.
   */
  @Column({ type: 'text', nullable: true })
  revocationReason!: RefreshTokenRevocationReason | null;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  /**
   * When this DEVICE first signed in, carried across every rotation in the
   * chain (`QA-20`).
   *
   * Distinct from `createdAt`, which is when this particular row was written --
   * eleven minutes ago for a session started three weeks ago. See the
   * migration for why the distinction is not cosmetic.
   *
   * Nullable for rows that predate the column; the API falls back to
   * `createdAt` rather than inventing one.
   */
  @Column({ type: 'timestamptz', nullable: true })
  sessionStartedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
