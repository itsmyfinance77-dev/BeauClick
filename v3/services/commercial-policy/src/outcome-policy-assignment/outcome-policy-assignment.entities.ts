import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { BookingOutcomeRetentionKind, SubscriberPartyType } from '@beauclick/commercial-policy-contract';

const bigint = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * The seller's booking-outcome selection history — V3.3 Story #159 (`#42b`),
 * ADR-051 §3.
 *
 * ## A projection of a schema whose rules live in SQL
 *
 * Nothing here enforces anything. One-current-row, the supersession pairing,
 * immutability, the refusal to DELETE, the database-clock instants and — the
 * rule this table adds to #104's shape — that every selected member belongs to
 * the version active at the database instant, are all in
 * `database/migrations/commercial/20260919100001_…`. A guarantee upheld by an
 * entity is upheld by whoever remembers to go through the entity.
 *
 * ## `supersededAt IS NULL` is the whole state machine
 *
 * As on #104's twin: presence of a current row IS enrollment, and there is no
 * un-enrollment column (ADR-048 R2, reused by ADR-051 §3).
 */
@Entity({ name: 'seller_outcome_policy_assignments', schema: 'commercial' })
export class SellerOutcomePolicyAssignmentEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'seller_party_type', type: 'varchar', length: 16 })
  sellerPartyType!: SubscriberPartyType;

  @Column({ name: 'seller_party_id', type: 'uuid' })
  sellerPartyId!: string;

  /** The stable key. The version is resolved per order, never pinned here. */
  @Column({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  @Column({ name: 'cutoff_hours', type: 'smallint' })
  cutoffHours!: number;

  @Column({ name: 'late_retention_kind', type: 'varchar', length: 32 })
  lateRetentionKind!: BookingOutcomeRetentionKind;

  @Column({ name: 'late_retention_basis_points', type: 'int', nullable: true })
  lateRetentionBasisPoints!: number | null;

  @Column({ name: 'late_retention_amount_toman', type: 'bigint', nullable: true, transformer: bigint })
  lateRetentionAmountToman!: number | null;

  @Column({ name: 'grace_minutes', type: 'smallint' })
  graceMinutes!: number;

  @Column({ name: 'no_show_retention_kind', type: 'varchar', length: 32 })
  noShowRetentionKind!: BookingOutcomeRetentionKind;

  @Column({ name: 'no_show_retention_basis_points', type: 'int', nullable: true })
  noShowRetentionBasisPoints!: number | null;

  @Column({ name: 'no_show_retention_amount_toman', type: 'bigint', nullable: true, transformer: bigint })
  noShowRetentionAmountToman!: number | null;

  @CreateDateColumn({ name: 'assigned_at', type: 'timestamptz' })
  assignedAt!: Date;

  /** The authenticated seller. Never accepted from a request. */
  @Column({ name: 'assigned_by_user_id', type: 'uuid' })
  assignedByUserId!: string;

  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  @Column({ name: 'superseded_by_user_id', type: 'uuid', nullable: true })
  supersededByUserId!: string | null;

  @Column({ name: 'superseded_by_assignment_id', type: 'uuid', nullable: true })
  supersededByAssignmentId!: string | null;
}

/**
 * Registered on its own and appended to no other array, for the reason #104's
 * `COLLECTION_POLICY_ASSIGNMENT_ENTITIES` records: no other module gains a
 * repository over a table it has no business writing.
 */
export const OUTCOME_POLICY_ASSIGNMENT_ENTITIES = [SellerOutcomePolicyAssignmentEntity];
