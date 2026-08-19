import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

export type OtpPurpose = 'login' | 'change_phone' | 'confirm_deletion';

/**
 * V3_SECURITY_MODEL.md §2: never store a plaintext code (codeHash only,
 * HMAC-SHA256), purpose-scoped, session-scoped for sensitive purposes
 * (sessionUserId), atomic single-use consumption (consumedAt), a small
 * fixed lockout of wrong-code attempts (attemptsRemaining).
 */
@Entity({ name: 'otp_requests', schema: 'identity' })
@Index(['phone', 'purpose', 'consumedAt'])
export class OtpRequestEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  phone!: string;

  @Column({ type: 'varchar', length: 20 })
  purpose!: OtpPurpose;

  @Column({ type: 'varchar', length: 64 })
  codeHash!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'int', default: 5 })
  attemptsRemaining!: number;

  @Column({ type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  /** For sensitive purposes (change_phone, confirm_deletion): scopes the code to the session that requested it -- V3_SECURITY_MODEL.md §2's "a code sent while user A is logged in must not be consumable by anyone who merely learns the phone number and the code." */
  @Column({ type: 'uuid', nullable: true })
  sessionUserId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requestIp!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
