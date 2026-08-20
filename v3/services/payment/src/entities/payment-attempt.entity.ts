import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { moneyTransformer, requiredMoneyTransformer } from '@beauclick/money';

export const PAYMENT_ATTEMPT_STATUSES = ['initiated', 'succeeded', 'failed'] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/**
 * One trip to the gateway.
 *
 * An intent may have several attempts (a declined card, a customer who
 * abandoned and came back). The ATTEMPT -- not the intent -- carries the
 * gateway's own reference, and `UNIQUE(provider_key, provider_reference)` is
 * the database-enforced answer to callback replay: a duplicate callback
 * resolves to the SAME attempt row, so there is exactly one place where
 * "did this transaction already succeed?" is recorded, and exactly one row
 * a compare-and-swap has to win.
 */
@Entity({ name: 'payment_attempts', schema: 'payment' })
@Index('ix_payment_attempts_intent', ['paymentIntentId'])
export class PaymentAttemptEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  paymentIntentId!: string;

  @Column({ type: 'varchar', length: 40 })
  providerKey!: string;

  /** The gateway's own transaction identifier (ZarinPal calls it an "authority"). */
  @Column({ type: 'varchar', length: 128 })
  providerReference!: string;

  @Column({ type: 'varchar', length: 20, default: 'initiated' })
  status!: PaymentAttemptStatus;

  /** What we asked the gateway to charge. */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  requestedAmountToman!: number;

  /** What the gateway says it actually captured -- learned only from server-to-server verification. */
  @Column({ type: 'bigint', nullable: true, transformer: moneyTransformer })
  verifiedAmountToman!: number | null;

  /**
   * Where the gateway said to send the customer.
   *
   * Stored so a retried checkout can REUSE this attempt instead of opening a
   * second one. Two live attempts means two separately-chargeable gateway
   * references for one intent -- the double-charge hole found in Phase 2
   * live QA (see the 20260820100005 migration).
   */
  @Column({ type: 'text', nullable: true })
  redirectUrl!: string | null;

  /** The settlement reference printed on the customer's receipt. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  providerTransactionId!: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  failureCode!: string | null;

  /**
   * The gateway's verification response, kept for dispute resolution.
   * Adapters must strip credentials before returning it -- a merchant id or
   * API key must never land in this column.
   */
  @Column({ type: 'jsonb', nullable: true })
  providerResponse!: PaymentProviderResponseSnapshot | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/** Flat scalar map. Deliberately not an arbitrary nested blob -- it keeps the column reviewable. */
export interface PaymentProviderResponseSnapshot {
  [key: string]: string | number | boolean | null;
}
