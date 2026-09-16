import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent, AuditLogger } from '@beauclick/events';
import { assertNonNegativeAmount } from '@beauclick/money';

import { FundJournalKind } from './entities/fund-journal.entity';
import { FundPostingAccount, FundPostingSellerPartyType, isDebitNormalAccount } from './entities/fund-posting.entity';
import { FinancialOutboxEntity } from './entities/financial-outbox.entity';
import { FINANCIAL_DATA_SOURCE } from './ports';

/**
 * The per-order advisory-lock namespace ADR-052 §4 names `fjo` ("Serialization
 * [T]"): the financial writer role holds INSERT + SELECT only, so it cannot
 * `SELECT ... FOR UPDATE` to safely read-then-write the `seq`/`balance_after`
 * chain. Every journal insert takes this transaction-scoped lock FIRST, so
 * the plain (unlocked) reads inside `insertPosting` below are safe against a
 * concurrent writer for the SAME order -- never against a different order,
 * which is the point of scoping the lock by `hashtext(orderId)`.
 *
 * Encoded exactly like every other `*_LOCK_NAMESPACE` in the tree (see
 * `booking/src/ports.ts`'s `RESOURCE_ASSIGNMENT_LOCK_NAMESPACE` for the
 * pattern this copies): four ASCII bytes packed into a signed int32.
 * `fjo` is three letters, padded with a leading zero byte -- the uniqueness
 * scan in `ai-lifecycle-privacy.pg-spec.ts` proves this value collides with
 * nothing else declared anywhere in `services/`, `libs/`, `apps/api/src/` or
 * `packages/`.
 */
export const FUND_JOURNAL_ORDER_LOCK_NAMESPACE = 0x00_66_6a_6f | 0; // 'fjo'

export interface RecordCollectionInput {
  orderId: string;
  sellerPartyType: FundPostingSellerPartyType;
  sellerPartyId: string;
  /** The gateway-verified amount BeauClick actually collected -- never the service total under a deposit (ADR-045). */
  collectedToman: number;
  /** The payment intent id. Becomes `collection:<paymentReferenceId>`, the journal's idempotency key. */
  paymentReferenceId: string;
}

export interface RecordFundRefundInput {
  orderId: string;
  refundId: string;
  refundAmountToman: number;
}

interface PostingInput {
  orderId: string;
  sellerPartyType: FundPostingSellerPartyType;
  sellerPartyId: string;
  account: FundPostingAccount;
  component: string | null;
  /** Signed by the account's normal side -- see `fund-posting.entity.ts`'s docblock. */
  amountToman: number;
}

/**
 * Sole writer of `financial.fund_journals` / `financial.fund_postings` --
 * the pending-funds journal for every order collected from `#43a` onward
 * (ADR-052 §4–§5). `financial.ledger_entries` stays exactly as it is,
 * forever, for every order that collected before this deploy; `LedgerService`
 * still owns THAT table's one remaining write path, the legacy cumulative
 * refund reversal (ADR-052 §16, §3).
 *
 * Runs on the same isolated `FINANCIAL_DATA_SOURCE` as `LedgerService` --
 * INSERT + SELECT only, proved against the real server by
 * `role-contract.ts`'s `funds_journal.*` / `funds_posting.*` checks.
 */
@Injectable()
export class FundJournalService {
  private readonly auditLog = new AuditLogger('financial');

  constructor(@Inject(FINANCIAL_DATA_SOURCE) private readonly dataSource: DataSource) {}

  /**
   * `OrderPaid v1` / `OrderCollectionCaptured v1` -- ADR-052 §5's `collection`
   * row: `pending +c / collected −c`. No commission, no receivable: neither
   * exists until `#43b`/`#43c`, and R1 recognises commission at the outcome,
   * never at collection.
   *
   * Idempotent by `uq_fund_journals_idempotency_key` on `collection:<paymentReferenceId>`
   * -- never a preceding SELECT, matching `LedgerService.insertEntries`'s
   * discipline.
   */
  async recordCollection(input: RecordCollectionInput): Promise<boolean> {
    assertNonNegativeAmount(input.collectedToman, 'collected amount');
    if (input.collectedToman === 0) return false;

    return this.dataSource.transaction(async (manager) => {
      await this.lockOrder(manager, input.orderId);

      const journalId = await this.insertJournal(manager, {
        kind: 'collection',
        idempotencyKey: `collection:${input.paymentReferenceId}`,
        sourceId: input.orderId,
      });
      if (!journalId) return false; // already recorded -- idempotent no-op

      const party = { sellerPartyType: input.sellerPartyType, sellerPartyId: input.sellerPartyId };
      await this.insertPosting(manager, journalId, {
        ...party,
        orderId: input.orderId,
        account: 'pending',
        component: null,
        amountToman: input.collectedToman,
      });
      await this.insertPosting(manager, journalId, {
        ...party,
        orderId: input.orderId,
        account: 'collected',
        component: null,
        amountToman: -input.collectedToman,
      });

      await this.emitRecorded(manager, journalId, 'collection', input.orderId, party, input.collectedToman);
      this.auditLog.log({ action: 'fund_journal.collection_recorded', orderId: input.orderId, amountToman: input.collectedToman });
      return true;
    });
  }

