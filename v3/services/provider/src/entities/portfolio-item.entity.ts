import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * One piece of published work.
 *
 * GAP-23 asked for this to be redesigned from requirements rather than ported
 * from V2, and the migration records the three differences. The one that
 * matters most in code: `mediaId` is a reference into `media.objects`, which
 * is where access class, content type, size, and dimensions live. This row
 * says "this professional shows this object, here, with this caption" and
 * nothing about whether the object may be shown at all -- that decision has
 * exactly one home.
 */
@Entity({ name: 'portfolio_items', schema: 'provider' })
export class PortfolioItemEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  professionalId!: string;

  @Column({ type: 'uuid' })
  mediaId!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  caption!: string | null;

  @Column({ type: 'int' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /** Soft delete: a removed item stops rendering immediately and stays auditable. */
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
