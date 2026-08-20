import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { CurrencyCode, requiredMoneyTransformer } from '@beauclick/money';

/**
 * Payment intent lifecycle.
 *
 *   created --> pending --> succeeded
 *      |           |
 *      |           +------> failed  (a new attempt may still be started)
 *      |
 *      +--> cancelled | expired
 *
 * **Deviation from the state list ADR-006 sketched, deliberate:** that
 * sketch included `requires_action`, which is a card-network/3DS concept
 * from Stripe's model. Iranian gateways are redirect-based -- the redirect
 * IS the action, and there is no second interaction step for the API to
 * request. Carrying a state no adapter can ever produce would force every
 * consumer to handle an unreachable branch forever. If a future gateway
 * genuinely needs it, adding a state is additive.
 *
 * `failed` is deliberately NOT terminal for the ORDER: a customer whose card
 * was declined may try again, creating a new attempt against the same
 * intent. The intent is terminal only at succeeded/cancelled/expired.
 */
export const PAYMENT_INTENT_STATUSES = ['created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired'] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/** Statuses in which an intent still owns its order -- a second intent may not exist alongside these. */
export const LIVE_INTENT_STATUSES: readonly PaymentIntentStatus[] = ['created', 'pending', 'succeeded'];

@Entity({ name: 'payment_intents', schema: 'payment' })
@Index('ix_payment_intents_order', ['orderId'])
export class PaymentIntentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References commerce.orders.id. No cross-schema FK, by convention. */
  @Column({ type: 'uuid' })
  orderId!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  /**
   * The amount owed, captured at intent creation from the order's own total.
   * Stored HERE as well as on the order so verification compares the
   * gateway's captured amount against a figure recorded before the customer
   * ever reached the gateway -- an order total mutated in between cannot
   * launder a mismatch.
   */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  amountToman!: number;

  @Column({ type: 'varchar', length: 3, default: 'IRT' })
  currency!: CurrencyCode;

  @Column({ type: 'varchar', length: 20, default: 'created' })
  status!: PaymentIntentStatus;

  @Column({ type: 'varchar', length: 40 })
  providerKey!: string;

  /** After this instant the intent may not be verified. Bounds the replay window for a stale callback. */
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  succeededAt!: Date | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  failureCode!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
