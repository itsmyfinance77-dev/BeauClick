import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const BUSINESS_STAFF_ROLES = ['manager', 'staff'] as const;
export type BusinessStaffRole = (typeof BUSINESS_STAFF_ROLES)[number];

export const BUSINESS_STAFF_STATUSES = ['invited', 'active', 'inactive', 'declined'] as const;
export type BusinessStaffStatus = (typeof BUSINESS_STAFF_STATUSES)[number];

/**
 * A business's staff roster. `owner` is deliberately NOT a value of `role`
 * here -- the owner is `BusinessEntity.ownerId` itself, a single identity
 * with unconditional control, never a row in this table that could be
 * edited, removed, or raced against. See ADR-023 §2.
 *
 * `professionalId` is nullable: a staff member manages the business (role
 * `manager`) without necessarily delivering services personally. When set,
 * it links this membership to the professional profile that actually holds
 * bookings/availability -- booking-service and search remain entirely
 * professional-id-keyed and untouched by this table's existence.
 *
 * Consent is structural, not a policy note: a row starts `invited` (created
 * by the owner) and only becomes `active` when the INVITED USER's own
 * session calls accept(). An owner can never grant themselves access to a
 * professional's earnings by inviting an id they do not control -- the
 * professional must accept from their own account.
 */
@Entity({ name: 'business_staff', schema: 'business' })
@Index('uq_business_staff_membership', ['businessId', 'userId'], { unique: true })
// At most one ACTIVE business affiliation per professional at a time -- the
// invariant financial party resolution (ADR-023 §3) and business-scoped
// booking visibility both depend on being unambiguous. A professional who
// wants to leave a business and join another does so by being deactivated
// first, never by holding two active memberships simultaneously.
@Index('uq_business_staff_active_professional', ['professionalId'], {
  unique: true,
  where: `status = 'active' AND professional_id IS NOT NULL`,
})
export class BusinessStaffEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  businessId!: string;

  /** References identity.users.id -- the staff member's own identity. No cross-schema FK by convention. */
  @Column({ type: 'uuid' })
  userId!: string;

  /** References provider.professionals.id when this staff member also personally delivers services. No cross-schema FK by convention. */
  @Column({ type: 'uuid', nullable: true })
  professionalId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  role!: BusinessStaffRole;

  @Column({ type: 'varchar', length: 20, default: 'invited' })
  status!: BusinessStaffStatus;

  /** The owner (or an inviting manager) who created this row. Always a real identity id, never the invitee's own -- self-invitation is meaningless. */
  @Column({ type: 'uuid' })
  invitedBy!: string;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
