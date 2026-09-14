import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type {
  BookingOutcomeRetentionKind,
  BookingOutcomeRetentionPurpose,
  CatalogueLifecycleState,
  CustomerPolicyCopyLocale,
  LegalEvidenceReferenceKind,
  LegalEvidenceStatus,
  LegalEvidenceSubject,
} from '@beauclick/commercial-policy-contract';

/**
 * The six tables of ADR-051's `#42a` publication plane — V3.3 Story #42.
 *
 * ## Read these as projections of a schema whose rules live in SQL
 *
 * Nothing here enforces anything. The lifecycle allow-lists, published
 * immutability, effective-window non-overlap, the retention-option shape and
 * one-per-meaning uniqueness, the frozen options of a published version, the
 * body/hash consistency, the `fa-IR`-only locale, non-retroactivity and the
 * Legal-evidence gate on a cap are all in
 * `database/migrations/commercial/20260918100001_…`, because a guarantee upheld
 * by an entity is upheld by whoever remembers to go through the entity. The
 * same division `BookingCollectionPolicyEntity` records.
 *
 * ## What is absent
 *
 * No seller selection, no order snapshot, no acceptance (`#42b`); no decision
 * (`#42c`); no declaration or remedy choice (`#42d`); no dispute (`#42e`). No
 * entity below is read by `booking`, `commerce`, `payment` or `financial`.
 */

const bigint = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

const smallintArray = {
  to: (value: number[]) => value,
  from: (value: number[] | string | null) => {
    if (value === null) return [];
    if (Array.isArray(value)) return value.map(Number);
    // `pg` returns int2[] as a `{1,2}` literal when the type is not parsed.
    return value
      .replace(/^\{|\}$/g, '')
      .split(',')
      .filter((item) => item.length > 0)
      .map(Number);
  },
};

// ---------------------------------------------------------------------------
// Legal evidence
// ---------------------------------------------------------------------------

@Entity({ name: 'legal_evidence_records', schema: 'commercial' })
export class LegalEvidenceRecordEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'evidence_key', type: 'varchar', length: 64 })
  evidenceKey!: string;

  @Column({ name: 'subject', type: 'varchar', length: 40 })
  subject!: LegalEvidenceSubject;

  @Column({ name: 'status', type: 'varchar', length: 16 })
  status!: LegalEvidenceStatus;

  @Column({ name: 'reference_kind', type: 'varchar', length: 32 })
  referenceKind!: LegalEvidenceReferenceKind;

  /** A reference to a document held elsewhere. Never the document. */
  @Column({ name: 'reference', type: 'varchar', length: 512 })
  reference!: string;

  @Column({ name: 'summary', type: 'varchar', length: 1000 })
  summary!: string;

  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;

  /** The authenticated session's own user id. Never accepted from a request. */
  @Column({ name: 'recorded_by_user_id', type: 'uuid' })
  recordedByUserId!: string;

  @Column({ name: 'recorded_audit_id', type: 'uuid' })
  recordedAuditId!: string;

  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt!: Date | null;

  @Column({ name: 'retired_by_user_id', type: 'uuid', nullable: true })
  retiredByUserId!: string | null;

  @Column({ name: 'retired_audit_id', type: 'uuid', nullable: true })
  retiredAuditId!: string | null;
}

// ---------------------------------------------------------------------------
// The numeric family
// ---------------------------------------------------------------------------

