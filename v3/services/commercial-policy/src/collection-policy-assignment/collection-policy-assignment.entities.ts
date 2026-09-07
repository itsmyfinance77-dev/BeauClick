import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { SubscriberPartyType } from '@beauclick/commercial-policy-contract';

/**
 * The assignment history table — V3.3 Story #104 (`#41d-2a`), ADR-048 R2.
 *
 * ## A read-mostly projection of a schema whose rules live in SQL
 *
 * Nothing here enforces anything. One-current-row, the terminal supersession
 * pairing, immutability, the refusal to DELETE and the database-clock
 * supersession instant are all in
 * `database/migrations/commercial/20260907800001_…`, because a guarantee upheld
 * by an entity is upheld by whoever remembers to go through the entity — the
 * same division `BookingCollectionPolicyVersionEntity` records.
 *
 * ## `supersededAt IS NULL` is the whole state machine
 *
 * There is no `lifecycleState`, no `enrolled` flag and no un-enrollment column,
 * because assignment presence **is** the enrollment fact (ADR-048 R2).
 */
@Entity({ name: 'seller_collection_policy_assignments', schema: 'commercial' })
export class SellerCollectionPolicyAssignmentEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'seller_party_type', type: 'varchar', length: 16 })
  sellerPartyType!: SubscriberPartyType;

  @Column({ name: 'seller_party_id', type: 'uuid' })
  sellerPartyId!: string;

  /** The stable key. Never an exact version — that is resolved per order by #115. */
  @Column({ name: 'policy_key', type: 'varchar', length: 64 })
  policyKey!: string;

  @CreateDateColumn({ name: 'assigned_at', type: 'timestamptz' })
  assignedAt!: Date;

  /** The authenticated seller. Never accepted from a request. */
  @Column({ name: 'assigned_by_user_id', type: 'uuid' })
  assignedByUserId!: string;

  /** Null exactly while this row is current; the three terminal facts arrive together. */
  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  @Column({ name: 'superseded_by_user_id', type: 'uuid', nullable: true })
  supersededByUserId!: string | null;

  @Column({ name: 'superseded_by_assignment_id', type: 'uuid', nullable: true })
  supersededByAssignmentId!: string | null;
}

/**
 * Registered on its own, and deliberately **not** appended to
 * `COMMERCIAL_ENTITIES` or `BOOKING_COLLECTION_POLICY_ENTITIES`.
 *
 * Those arrays are imported by modules that have no business writing an
 * assignment — price resolution, the subscription foundation, the catalogue —
 * and Story #83 ships a structural test asserting that separation. Appending
 * would have handed all of them a repository over this table and broken that
 * test for a convenience nobody needs.
 */
export const COLLECTION_POLICY_ASSIGNMENT_ENTITIES = [SellerCollectionPolicyAssignmentEntity];
