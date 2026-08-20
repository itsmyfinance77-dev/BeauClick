import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { CurrencyCode, requiredMoneyTransformer } from '@beauclick/money';
import { LedgerPartyType } from './ledger-entry.entity';

export const SETTLEMENT_KINDS = ['settlement', 'reversal'] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

/**
 * A settlement is a RECORD that a real, external payment already happened.
 * This service never moves money, never calls a bank, and never mutates the
 * ledger -- it only reads receivable facts and records what was paid out.
 *
 * **Deviation from V2, deliberate: settlements are append-only too.**
 *
 * V2 reversed a settlement by UPDATEing its row's status to `reversed`. That
 * works, but it means the settlement history is mutable, so it cannot live
 * under the same revoked-UPDATE grant that protects the ledger -- and it
 * loses the original row's content the moment anyone edits it. Here, a
 * reversal is a NEW row (`kind = 'reversal'`) with mirrored negative items
 * pointing back at the batch it reverses.
 *
 * Two things fall out of that. The whole `financial` schema becomes
 * INSERT-only, so one grant policy protects every financial table rather
 * than just one. And "how much has this party been settled?" becomes a
 * single `SUM(amount)` over all rows -- no status filter, no join to decide
 * which batches still count, no way to get the filter wrong.
 */
@Entity({ name: 'settlement_batches', schema: 'financial' })
@Index('ix_settlement_batches_party', ['partyType', 'partyId'])
export class SettlementBatchEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16, default: 'settlement' })
  kind!: SettlementKind;

  /** Set only on a reversal row. UNIQUE among reversals, so a batch cannot be reversed twice. */
  @Column({ type: 'uuid', nullable: true })
  reversesSettlementId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  partyType!: LedgerPartyType;

  @Column({ type: 'uuid' })
  partyId!: string;

  /** Negative on a reversal row. Always equals the sum of this batch's items. */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  amountToman!: number;

  @Column({ type: 'varchar', length: 3, default: 'IRT' })
  currency!: CurrencyCode;

  @Column({ type: 'varchar', length: 60, nullable: true })
  method!: string | null;

  /** The external bank/transfer reference the operator recorded. */
  @Column({ type: 'varchar', length: 191, nullable: true })
  reference!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * Itemizes a settlement by order, so "why is this party's outstanding
 * balance X?" is always traceable to specific orders rather than an opaque
 * lump sum. A reversal batch carries the exact negative mirror of the items
 * it reverses.
 */
@Entity({ name: 'settlement_items', schema: 'financial' })
@Index('ix_settlement_items_order', ['orderId'])
export class SettlementItemEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  settlementId!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  /** Negative on a reversal item. */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  amountToman!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
