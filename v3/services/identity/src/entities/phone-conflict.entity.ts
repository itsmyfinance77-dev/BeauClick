import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * V3_SECURITY_MODEL.md §1: "never silently merge identities on ambiguity --
 * record the conflict for human review, and fall through to creating a new
 * account (the safe default)." Foundation table, ported in shape from V2's
 * wp_bc_phone_conflicts; the resolution/admin-review UI is out of Phase 1
 * scope (admin application is Phase 4).
 */
@Entity({ name: 'phone_conflicts', schema: 'identity' })
export class PhoneConflictEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  phone!: string;

  @Column({ type: 'uuid' })
  existingUserId!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