  /**
   * `OrderRefunded v1` -- ADR-052 §5's `refund` row, drawing `pending`
   * (`#43a` never populates `available`: `release`, the only journal kind
   * that moves money there, belongs to `#43c`, so every new-regime order's
   * whole collected amount sits in `pending` until then and a refund can
   * never legitimately need to draw beyond it -- `commerce.orders`'
   * `ck_orders_refund_within_collected` CHECK is the same bound applied on
   * the commerce side). `ck_fund_postings_balance_non_negative` refuses any
   * refund this platform's own commerce invariant should have already
   * prevented, rather than silently drawing from an account `#43a` does not
   * own.
   *
   * Idempotent by `uq_fund_journals_idempotency_key` on `refund:<refundId>`.
   */
  async recordRefund(input: RecordFundRefundInput): Promise<boolean> {
    assertNonNegativeAmount(input.refundAmountToman, 'refund amount');
    if (input.refundAmountToman === 0) return false;

    return this.dataSource.transaction(async (manager) => {
      await this.lockOrder(manager, input.orderId);

      const collectionParty = await this.findCollectionParty(manager, input.orderId);
      if (!collectionParty) {
        // No new-regime collection was ever recorded for this order -- a
        // refund racing ahead of the collection, or a legacy order this
        // service was never meant to touch. Inventing a reversal would
        // fabricate a financial fact; the caller (the event handler) is
        // responsible for routing a legacy order to `LedgerService` instead.
        this.auditLog.warn({ action: 'fund_journal.refund_without_collection', orderId: input.orderId, refundId: input.refundId });
        return false;
      }

      const journalId = await this.insertJournal(manager, {
        kind: 'refund',
        idempotencyKey: `refund:${input.refundId}`,
        sourceId: input.orderId,
      });
      if (!journalId) return false; // already recorded -- idempotent no-op

      await this.insertPosting(manager, journalId, {
        ...collectionParty,
        orderId: input.orderId,
        account: 'refunded',
        component: null,
        amountToman: input.refundAmountToman,
      });
      await this.insertPosting(manager, journalId, {
        ...collectionParty,
        orderId: input.orderId,
        account: 'pending',
        component: null,
        amountToman: -input.refundAmountToman,
      });

      await this.emitRecorded(manager, journalId, 'refund', input.orderId, collectionParty, input.refundAmountToman);
      this.auditLog.log({ action: 'fund_journal.refund_recorded', orderId: input.orderId, refundId: input.refundId, amountToman: input.refundAmountToman });
      return true;
    });
  }

  /** True iff a `collection` journal exists for this order under the new regime -- the legacy/new-regime router's other half (see `LedgerService.hasLegacyPayment`). */
  async hasCollection(orderId: string): Promise<boolean> {
    const party = await this.findCollectionParty(this.dataSource.manager, orderId);
    return party !== null;
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /**
   * Per-state totals for one order's new-regime postings -- what the `/funds`
   * read route projects. `balance_after` at each account's latest `seq`
   * already IS that account's current, natural non-negative total (computed
   * account-side-aware once, at insert time, by `insertPosting` and proved by
   * `tg_fund_postings_chain`) -- reading the last row per account is
   * therefore correct on its own; summing `amount_toman` again here would
   * re-derive a value the chain already committed. Empty when the order has
   * no new-regime collection.
   */
  async statesForOrder(orderId: string): Promise<Partial<Record<FundPostingAccount, number>>> {
    const rows: { account: FundPostingAccount; balance_after: string }[] = await this.dataSource.query(
      `SELECT DISTINCT ON (account) account, balance_after
         FROM financial.fund_postings
        WHERE order_id = $1
        ORDER BY account, seq DESC`,
      [orderId],
    );
    return Object.fromEntries(rows.map((r) => [r.account, Number(r.balance_after)]));
  }

  /**
   * Per-state totals across every order for one seller party -- the `/funds`
   * workspace read (ADR-052 §14, §16). Sums each order's LATEST per-account
   * balance, never re-summing every posting: the running balance already IS
   * the current total, and summing every posting again would double-count
   * any state that moved more than once (a refund after a collection, for
   * instance).
   */
  async statesForParty(
    sellerPartyType: FundPostingSellerPartyType,
    sellerPartyId: string,
  ): Promise<Partial<Record<FundPostingAccount, number>>> {
    const rows: { account: FundPostingAccount; total: string }[] = await this.dataSource.query(
      `SELECT account, SUM(balance_after) AS total
         FROM (
           SELECT DISTINCT ON (order_id, account) order_id, account, balance_after
             FROM financial.fund_postings
            WHERE seller_party_type = $1 AND seller_party_id = $2
            ORDER BY order_id, account, seq DESC
         ) latest
        GROUP BY account`,
      [sellerPartyType, sellerPartyId],
    );
    return Object.fromEntries(rows.map((r) => [r.account, Number(r.total)]));
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async lockOrder(manager: EntityManager, orderId: string): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [FUND_JOURNAL_ORDER_LOCK_NAMESPACE, orderId]);
  }

