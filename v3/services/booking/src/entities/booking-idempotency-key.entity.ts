import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Request-level idempotency for booking mutations.
 *
 * The structural guarantees (the slot claim, the partial unique index on
 * `slot_id`) already make it impossible to double-BOOK a slot. This table
 * solves the different, softer problem those cannot: a double-clicked
 * "confirm" or a mobile client's automatic retry must return the SAME
 * booking rather than a second, different booking of a second slot -- and
 * a cancel/reschedule retried after a network timeout must be a no-op
 * rather than a second state change.
 *
 * `UNIQUE(scope, owner_id, key)` is scoped by owner deliberately: an
 * idempotency key is a client-chosen string, so keying it globally would
 * let one customer's key collide with (and leak the response of) another's.
 */
@Entity({ name: 'idempotency_keys', schema: 'booking' })
@Index('uq_booking_idempotency_keys', ['scope', 'ownerId', 'key'], { unique: true })
export class BookingIdempotencyKeyEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** e.g. 'booking.create'. Namespaces keys so the same client key can be reused across different operations. */
  @Column({ type: 'varchar', length: 40 })
  scope!: string;

  /** The session user the key belongs to -- never client-supplied. */
  @Column({ type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'varchar', length: 128 })
  key!: string;

  /** The id of whatever the first successful call produced (e.g. the booking id), so a retry can return it. */
  @Column({ type: 'uuid', nullable: true })
  resultId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
