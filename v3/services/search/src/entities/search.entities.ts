import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

export interface IndexedService {
  serviceId: string;
  name: string;
  priceToman: number;
  durationMinutes: number;
}

/**
 * The PostgreSQL projection of a provider search document.
 *
 * `revision` is the whole out-of-order story. See the schema migration for
 * the reasoning; the enforcement is in `SearchIndexerService.applyProfessional`,
 * which does a conditional UPDATE guarded on `revision < :incoming` rather
 * than a read-then-write. Under READ COMMITTED, a second concurrent UPDATE of
 * the same row blocks on the first's lock and re-evaluates its WHERE against
 * the newly committed row -- so two simultaneous events for one professional
 * resolve to exactly the higher revision, with no application-level locking.
 */
@Entity({ name: 'provider_documents', schema: 'search' })
export class ProviderDocumentEntity {
  @PrimaryColumn('uuid')
  professionalId!: string;

  @Column({ type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  revision!: number;

  @Column({ type: 'varchar', length: 120 })
  displayName!: string;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'uuid', nullable: true })
  cityId!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  cityName!: string | null;

  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  specialtyIds!: string[];

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  specialtyNames!: string[];

  @Column({ type: 'varchar', length: 20, default: 'unverified' })
  verificationStatus!: string;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  services!: IndexedService[];

  @Column({ type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  minPriceToman!: number | null;

  @Column({ type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  maxPriceToman!: number | null;

  @Column({ type: 'boolean', default: false })
  isDeleted!: boolean;

  /**
   * Imagery (V3.1 Phase C), written by `ProfessionalMediaChanged` and NOT by
   * `ProfessionalUpdated`.
   *
   * The two events carry the same per-professional `revision`, so ordering
   * still works; they simply own different columns. `applyProfessional`'s
   * upsert names its own columns explicitly and does not touch these, which is
   * what stops a profile edit from blanking a professional's avatar -- exactly
   * the treatment `services` already gets.
   */
  @Column({ type: 'text', nullable: true })
  avatarUrl!: string | null;

  /** Intrinsic dimensions, so a result card can reserve space before the image loads. */
  @Column({ type: 'int', nullable: true })
  avatarWidth!: number | null;

  @Column({ type: 'int', nullable: true })
  avatarHeight!: number | null;

  @Column({ type: 'int', default: 0 })
  portfolioCount!: number;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  portfolioPreviewUrls!: string[];

  @Column({ type: 'numeric', precision: 9, scale: 4, default: 0, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  rankingScore!: number;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  rankingSignalKeys!: string[];

  /** Non-null = this row still needs pushing to the engine. The outstanding-work queue. */
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  indexDirtySince!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  indexedAt!: Date | null;

  @Column({ type: 'timestamptz' })
  sourceUpdatedAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'ranking_signals', schema: 'search' })
export class RankingSignalsEntity {
  @PrimaryColumn('uuid')
  professionalId!: string;

  @Column({ type: 'int', default: 0 })
  completedBookings!: number;

  @Column({ type: 'int', default: 0 })
  cancelledBookings!: number;

  @Column({ type: 'int', default: 0 })
  createdBookings!: number;

  @Column({ type: 'int', default: 0 })
  profileViews!: number;

  @Column({ type: 'int', default: 0 })
  ratingSum!: number;

  @Column({ type: 'int', default: 0 })
  reviewCount!: number;

  @Column({ type: 'int', default: 0 })
  recentActivityCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastActivityAt!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * Which events have already moved a counter.
 *
 * A counter increment is the one projection operation that is NOT naturally
 * idempotent: `SET n = n + 1` applied twice leaves a permanently wrong number
 * with nothing to detect it afterwards. Every increment therefore inserts a
 * row here first, keyed on the outbox event's own id, and a redelivery loses
 * that insert and skips the increment.
 */
@Entity({ name: 'signal_applications', schema: 'search' })
export class SignalApplicationEntity {
  @PrimaryColumn('uuid')
  eventId!: string;

  @PrimaryColumn({ type: 'varchar', length: 40 })
  signal!: string;

  @Column({ type: 'uuid' })
  professionalId!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  appliedAt!: Date;
}

@Entity({ name: 'index_state', schema: 'search' })
export class IndexStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  indexKey!: string;

  @Column({ type: 'varchar', length: 120 })
  physicalIndex!: string;

  @Column({ type: 'int' })
  mappingVersion!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastFullReindexAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  lastFullReindexCount!: number | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'outbox_events', schema: 'search' })
export class SearchOutboxEntity extends OutboxEventEntityBase {}

export const SEARCH_ENTITIES = [
  ProviderDocumentEntity,
  RankingSignalsEntity,
  SignalApplicationEntity,
  IndexStateEntity,
  SearchOutboxEntity,
];
