import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type {
  BookingCollectionDepositKind,
  BookingCollectionMode,
  BookingCollectionPercentageBase,
  CatalogueLifecycleState,
} from '@beauclick/commercial-policy-contract';

/**
 * The two tables of ADR-048's publication plane — V3.3 Story #83 (`#41d-1`).
 *
 * ## Read these as read-mostly projections of a schema whose rules live in SQL
 *
 * Nothing here enforces anything. The lifecycle allow-list, the immutability of
 * a published version, the effective-window non-overlap, the deposit shape, the
 * percentage-base conditionality and non-retroactivity are all in
 * `database/migrations/commercial/20260906950001_…`, because a guarantee upheld
 * by an entity is upheld by whoever remembers to go through the entity. The
 * same division `CommercialPlanEntity` records.
 *
 * ## Two nullable columns that are NOT optional in the domain
 *
 * `activationStartsAt` is null exactly while the version is a draft, and is set
 * from the DATABASE CLOCK at publication. `deposit*` and `percentageBase` are
 * null exactly for the rules that do not use them. Both pairings are CHECKs, so
 * a null here means "this shape does not carry that fact", never "somebody
 * forgot".
 *
 * ## No assignment entity
 *
 * `commercial.seller_collection_policy_assignments` is #104 (`#41d-2`). It does
 * not exist in this story, in any form.
 */

@Entity({ name: 'booking_collection_policies', schema: 'commercial' })
export class BookingCollectionPolicyEntity {
  @PrimaryColumn({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  /** Administrative prose. Never customer-facing copy — that is `V33-DEC-017`, on #42. */
  @Column({ name: 'display_name', type: 'varchar', length: 120 })
  displayName!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** The authenticated session's own user id. Never accepted from a request. */
  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  /** Present exactly when `createdByUserId` is null; a DB CHECK enforces the pairing. */
  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;
}

@Entity({ name: 'booking_collection_policy_versions', schema: 'commercial' })
export class BookingCollectionPolicyVersionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  @Column({ name: 'version', type: 'int' })
  version!: number;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 16 })
  lifecycleState!: CatalogueLifecycleState;

  @Column({ name: 'collection_mode', type: 'varchar', length: 40 })
  collectionMode!: BookingCollectionMode;

  @Column({ name: 'deposit_kind', type: 'varchar', length: 16 })
  depositKind!: BookingCollectionDepositKind;

  /*
   * BIGINT columns come back from `pg` as strings, so each carries an explicit
   * transformer rather than a silent `as number`. A deposit amount that arrived
   * as "50000" and was compared with `<` would sort lexically — the failure
   * mode `@beauclick/money` exists to make impossible.
   */
  @Column({
    name: 'deposit_amount_toman',
    type: 'bigint',
    nullable: true,
    transformer: { to: (value: number | null) => value, from: (value: string | null) => (value === null ? null : Number(value)) },
  })
  depositAmountToman!: number | null;

  @Column({ name: 'deposit_basis_points', type: 'int', nullable: true })
  depositBasisPoints!: number | null;

  @Column({
    name: 'deposit_minimum_toman',
    type: 'bigint',
    nullable: true,
    transformer: { to: (value: number | null) => value, from: (value: string | null) => (value === null ? null : Number(value)) },
  })
  depositMinimumToman!: number | null;

  @Column({
    name: 'deposit_maximum_toman',
    type: 'bigint',
    nullable: true,
    transformer: { to: (value: number | null) => value, from: (value: string | null) => (value === null ? null : Number(value)) },
  })
  depositMaximumToman!: number | null;

  /** Non-null exactly for a percentage rule. No default anywhere. */
  @Column({ name: 'percentage_base', type: 'varchar', length: 24, nullable: true })
  percentageBase!: BookingCollectionPercentageBase | null;

  @Column({ name: 'contract_version', type: 'smallint' })
  contractVersion!: number;

  /** Null while draft; set from the database clock at publication. */
  @Column({ name: 'activation_starts_at', type: 'timestamptz', nullable: true })
  activationStartsAt!: Date | null;

  /** An optional forward bound an administrator may set while drafting. */
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
 * Registered separately from `COMMERCIAL_ENTITIES` rather than appended to it.
 *
 * That array is imported by four modules — the catalogue, price resolution, the
 * subscription foundation and the seller surface — none of which reads a
 * collection policy. Appending would have given all four repository access to
 * tables they have no business touching, and the asymmetry those modules
 * already record ("the service, not the repositories") is the same reason.
 */
export const BOOKING_COLLECTION_POLICY_ENTITIES = [
  BookingCollectionPolicyEntity,
  BookingCollectionPolicyVersionEntity,
];
