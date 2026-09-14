import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

const bigint = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * The immutable booking-outcome terms one order was created under, and that
 * its customer accepted — V3.3 #159 (`#42b`), ADR-051 §3–§4.
 *
 * ## A 1:1 side table, and its ABSENCE is a fact
 *
 * No row means the order carries no outcome terms: the seller was unenrolled,
 * or enrolled but unresolvable on a booking that collected nothing online.
 * `#42c` fails closed on that absence (`V33-DEC-029` Ruling 3), so nothing ever
 * back-fills or defaults a row.
 *
 * ## A projection of rules that live in SQL
 *
 * Append-only, the legal seller equal to the order's, the database-clock
 * `resolvedAt`, and acceptance ⇔ terms (deferred constraint triggers on both
 * this table and `commerce.order_payment_schedules`) are all in
 * `database/migrations/commerce/20260919100002_…`. Order creation writes the
 * row with raw SQL; this entity exists for typed reads.
 */
@Entity({ name: 'order_outcome_terms', schema: 'commerce' })
export class OrderOutcomeTermsEntity {
  @PrimaryColumn({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  /** The legal seller: the order's server-resolved party, frozen. */
  @Column({ name: 'seller_party_type', type: 'varchar', length: 16 })
  sellerPartyType!: 'professional' | 'business';

  @Column({ name: 'seller_party_id', type: 'uuid' })
  sellerPartyId!: string;

  @Column({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  @Column({ name: 'policy_version', type: 'int' })
  policyVersion!: number;

  @Column({ name: 'copy_key', type: 'varchar', length: 64 })
  copyKey!: string;

  @Column({ name: 'copy_version', type: 'int' })
  copyVersion!: number;

  @Column({ name: 'cutoff_hours', type: 'smallint' })
  cutoffHours!: number;

  @Column({ name: 'late_retention_kind', type: 'varchar', length: 32 })
  lateRetentionKind!: string;

  @Column({ name: 'late_retention_basis_points', type: 'int', nullable: true })
  lateRetentionBasisPoints!: number | null;

  @Column({ name: 'late_retention_amount_toman', type: 'bigint', nullable: true, transformer: bigint })
  lateRetentionAmountToman!: number | null;

  @Column({ name: 'grace_minutes', type: 'smallint' })
  graceMinutes!: number;

  @Column({ name: 'no_show_retention_kind', type: 'varchar', length: 32 })
  noShowRetentionKind!: string;

  @Column({ name: 'no_show_retention_basis_points', type: 'int', nullable: true })
  noShowRetentionBasisPoints!: number | null;

  @Column({ name: 'no_show_retention_amount_toman', type: 'bigint', nullable: true, transformer: bigint })
  noShowRetentionAmountToman!: number | null;

  @Column({ name: 'reschedule_free_count', type: 'smallint' })
  rescheduleFreeCount!: number;

  @Column({ name: 'dispute_window_hours', type: 'smallint' })
  disputeWindowHours!: number;

  @Column({ name: 'bodily_harm_window_hours', type: 'smallint', nullable: true })
  bodilyHarmWindowHours!: number | null;

  @Column({ name: 'appeal_window_hours', type: 'smallint' })
  appealWindowHours!: number;

  @Column({ name: 'case_file_retention_days', type: 'smallint', nullable: true })
  caseFileRetentionDays!: number | null;

  @Column({ name: 'legal_cap_kind', type: 'varchar', length: 32, nullable: true })
  legalCapKind!: string | null;

  @Column({ name: 'legal_cap_basis_points', type: 'int', nullable: true })
  legalCapBasisPoints!: number | null;

  @Column({ name: 'legal_cap_amount_toman', type: 'bigint', nullable: true, transformer: bigint })
  legalCapAmountToman!: number | null;

  /** Internal. Never projected to a customer or seller. */
  @Column({ name: 'legal_evidence_id', type: 'uuid', nullable: true })
  legalEvidenceId!: string | null;

  @Column({ name: 'contract_version', type: 'smallint' })
  contractVersion!: number;

  /** The transaction instant; equal to the schedule's `policyAcceptedAt` by constraint trigger. */
  @CreateDateColumn({ name: 'resolved_at', type: 'timestamptz' })
  resolvedAt!: Date;
}
