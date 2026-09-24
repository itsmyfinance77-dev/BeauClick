import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The V3 booking state machine.
 *
 *                    +-----------> expired      (hold lapsed, never paid)
 *                    |
 *   [*] --> pending -+-----------> cancelled    (customer/professional/system)
 *              |
 *              v
 *          confirmed ------------> cancelled
 *              |
 *              +------> completed
 *              |
 *              +------> no_show
 *
 * Deviation from V2, deliberate: V2 modelled an abandoned hold as
 * `cancelled` with `cancelled_reason='expired'`, which made "how many
 * customers actually cancelled on us" unanswerable without string-matching
 * a free-text reason column, and made the refund decision ("a cancellation
 * may need a refund; an expired unpaid hold never does") depend on that
 * same string. `expired` is now a first-class terminal state, so both
 * questions are answered by the status column alone.
 *
 * `rescheduled` is deliberately NOT a state: rescheduling moves a booking
 * to a different slot while it remains pending/confirmed. Modelling it as a
 * state would force an immediate transition back out again and lose the
 * booking's real lifecycle position. It is recorded as a history EVENT and
 * a counter instead.
 */
export const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'expired', 'no_show'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** The statuses that still hold a slot against other customers. Used by the partial unique index and by availability queries. */
export const SLOT_HOLDING_STATUSES: readonly BookingStatus[] = ['pending', 'confirmed'];

/**
 * The statuses that put a booking BEHIND both parties -- #282.
 *
 * Deliberately not `SLOT_HOLDING_STATUSES` inverted, though the two sets are
 * complements of each other today. That one answers "does this booking still
 * hold the slot against another customer", which is a contention question
 * owned by the partial unique index and the availability queries. This one
 * answers "is this booking still ahead of the people involved", which is a
 * worklist question. Sharing one constant between them would mean a change
 * made for contention silently moved a booking out of a professional's
 * counter.
 */
export const CONCLUDED_BOOKING_STATUSES: readonly BookingStatus[] = ['completed', 'cancelled', 'expired', 'no_show'];

/**
 * Everything else, DERIVED rather than written out -- #282.
 *
 * The professional's booking list partitions by complement ("cancelled to its
 * own tab, the terminal ones to the past, everything else upcoming"), so the
 * count beside «رزروها» has to agree with a complement, not with a hand-kept
 * allow-list. Deriving it means a status added to `BOOKING_STATUSES` tomorrow
 * lands here by default and is counted, which is what that list would already
 * do with it. The failure mode of forgetting to classify a new status is
 * therefore agreement, not a badge that silently disagrees with the tab.
 */
export const OPEN_BOOKING_STATUSES: readonly BookingStatus[] = BOOKING_STATUSES.filter(
  (status) => !CONCLUDED_BOOKING_STATUSES.includes(status),
);

export const BOOKING_ACTOR_TYPES = ['customer', 'professional', 'system', 'admin'] as const;
export type BookingActorType = (typeof BOOKING_ACTOR_TYPES)[number];

@Entity({ name: 'bookings', schema: 'booking' })
@Index('ix_bookings_customer_status', ['customerId', 'status'])
@Index('ix_bookings_professional_status', ['professionalId', 'status'])
export class BookingEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References identity.users.id -- the person who booked. */
  @Column({ type: 'uuid' })
  customerId!: string;

  /** References provider.professionals.id -- NOT the professional's owning user id (that indirection is resolved by the ownership resolver). */
  @Column({ type: 'uuid' })
  professionalId!: string;

  @Column({ type: 'uuid', nullable: true })
  serviceId!: string | null;

  @Column({ type: 'uuid' })
  slotId!: string;

  /**
   * Denormalized from the slot at claim time, on purpose. The booking is
   * the customer's record of "when am I expected"; it must remain
   * answerable and auditable even if the slot row is later reshaped, and a
   * reschedule must leave a history trail of what the time USED to be.
   */
  @Column({ type: 'timestamptz' })
  slotStart!: Date;

  @Column({ type: 'timestamptz' })
  slotEnd!: Date;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: BookingStatus;

  /** Mirrors the slot's hold expiry so the sweep can find stale bookings without joining. Null once confirmed or terminal. */
  @Column({ type: 'timestamptz', nullable: true })
  holdExpiresAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  rescheduleCount!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  cancellationReason!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  cancelledByActorType!: BookingActorType | null;

  @Column({ type: 'uuid', nullable: true })
  cancelledByActorId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
