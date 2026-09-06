import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { CreditPurchaseState } from '@beauclick/commercial-policy-contract';

import type { SubscriberPartyType } from './seller-subscription.entities';

/**
 * One custom booking-credit purchase request — V3.3 #57 (`#40c-1`), ADR-047.
 *
 * ## Read this as a projection of a schema whose rules live in SQL
 *
 * Nothing here enforces anything. `total_toman = unit_price_toman * quantity`,
 * the IRT-only currency, the technical quantity and money bounds, the lifecycle
 * vocabulary, request uniqueness, the three composite foreign keys that tie the
 * party to its subscription and the tier to its version to its key, and the
 * trigger that refuses DELETE and every snapshot UPDATE — all of them are in
 * `database/migrations/commercial/20260906900001_create_credit_purchases.sql`,
 * because a guarantee upheld by an entity is upheld by whoever remembers to go
 * through the entity.
 *
 * ## Every field is a snapshot
 *
 * The row records what the seller was offered at one instant: the quantity they
 * asked for, the exact schedule version and tier that priced it, the integer
 * money, and the instant itself. An administrator publishing a new version of
 * the same schedule key changes what LATER requests cost and leaves every row
 * here byte-identical (`V33-DEC-027` R4).
 *
 * ## It confers nothing
 *
 * `awaiting_payment` and `abandoned` are the only states, neither is
 * entitlement, and Story #57 contains no code path that writes a booking-credit
 * grant. A purchase becomes credit only in #99, in the same transaction that
 * records an adapter-verified payment fact.
 */
@Entity({ name: 'credit_purchases', schema: 'commercial' })
export class CreditPurchaseEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId!: string;

  /** Copied from the subscription, never re-resolved from live affiliation. */
  @Column({ name: 'subscriber_party_type', type: 'varchar', length: 16 })
  subscriberPartyType!: SubscriberPartyType;

  @Column({ name: 'subscriber_party_id', type: 'uuid' })
  subscriberPartyId!: string;

  @Column({ name: 'quantity', type: 'int' })
  quantity!: number;

  /** The stable key the subscription was bound to. */
  @Column({ name: 'schedule_key', type: 'varchar', length: 64 })
  scheduleKey!: string;

  /** The version of that key published and active at `effectiveAt`. */
  @Column({ name: 'price_schedule_version_id', type: 'uuid' })
  priceScheduleVersionId!: string;

  /** The tier within that version that covered the quantity. */
  @Column({ name: 'price_tier_id', type: 'uuid' })
  priceTierId!: string;

  /**
   * Integer Toman, read back through a transformer.
   *
   * `bigint` arrives from the driver as a string, and `Number()` on a value
   * past `2^53` silently rounds — which for money is the bug class
   * `@beauclick/money` exists to prevent. The same transformer the catalogue's
   * tiers use, for the same reason.
   */
  @Column({
    name: 'unit_price_toman',
    type: 'bigint',
    transformer: {
      to: (value: number): number => value,
      from: (value: string | number | null): number => toSafeToman('unit_price_toman', value),
    },
  })
  unitPriceToman!: number;

  @Column({
    name: 'total_toman',
    type: 'bigint',
    transformer: {
      to: (value: number): number => value,
      from: (value: string | number | null): number => toSafeToman('total_toman', value),
    },
  })
  totalToman!: number;

  @Column({ name: 'currency_code', type: 'char', length: 3 })
  currencyCode!: string;

  @Column({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt!: Date;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 24 })
  lifecycleState!: CreditPurchaseState;

  /** The caller's `Idempotency-Key`. Opaque here; never returned to a client. */
  @Column({ name: 'request_key', type: 'varchar', length: 128 })
  requestKey!: string;

  /** The authenticated session's own user id. Never accepted from a body. */
  @Column({ name: 'requested_by_user_id', type: 'uuid' })
  requestedByUserId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

function toSafeToman(column: string, value: string | number | null): number {
  if (value === null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`commercial.credit_purchases.${column} is not a safe integer: ${String(value)}`);
  }
  return parsed;
}
