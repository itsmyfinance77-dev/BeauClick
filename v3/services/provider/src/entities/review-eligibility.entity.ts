import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * "This customer completed this booking with this professional."
 *
 * A projection of a booking fact into the provider domain, written by the
 * `BookingCompleted` consumer. It is NOT a second source of truth about
 * bookings: it carries no price, no status, and no schedule, and the single
 * thing it claims — that a booking completed — is not a fact that later
 * changes.
 *
 * It exists so that review eligibility is a FOREIGN KEY rather than a
 * synchronous cross-domain read. provider-service cannot query booking-service
 * (ADR-011), and a port that let it would reintroduce exactly the coupling
 * `ProviderEventsService`'s docblock records V2 suffering from — reviews would
 * become undeployable without booking, and the eligibility check would be four
 * application assertions every future caller has to remember instead of one
 * constraint the database enforces.
 *
 * `bookingId` is the primary key rather than a surrogate: the event is
 * delivered at least once, so a redelivery must be a no-op, and making the
 * natural key the primary key means `ON CONFLICT DO NOTHING` is the entire
 * idempotency story with no second place for a duplicate to hide.
 */
@Entity({ name: 'review_eligibility', schema: 'provider' })
export class ReviewEligibilityEntity {
  @PrimaryColumn('uuid')
  bookingId!: string;

  @Column({ type: 'uuid' })
  professionalId!: string;

  /** identity.users.id, by value. No cross-schema FK, per V3_DATABASE_BLUEPRINT.md §1. */
  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'uuid', nullable: true })
  serviceId!: string | null;

  @Column({ type: 'timestamptz' })
  completedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
