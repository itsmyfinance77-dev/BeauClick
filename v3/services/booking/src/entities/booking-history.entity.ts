import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { BookingActorType, BookingStatus } from './booking.entity';

export const BOOKING_HISTORY_EVENTS = [
  'created',
  'confirmed',
  'completed',
  'cancelled',
  'expired',
  'no_show',
  'rescheduled',
] as const;
export type BookingHistoryEvent = (typeof BOOKING_HISTORY_EVENTS)[number];

/**
 * The shape of `booking_history.metadata`.
 *
 * A concrete interface rather than `Record<string, unknown>`, for two
 * reasons: it documents what each event actually records (an untyped blob
 * is how audit tables become unreadable), and TypeORM's
 * `QueryDeepPartialEntity` cannot narrow an index-signature type, so an
 * insert of a plain object literal into such a column does not type-check
 * at all.
 */
export interface BookingHistoryMetadata {
  slotId?: string;
  holdExpiresAt?: string;
  oldSlotId?: string;
  newSlotId?: string;
  oldStartAt?: string;
  newStartAt?: string;
}

/**
 * Append-only audit trail for one booking. Written in the SAME transaction
 * as the status change it records, so "the booking says cancelled but
 * nothing says who cancelled it" is not a reachable state.
 *
 * Carries no `updated_at` -- V3_DATABASE_BLUEPRINT.md §5's append-only
 * exception: a history row is never updated after insert. Unlike the
 * financial ledger this is not backed by a revoked-grant role (it is not
 * money, and giving the main application role a second restricted
 * connection pool for an audit table is disproportionate) -- the guarantee
 * here is that no code path in this module updates or deletes it.
 */
@Entity({ name: 'booking_history', schema: 'booking' })
@Index('ix_booking_history_booking_id', ['bookingId'])
export class BookingHistoryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  bookingId!: string;

  @Column({ type: 'varchar', length: 20 })
  event!: BookingHistoryEvent;

  @Column({ type: 'varchar', length: 16, nullable: true })
  fromStatus!: BookingStatus | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  toStatus!: BookingStatus | null;

  @Column({ type: 'varchar', length: 16 })
  actorType!: BookingActorType;

  /** Null for system actions (the hold-expiry sweep has no human actor). */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  /** Event-specific detail. Never credentials. */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: BookingHistoryMetadata | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
