import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { CurrencyCode, requiredMoneyTransformer } from '@beauclick/money';

/**
 * Order lifecycle.
 *
 *   [*] --> pending --> paid --> partially_refunded --> refunded
 *              |  |       |                                ^
 *              |  |       +--------------------------------+
 *              |  v
 *              | online_collection_not_required
 *              |  |
 *              v  v
 *              cancelled
 *
 * `paid` means a gateway confirmed money actually moved -- never merely
 * "status looks payment-ish". V2 chose `woocommerce_payment_complete` over
 * a generic status-changed hook for exactly this reason, and the event
 * catalog makes it an explicit contract: an `OrderPaid` event must mean
 * payment-confirmed. The status is only ever written by the payment
 * verification path.
 *
 * `online_collection_not_required` -- V3.3 #81 (`#41b`), ADR-044,
 * `V33-DEC-023` Rulings 1 and 2 -- means BeauClick is not collecting money
 * online now. It is **not** a synonym for paid, free, settled, completed or
 * written off: under `pay_at_venue` the full service price may still be owed
 * to the seller, and that balance is not BeauClick's money. It is written only
 * by the zero-collectible confirmation path, only from `pending`, and only when
 * the order's immutable schedule says `platformCollectibleToman === 0`.
 *
 * No transition returns to `pending`, and `paid` is not reachable from
 * `online_collection_not_required` -- an order the platform decided not to
 * collect for online is not one a gateway may later claim to have collected.
 */
export const ORDER_STATUSES = [
  'pending',
  'paid',
  'partially_refunded',
  'refunded',
  'cancelled',
  'online_collection_not_required',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * What produced this order. `UNIQUE(source_type, source_id)` on this pair is
 * the structural fix for GAP-03 (V2's booking->order double-creation gap,
 * which "self-healed only by accident").
 */
export const ORDER_SOURCE_TYPES = ['booking', 'direct'] as const;
export type OrderSourceType = (typeof ORDER_SOURCE_TYPES)[number];

@Entity({ name: 'orders', schema: 'commerce' })
@Index('ix_orders_customer', ['customerId', 'status'])
export class OrderEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  sourceType!: OrderSourceType;

  /** The booking id for a booking order. Together with sourceType, uniquely identifies what this order is FOR. */
  @Column({ type: 'uuid' })
  sourceId!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  /** Who earns from this order -- the professional delivering the service. Drives the financial receivable. */
  @Column({ type: 'varchar', length: 16 })
  sellerPartyType!: 'professional' | 'business';

  @Column({ type: 'uuid' })
  sellerPartyId!: string;

  /**
   * 32, not 20: `online_collection_not_required` is 30 characters, and the
   * column would otherwise refuse the value the #81 path writes. Mirrors the
   * width `20260905900002_add_online_collection_not_required_status.sql` sets.
   */
  @Column({ type: 'varchar', length: 32, default: 'pending' })
  status!: OrderStatus;

  @Column({ type: 'varchar', length: 3, default: 'IRT' })
  currency!: CurrencyCode;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  subtotalToman!: number;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  discountTotalToman!: number;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  feeTotalToman!: number;

  /** What the customer actually owes. Always == subtotal - discountTotal + feeTotal, enforced by a CHECK constraint. */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  totalToman!: number;

  /** Cumulative refunded amount. Never decreases -- a refund is never un-done, only added to. */
  @Column({ type: 'bigint', default: 0, transformer: requiredMoneyTransformer })
  refundedTotalToman!: number;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