  /** @returns the new journal's id, or null if `idempotencyKey` was already recorded. */
  private async insertJournal(
    manager: EntityManager,
    input: { kind: FundJournalKind; idempotencyKey: string; sourceId: string },
  ): Promise<string | null> {
    const id = uuidv7();
    const inserted: unknown[] = await manager.query(
      `INSERT INTO financial.fund_journals (id, kind, idempotency_key, source_type, source_id)
       VALUES ($1, $2, $3, 'order', $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [id, input.kind, input.idempotencyKey, input.sourceId],
    );
    return Array.isArray(inserted) && inserted.length > 0 ? id : null;
  }

  /**
   * Computes the next `seq`/`balance_after` and inserts one posting.
   *
   * The read here is UNLOCKED -- safe only because `lockOrder` above already
   * serialises every writer for this order. `tg_fund_postings_chain` and
   * `uq_fund_postings_chain` are the real guarantee: if a lock were ever
   * missed, this method's own math could race and disagree with the trigger's,
   * and the INSERT fails loudly (`23505` or a `seq` mismatch) rather than
   * silently forking the balance chain.
   */
  private async insertPosting(manager: EntityManager, journalId: string, input: PostingInput): Promise<void> {
    const prior: { seq: number; balance_after: string }[] = await manager.query(
      `SELECT seq, balance_after FROM financial.fund_postings
        WHERE order_id = $1 AND account = $2 AND component IS NOT DISTINCT FROM $3
        ORDER BY seq DESC LIMIT 1`,
      [input.orderId, input.account, input.component],
    );
    const prevSeq = prior.length > 0 ? prior[0].seq : 0;
    const prevBalance = prior.length > 0 ? Number(prior[0].balance_after) : 0;
    const delta = isDebitNormalAccount(input.account) ? input.amountToman : -input.amountToman;
    const balanceAfter = prevBalance + delta;

    await manager.query(
      `INSERT INTO financial.fund_postings
         (id, journal_id, order_id, seller_party_type, seller_party_id, account, component, amount_toman, seq, balance_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        uuidv7(),
        journalId,
        input.orderId,
        input.sellerPartyType,
        input.sellerPartyId,
        input.account,
        input.component,
        String(input.amountToman),
        prevSeq + 1,
        String(balanceAfter),
      ],
    );
  }

  /** The order's first posting -- its fixed, database-proved beneficiary (see `tg_fund_postings_beneficiary`). Null when no new-regime posting exists for this order yet. */
  private async findCollectionParty(
    manager: EntityManager,
    orderId: string,
  ): Promise<{ sellerPartyType: FundPostingSellerPartyType; sellerPartyId: string } | null> {
    const rows: { seller_party_type: FundPostingSellerPartyType; seller_party_id: string }[] = await manager.query(
      `SELECT seller_party_type, seller_party_id FROM financial.fund_postings
        WHERE order_id = $1 ORDER BY id ASC LIMIT 1`,
      [orderId],
    );
    return rows.length > 0 ? { sellerPartyType: rows[0].seller_party_type, sellerPartyId: rows[0].seller_party_id } : null;
  }

  private async emitRecorded(
    manager: EntityManager,
    journalId: string,
    kind: FundJournalKind,
    orderId: string,
    party: { sellerPartyType: FundPostingSellerPartyType; sellerPartyId: string },
    amountToman: number,
  ): Promise<void> {
    await emitEvent(manager, FinancialOutboxEntity, {
      aggregateType: 'fund_journal',
      aggregateId: journalId,
      eventType: 'FundsJournalRecorded',
      payload: {
        journalId,
        orderId,
        kind,
        sellerPartyType: party.sellerPartyType,
        sellerPartyId: party.sellerPartyId,
        amountToman,
      },
    });
  }
}
