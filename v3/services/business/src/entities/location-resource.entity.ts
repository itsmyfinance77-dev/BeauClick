import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The closed resource-kind vocabulary -- V3.3 Story #110 (`#110a`),
 * `V33-DEC-034` R2.
 *
 * **Exactly three members.** `station` is the one that generalises: it covers
 * chairs, beds, nail desks, styling positions and comparable service stations,
 * rather than naming each and needing a fourth entry the first time a salon buys
 * different furniture.
 *
 * There is deliberately no `owner` (that is `businesses.owner_id`, derived, never
 * stored -- ADR-023), no `chair` or `bed` (both are `station`), no `service`
 * (that is `provider.services`, which this story does not touch), no generic
 * `resource`, and no speculative member. A further kind requires a later explicit
 * decision **tied to a real consumer** -- the rule `V33-DEC-033` R1 set for
 * scoped roles and `V33-DEC-034` R2 adopts here; a vocabulary member that nothing
 * can book is a promise the schema cannot keep.
 */
export const LOCATION_RESOURCE_KINDS = ['room', 'device', 'station'] as const;
export type LocationResourceKind = (typeof LOCATION_RESOURCE_KINDS)[number];

/**
 * The closed resource-lifecycle vocabulary -- `V33-DEC-034` R2, and the owner's
 * 2026-09-09 implementation clarification.
 *
 * Exactly `active | retired`, with `active` the initial state. **`retired` is
 * TERMINAL.** No restore or reactivate route, service method or transition is
 * authorized by this story, and `tg_location_resources_lifecycle` refuses one in
 * PostgreSQL rather than trusting the service to remember. A future restore
 * capability requires its own explicit decision.
 */
export const LOCATION_RESOURCE_LIFECYCLES = ['active', 'retired'] as const;
export type LocationResourceLifecycle = (typeof LOCATION_RESOURCE_LIFECYCLES)[number];

/**
 * One bookable resource of a `business.locations` branch -- V3.3 Story #110
 * (`#110a`), bound by `V33-DEC-034` and ADR-049 sections 3 and 6.
 *
 * ## A catalogue, and nothing more
 *
 * This story records that a branch HAS two laser devices and three rooms. It
 * does not record that a booking occupies one: `booking.booking_resource_assignments`,
 * `ex_booking_resource_no_overlap` and every booking transaction hook are
 * `#110b` (#128), and the delivery-location context they need is `#110c` (#127).
 * Nothing here reaches `booking` or `provider`, and no customer-facing surface
 * exposes any of it (`V33-DEC-034` R6).
 *
 * ## Anchored on the location, with the business denormalised on purpose
 *
 * `businessId` duplicates what `locationId` already implies, for exactly one
 * reason: `fk_location_resources_location_same_business` is a composite foreign
 * key onto `business.locations (id, business_id)`, so a resource whose location
 * belongs to a different business is **unwritable in PostgreSQL** rather than
 * merely refused by a service that could be called a second way. Without the
 * denormalised column that invariant could only be application code.
 *
 * ## Owner-only, and the owner is never stored here
 *
 * `V33-DEC-034` R3. Create, rename and retire are owner-only, resolved live from
 * `businesses.owner_id`, with `@ResolveOwner` on every handler and never on the
 * class. This table carries **no owner, actor or user column** -- the same
 * reasoning `BusinessLocationEntity` records: a stored actor would be a
 * subject-shaped column that changes the ADR-027 answer and adds a row that can
 * be edited or raced. Actor identity for every mutation lives in
 * `admin.admin_audit_log` and nowhere else.
 *
 * **No scoped-staff role authorizes this surface.** No member of
 * `SCOPED_STAFF_ROLES` (`practitioner_chat`, or #111's read-only `finance_read`)
 * reaches it, and a holder of either is refused here identically to a stranger.
 *
 * ## No speculative column
 *
 * Deliberately absent: capacity, price, availability, calendar, schedule,
 * occupancy, booking reference, service binding, soft-delete column, public flag,
 * ordering weight, colour, icon, serial number and maintenance field. Each is
 * either a named non-goal of this story or belongs to a story that does not exist
 * yet.
 */
@Entity({ name: 'location_resources', schema: 'business' })
@Index('ix_location_resources_location_id', ['locationId'])
export class LocationResourceEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References business.locations.id, and half of the composite same-business FK. */
  @Column({ type: 'uuid' })
  locationId!: string;

  /** The other half of the composite FK: the resource and its location must name the same business. */
  @Column({ type: 'uuid' })
  businessId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: LocationResourceKind;

  /** Owner-authored, trimmed and bounded. Deliberately NOT unique: two branches may both have a "Room 1". */
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /** `active` on insert; `retired` is terminal and enforced by trigger, not by convention. */
  @Column({ type: 'varchar', length: 16 })
  lifecycle!: LocationResourceLifecycle;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
