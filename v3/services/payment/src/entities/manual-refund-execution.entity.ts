import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * DEMO BRANCH ONLY — F-10 (demo/F10-DESIGN.md). The durable, exclusive claim an
 * operator takes BEFORE executing a `manual_required` refund by hand, and how
 * that execution ended. At most one active (claimed/uncertain/executed) row per
 * refund (partial unique index); `released` rows are history. Forward-only
 * (trigger); no timeout ever releases a claim.
 *
 * The demo records a SYNTHETIC execution: nothing here moves money. A transfer
 * made outside the system without taking this claim cannot be detected by it.
 */
export const MANUAL_REFUND_EXECUTION_STATES = ['claimed', 'executed', 'uncertain', 'released'] as const;
export type ManualRefundExecutionState = (typeof MANUAL_REFUND_EXECUTION_STATES)[number];
/** States that block a supersession and forbid a second claim. */
export const ACTIVE_MANUAL_EXECUTION_STATES: readonly ManualRefundExecutionState[] = ['claimed', 'uncertain', 'executed'];

@Entity({ name: 'manual_refund_executions', schema: 'payment' })
export class ManualRefundExecutionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  refundId!: string;

  @Column({ type: 'varchar', length: 12 })
  state!: ManualRefundExecutionState;

  @Column({ type: 'uuid' })
  claimedByUserId!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  claimedAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  externalReference!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;
}
