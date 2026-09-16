import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * `#43a` writes only these two; the rest are ADR-052 §4/§5's reserved
 * vocabulary for `#43c`–`#43g`, kept here so a later child's migration widens
 * one CHECK instead of also widening this union in a different file.
 */
export const FUND_JOURNAL_KINDS = [
  'collection',
  'refund',
  'dispute_hold',
  'dispute_outcome',
  'release',
  'reserve_hold',
  'reserve_release',
  'settlement',
  'settlement_reversal',
  'recovery',
  'fee',
] as const;
export type FundJournalKind = (typeof FUND_JOURNAL_KINDS)[number];

export const FUND_JOURNAL_SOURCE_TYPES = ['order'] as const;
export type FundJournalSourceType = (typeof FUND_JOURNAL_SOURCE_TYPES)[number];

/**
 * One balanced, append-only accounting fact (ADR-052 §4). Every posting that
 * belongs to one journal sums to exactly zero across the order(s) it touches
 * -- enforced by `tg_fund_postings_journal_balance`, a DEFERRED CONSTRAINT
 * TRIGGER on `fund_postings`, never by application arithmetic (R6/M0).
 *
 * `#43a` writes exactly two kinds, `collection` and `refund`, each carrying
 * NO commission and NO receivable row -- ADR-052 §5 is explicit that a
 * `collection` journal is `pending +c / collected −c` and nothing else.
 *
 * Immutability is enforced by PostgreSQL exactly as `LedgerEntryEntity`'s
 * docblock describes: the financial writer role holds INSERT + SELECT only,
 * proved against the real server by `role-contract.ts`'s `funds_journal.*`
 * checks, so there is no `updated_at` here either.
 */
@Entity({ name: 'fund_journals', schema: 'financial' })
@Index('ix_fund_journals_source', ['sourceType', 'sourceId'])
export class FundJournalEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: FundJournalKind;

  /**
   * Consumer idempotency (ADR-052 §13): `collection:<paymentIntentId>` /
   * `refund:<refundId>`. Enforced by `uq_fund_journals_idempotency_key`, a
   * real UNIQUE index -- never a preceding SELECT, for the same reason
   * `LedgerService.insertEntries` never checks-then-inserts.
   */
  @Column({ type: 'varchar', length: 160 })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 16 })
  sourceType!: FundJournalSourceType;

  @Column({ type: 'uuid' })
  sourceId!: string;

  /**
   * The commission-policy snapshot, by value. Always null for `#43a`'s two
   * kinds -- neither commission policy (`#43b`) nor release (`#43c`) exist
   * yet. Reserved for `#43c`'s `release` journal.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  policyKey!: string | null;

  @Column({ type: 'int', nullable: true })
  policyVersion!: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
