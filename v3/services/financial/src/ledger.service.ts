import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent, AuditLogger } from '@beauclick/events';
import { assertNonNegativeAmount, splitExact } from '@beauclick/money';

import {
  LedgerEntryEntity,
  LedgerEntryType,
  LedgerPartyType,
  LedgerReferenceType,
} from './entities/ledger-entry.entity';
import { FinancialOutboxEntity } from './entities/financial-outbox.entity';
import { FINANCIAL_DATA_SOURCE } from './ports';

/**
 * What the rate was applied TO. `#43a` (ADR-052 §16) removed `FinancialConfig`
 * and the whole in-code commission rate along with it; this literal is the
 * one thing `recordRefund` still needs from that class, kept here because a
 * legacy row's `basis` column must keep meaning what it always meant.
 */
const LEGACY_BASIS = 'net_customer_amount';

export interface RecordRefundInput {
  orderId: string;
  refundId: string;
  refundAmountToman: number;
}

/**
 * Sole owner of `financial.ledger_entries` -- the LEGACY regime only, from
 * `#43a` onward (ADR-052 §16). Every order that collected before this deploy
 * keeps its ledger rows for life, here; every order collected from this
 * deploy on uses `FundJournalService` instead, and never writes a
 * `ledger_entries` row at all -- `recordPayment` (and the in-code commission
 * rate it read) is removed, not merely unused.
 *
 * Runs on its own `DataSource` -- a connection whose PostgreSQL role holds
 * INSERT + SELECT and nothing else on this schema. This class could not
 * update or delete a ledger row if it tried; the database would refuse.
 */
@Injectable()
export class LedgerService {
  private readonly auditLog = new AuditLogger('financial');

  constructor(@Inject(FINANCIAL_DATA_SOURCE) private readonly dataSource: DataSource) {}

  /** True iff this order's collection was ever recorded on the LEGACY ledger -- the regime router `financial-projection.handlers.ts` uses to send a refund here instead of to `FundJournalService` (ADR-052 §16: "the regime is fixed per order by where its collection fact lives"). */
  async hasLegacyPayment(orderId: string): Promise<boolean> {
    const count = await this.dataSource
      .getRepository(LedgerEntryEntity)
      .count({ where: { orderId, referenceType: 'order_payment', entryType: 'commission' } });
    return count > 0;
  }

