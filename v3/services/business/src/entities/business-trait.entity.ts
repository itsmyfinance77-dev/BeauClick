import { Entity, PrimaryColumn } from 'typeorm';

/**
 * The closed operating-trait vocabulary -- how the organisation OPERATES.
 *
 * `V33-DEC-030` D1 and ADR-049 section 1.3. An additive set on its own axis,
 * never a second enum column and never a member of `BUSINESS_VERTICALS`.
 * Adding a third member is a register decision, not a code change.
 */
export const BUSINESS_TRAITS = ['multi_location', 'mobile'] as const;
export type BusinessTrait = (typeof BUSINESS_TRAITS)[number];

/**
 * One operating trait a business carries. Zero, one or both rows may exist.
 *
 * ## `(businessId, trait)` is the identity, and that IS the set
 *
 * `V33-DEC-032` R6. The composite primary key is what makes this a set rather
 * than a list: one row per trait, no duplicate, no ordering column, no
 * surrogate id whose only purpose would be to permit a second identical trait.
 * Deterministic read ordering is the SERVICE's job, sorted at the boundary, so
 * a client never depends on physical row order.
 *
 * Absence is legal and is never backfilled or defaulted, exactly as it is for
 * the vertical. No timestamps, for the reason `BusinessVerticalEntity` records:
 * history lives in `admin.admin_audit_log`, not in a current-state table.
 *
 * Traits authorize nothing, and a structural spec asserts it.
 */
@Entity({ name: 'business_traits', schema: 'business' })
export class BusinessTraitEntity {
  /** References business.businesses.id. Same-schema FK, non-cascading. */
  @PrimaryColumn({ type: 'uuid' })
  businessId!: string;

  @PrimaryColumn({ type: 'varchar', length: 16 })
  trait!: BusinessTrait;
}
