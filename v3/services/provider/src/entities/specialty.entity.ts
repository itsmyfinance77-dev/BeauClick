import { Column, Entity, PrimaryColumn } from 'typeorm';

/** V2's `bc_specialty` taxonomy -- DIRECT REUSE of the data itself (WORDPRESS_EXIT_MATRIX.md §3), now a plain relational table instead of a WP taxonomy term. */
@Entity({ name: 'specialties', schema: 'provider' })
export class SpecialtyEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'uuid', nullable: true })
  parentId!: string | null;
}
