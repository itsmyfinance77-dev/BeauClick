import { Column, Entity, PrimaryColumn } from 'typeorm';

import type {
  CatalogueLifecycleState,
  CommissionBase,
  CommissionComponent,
  CommissionRuleKind,
} from '@beauclick/commercial-policy-contract';

/**
 * The two tables of ADR-052 §1's commission publication plane — V3.3 Story
 * #173 (`#43b-1`).
 *
 * ## Read these as projections of a schema whose rules live in SQL
 *
 * Nothing here enforces anything. The four-shape CHECK matrix, the lifecycle
 * allow-list, published immutability, the effective-window exclusion, the
 * one-key-per-component uniqueness, non-retroactivity and the no-tolerance
 * publication instant are all constraints and triggers in
 * `database/migrations/commercial/20260922100001_…`, because a guarantee
 * upheld by an entity is upheld only by whoever remembers to go through the
 * entity. The same division `BookingOutcomePolicyEntity` records.
 *
 * ## What is absent
 *
 * No order snapshot (`#43b-2`, #192), no recognition or release (`#43c`), no
 * receivable, no journal posting, no fee allocation and no settlement
 * schedule. Neither entity below is read by `commerce`, `booking`, `payment`
 * or `financial` — on the day this lands, nothing reads them at all.
 */

const bigint = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity({ name: 'commission_policies', schema: 'commercial' })
export class CommissionPolicyEntity {
  @PrimaryColumn({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  /** Unique across the table: one key per component, so the resolver's question has one answer. */
  @Column({ name: 'component', type: 'varchar', length: 32 })
  component!: CommissionComponent;

  @Column({ name: 'display_name', type: 'varchar', length: 120 })
  displayName!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;
}

@Entity({ name: 'commission_policy_versions', schema: 'commercial' })
export class CommissionPolicyVersionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 16 })
  lifecycleState!: CatalogueLifecycleState;

  @Column({ name: 'rule_kind', type: 'varchar', length: 16 })
  ruleKind!: CommissionRuleKind;

  /** Present for `percentage` and `hybrid` only — the CHECK matrix makes anything else unrepresentable. */
  @Column({ name: 'bp', type: 'int', nullable: true })
  basisPoints!: number | null;

  @Column({ name: 'fixed_toman', type: 'bigint', nullable: true, transformer: bigint })
  fixedToman!: number | null;

  @Column({ name: 'base', type: 'varchar', length: 32, nullable: true })
  base!: CommissionBase | null;

  @Column({ name: 'arithmetic_version', type: 'int' })
  arithmeticVersion!: number;

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

/** Registered with TypeORM by `CommissionPolicyModule`, and by the pg test factory. */
export const COMMISSION_POLICY_ENTITIES = [CommissionPolicyEntity, CommissionPolicyVersionEntity];
