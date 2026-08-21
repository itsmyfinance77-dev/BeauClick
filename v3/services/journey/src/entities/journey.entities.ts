import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

/**
 * One row per customer, keyed BY the user id.
 *
 * There is no separate surrogate `id`, and that is deliberate: a profile with
 * its own id could be addressed by that id, which immediately creates a route
 * shape where a customer names a profile that might not be theirs. With the
 * user id as the primary key, "my profile" is the only addressable thing, and
 * cross-customer access has no representation to attempt.
 */
@Entity({ name: 'beauty_profiles', schema: 'journey' })
export class BeautyProfileEntity {
  @PrimaryColumn('uuid')
  userId!: string;

  @Column({ type: 'uuid', nullable: true })
  preferredCityId!: string | null;

  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  preferredSpecialtyIds!: string[];

  @Column({ type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  budgetMinToman!: number | null;

  @Column({ type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  budgetMaxToman!: number | null;

  /**
   * Customer-authored free text.
   *
   * This field is the reason Journey is its own module (ADR-019). It must
   * never enter an AI prompt, an event payload, an analytics fact, or a log
   * line. `JourneyContextProvider` is the only code that reads the profile for
   * an outbound purpose, and its return TYPE has no free-text field -- so the
   * rule is enforced by the type system rather than by remembering.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  notes!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

export type GoalStatus = 'active' | 'achieved' | 'abandoned';

@Entity({ name: 'beauty_goals', schema: 'journey' })
export class BeautyGoalEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 191 })
  title!: string;

  @Column({ type: 'uuid', nullable: true })
  specialtyId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  cityId!: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  budgetToman!: number | null;

  @Column({ type: 'date', nullable: true })
  targetDate!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: GoalStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * The timeline read model.
 *
 * V2 composed this at read time from `wp_bc_events` and `wp_bc_bookings` --
 * two other plugins' tables -- and its own docblock records the workaround
 * that forced: booking events carried no actor_id, so the composer had to
 * fetch the customer's booking ids first and match against that set.
 *
 * Here the timeline is written by event handlers into a table journey owns.
 * Journey queries no other schema, and the entries are already scoped to a
 * user by construction rather than by a join that has to get the scoping right.
 */
@Entity({ name: 'timeline_entries', schema: 'journey' })
export class TimelineEntryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  /** A stable machine key. The Persian label is rendered from it at read time. */
  @Column({ type: 'varchar', length: 40 })
  entryType!: string;

  @Column({ type: 'varchar', length: 40 })
  sourceType!: string;

  @Column({ type: 'uuid' })
  sourceId!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @Column({ type: 'timestamptz' })
  occurredAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'outbox_events', schema: 'journey' })
export class JourneyOutboxEntity extends OutboxEventEntityBase {}

export const JOURNEY_ENTITIES = [BeautyProfileEntity, BeautyGoalEntity, TimelineEntryEntity, JourneyOutboxEntity];
