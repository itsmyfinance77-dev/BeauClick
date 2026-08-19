import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The `bc_service` CPT's catalog fields (name/duration/price) only --
 * deliberately NOT availability/slots/booking, which is booking-service's
 * domain (V3_DOMAIN_BOUNDARIES.md) and explicitly out of Phase 1 scope
 * ("Do not implement: Booking availability").
 */
@Entity({ name: 'services', schema: 'provider' })
export class ServiceOfferingEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  professionalId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'int' })
  durationMinutes!: number;

  @Column({ type: 'int' })
  priceToman!: number;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
