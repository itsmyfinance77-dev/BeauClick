import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * A slot has exactly three states and every transition is a compare-and-swap:
 *
 *   open  --claim-->  held  --confirm-->  booked
 *     ^                 |                    |
 *     +---- release ----+----- release ------+
 *
 * There is deliberately no `blocked`/`unavailable` state: a professional
 * removing time simply deletes an `open` row (a held/booked one may not be
 * deleted -- it backs a real customer commitment and must go through
 * cancellation). Adding a fourth state to express "not offered" would make
 * the claim predicate more complex for zero product benefit, since "no row"
 * already means "not offered".
 */
export const SLOT_STATUSES = ['open', 'held', 'booked'] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

/**
 * V3's availability model, carried forward from V2's proven choice
 * (`CreateBookingTables`'s own docblock): **concrete materialized rows**,
 * not a recurrence rule evaluated at read time. A recurrence engine would
 * have to re-derive "is this instance still free?" against an exception
 * table on every read, and there is no atomic way to claim a row that does
 * not exist -- which is precisely the property the whole concurrency
 * guarantee rests on. `bulkGenerate` gives professionals the weekly-pattern
 * ergonomics of recurrence while keeping one real, lockable row per slot.
 */
@Entity({ name: 'availability_slots', schema: 'booking' })
@Index('ix_availability_slots_professional_start_status', ['professionalId', 'startAt', 'status'])
export class AvailabilitySlotEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References provider.professionals.id -- no cross-schema FK, by the same convention Phase 1 established. */
  @Column({ type: 'uuid' })
  professionalId!: string;

  /** References provider.services.id. Nullable: a professional may publish generic availability not tied to one service. */
  @Column({ type: 'uuid', nullable: true })
  serviceId!: string | null;

  @Column({ type: 'timestamptz' })
  startAt!: Date;

  @Column({ type: 'timestamptz' })
  endAt!: Date;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: SlotStatus;

  /**
   * When a `held` claim lapses. Read as part of the claim predicate itself
   * (`status='open' OR (status='held' AND held_until < now())`), so a
   * customer is never blocked by how recently the expiry sweep last ran --
   * only by an ACTIVE hold. V2's most important availability behaviour,
   * preserved exactly.
   */
  @Column({ type: 'timestamptz', nullable: true })
  heldUntil!: Date | null;

  /** Which booking currently holds/owns this slot. Diagnostic + lets a release verify it is releasing its own hold. */
  @Column({ type: 'uuid', nullable: true })
  heldByBookingId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
