import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const BUSINESS_VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected', 'suspended'] as const;
export type BusinessVerificationStatus = (typeof BUSINESS_VERIFICATION_STATUSES)[number];

/**
 * A Business is a distinct seller party from a Professional, not a layer on
 * top of one -- see ADR-023. `ownerId` is the identity user who created and
 * ultimately controls the business, mirroring `ProfessionalEntity.ownerId`
 * exactly (same self-service-creation, ownership-gated pattern), but a
 * business owner is not required to be a professional themselves: a salon
 * owner who does not personally deliver services is a legitimate case
 * `BusinessStaffEntity` is what actually links delivering professionals in.
 */
@Entity({ name: 'businesses', schema: 'business' })
// One ACTIVE business organisation per owner -- V3.3 Story #107 (`#44a`),
// `V33-DEC-030` D3 and ADR-049 section 2.3.
//
// This was `@Column({ unique: true })` on `ownerId`, which produced an
// UNCONDITIONAL unique index. The migration's index is partial on
// `deleted_at IS NULL`, and entity metadata that disagreed with it would give
// pg-mem (which builds its schema from this metadata with `synchronize: true`)
// a stricter rule than real PostgreSQL enforces -- so a soft-delete-then-
// recreate would pass in production and fail only in the fast test layer, or
// the reverse. The named entity-level partial form is the same shape
// `BusinessStaffEntity` already uses for `uq_business_staff_active_professional`.
//
// Real PostgreSQL stays authoritative for partial-index behaviour (ADR-049
// section 2.4); a real-PG spec compares `pg_indexes.indexdef` against this
// declaration so the two cannot drift apart silently.
@Index('uq_businesses_owner_id', ['ownerId'], { unique: true, where: 'deleted_at IS NULL' })
export class BusinessEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References identity.users.id. No cross-schema FK by convention (V3_DATABASE_BLUEPRINT.md §1). */
  @Column({ type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'varchar', length: 120 })
  displayName!: string;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'uuid', nullable: true })
  cityId!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'unverified' })
  verificationStatus!: BusinessVerificationStatus;

  /** Same at-least-once-delivery discard mechanism as `ProfessionalEntity.revision` -- see that entity's docblock. */
  @Column({ type: 'bigint', default: 1, transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  revision!: number;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
