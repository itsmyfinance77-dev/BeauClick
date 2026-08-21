import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type MetricKind = 'event_derived' | 'domain_derived' | 'correlation_derived';

export type AnalyticsSubjectType =
  | 'provider'
  | 'customer'
  | 'order'
  | 'booking'
  | 'search'
  | 'notification'
  | 'membership';

/**
 * The analytics fact table.
 *
 * The primary key is the PRODUCING EVENT'S id, not a fresh one. That single
 * choice is what makes ingestion idempotent: the outbox is at-least-once, so
 * a redelivered event would otherwise inflate every count derived from it, and
 * an inflated analytics number is uniquely bad — it is wrong, plausible, and
 * has nothing to compare against that would reveal it.
 *
 * V2's `wp_bc_events` had no such guard, plus a free-text `event_type` and an
 * unvalidated JSON `meta` blob documented only in a code comment. Everything
 * reaching this table now passes a registered event contract first.
 */
@Entity({ name: 'events', schema: 'analytics' })
export class AnalyticsEventEntity {
  @PrimaryColumn('uuid')
  eventId!: string;

  @Index()
  @Column({ type: 'varchar', length: 80 })
  eventType!: string;

  @Column({ type: 'int' })
  eventVersion!: number;

  @Column({ type: 'varchar', length: 60 })
  aggregateType!: string;

  @Column({ type: 'uuid' })
  aggregateId!: string;

  /**
   * The party the fact is ABOUT, normalized.
   *
   * GAP-15's closure. V2's `profile_view` logged the raw CPT post type here
   * (`bc_professional`) while every other provider-scoped event logged
   * `provider`, so the two could not be compared and any query joining them
   * silently returned nothing. A CHECK constraint now makes the
   * un-normalized value unstorable.
   */
  @Column({ type: 'varchar', length: 30, nullable: true })
  subjectType!: AnalyticsSubjectType | null;

  @Column({ type: 'uuid', nullable: true })
  subjectId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  /** Bounded, structured dimensions. Never a free-form blob. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  dimensions!: Record<string, string | number | boolean | null>;

  @Column({ type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  metricValue!: number | null;

  @Column({ type: 'timestamptz' })
  occurredAt!: Date;

  /** The calendar day in the platform timezone, denormalized so rollups can index it. */
  @Column({ type: 'date' })
  occurredOn!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  ingestedAt!: Date;
}

/**
 * Pre-aggregated daily figures. What dashboards read.
 *
 * `metricKind` travels with every number so a dashboard cannot present a
 * proxy as a direct measurement. That distinction is a real requirement
 * (§26), and putting it in the data rather than in a footnote is what makes
 * it survive being copied into a report.
 */
@Entity({ name: 'daily_metrics', schema: 'analytics' })
export class DailyMetricEntity {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  metricKey!: string;

  @PrimaryColumn({ type: 'date' })
  metricDay!: string;

  @PrimaryColumn({ type: 'varchar', length: 30, default: '' })
  scopeType!: string;

  @PrimaryColumn({ type: 'uuid', default: '00000000-0000-0000-0000-000000000000' })
  scopeId!: string;

  @Column({ type: 'varchar', length: 20 })
  metricKind!: MetricKind;

  @Column({ type: 'bigint', default: 0, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  countValue!: number;

  @Column({ type: 'bigint', default: 0, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  sumValue!: number;

  @Column({ type: 'int', default: 0 })
  distinctActors!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  computedAt!: Date;
}

@Entity({ name: 'rollup_state', schema: 'analytics' })
export class RollupStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  metricKey!: string;

  @Column({ type: 'date', nullable: true })
  lastComputedDay!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  lastRunRows!: number | null;
}

export const ANALYTICS_ENTITIES = [AnalyticsEventEntity, DailyMetricEntity, RollupStateEntity];
