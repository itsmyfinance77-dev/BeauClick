import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * V3_DOMAIN_BOUNDARIES.md / V3_DATABASE_BLUEPRINT.md §8: location reference
 * data, seeded not migrated (ADR-010 §2) -- the same `is_launched` pattern
 * V2 used to control marketplace rollout without hardcoding a city list in
 * code, preserved verbatim as a business rule.
 */
@Entity({ name: 'locations_cities', schema: 'provider' })
export class CityEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'boolean', default: true })
  isLaunched!: boolean;
}
