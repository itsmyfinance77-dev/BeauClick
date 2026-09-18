import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { requiredMoneyTransformer } from '@beauclick/money';

export const FUND_POSTING_SELLER_PARTY_TYPES = ['professional', 'business'] as const;
export type FundPostingSellerPartyType = (typeof FUND_POSTING_SELLER_PARTY_TYPES)[number];

/** Increases on a POSITIVE `amount_toman`. ADR-052 §4. */
export const DEBIT_NORMAL_ACCOUNTS = [
  'pending',
  'disputed',
  'available',
  'reserve',
  'settled',
  'refunded',
  'platform_earned',
  'provider_fee',
  'recovery_out',
] as const;

/** Increases on a NEGATIVE `amount_toman` -- see `FundJournalService`'s signing note. ADR-052 §4. */
export const CREDIT_NORMAL_ACCOUNTS = ['collected', 'platform_advance', 'recovered_in'] as const;

export const FUND_POSTING_ACCOUNTS = [...DEBIT_NORMAL_ACCOUNTS, ...CREDIT_NORMAL_ACCOUNTS] as const;
export type FundPostingAccount = (typeof FUND_POSTING_ACCOUNTS)[number];

const DEBIT_NORMAL_SET: ReadonlySet<string> = new Set(DEBIT_NORMAL_ACCOUNTS);

/** True for a debit-normal account (a positive posting is an increase). Mirrors `tg_fund_postings_chain`'s SQL exactly -- see that function for why the sign convention exists. */
export function isDebitNormalAccount(account: FundPostingAccount): boolean {
  return DEBIT_NORMAL_SET.has(account);
}

/**
 * One leg of a balanced journal (ADR-052 §4).
 *
 * `amountToman` is signed BY THE ACCOUNT'S NORMAL SIDE, not by "increase vs
 * decrease" in plain language: a debit-normal account's posting is positive
 * on an increase, and a credit-normal account's posting is NEGATIVE on an
 * increase. That is what makes the raw, unweighted sum of every posting in
 * one journal equal zero (M0) -- see `tg_fund_postings_journal_balance` in
 * the migration. `isDebitNormalAccount` above is the single place that says
 * which side an account is on; nothing here re-derives it.
 *
 * `seq`/`balanceAfter` form a running-balance chain per
 * `(orderId, account, component)`, checked by `tg_fund_postings_chain`
 * (BEFORE INSERT) against the account's own natural, non-negative running
 * total -- never computed by this class, because the financial writer role
 * cannot `SELECT ... FOR UPDATE` to safely read-then-write it (ADR-052 §4,
 * "Serialization [T]"). `FundJournalService` takes a transaction-scoped
 * advisory lock per order before every insert instead; a missed lock fails
 * loudly here (`23505` on `uq_fund_postings_chain`) rather than silently
 * forking the chain.
 */
@Entity({ name: 'fund_postings', schema: 'financial' })
@Index('ix_fund_postings_order', ['orderId', 'id'])
export class FundPostingEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  journalId!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  /**
   * Copied from `commerce.orders.seller_party_*` through the capture event
   * ONLY -- never from a request (`V33-DEC-025` R7). `tg_fund_postings_beneficiary`
   * refuses any later posting for this order that disagrees.
   */
  @Column({ type: 'varchar', length: 16 })
  sellerPartyType!: FundPostingSellerPartyType;

  @Column({ type: 'uuid' })
  sellerPartyId!: string;

  @Column({ type: 'varchar', length: 20 })
  account!: FundPostingAccount;

  /** Null for every account `#43a` posts to. Reserved for `platform_earned`'s per-component split, owned by `#43b`/`#43c`. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  component!: string | null;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  amountToman!: number;

  @Column({ type: 'int' })
  seq!: number;

  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  balanceAfter!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
