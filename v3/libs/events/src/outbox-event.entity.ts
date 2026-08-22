import { Column, CreateDateColumn, Index, PrimaryColumn } from 'typeorm';

/**
 * V3_DATABASE_BLUEPRINT.md §7's transactional outbox, as a shared abstract
 * entity each schema subclasses (`booking.outbox_events`,
 * `commerce.outbox_events`, `payment.outbox_events`).
 *
 * Why an outbox at all rather than publishing from application code: a
 * business write and its corresponding event must never be able to happen
 * independently of each other. Publishing from code after a commit loses
 * the event if the process dies in between; publishing before the commit
 * announces something that may never have happened. Writing the event row
 * inside the SAME transaction as the business change makes the pair atomic,
 * and a separate relay turns committed rows into deliveries.
 *
 * TypeORM abstract-entity inheritance: this class carries no `@Entity`
 * decorator. Each schema declares its own concrete subclass with its own
 * `@Entity({ schema })`, so the columns are defined once here while the
 * table stays owned by exactly one module -- honouring ADR-011's rule that
 * no service reads another service's tables.
 */
export abstract class OutboxEventEntityBase {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 60 })
  aggregateType!: string;

  @Column({ type: 'uuid' })
  aggregateId!: string;

  @Column({ type: 'varchar', length: 80 })
  eventType!: string;

  @Column({ type: 'int', default: 1 })
  eventVersion!: number;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /**
   * Ties this event to the customer action that caused it, across every
   * schema it fans out to. Nullable only because rows written before the
   * column existed have no honest value to backfill -- every new row gets
   * one, minted at the request edge or by the relay for a background sweep.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  correlationId!: string | null;

  /**
   * Null until the relay has successfully dispatched this row to every
   * registered handler. The relay's claim query filters on this being
   * null, which is what makes redelivery-after-crash automatic.
   */
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  /** Incremented on each failed dispatch, so a poison message is visible rather than silently retried forever. */
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
