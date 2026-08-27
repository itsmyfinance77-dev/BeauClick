import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The dynamic roles/capabilities tables `V3_DATABASE_BLUEPRINT.md` §8
 * specified and Phase 1 deliberately deferred (R31-01).
 *
 * What Phase 1's deferral cost, stated plainly because it is the reason these
 * exist: `AccountResolverService` wrote `roles: ['customer']` at creation and
 * nothing ever wrote that column again, so `bc_manage_platform` was
 * ungrantable and all five `/v1/admin/*` surfaces were unreachable by any
 * account the application could produce.
 *
 * What has NOT changed: every authorization check still tests a capability
 * NAME. Only the data's source moved, exactly as the Phase 1 docblock said it
 * would.
 */
@Entity({ name: 'roles', schema: 'identity' })
export class RoleEntity {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  slug!: string;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'text' })
  description!: string;

  /** A role nobody may grant through the ordinary application flow. */
  @Column({ type: 'boolean', default: false })
  isPrivileged!: boolean;

  /** The single role every new account receives. A partial unique index allows exactly one. */
  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'capabilities', schema: 'identity' })
export class CapabilityEntity {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  slug!: string;

  @Column({ type: 'text' })
  description!: string;

  /**
   * Authority over other people's data or over the platform.
   *
   * Load-bearing beyond documentation: these are the capabilities whose
   * revocation must take effect immediately rather than at the next token
   * issuance, and the ones the boot-time audit assertion treats as privileged.
   */
  @Column({ type: 'boolean', default: false })
  isPrivileged!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'role_capabilities', schema: 'identity' })
export class RoleCapabilityEntity {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  roleSlug!: string;

  @PrimaryColumn({ type: 'varchar', length: 60 })
  capabilitySlug!: string;
}

/** The assignment that did not exist. */
@Entity({ name: 'user_roles', schema: 'identity' })
export class UserRoleEntity {
  @PrimaryColumn('uuid')
  userId!: string;

  @PrimaryColumn({ type: 'varchar', length: 40 })
  roleSlug!: string;

  /**
   * NULL for exactly two cases and no others: the automatic `customer` grant
   * at account creation, and the documented one-time bootstrap of the first
   * platform operator. Every other row records a real granting user.
   */
  @Column({ type: 'uuid', nullable: true })
  grantedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  grantedAt!: Date;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;
}
