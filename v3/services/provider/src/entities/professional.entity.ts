import { Column, CreateDateColumn, Entity, JoinColumn, JoinTable, ManyToMany, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { CityEntity } from './city.entity';
import { SpecialtyEntity } from './specialty.entity';

export const VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected', 'suspended', 'revoked'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * V3_DATABASE_BLUEPRINT.md §2 / ADR-001 §2 -- the CPT->relational
 * re-platform: `bc_professional` + its `_bc_city_id`/`_bc_verification_
 * status` postmeta keys (WORDPRESS_EXIT_MATRIX.md §2) become real, typed
 * columns. `ownerId` replaces `post_author` and is UNIQUE for Phase 1's
 * scope ("every provider belongs to an identity user", one profile per
 * user) -- see V3_PHASE1_IMPLEMENTATION.md Known Limitations for why
 * Business (a structurally similar but distinct V2 CPT, not one-owner-
 * per-profile once staff exist) is deliberately out of this phase.
 */
@Entity({ name: 'professionals', schema: 'provider' })
export class ProfessionalEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References identity.users.id. No cross-schema FK constraint (V3_DATABASE_BLUEPRINT.md §1: no cross-schema queries/FKs by application-layer convention, mirroring V2's own cross-plugin-FK-free discipline) -- enforced in code via the ownership resolver, not the database. */
  @Column({ type: 'uuid', unique: true })
  ownerId!: string;

  @Column({ type: 'varchar', length: 120 })
  displayName!: string;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'uuid', nullable: true })
  cityId!: string | null;

  @ManyToOne(() => CityEntity, { nullable: true })
  @JoinColumn({ name: 'cityId' })
  city?: CityEntity;

  @ManyToMany(() => SpecialtyEntity)
  @JoinTable({
    name: 'professional_specialties',
    schema: 'provider',
    joinColumn: { name: 'professionalId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'specialtyId', referencedColumnName: 'id' },
  })
  specialties!: SpecialtyEntity[];

  @Column({ type: 'varchar', length: 20, default: 'unverified' })
  verificationStatus!: VerificationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
