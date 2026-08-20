import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { requiredMoneyTransformer } from '@beauclick/money';

/**
 * One itemized price adjustment, exactly as the pricing engine produced it.
 *
 * Persisting these -- rather than only the final total -- is what makes a
 * historical price permanently explainable. A customer asking "why was this
 * 150,000?" two years later gets an answer from data, not from re-running
 * today's rules against yesterday's order (which would give a different,
 * wrong answer whenever a rule has since changed).
 */
@Entity({ name: 'order_adjustments', schema: 'commerce' })
@Index('ix_order_adjustments_order', ['orderId'])
export class OrderAdjustmentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  @Column({ type: 'varchar', length: 60 })
  ruleKey!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: 'discount' | 'fee';

  @Column({ type: 'varchar', length: 60, nullable: true })
  code!: string | null;

  @Column({ type: 'varchar', length: 200 })
  label!: string;

  /** Negative for a discount, positive for a fee. */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  amountToman!: number;

  @Column({ type: 'int' })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
