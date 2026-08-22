import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const WAITLIST_STATUSES = ['waiting', 'offered', 'accepted', 'declined', 'expired', 'missed', 'removed'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

/**
 * GAP-26's invariant, preserved deliberately (ADR-024): a waitlist offer
 * never reserves the slot. `offeredSlotId` records WHICH slot was offered,
 * for display and for the matcher's own idempotency -- it grants no hold on
 * `booking.availability_slots`, which stays claimable by anyone (including a
 * direct, non-waitlist customer) the entire time an offer is outstanding.
 * Converting an offer into a real booking goes through the identical atomic
 * claim every other booking uses (`WaitlistAcceptanceService`, composition
 * root) and can still lose that race -- `missed` is the status that records
 * when it did.
 */
@Entity({ name: 'entries', schema: 'waitlist' })
// One ACTIVE join per (customer, professional, service) -- a customer
// cannot flood the same waitlist twice, and re-joining after leaving or
// missing an offer is a fresh, distinct entry (a new position at the back).
//
// Approximate here: PostgreSQL unique indexes treat NULL as distinct from
// NULL, so this decorator alone would let a customer join the "any
// service" (serviceId=null) waitlist twice. The real migration
// (`20260822200001_create_waitlist_schema.sql`) closes that with a
// COALESCE-to-sentinel expression index a TypeORM decorator cannot express;
// it is the authoritative constraint. This decorator exists for pg-mem's
// fast-layer schema synthesis, and being looser than the real database in
// the null case is the safe direction to diverge in (PHASE2-01: pg-mem is
// never trusted for constraint-strength guarantees, only real PostgreSQL is).
@Index('uq_waitlist_active_entry', ['customerId', 'professionalId', 'serviceId'], {
  unique: true,
  where: `status IN ('waiting', 'offered')`,
})
// At most one ACTIVE offer per slot at a time -- the matcher's own
// idempotency backstop (see waitlist.service.ts offerNextFor()).
@Index('uq_waitlist_active_offer_slot', ['offeredSlotId'], {
  unique: true,
  where: `status = 'offered'`,
})
export class WaitlistEntryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  /** References provider.professionals.id. No cross-schema FK by convention. */
  @Column({ type: 'uuid' })
  professionalId!: string;

  /** Null means "any service this professional offers" -- broader eligibility, offered whichever slot opens first. */
  @Column({ type: 'uuid', nullable: true })
  serviceId!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'waiting' })
  status!: WaitlistStatus;

  @Column({ type: 'uuid', nullable: true })
  offeredSlotId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  offeredAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  offerExpiresAt!: Date | null;

  /** Set only when status reaches 'accepted' -- the real booking this waitlist entry produced. */
  @Column({ type: 'uuid', nullable: true })
  resultingBookingId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
