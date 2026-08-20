import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { requiredMoneyTransformer } from '@beauclick/money';

/**
 * The local mock gateway's OWN books -- a stand-in for the external bank's
 * records, not part of BeauClick's payment domain.
 *
 * It exists as a real table rather than an in-memory map for one reason: it
 * makes the mock behave like a genuine external system. `verify()` has to go
 * and ASK it what happened, exactly as a real adapter asks a real gateway
 * over HTTP. If the mock instead returned success based on the callback
 * parameters, the entire callback-security test suite would be testing
 * nothing -- it would pass against an implementation that trusts the
 * browser, which is precisely the vulnerability those tests exist to prove
 * is absent.
 *
 * Only MockGatewayProvider ever touches this table.
 */
@Entity({ name: 'mock_gateway_transactions', schema: 'payment' })
export class MockGatewayTransactionEntity {
  /** The provider reference handed back at initiation -- the gateway's own id for this transaction. */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  reference!: string;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  amountToman!: number;

  /** What the simulated bank decided. 'pending' until the mock checkout page is used. */
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  outcome!: 'pending' | 'paid' | 'declined';

  /** The simulated settlement reference, assigned when the transaction is paid. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  settlementReference!: string | null;

  /** Set once refunded, so a replayed refund is a no-op on the gateway side too. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  refundReference!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
