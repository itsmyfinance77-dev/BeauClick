import { Column, Entity, PrimaryColumn } from 'typeorm';

export type CustomerRemedyChoiceOption = 'refund' | 'reschedule';
export type CustomerRemedyResolvedBy = 'customer' | 'default';

/**
 * The customer's remedy after a seller, platform or provider cancellation —
 * V3.3 #161 (`#42d`), ADR-051 §8.
 *
 * Always born already `resolvedBy: 'default'` (the immediate full refund,
 * `V33-DEC-039` R7 — no ratified response deadline exists to wait on) and
 * moves at most once more, to `resolvedBy: 'customer'` / `chosen:
 * 'reschedule'`, while the linked cancellation decision's refund has not yet
 * executed (`database/migrations/commerce/20260921100003_…`). `order_id`
 * PRIMARY KEY is the idempotency mechanism: a second remedy request is a
 * read of the existing resolution, never a second write.
 */
@Entity({ name: 'customer_remedy_choices', schema: 'commerce' })
export class CustomerRemedyChoiceEntity {
  @PrimaryColumn({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId!: string;

  @Column({ name: 'offered_at', type: 'timestamptz' })
  offeredAt!: Date;

  @Column({ type: 'text', array: true })
  options!: CustomerRemedyChoiceOption[];

  @Column({ type: 'varchar', length: 16, nullable: true })
  chosen!: CustomerRemedyChoiceOption | null;

  @Column({ name: 'chosen_at', type: 'timestamptz', nullable: true })
  chosenAt!: Date | null;

  @Column({ name: 'resolved_by', type: 'varchar', length: 16 })
  resolvedBy!: CustomerRemedyResolvedBy;

  @Column({ name: 'resolved_at', type: 'timestamptz' })
  resolvedAt!: Date;
}
