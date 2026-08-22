import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

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
export class BusinessEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References identity.users.id. No cross-schema FK by convention (V3_DATABASE_BLUEPRINT.md §1). */
  @Column({ type: 'uuid', unique: true })
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
