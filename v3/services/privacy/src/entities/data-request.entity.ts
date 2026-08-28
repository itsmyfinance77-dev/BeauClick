import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const DATA_REQUEST_KINDS = ['export', 'erasure'] as const;
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];

/**
 * The shared lifecycle for both kinds, with two terminal states each.
 *
 *   export:  pending -> processing -> ready -> expired
 *                                  \-> failed
 *   erasure: pending -> processing -> completed
 *                    \-> cancelled  (grace window only)
 *                                  \-> failed
 *
 * `ready` is export-only and `completed` is erasure-only, deliberately: an
 * export that is "completed" tells the subject nothing about whether they can
 * still download it, and an erasure that is "ready" is a state nobody should
 * ever be able to write.
 */
export const DATA_REQUEST_STATUSES = [
  'pending',
  'processing',
  'ready',
  'completed',
  'cancelled',
  'expired',
  'failed',
] as const;
export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number];

/**
 * What erasure did, per module. Counts and retention reasons -- never content.
 *
 * A concrete interface rather than `Record<string, unknown>` on purpose: the
 * shape is the compliance record's contract, and an open bag would let a
 * future caller put anything at all in a column that outlives the erasure it
 * describes.
 */
export interface ErasureOutcomeSnapshot {
  modules: Array<{
    module: string;
    anonymized: number;
    deleted: number;
    retained: ReadonlyArray<{ table: string; reason: string }>;
  }>;
}

@Entity({ name: 'data_requests', schema: 'privacy' })
export class DataRequestEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** identity.users.id, by value. See the migration for why there is no cascade. */
  @Column({ type: 'uuid' })
  subjectUserId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: DataRequestKind;

  @Column({ type: 'varchar', length: 16 })
  status!: DataRequestStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  requestedAt!: Date;

  /** Erasure only: the earliest moment the sweep may execute. The grace window (GAP-21). */
  @Column({ type: 'timestamptz', nullable: true })
  executeAfter!: Date | null;

  /** Export only: when the document stops being downloadable and its payload row is destroyed. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  cancelledBy!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  failureCode!: string | null;

  /**
   * Per-module counts and retention reasons. Never content.
   *
   * This row is the compliance record and has to outlive the erasure, so
   * anything in it survives the erasure -- which makes "counts only" a
   * correctness rule and not a preference.
   */
  @Column({ type: 'jsonb', nullable: true })
  outcome!: ErasureOutcomeSnapshot | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
