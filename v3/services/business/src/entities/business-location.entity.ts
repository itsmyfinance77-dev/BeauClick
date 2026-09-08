import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The closed location-lifecycle vocabulary -- V3.3 Story #108 (`#44b`).
 *
 * Ratified by ADR-049 section 3.1: exactly `active | suspended | closed`, closed
 * by a database CHECK constraint, `active` the initial state. `closed` is
 * terminal -- there is no transition out of it, and no reopening is invented
 * (ADR-049 section 3, and #108's issue contract). Adding a fourth member is a
 * register decision, not a code change.
 */
export const BUSINESS_LOCATION_LIFECYCLES = ['active', 'suspended', 'closed'] as const;
export type BusinessLocationLifecycle = (typeof BUSINESS_LOCATION_LIFECYCLES)[number];

/**
 * A named branch of a `business.businesses` organisation -- V3.3 Story #108
 * (`#44b`), bound by `V33-DEC-030` D2 and ADR-049 section 3.
 *
 * ## `business.businesses` stays the organisation; this is a child
 *
 * `V33-DEC-030` D2. No ownership, booking, order, ledger, subscription or staff
 * FK is re-pointed by this table's existence, and a business with zero location
 * rows behaves exactly as it does today on every surface. The seller party of
 * every existing order and every append-only ledger row is unchanged.
 *
 * ## The city is an opaque reference, crossed through a port
 *
 * ADR-049 section 3.2. `cityId` holds a `provider.locations_cities.id`, but
 * `business` imports no `provider` ORM entity and issues no `provider.*` query:
 * there is no `@ManyToOne`, no `CityEntity` import and no cross-schema FK
 * (`V3_DATABASE_BLUEPRINT.md` section 1). The id's existence and availability are
 * validated at write time by a narrow business-owned catalogue port bound in the
 * composition root, on the caller's own transaction.
 *
 * ## Owner-only, and the owner is never stored here
 *
 * ADR-049 section 3.5. Create, rename, suspend, reactivate and close are
 * owner-only, resolved live from `businesses.owner_id`. This table carries **no
 * owner or actor column** -- a stored actor would be a subject-shaped column that
 * makes the ADR-027 `no_subject_data`/`retained` question harder and adds a row
 * that can be edited or raced. Actor identity for every mutation lives in
 * `admin.admin_audit_log` and nowhere else (ADR-049 sections 7.2-7.4).
 *
 * ## No speculative column
 *
 * Deliberately absent: address, coordinate, province, district, phone, medical
 * field, resource, service, availability, staff grant, soft-delete column,
 * public flag and search field. Each is a non-goal of #108 (ADR-049 sections 3
 * and 7); `#110` owns resources and `#109` owns scoped staff authority.
 */
@Entity({ name: 'locations', schema: 'business' })
@Index('ix_locations_business_id', ['businessId'])
export class BusinessLocationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References business.businesses.id. Same-schema FK, non-cascading. */
  @Column({ type: 'uuid' })
  businessId!: string;

  /** Non-empty, whitespace-trimmed, bounded -- shape enforced by `ck_locations_name_shape` in PostgreSQL. */
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /**
   * An opaque `provider.locations_cities.id`. No cross-schema FK and no provider
   * ORM relation -- availability is checked through the city-catalogue port.
   */
  @Column({ type: 'uuid' })
  cityId!: string;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  lifecycle!: BusinessLocationLifecycle;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