@Entity({ name: 'booking_outcome_policies', schema: 'commercial' })
export class BookingOutcomePolicyEntity {
  @PrimaryColumn({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  /** Administrative prose. Never customer-facing text — that is the copy family. */
  @Column({ name: 'display_name', type: 'varchar', length: 120 })
  displayName!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;
}

@Entity({ name: 'booking_outcome_policy_versions', schema: 'commercial' })
export class BookingOutcomePolicyVersionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 16 })
  lifecycleState!: CatalogueLifecycleState;

  /** The SET a seller chooses inside (`#42b`). Never one value. */
  @Column({ name: 'cutoff_hours_allowed', type: 'smallint', array: true, transformer: smallintArray })
  cutoffHoursAllowed!: number[];

  @Column({ name: 'no_show_grace_minutes_allowed', type: 'smallint', array: true, transformer: smallintArray })
  noShowGraceMinutesAllowed!: number[];

  @Column({ name: 'reschedule_free_count_before_cutoff', type: 'smallint' })
  rescheduleFreeCountBeforeCutoff!: number;

  @Column({ name: 'dispute_window_hours', type: 'smallint' })
  disputeWindowHours!: number;

  @Column({ name: 'bodily_harm_window_hours', type: 'smallint', nullable: true })
  bodilyHarmWindowHours!: number | null;

  @Column({ name: 'appeal_window_hours', type: 'smallint' })
  appealWindowHours!: number;

  /** Null means UNCONFIGURED, which ADR-051 §10 relies on. Never defaulted. */
  @Column({ name: 'case_file_retention_days', type: 'smallint', nullable: true })
  caseFileRetentionDays!: number | null;

  /** Null exactly when there is no cap; a cap exists only with a Legal-evidence reference. */
  @Column({ name: 'legal_cap_kind', type: 'varchar', length: 32, nullable: true })
  legalCapKind!: Exclude<BookingOutcomeRetentionKind, 'none'> | null;

  @Column({ name: 'legal_cap_basis_points', type: 'int', nullable: true })
  legalCapBasisPoints!: number | null;

  @Column({ name: 'legal_cap_amount_toman', type: 'bigint', nullable: true, transformer: bigint })
  legalCapAmountToman!: number | null;

  @Column({ name: 'legal_evidence_id', type: 'uuid', nullable: true })
  legalEvidenceId!: string | null;

  @Column({ name: 'contract_version', type: 'smallint' })
  contractVersion!: number;

  @Column({ name: 'activation_starts_at', type: 'timestamptz', nullable: true })
  activationStartsAt!: Date | null;

  @Column({ name: 'activation_ends_at', type: 'timestamptz', nullable: true })
  activationEndsAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
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

@Entity({ name: 'booking_outcome_policy_retention_options', schema: 'commercial' })
export class BookingOutcomePolicyRetentionOptionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId!: string;

  @Column({ name: 'purpose', type: 'varchar', length: 24 })
  purpose!: BookingOutcomeRetentionPurpose;

  @Column({ name: 'ordinal', type: 'smallint' })
  ordinal!: number;

  @Column({ name: 'kind', type: 'varchar', length: 32 })
  kind!: BookingOutcomeRetentionKind;

  @Column({ name: 'basis_points', type: 'int', nullable: true })
  basisPoints!: number | null;

  @Column({ name: 'amount_toman', type: 'bigint', nullable: true, transformer: bigint })
  amountToman!: number | null;
}

// ---------------------------------------------------------------------------
// The text family
// ---------------------------------------------------------------------------

@Entity({ name: 'customer_policy_copies', schema: 'commercial' })
export class CustomerPolicyCopyEntity {
  @PrimaryColumn({ name: 'copy_key', type: 'varchar', length: 64 })
  copyKey!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 120 })
  displayName!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;
}

@Entity({ name: 'customer_policy_copy_versions', schema: 'commercial' })
export class CustomerPolicyCopyVersionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'copy_key', type: 'varchar', length: 64 })
  copyKey!: string;

  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 16 })
  lifecycleState!: CatalogueLifecycleState;

  @Column({ name: 'locale', type: 'varchar', length: 8 })
  locale!: CustomerPolicyCopyLocale;

  /** The Persian text, as data. No number lives on this row. */
  @Column({ name: 'body', type: 'text' })
  body!: string;

  /** Computed by PostgreSQL from `body`; a CHECK keeps them consistent. */
  @Column({ name: 'body_sha256', type: 'char', length: 64 })
  bodySha256!: string;

  @Column({ name: 'contract_version', type: 'smallint' })
  contractVersion!: number;

  @Column({ name: 'activation_starts_at', type: 'timestamptz', nullable: true })
  activationStartsAt!: Date | null;

  @Column({ name: 'activation_ends_at', type: 'timestamptz', nullable: true })
  activationEndsAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
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

/**
 * Registered by `BookingOutcomePolicyModule` only. Not appended to
 * `COMMERCIAL_ENTITIES` or `BOOKING_COLLECTION_POLICY_ENTITIES`, for the reason
 * both of those record: no other module gains repository access to tables it
 * has no business touching.
 */
export const BOOKING_OUTCOME_POLICY_ENTITIES = [
  LegalEvidenceRecordEntity,
  BookingOutcomePolicyEntity,
  BookingOutcomePolicyVersionEntity,
  BookingOutcomePolicyRetentionOptionEntity,
  CustomerPolicyCopyEntity,
  CustomerPolicyCopyVersionEntity,
];
