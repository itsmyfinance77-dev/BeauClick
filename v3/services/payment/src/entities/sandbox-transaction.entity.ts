import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { requiredMoneyTransformer } from '@beauclick/money';

export const SANDBOX_OUTCOMES = ['pending', 'paid', 'declined', 'cancelled'] as const;
export type SandboxOutcome = (typeof SANDBOX_OUTCOMES)[number];

/**
 * The sandbox gateway's OWN books -- a stand-in for the external bank's
 * records, not part of BeauClick's payment domain.
 *
 * It exists as a real table rather than an in-memory map for one reason: it
 * makes the sandbox behave like a genuine external system. `verify()` has to
 * go and ASK it what happened, exactly as a real adapter asks a real gateway
 * over HTTP. If the sandbox instead returned success based on the callback
 * parameters, the entire callback-security suite would be testing nothing --
 * it would pass against an implementation that trusts the browser, which is
 * precisely the vulnerability those tests exist to prove is absent.
 *
 * `declined` and `cancelled` are deliberately DISTINCT outcomes. A bank
 * refusing a card and a customer abandoning checkout are different events
 * that a support engineer reproducing a ticket must be able to tell apart,
 * and they produce different `failureCode`s downstream.
 *
 * Only SandboxPaymentProvider ever touches this table.
 */
@Entity({ name: 'sandbox_transactions', schema: 'payment' })
export class SandboxTransactionEntity {
  /** The provider reference handed back at initiation -- the gateway's own id for this transaction. */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  reference!: string;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  amountToman!: number;

  @Column({ type: 'varchar', length: 3, default: 'IRT' })
  currency!: string;

  /**
   * What the transaction was FOR, as the gateway was told at initiation.
   *
   * Recorded so QA (and the sandbox's own tests) can cross-check an order
   * against the simulated bank's independent books -- the same reconciliation
   * a real gateway's merchant dashboard supports. Nullable only because rows
   * predating this column have no honest value to backfill.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  orderId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  paymentIntentId!: string | null;

  /** What the simulated bank decided. 'pending' until the sandbox checkout page is used. */
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  outcome!: SandboxOutcome;

  /** The simulated settlement reference, assigned when and only when the transaction is paid. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  settlementReference!: string | null;

  /** Set once refunded, so a replayed refund is a no-op on the gateway side too. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  refundReference!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
