import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * V3_DATABASE_BLUEPRINT.md §4/§5: UUIDv7 primary key generated application-
 * side (see id-generator.ts), standard audit columns. `roles` is a plain
 * text array for Phase 1's foundation-level RBAC -- a full dynamic
 * roles/capabilities table pair (identity.roles / identity.capabilities per
 * V3_DATABASE_BLUEPRINT.md §8) is deliberately deferred; see
 * V3_PHASE1_IMPLEMENTATION.md Known Limitations. The capability-per-role
 * MAPPING lives in code (capabilities.ts) but is checked via the same
 * capability-based guard the final design calls for -- callers never check
 * a role string directly.
 */
@Entity({ name: 'users', schema: 'identity' })
export class UserEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  phone!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  displayName!: string | null;

  @Column({ type: 'text', array: true, default: () => "'{customer}'" })
  roles!: string[];

  @Column({ type: 'boolean', default: false })
  isVerifiedProfessional!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
