import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { OutboxEventEntityBase } from '@beauclick/events';

/**
 * The append-only points ledger.
 *
 * There is deliberately no `balance` column anywhere in this schema. V2 made
 * the same call and its reasoning holds: a cached balance is a second source
 * of truth that must be kept in sync with the ledger under concurrency, and
 * the query it saves (`SUM` over one indexed user's rows) is cheap at any
 * realistic per-customer row count. The financial ledger makes the identical
 * choice for the identical reason.
 */
@Entity({ name: 'points_entries', schema: 'loyalty' })
export class PointsEntryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  /** Signed. Negative is a redemption. */
  @Column({ type: 'int' })
  points!: number;

  @Column({ type: 'varchar', length: 64 })
  reason!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  referenceType!: string | null;

  @Column({ type: 'uuid', nullable: true })
  referenceId!: string | null;

  /**
   * The multiplier actually applied, in basis points. Captured per row rather
   * than recomputed, for the same reason financial captures the commission
   * rate per ledger row: changing a tier's benefit tomorrow must never
   * retroactively change what a past award was worth.
   */
  @Column({ type: 'int', default: 10000 })
  multiplierBp!: number;

  /** What the rule awarded before the multiplier -- so the two are separable after the fact. */
  @Column({ type: 'int' })
  basePoints!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'tiers', schema: 'loyalty' })
export class TierEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  slug!: string;

  @Column({ type: 'varchar', length: 191 })
  name!: string;

  @Column({ type: 'int', default: 0 })
  thresholdPoints!: number;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'membership_plans', schema: 'loyalty' })
export class MembershipPlanEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  slug!: string;

  @Column({ type: 'varchar', length: 191 })
  name!: string;

  @Column({ type: 'uuid', nullable: true })
  tierId!: string | null;

  @Column({ type: 'boolean', default: false })
  isPaid!: boolean;

  @Column({ type: 'bigint', nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) } })
  priceToman!: number | null;

  @Column({ type: 'int', nullable: true })
  billingPeriodDays!: number | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

export type MembershipStatus = 'active' | 'expired' | 'cancelled';
export type ActivationSource = 'manual' | 'tier_qualification';

@Entity({ name: 'memberships', schema: 'loyalty' })
export class MembershipEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  userId!: string;

  @Column({ type: 'uuid' })
  planId!: string;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: MembershipStatus;

  @Column({ type: 'varchar', length: 20, default: 'manual' })
  activationSource!: ActivationSource;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

export type BenefitType = 'bonus_points_multiplier' | 'discount_percentage' | 'descriptive';

@Entity({ name: 'benefits', schema: 'loyalty' })
export class BenefitEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  sourceType!: 'tier' | 'membership_plan';

  @Column({ type: 'uuid' })
  sourceId!: string;

  @Column({ type: 'varchar', length: 30 })
  benefitType!: BenefitType;

  @Column({ type: 'varchar', length: 191 })
  label!: string;

  /**
   * Typed by convention, in basis points where it is a rate.
   * `{ multiplierBp: 12000 }` or `{ percentBp: 1000 }`.
   *
   * Basis points rather than a float percentage is the same correction Phase 2
   * made to commission rates: V2 stored integer percent, so 12.5% was
   * unrepresentable, and stored discounts as floats, which produced a real
   * rounding mismatch between two stacked discounts.
   */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  config!: Record<string, number | string>;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * A record of the MOMENT a tier changed, never the tier itself.
 *
 * V2 computed tier at read time and stored nothing, which was right, but it
 * meant "when did this customer reach Gold" had no answer and no notification
 * could be sent. Recording the crossing keeps the computed-tier property
 * intact while making the transition observable.
 */
@Entity({ name: 'tier_crossings', schema: 'loyalty' })
export class TierCrossingEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  fromTierSlug!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  toTierSlug!: string | null;

  @Column({ type: 'int' })
  lifetimeEarned!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'outbox_events', schema: 'loyalty' })
export class LoyaltyOutboxEntity extends OutboxEventEntityBase {}

export const LOYALTY_ENTITIES = [
  PointsEntryEntity,
  TierEntity,
  MembershipPlanEntity,
  MembershipEntity,
  BenefitEntity,
  TierCrossingEntity,
  LoyaltyOutboxEntity,
];
