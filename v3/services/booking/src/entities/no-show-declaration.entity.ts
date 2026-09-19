import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export const NO_SHOW_EVALUATION_STATES = ['window_open', 'disputed', 'evaluated'] as const;
export type NoShowEvaluationState = (typeof NO_SHOW_EVALUATION_STATES)[number];

/**
 * The professional's no-show declaration — V3.3 #161 (`#42d`), ADR-051 §7.
 *
 * One immutable row per booking (`UNIQUE(booking_id)`), evidence-minimal
 * (actor, instant, statement — no photo, file, geolocation or health field),
 * moving no money on its own: `#42c`'s evaluator decides the retention later,
 * once `objectionWindowEndsAt` has passed with no dispute. `graceMinutesSnapshot`
 * and `objectionWindowEndsAt` are both `null` for a legacy (no outcome-terms)
 * booking, which keeps the V2 `slot_end` guard and opens no window at all.
 *
 * `evaluationState` is the only column that ever changes after insert, and
 * only forward (`database/migrations/booking/20260921100001_…`).
 */
@Entity({ name: 'no_show_declarations', schema: 'booking' })
export class NoShowDeclarationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId!: string;

  @Column({ name: 'declared_by_user_id', type: 'uuid' })
  declaredByUserId!: string;

  @CreateDateColumn({ name: 'declared_at', type: 'timestamptz' })
  declaredAt!: Date;

  @Column({ name: 'grace_minutes_snapshot', type: 'smallint', nullable: true })
  graceMinutesSnapshot!: number | null;

  @Column({ type: 'text' })
  statement!: string;

  @Column({ name: 'objection_window_ends_at', type: 'timestamptz', nullable: true })
  objectionWindowEndsAt!: Date | null;

  @Column({ name: 'evaluation_state', type: 'varchar', length: 16, default: 'window_open' })
  evaluationState!: NoShowEvaluationState;
}
