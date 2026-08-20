import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { requiredMoneyTransformer } from '@beauclick/money';

export const REFUND_STATUSES = ['pending', 'succeeded', 'failed', 'manual_required'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * What a refund is CORRECTING, which is not the same question as how much.
 *
 * `order`            -- money back for the order itself (a cancellation, a
 *                       booking that could not be honoured). Flows on to
 *                       commerce and reverses the ledger.
 * `duplicate_charge` -- a second gateway charge that should never have
 *                       happened. The order was legitimately paid ONCE, so
 *                       this must NOT touch the order's refunded total or
 *                       reverse a commission that was correctly earned.
 *
 * Conflating the two would drive a correctly-paid order to `refunded` and
 * strip the professional's receivable for a service they are still owed for.
 */
export const REFUND_KINDS = ['order', 'duplicate_charge'] as const;
export type RefundKind = (typeof REFUND_KINDS)[number];

/**
 * A refund is its own durable fact, written BEFORE the gateway is called.
 *
 * That ordering is the whole design. If the row were written only after a
 * successful gateway call, a crash mid-call would leave no record that a
 * refund was ever attempted -- and the retry would issue a second one
 * against real money. The row exists first, keyed by a caller-supplied
 * `requestKey`, so a retry finds the in-flight refund instead of starting
 * another.
 *
 * `manual_required` is a real business outcome, not an error state: several
 * Iranian gateways have no programmatic refund API at all. Recording that
 * honestly routes the money to the manual settlement path, which is far
 * better than reporting a refund that never happened.
 */
@Entity({ name: 'refunds', schema: 'payment' })
@Index('ix_refunds_order', ['orderId'])
export class RefundEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  @Column({ type: 'uuid' })
  paymentIntentId!: string;

  @Column({ type: 'uuid', nullable: true })
  paymentAttemptId!: string | null;

  /**
   * Caller-supplied idempotency token, UNIQUE per order. For an automatic
   * refund it is a deterministic string derived from the CAUSE (e.g.
   * "booking-cancelled:<bookingId>"), so the same cause firing twice can
   * never produce two refunds -- the guarantee does not depend on the caller
   * remembering to generate a fresh random key.
   */
  @Column({ type: 'varchar', length: 128 })
  requestKey!: string;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  amountToman!: number;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: RefundStatus;

  @Column({ type: 'varchar', length: 20, default: 'order' })
  kind!: RefundKind;

  @Column({ type: 'varchar', length: 128, nullable: true })
  providerRefundReference!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  failureCode!: string | null;

  @Column({ type: 'varchar', length: 255 })
  reason!: string;

  @Column({ type: 'varchar', length: 16 })
  requestedByActorType!: 'customer' | 'professional' | 'system' | 'admin';

  @Column({ type: 'uuid', nullable: true })
  requestedByActorId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