  /**
   * Records the reversal pair for a refund against a LEGACY order.
   *
   * **Reuses the ORIGINAL entry's captured commission rate, never the
   * platform's current one** (which no longer exists in code at all --
   * every legacy row's rate is frozen forever at the value it was written
   * with). This is V2's single most important financial rule and it
   * transfers unchanged.
   *
   * **Cumulative, not independent, reversal (ADR-052 §3, §16; a `#43a`
   * technical repair).** Each call used to split `-refundAmountToman`
   * on its own, at the original rate -- which double-rounds: two partial
   * refunds of an order collected at 1500bp (50 then 51 of 101) reversed 8+8
   * = 16 of commission against an original 15, leaving −1 commission and +1
   * receivable after a FULL refund (ADR-052 §3's own worked example). Instead,
   * every call recomputes the commission/receivable split the order SHOULD
   * carry after this refund, from the order's still-remaining net amount, and
   * posts only the DELTA from what is already recorded. The final refund of a
   * fully-refunded order therefore always leaves exactly 0 / 0, however many
   * partial refunds preceded it, because the target is re-derived from the
   * remaining amount every time rather than accumulated from independent
   * roundings.
   *
   * Nothing here touches settlement. A refund landing after a settlement is
   * handled identically to one landing before: the receivable total simply
   * drops, and `SettlementService`'s always-freshly-computed outstanding
   * naturally reflects the reduced -- possibly negative -- figure the next
   * time it is read. A negative outstanding is an honest fact about money
   * that was paid out and then refunded; it is never clamped to zero.
   */
  async recordRefund(input: RecordRefundInput): Promise<boolean> {
    assertNonNegativeAmount(input.refundAmountToman, 'refund amount');
    if (input.refundAmountToman === 0) return false;

    const rows = await this.dataSource.getRepository(LedgerEntryEntity).find({
      where: { orderId: input.orderId },
    });
    const originalCommission = rows.find((e) => e.referenceType === 'order_payment' && e.entryType === 'commission');
    const originalReceivable = rows.find((e) => e.referenceType === 'order_payment' && e.entryType === 'receivable');

    if (!originalCommission || !originalReceivable) {
      // No payment was ever recorded for this order (a refund racing ahead of
      // the payment record, or an order with no seller party). Nothing to
      // reverse -- and inventing a reversal would fabricate a financial fact.
      this.auditLog.warn({ action: 'ledger.refund_without_payment', orderId: input.orderId, refundId: input.refundId });
      return false;
    }

    const rateBp = originalCommission.commissionRateBp;
    const originalNetToman = originalCommission.amountToman + originalReceivable.amountToman;

    // Every prior reversal this order has already recorded (each negative,
    // or zero on the first refund). Idempotency means a redelivered refundId
    // is already among these rows by the time a second call could observe
    // them, so a retried delivery recomputes the SAME target and the insert
    // below is a real no-op via the unique constraint -- never a double
    // reversal.
    const priorCommissionReversed = rows
      .filter((e) => e.referenceType === 'order_refund' && e.entryType === 'commission')
      .reduce((sum, e) => sum + e.amountToman, 0);
    const priorReceivableReversed = rows
      .filter((e) => e.referenceType === 'order_refund' && e.entryType === 'receivable')
      .reduce((sum, e) => sum + e.amountToman, 0);
    const alreadyRefundedToman = -(priorCommissionReversed + priorReceivableReversed);

    const remainingNetToman = originalNetToman - alreadyRefundedToman - input.refundAmountToman;
    const target = splitExact(remainingNetToman, rateBp);

    const currentCommissionRecorded = originalCommission.amountToman + priorCommissionReversed;
    const currentReceivableRecorded = originalReceivable.amountToman + priorReceivableReversed;

    const commissionPart = target.part - currentCommissionRecorded;
    const receivablePart = target.remainder - currentReceivableRecorded;

    return this.dataSource.transaction(async (manager) => {
      const inserted = await this.insertEntries(manager, [
        {
          orderId: input.orderId,
          sourceId: originalCommission.sourceId,
          partyType: 'platform',
          partyId: null,
          entryType: 'commission',
          amountToman: commissionPart,
          commissionRateBp: rateBp,
          referenceType: 'order_refund',
          referenceId: input.refundId,
        },
        {
          orderId: input.orderId,
          sourceId: originalReceivable.sourceId,
          partyType: originalReceivable.partyType,
          partyId: originalReceivable.partyId,
          entryType: 'receivable',
          amountToman: receivablePart,
          commissionRateBp: rateBp,
          referenceType: 'order_refund',
          referenceId: input.refundId,
        },
      ]);

      if (inserted === 0) return false;

      await emitEvent(manager, FinancialOutboxEntity, {
        aggregateType: 'ledger',
        aggregateId: input.orderId,
        eventType: 'LedgerEntriesRecorded',
        payload: {
          orderId: input.orderId,
          referenceType: 'order_refund',
          referenceId: input.refundId,
          commissionToman: commissionPart,
          receivableToman: receivablePart,
          commissionRateBp: rateBp,
        },
      });

      this.auditLog.log({
        action: 'ledger.refund_recorded',
        orderId: input.orderId,
        refundId: input.refundId,
        commissionToman: commissionPart,
        receivableToman: receivablePart,
        commissionRateBp: rateBp,
      });
      return true;
    });
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async entriesForOrder(orderId: string): Promise<LedgerEntryEntity[]> {
    return this.dataSource.getRepository(LedgerEntryEntity).find({ where: { orderId }, order: { id: 'ASC' } });
  }

  /**
   * One order's ledger rows FOR ONE PARTY — V3.3 #72, `V33-DEC-020`.
   *
   * The party predicate is in the WHERE clause, not applied afterwards.
   * `MyFinanceService.myLedgerForOrder` used to call `entriesForOrder` above and
   * filter the result in JavaScript, which produced the right answer and the
   * wrong shape: every row of the order — the platform's commission row and any
   * other party's receivable — was loaded into the process before being
   * discarded. `V33-DEC-020` requires the workspace to scope the query at the
   * predicate rather than filter an already-loaded cross-workspace result.
   *
   * `ix_ledger_entries_party` covers `(party_type, party_id)`, so this is a
   * narrower read as well as a safer one.
   *
   * An order belonging to another party returns `[]`, exactly like an order that
   * does not exist.
   */
  async entriesForOrderAndParty(
    orderId: string,
    partyType: LedgerPartyType,
    partyId: string,
  ): Promise<LedgerEntryEntity[]> {
    return this.dataSource.getRepository(LedgerEntryEntity).find({
      where: { orderId, partyType, partyId },
      order: { id: 'ASC' },
    });
  }

  /** Net receivable (payments minus refund reversals) for one order. */
  async orderReceivableNet(orderId: string, manager?: EntityManager): Promise<number> {
    return this.sumAmount(manager, 'order_receivable', {
      where: 'order_id = $1 AND entry_type = $2',
      params: [orderId, 'receivable'],
    });
  }

  /** Net receivable across every order for one party, regardless of settlement. */
  async partyReceivableNet(partyType: LedgerPartyType, partyId: string): Promise<number> {
    return this.sumAmount(undefined, 'party_receivable', {
      where: 'party_type = $1 AND party_id = $2 AND entry_type = $3',
      params: [partyType, partyId, 'receivable'],
    });
  }

  /** Distinct orders that ever produced a receivable for this party, newest first. */
  async orderIdsForParty(partyType: LedgerPartyType, partyId: string, limit = 500): Promise<string[]> {
    const rows: { order_id: string }[] = await this.dataSource.query(
      `SELECT DISTINCT order_id FROM financial.ledger_entries
       WHERE party_type = $1 AND party_id = $2 AND entry_type = 'receivable'
       ORDER BY order_id DESC LIMIT $3`,
      [partyType, partyId, limit],
    );
    return rows.map((r) => r.order_id);
  }

  /** Platform-wide totals. Operator-only -- the caller is responsible for the capability check. */
  async platformTotals(): Promise<{ commissionToman: number; receivableToman: number; orderCount: number }> {
    const [row]: { commission: string; receivable: string; order_count: string }[] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(amount_toman) FILTER (WHERE entry_type = 'commission'), 0) AS commission,
         COALESCE(SUM(amount_toman) FILTER (WHERE entry_type = 'receivable'), 0) AS receivable,
         COUNT(DISTINCT order_id) FILTER (WHERE reference_type = 'order_payment') AS order_count
       FROM financial.ledger_entries`,
    );
    return {
      commissionToman: Number(row.commission),
      receivableToman: Number(row.receivable),
      orderCount: Number(row.order_count),
    };
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * One multi-row INSERT ... ON CONFLICT DO NOTHING.
   *
   * Insert-first, never check-then-insert: a preceding SELECT is racy
   * against a concurrent duplicate, and the unique constraint is the real
   * guarantee anyway. Same discipline V2 settled on after a real double-fire.
   */
  private async insertEntries(manager: EntityManager, entries: NewLedgerEntry[]): Promise<number> {
    const basis = LEGACY_BASIS;
    const COLUMNS_PER_ROW = 11;

    const values: unknown[] = [];
    const placeholders: string[] = [];

    entries.forEach((entry, index) => {
      const base = index * COLUMNS_PER_ROW;
      values.push(
        uuidv7(),
        entry.orderId,
        entry.sourceId,
        entry.partyType,
        entry.partyId,
        entry.entryType,
        // BIGINT bound as a string: node-postgres would otherwise round-trip
        // a large int8 through a JS double.
        String(entry.amountToman),
        basis,
        entry.commissionRateBp,
        entry.referenceType,
        entry.referenceId,
      );
      const slots = Array.from({ length: COLUMNS_PER_ROW }, (_, i) => `$${base + i + 1}`);
      // currency is a literal: this ledger is IRT-only by design (ADR-017),
      // so it is not a per-row decision a caller could get wrong.
      placeholders.push(`(${slots.slice(0, 7).join(', ')}, 'IRT', ${slots.slice(7).join(', ')})`);
    });

    const inserted: unknown[] = await manager.query(
      `INSERT INTO financial.ledger_entries
         (id, order_id, source_id, party_type, party_id, entry_type, amount_toman,
          currency, basis, commission_rate_bp, reference_type, reference_id)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (entry_type, reference_type, reference_id) DO NOTHING
       RETURNING id`,
      values,
    );
    return Array.isArray(inserted) ? inserted.length : 0;
  }

  private async sumAmount(
    manager: EntityManager | undefined,
    _label: string,
    query: { where: string; params: unknown[] },
  ): Promise<number> {
    const runner = manager ?? this.dataSource.manager;
    const [row]: { total: string }[] = await runner.query(
      `SELECT COALESCE(SUM(amount_toman), 0) AS total FROM financial.ledger_entries WHERE ${query.where}`,
      query.params,
    );
    return Number(row.total);
  }
}

interface NewLedgerEntry {
  orderId: string;
  sourceId: string | null;
  partyType: LedgerPartyType;
  partyId: string | null;
  entryType: LedgerEntryType;
  amountToman: number;
  commissionRateBp: number;
  referenceType: LedgerReferenceType;
  referenceId: string;
}
