import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { LOCATION_RESOURCE_KINDS, LocationResourceKind } from './location-resource.entity';

/**
 * The required-kind vocabulary, re-exported under this table's own name.
 *
 * This is the SAME closed `room | device | station` set `#110a` shipped as
 * `LOCATION_RESOURCE_KINDS` -- not a second vocabulary. #131's own readiness
 * audit explicitly rules out a browser-safe contract package or a duplicated
 * enum: `business` already owns the vocabulary, and `booking` never needs it,
 * because it receives candidate resource ids, not kinds.
 */
export const REQUIRED_RESOURCE_KINDS = LOCATION_RESOURCE_KINDS;
export type RequiredResourceKind = LocationResourceKind;

/**
 * The requirement mapping between one business's service and the resource
 * kind it needs -- V3.3 Story #131 (`#127b`), bound by `V33-DEC-035` R5/R6 and
 * ADR-049 section 6.
 *
 * ## A mapping, and nothing more
 *
 * This records that a service NEEDS a `room | device | station`. It does not
 * record which physical resource is assigned to a booking:
 * `booking.booking_resource_assignments`, the collision exclusion constraint
 * and selection itself are `#110b` (#128). Nothing here reaches `booking` or
 * `provider`, and no customer-facing surface exposes any of it
 * (`V33-DEC-035` R9).
 *
 * ## `serviceId` is OPAQUE
 *
 * References `provider.services.id`. **No cross-schema foreign key by
 * convention** (`V3_DATABASE_BLUEPRINT.md` §1) and no `provider` ORM import
 * anywhere in `business` -- service existence and ownership are proved
 * through `SERVICE_OWNERSHIP_DIRECTORY`, a composition-root port, exactly as
 * `LOCATION_CITY_CATALOGUE` already proves a city.
 *
 * ## Owner-only, and the owner is never stored here
 *
 * Create, change and remove are owner-only, resolved live from
 * `businesses.owner_id`, with `@ResolveOwner` on every handler and never on
 * the class. This table carries **no owner, actor or user column** -- the
 * same reasoning `LocationResourceEntity` records: actor identity for every
 * mutation lives in `admin.admin_audit_log` and nowhere else.
 *
 * ## No lifecycle, no version history
 *
 * Unlike `LocationResourceEntity`'s terminal `retired` state, there is no
 * lifecycle column here: a row's existence IS the live requirement. Removal
 * is a DELETE, a kind change is an UPDATE in place, and the full history of
 * who changed what lives in `admin.admin_audit_log` -- #131's own audit ruled
 * out a version table as unjustified dormant complexity.
 *
 * ## No speculative column
 *
 * Deliberately absent: multiple acceptable kinds, quantity, capacity pools,
 * a resourceRef, occupancy, a customer-facing flag and any resource
 * identity. Each is a named non-goal of this story.
 */
@Entity({ name: 'service_resource_requirements', schema: 'business' })
@Index('uq_service_resource_requirements_business_service', ['businessId', 'serviceId'], { unique: true })
@Index('ix_service_resource_requirements_service_id', ['serviceId'])
export class ServiceResourceRequirementEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  businessId!: string;

  /** References provider.services.id. No cross-schema FK by convention -- opaque, proved through a port. */
  @Column({ type: 'uuid' })
  serviceId!: string;

  @Column({ type: 'varchar', length: 16 })
  requiredKind!: RequiredResourceKind;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
