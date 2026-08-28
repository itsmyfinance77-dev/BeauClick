import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const REVIEW_STATUSES = ['published', 'hidden'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * One customer's review of one completed booking.
 *
 * `bookingId` carries a foreign key to `provider.review_eligibility` and a
 * UNIQUE index. Those two constraints ARE the eligibility rules -- "no review
 * without a completed booking" and "one review per booking" -- so neither is
 * an application check that a future caller could forget, and neither races.
 * See the migration for why eligibility is a projection this domain owns
 * rather than a synchronous read of booking-service.
 */
@Entity({ name: 'reviews', schema: 'provider' })
export class ReviewEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  bookingId!: string;

  /** Denormalized from the eligibility row at write time. Never from the request. */
  @Column({ type: 'uuid' })
  professionalId!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'smallint' })
  rating!: number;

  /**
   * Free text from the customer.
   *
   * PII-adjacent and EXCLUDED BY CONSTRUCTION from event payloads, audit
   * snapshots, and any future AI context -- `V3_DOMAIN_BOUNDARIES.md` §ai
   * names "raw review text" explicitly. The rule lives beside the data so a
   * later phase inherits it rather than rediscovering it.
   */
  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'published' })
  status!: ReviewStatus;

  /** The professional's public reply. Also free text, also never in an event. */
  @Column({ type: 'text', nullable: true })
  responseText!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  moderatedBy!: string | null;

  /** Non-null means triaged. The moderation queue is exactly the rows where this is null. */
  @Column({ type: 'timestamptz', nullable: true })
  moderatedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  moderationReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
