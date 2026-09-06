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

/**
 * Why a credit came back — V3.3 #58 (`#58a`), ADR-046 §8.
 *
 * A closed server-authored vocabulary, never the customer's cancellation
 * sentence: free text written by one party would travel into the other party's
 * commercial ledger, audit trail and exports.
 *
 * Two values because two cancellation actors are reachable today. `customer`
 * cancellation and no-show retention are absent because whether they return the
 * seller's credit is retention policy under `V33-DEC-013`/#46; `admin` because
 * no production route produces that actor; `business` because no such booking
 * actor exists.
 */
export const BOOKING_CREDIT_RETURN_CAUSES = ['seller_cancelled', 'platform_cancelled'] as const;
export type BookingCreditReturnCause = (typeof BOOKING_CREDIT_RETURN_CAUSES)[number];

/**
 * One booking credit spent — V3.3 #58 (`#58a`), ADR-046 §1.
 *
 * Append-only. `uq_bcc_booking_once` makes one row per booking a storage
 * guarantee rather than a service convention, and the immutability trigger
 * refuses UPDATE and DELETE outright: a return is a NEW ROW, never an edit here.
 *
 * The grant, subscription, period and charged party are all **snapshotted**.
 * Nothing recomputes them, which is what makes "a booking confirmed in term N
 * stays charged to term N" structural rather than remembered — rescheduling
 * across a future term boundary changes nothing on this row.
 */
@Entity({ name: 'booking_credit_consumptions', schema: 'commercial' })
export class BookingCreditConsumptionEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  /**
   * Deliberately not a foreign key: `booking.bookings` is another domain's
   * table, and the entitlement ledger must outlive the scheduling row rather
   * than cascade with it.
   */
  @Column({ name: 'booking_id', type: 'uuid' })
  bookingId!: string;

  @Column({ name: 'grant_id', type: 'uuid' })
  grantId!: string;

  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId!: string;

  @Column({ name: 'period_index', type: 'int' })
  periodIndex!: number;

  /** Copied from the order's immutable seller snapshot. Never re-resolved. */
  @Column({ name: 'subscriber_party_type', type: 'varchar', length: 16 })
  subscriberPartyType!: SubscriberPartyType;

  @Column({ name: 'subscriber_party_id', type: 'uuid' })
  subscriberPartyId!: string;

  @CreateDateColumn({ name: 'consumed_at', type: 'timestamptz' })
  consumedAt!: Date;
}

/**
 * A consumed credit returned by a qualifying cancellation — V3.3 #58 (`#58a`),
 * ADR-046 §8.
 *
 * Append-only, at most one per consumption (`uq_bcr_consumption_once`), and it
 * never touches the consumption it reverses. Written inside the cancellation's
 * own transaction, so a cancellation that rolls back leaves no return.
 */
@Entity({ name: 'booking_credit_returns', schema: 'commercial' })
export class BookingCreditReturnEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'consumption_id', type: 'uuid' })
  consumptionId!: string;

  @Column({ name: 'return_cause', type: 'varchar', length: 24 })
  returnCause!: BookingCreditReturnCause;

  @CreateDateColumn({ name: 'returned_at', type: 'timestamptz' })
  returnedAt!: Date;
}

export const SUBSCRIPTION_ENTITIES = [
  SellerSubscriptionEntity,
  BookingCreditGrantEntity,
  BookingCreditConsumptionEntity,
  BookingCreditReturnEntity,
];

/** Re-exported so ledger entities in this package can name the same type. */
export type { SubscriberPartyType };
