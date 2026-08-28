import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * V3_API_CONTRACT_BLUEPRINT.md §2: one row per device/session, opaque token
 * stored hashed (never plaintext), rotates on every use. `replacedByTokenId`
 * forms the rotation chain used for replay detection -- if a token whose
 * `replacedByTokenId` is already set is presented again, the whole chain
 * (every token for this session) is revoked, not just this one request
 * denied.
 */
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
