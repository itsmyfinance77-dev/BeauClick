import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { requiredMoneyTransformer } from '@beauclick/money';
import type { BookingCollectionMode } from '@beauclick/commercial-policy-contract';

/**
 * The immutable collection schedule for one order — V3.3 `#41a`, ADR-043.
 *
 * ## Why this is not three columns on `OrderEntity`
 *
 * `commerce.orders` legitimately mutates `status`, `refundedTotalToman`,
 * `paidAt` and `updatedAt`. An immutability trigger there would need an
 * exemption list, and an exemption list is exactly where the next column
 * becomes silently mutable. This table has **no** legitimately mutable column,
 * so `tg_order_payment_schedules_immutable` refuses UPDATE and DELETE
 * unconditionally and the guarantee is a database property rather than a
 * comment.
 *
 * ## The mode type is imported, never redeclared
 *
 * `BookingCollectionMode` comes from `@beauclick/commercial-policy-contract`,
 * which is `scope:shared` and zero-dependency. `V33-DEC-022` Ruling 2 forbids a
 * parallel money vocabulary, and a second `'pay_at_venue' | ...` union here
 * would be exactly that — two lists that must agree, which is one list waiting
 * to disagree.
 *
 * ## What every row says today
 *
 * `full_payment_online`, `platformCollectibleToman === serviceTotalToman`,
 * `venueBalanceToman === 0`, and no policy reference. `V33-DEC-011` still
 * controls which modes may be ENABLED and is open under #46, so `#41a`
 * represents all three and activates none.
 */
@Entity({ name: 'order_payment_schedules', schema: 'commerce' })
export class OrderPaymentScheduleEntity {
  /** The order this schedule describes. Primary key AND foreign key: one schedule per order, by construction. */
  @PrimaryColumn('uuid')
  orderId!: string;

  @Column({ type: 'varchar', length: 32 })
  collectionMode!: BookingCollectionMode;

  /** The full disclosed service price. */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  serviceTotalToman!: number;

  /** What BeauClick asks the gateway to collect. Never more than the service total (`ck_ops_sum`). */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  platformCollectibleToman!: number;

  /** What remains payable directly to the seller at the venue. */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  venueBalanceToman!: number;

  /**
   * The policy this schedule was selected from, or a real absence.
   *
   * All three are NULL together or present together — `ck_ops_policy_reference`
   * makes "partially referenced" unrepresentable. They are NULL for every row
   * today: `#41a` selects no policy, and the backfilled orders were placed
   * before any policy existed to select. #83 (`#41d`) fills them in.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  policyKey!: string | null;

  @Column({ type: 'int', nullable: true })
  policyVersion!: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  policyAcceptedAt!: Date | null;

  /** Which contract version wrote this row, so a future `V2` breakdown is a new value rather than a reinterpretation. */
  @Column({ type: 'smallint', default: 1 })
  contractVersion!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
