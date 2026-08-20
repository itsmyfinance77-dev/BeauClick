import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { requiredMoneyTransformer } from '@beauclick/money';

/**
 * One priced line of an order.
 *
 * `name` and `unitPriceToman` are SNAPSHOTS taken at order creation, not
 * lookups. A professional editing their service price later must never
 * change what a past customer was charged -- the same "capture the value at
 * write time" discipline the financial ledger applies to commission rates.
 */
@Entity({ name: 'order_items', schema: 'commerce' })
@Index('ix_order_items_order', ['orderId'])
export class OrderItemEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  /** 'service' today. Kept explicit so a future product/shop line is additive, not a schema change. */
  @Column({ type: 'varchar', length: 20 })
  itemType!: string;

  /** provider.services.id for a service line. */
  @Column({ type: 'uuid', nullable: true })
  referenceId!: string | null;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'int' })
  quantity!: number;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  unitPriceToman!: number;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  lineTotalToman!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
