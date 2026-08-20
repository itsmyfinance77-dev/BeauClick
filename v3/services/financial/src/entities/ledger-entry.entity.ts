import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { CurrencyCode, requiredMoneyTransformer } from '@beauclick/money';

export const LEDGER_ENTRY_TYPES = ['commission', 'receivable'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const LEDGER_REFERENCE_TYPES = ['order_payment', 'order_refund'] as const;
export type LedgerReferenceType = (typeof LEDGER_REFERENCE_TYPES)[number];

export const LEDGER_PARTY_TYPES = ['platform', 'professional', 'business'] as const;
export type LedgerPartyType = (typeof LEDGER_PARTY_TYPES)[number];

/**
 * The append-only commission ledger (ADR-009).
 *
 * Single-entry, not double-entry -- confirmed rather than redesigned. There
 * is no multi-currency, no intercompany settlement, and no accounting-
 * standard compliance requirement anywhere in this product, so double-entry
 * would add real complexity for no evidenced need.
 *
 * What this table records is deliberately narrow: the TWO facts that exist
 * nowhere else -- the platform's `commission` cut and the seller's
 * `receivable` cut of an order's real total -- plus the negative reversal
 * counterpart of each when a refund happens. It does not duplicate gross,
 * discount, or subtotal; those already live, unmodified, on the order. The
 * ledger explains the financial history, it does not replace commerce as
 * the order system.
 *
 * **Immutability is enforced by PostgreSQL, not by this class.** The table
 * is owned by a role the application does not have, and the connection
 * financial-service uses holds INSERT + SELECT only -- `UPDATE`, `DELETE`,
 * and `TRUNCATE` are never granted to any application role. That is why
 * this entity has no `updated_at`: not as a convention, but because no
 * connection in the system can perform an update. V2 could only ever claim
 * "no mutating method exists" (GAP-01); V3 makes it structurally true, and
 * `financial-immutability.pg-spec.ts` proves it against the real server.
 */
@Entity({ name: 'ledger_entries', schema: 'financial' })
@Index('ix_ledger_entries_party', ['partyType', 'partyId'])
export class LedgerEntryEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  /** The booking (or other source) the order came from, so finance is traceable back to the service delivered. */
  @Column({ type: 'uuid', nullable: true })
  sourceId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  partyType!: LedgerPartyType;

  /** Null for platform commission rows -- the platform is not a party with an id. */
  @Column({ type: 'uuid', nullable: true })
  partyId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  entryType!: LedgerEntryType;

  /** Negative on a refund reversal. Always integer Toman. */
  @Column({ type: 'bigint', transformer: requiredMoneyTransformer })
  amountToman!: number;

  @Column({ type: 'varchar', length: 3, default: 'IRT' })
  currency!: CurrencyCode;

  /**
   * What the rate was applied TO, captured as a string at write time.
   * Recording it per row means a future second basis can be introduced
   * without needing to reinterpret a single historical row.
   */
  @Column({ type: 'varchar', length: 30 })
  basis!: string;

  /**
   * The commission rate IN BASIS POINTS, captured at write time -- never
   * looked up live. This single column is what makes a rate change unable to
   * retroactively alter the meaning of a past transaction, and what lets a
   * refund reverse at the rate it was originally recorded at. V2's most
   * important financial invariant, carried over exactly (widened from
   * integer percent to basis points so a rate like 12.5% is representable).
   */
  @Column({ type: 'int' })
  commissionRateBp!: number;

  @Column({ type: 'varchar', length: 20 })
  referenceType!: LedgerReferenceType;

  /** The payment id for `order_payment`, the refund id for `order_refund`. */
  @Column({ type: 'uuid' })
  referenceId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
