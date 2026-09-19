import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { CatalogueLifecycleState, SellerRiskClass } from '@beauclick/commercial-policy-contract';

/**
 * The three tables of ADR-052 §1 and §8's settlement plane — V3.3 Story #175
 * (`#43d`).
 *
 * Projections of a schema whose rules live in SQL. The lifecycle, published
 * immutability, the effective-window exclusion, one key per
 * `(plan_key, risk_class)`, the strict publication instant, one CURRENT class
 * per seller party and the forward-only supersession are all constraints and
 * triggers in `20260924100001_…`.
 *
 * ## What is absent
 *
 * No proposal, batch, reserve posting or payout (`#43e`). No scoring: nothing
 * here computes a risk class, and `V33-DEC-040` R4 is why.
 */

const bigint = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity({ name: 'settlement_schedule_policies', schema: 'commercial' })
export class SettlementSchedulePolicyEntity {
  @PrimaryColumn({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  @Column({ name: 'plan_key', type: 'varchar', length: 64 })
  planKey!: string;

  /** Unique with `plan_key`: the pair is the key `#43e`'s resolver asks about. */
  @Column({ name: 'risk_class', type: 'varchar', length: 16 })
  riskClass!: SellerRiskClass;

  @Column({ name: 'display_name', type: 'varchar', length: 120 })
  displayName!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;
}

@Entity({ name: 'settlement_schedule_policy_versions', schema: 'commercial' })
export class SettlementSchedulePolicyVersionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 16 })
  lifecycleState!: CatalogueLifecycleState;

  @Column({ name: 'settlement_interval_days', type: 'int' })
  settlementIntervalDays!: number;

  /** Null means NO minimum — distinct from zero. */
  @Column({ name: 'minimum_payout_toman', type: 'bigint', nullable: true, transformer: bigint })
  minimumPayoutToman!: number | null;

  @Column({ name: 'reserve_bp', type: 'int', nullable: true })
  reserveBasisPoints!: number | null;

  @Column({ name: 'reserve_cap_toman', type: 'bigint', nullable: true, transformer: bigint })
  reserveCapToman!: number | null;

  @Column({ name: 'activation_starts_at', type: 'timestamptz', nullable: true })
  activationStartsAt!: Date | null;

  @Column({ name: 'activation_ends_at', type: 'timestamptz', nullable: true })
  activationEndsAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ name: 'published_by_user_id', type: 'uuid', nullable: true })
  publishedByUserId!: string | null;

  @Column({ name: 'published_by_label', type: 'varchar', length: 40, nullable: true })
  publishedByLabel!: string | null;

  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt!: Date | null;

  @Column({ name: 'retired_by_user_id', type: 'uuid', nullable: true })
  retiredByUserId!: string | null;

  @Column({ name: 'retired_by_label', type: 'varchar', length: 40, nullable: true })
  retiredByLabel!: string | null;
}

@Entity({ name: 'seller_risk_class_assignments', schema: 'commercial' })
export class SellerRiskClassAssignmentEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'seller_party_type', type: 'varchar', length: 16 })
  sellerPartyType!: 'professional' | 'business';

  @Column({ name: 'seller_party_id', type: 'uuid' })
  sellerPartyId!: string;

  @Column({ name: 'risk_class', type: 'varchar', length: 16 })
  riskClass!: SellerRiskClass;

  /**
   * Retained and NEVER exported to the seller (ADR-027, #175's preflight).
   * The class is disclosed; this text is not.
   */
  @Column({ name: 'reason', type: 'varchar', length: 500 })
  reason!: string;

  @Column({ name: 'assigned_at', type: 'timestamptz' })
  assignedAt!: Date;

  @Column({ name: 'assigned_by_user_id', type: 'uuid', nullable: true })
  assignedByUserId!: string | null;

  @Column({ name: 'assigned_by_label', type: 'varchar', length: 40, nullable: true })
  assignedByLabel!: string | null;

  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  @Column({ name: 'superseded_by_user_id', type: 'uuid', nullable: true })
  supersededByUserId!: string | null;

  @Column({ name: 'superseded_by_assignment_id', type: 'uuid', nullable: true })
  supersededByAssignmentId!: string | null;
}

/** Registered with TypeORM by `SettlementScheduleModule`, and by the app DataSource. */
export const SETTLEMENT_SCHEDULE_ENTITIES = [
  SettlementSchedulePolicyEntity,
  SettlementSchedulePolicyVersionEntity,
  SellerRiskClassAssignmentEntity,
];
