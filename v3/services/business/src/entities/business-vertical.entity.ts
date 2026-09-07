import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The closed vertical vocabulary -- what the organisation PROVIDES.
 *
 * Ratified by `V33-DEC-030` D1 (which amended `V33-DEC-002`) and restated by
 * ADR-049 section 1.2. `multi_location` and `mobile` are deliberately NOT
 * members: they describe how an organisation is arranged, not what it provides,
 * and they live in `BUSINESS_TRAITS` on a separate axis. A salon that opens a
 * second branch stays a salon.
 *
 * Adding a seventh member is a register decision, not a code change.
 */
export const BUSINESS_VERTICALS = ['salon', 'clinic', 'maison', 'retail', 'wholesale', 'academy'] as const;
export type BusinessVertical = (typeof BUSINESS_VERTICALS)[number];

/**
 * A business's ONE current vertical -- or, when the row is absent, the fact
 * that its owner has not classified it.
 *
 * ## `businessId` is the primary key, and that IS the invariant
 *
 * `V33-DEC-032` R2. "At most one vertical" is enforced by this key, in
 * PostgreSQL, not by a service that a second call site could forget. There is
 * deliberately no surrogate id and no `isPrimary` column: both would exist only
 * to permit rows the product does not have, and the register rejected "primary
 * vertical" precisely because the mechanism would have created a secondary
 * vertical nothing defines, exports or reads.
 *
 * ## Absence means unclassified, and that is legal
 *
 * `V33-DEC-032` R3/R4. There is no sentinel member, no default and no backfill.
 * A read of an unclassified business returns `null` truthfully; nothing repairs
 * it, and `POST /v1/businesses` is unchanged by this story.
 *
 * ## No timestamps, on purpose
 *
 * This is a CURRENT-STATE table. Adding `createdAt`/`updatedAt` merely so a
 * caller could detect change would put a second, weaker history next to the one
 * that already exists: `admin.admin_audit_log`, which is append-only by
 * PostgreSQL GRANT rather than by convention. Idempotent replay is proved by
 * comparing the rows themselves, not by watching a timestamp.
 *
 * ## It authorizes nothing
 *
 * `V33-DEC-030` D1 and `V33-DEC-032` R7. No guard, resolver, capability
 * verifier or port may read this table, and a structural spec asserts it rather
 * than a reviewer.
 */
@Entity({ name: 'business_verticals', schema: 'business' })
export class BusinessVerticalEntity {
  /** References business.businesses.id. Same-schema FK, non-cascading -- business deletion is a non-goal of #107. */
  @PrimaryColumn({ type: 'uuid' })
  businessId!: string;

  @Column({ type: 'varchar', length: 16 })
  vertical!: BusinessVertical;
}
