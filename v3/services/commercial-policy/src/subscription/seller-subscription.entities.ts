import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type {
  BookingCreditGrantSource,
  SellerSubscriptionState,
  SubscriberPartyType,
} from '@beauclick/commercial-policy-contract';

/**
 * The two tables of ADR-042's subscription foundation.
 *
 * ## Read these as projections of a schema whose rules live in SQL
 *
 * Nothing here enforces anything, exactly as `commercial-catalogue.entities.ts`
 * says of its own five. The one-active-per-party invariant, the zero-price
 * boundary, snapshot immutability, the two permitted transitions, grant
 * uniqueness and the NULL-only expiry are all in
 * `database/migrations/commercial/20260903800001_create_seller_subscriptions.sql`,
 * because a guarantee upheld by an entity is upheld by whoever remembers to go
 * through the entity.
 *
 * ## `synchronize` is off everywhere (ADR-015)
 *
 * So these mappings describe a schema the migration owns. A column added here
 * without a migration does not appear; a column added by migration and not
 * mapped here is simply unread, which is why the subject-data coverage check
 * reads `pg_tables` rather than entity metadata.
 */

@Entity({ name: 'seller_subscriptions', schema: 'commercial' })
export class SellerSubscriptionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  /**
   * The party, frozen at creation.
   *
   * Never re-resolved from current staff affiliation (`V33-DEC-018`), and a
   * database trigger refuses an UPDATE of either column — so "whose
   * subscription is this?" has exactly one answer for the row's whole life.
   */
  @Column({ name: 'subscriber_party_type', type: 'varchar', length: 16 })
  subscriberPartyType!: SubscriberPartyType;

  @Column({ name: 'subscriber_party_id', type: 'uuid' })
  subscriberPartyId!: string;

  /** Provenance only. Every entitlement below is copied, not joined. */
  @Column({ name: 'plan_version_id', type: 'uuid' })
  planVersionId!: string;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 16 })
  lifecycleState!: SellerSubscriptionState;

  @Column({ name: 'snapshot_plan_key', type: 'varchar', length: 64 })
  snapshotPlanKey!: string;

  @Column({ name: 'snapshot_version', type: 'int' })
  snapshotVersion!: number;

  /** NULL means no recurring term — deliberately different from a zero. */
  @Column({ name: 'snapshot_billing_term_days', type: 'int', nullable: true })
  snapshotBillingTermDays!: number | null;

  @Column({ name: 'snapshot_included_booking_credits', type: 'int' })
  snapshotIncludedBookingCredits!: number;

  @Column({ name: 'snapshot_staff_seats', type: 'int' })
  snapshotStaffSeats!: number;

  @Column({ name: 'snapshot_included_locations', type: 'int' })
  snapshotIncludedLocations!: number;

  @Column({ name: 'snapshot_capability_keys', type: 'text', array: true })
  snapshotCapabilityKeys!: string[];

  @Column({ name: 'snapshot_currency_code', type: 'char', length: 3 })
  snapshotCurrencyCode!: string;

  /** Always zero while #46/#47 are open — a database CHECK, not a convention. */
  @Column({ name: 'snapshot_unit_price_toman', type: 'bigint', transformer: { to: (v: number) => v, from: (v: string) => Number(v) } })
  snapshotUnitPriceToman!: number;

  @Column({ name: 'snapshot_price_schedule_version_id', type: 'uuid' })
  snapshotPriceScheduleVersionId!: string;

  @Column({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date;

  /** The authenticated session's own user id. Never accepted from a request. */
  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  /** Present exactly when `createdByUserId` is null; a DB CHECK enforces the pairing. */
  @Column({ name: 'created_by_label', type: 'varchar', length: 40, nullable: true })
  createdByLabel!: string | null;

  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt!: Date | null;

  @Column({ name: 'superseded_by_id', type: 'uuid', nullable: true })
  supersededById!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancelled_by_user_id', type: 'uuid', nullable: true })
  cancelledByUserId!: string | null;

  @Column({ name: 'cancelled_by_label', type: 'varchar', length: 40, nullable: true })
  cancelledByLabel!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'booking_credit_grants', schema: 'commercial' })
export class BookingCreditGrantEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId!: string;

  @Column({ name: 'plan_version_id', type: 'uuid' })
  planVersionId!: string;

  /**
   * Copied from the subscription, never re-resolved. #58 consumes and returns
   * against these columns (`V33-DEC-010`).
   */
  @Column({ name: 'subscriber_party_type', type: 'varchar', length: 16 })
  subscriberPartyType!: SubscriberPartyType;

  @Column({ name: 'subscriber_party_id', type: 'uuid' })
  subscriberPartyId!: string;

  @Column({ name: 'source', type: 'varchar', length: 24 })
  source!: BookingCreditGrantSource;

  /** Zero is a real quantity. See the migration's comment on why the row exists. */
  @Column({ name: 'quantity', type: 'int' })
  quantity!: number;

  /** Always 0: no publishable version carries a billing term, so no second period exists. */
  @Column({ name: 'period_index', type: 'int' })
  periodIndex!: number;

  @CreateDateColumn({ name: 'granted_at', type: 'timestamptz' })
  grantedAt!: Date;

  /**
   * Always NULL, pinned by `ck_booking_credit_grants_no_expiry`.
   *
   * Mapped so the column is visible to a reader rather than hidden, and
   * deliberately writable by nothing: no service argument, DTO or default sets
   * it, and the CHECK holds even against raw SQL.
   */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;
}

export const SUBSCRIPTION_ENTITIES = [SellerSubscriptionEntity, BookingCreditGrantEntity];
