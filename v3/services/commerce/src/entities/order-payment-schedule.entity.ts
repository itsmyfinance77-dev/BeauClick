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
   * ## Who writes these, corrected
   *
   * This docblock used to say #83 (`#41d`) would fill them in. That was true of
   * the story as originally scoped and stopped being true when `V33-DEC-031`
   * split it: **#83 publishes the catalogue and writes nothing here**, #104
   * (`#41d-2a`) records which policy a seller chose, and **#115 (`#41d-2b`) is
   * the writer of `policyKey` and `policyVersion`** — the exact key and version
   * that priced one booking, snapshotted immutably at order creation.
   *
   * ## Key and version are all-or-none; acceptance is independent
   *
   * `ck_ops_policy_reference` originally required all THREE together, which
   * made an enrolled order unwritable: #115 knows the policy and, deliberately,
   * no acceptance. Its migration replaced the constraint so key and version
   * remain inseparable while `policyAcceptedAt` is independently nullable.
   *
   * An UNENROLLED seller's order still carries all three NULL, as does every
   * backfilled order placed before any policy existed — which is a fact about
   * those bookings, not a gap.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  policyKey!: string | null;

  @Column({ type: 'int', nullable: true })
  policyVersion!: number | null;

  /**
   * Customer acceptance of the policy. **NULL for every row.**
   *
   * Neither child of `#41d-2` records it: #104 assigns and #115 snapshots, and
   * acceptance is #42's after Legal. It is nullable independently of the key
   * and version precisely so #42 can add it beside a reference that is already
   * there.
   */
  @Column({ type: 'timestamptz', nullable: true })
  policyAcceptedAt!: Date | null;

  /** Which contract version wrote this row, so a future `V2` breakdown is a new value rather than a reinterpretation. */
  @Column({ type: 'smallint', default: 1 })
  contractVersion!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
