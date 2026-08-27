import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export const VERIFICATION_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type VerificationRequestStatus = (typeof VERIFICATION_REQUEST_STATUSES)[number];

/**
 * One verification review.
 *
 * NOT a second source of truth for whether a professional is verified --
 * `ProfessionalEntity.verificationStatus` remains that, and the existing
 * `transitionVerification()` state machine remains the only thing that changes
 * it. This row records who asked, when, who decided, and why: the queue the
 * state machine never had.
 */
@Entity({ name: 'verification_requests', schema: 'provider' })
export class VerificationRequestEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  professionalId!: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: VerificationRequestStatus;

  /** Free text from the professional. Never enters an event payload or an audit snapshot. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'uuid' })
  submittedBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  submittedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;
}
