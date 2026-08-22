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
import { FinancialConfig } from './financial.config';
import { FINANCIAL_DATA_SOURCE } from './ports';

export interface RecordPaymentInput {
  orderId: string;
  sourceId: string | null;
  sellerPartyType: 'professional' | 'business';
  sellerPartyId: string;
  /** The real amount the customer paid -- already discounted. The figure platform and seller actually split. */
  netAmountToman: number;
  /** The payment intent id. Becomes the ledger reference, and therefore the idempotency key. */
  paymentReferenceId: string;
}

export interface RecordRefundInput {
  orderId: string;
  refundId: string;
  refundAmountToman: number;
}

/**
 * Sole owner of `financial.ledger_entries`.
 *
 * Runs on its own `DataSource` -- a connection whose PostgreSQL role holds
 * INSERT + SELECT and nothing else on this schema. This class could not
 * update or delete a ledger row if it tried; the database would refuse.
 */
@Injectable()
export class LedgerService {
  private readonly auditLog = new AuditLogger('financial');

  constructor(
    @Inject(FINANCIAL_DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly config: FinancialConfig,
  ) {}

  /**
   * Records the commission + receivable pair for a real, confirmed payment.
   *
   * **Idempotent by a real database constraint**, not by a preceding SELECT:
   * `UNIQUE(entry_type, reference_type, reference_id)` with an
   * ON CONFLICT DO NOTHING insert. V2's version of this constraint is the
   * single strongest idempotency guarantee found anywhere in that codebase
   * -- confirmed to have absorbed a real double-fire in production-
   * equivalent testing -- and it is carried over verbatim in shape.
   *
   * The two amounts are produced by `splitExact`, so they always sum to
   * exactly the net amount. Computing them as two independent roundings is
   * how a ledger ends up a Toman short of the money that actually moved.
   *
   * @returns true if this call newly recorded the pair; false if it was
   *          already recorded -- a normal idempotent no-op, never an error.
   */
  async recordPayment(input: RecordPaymentInput): Promise<boolean> {
    assertNonNegativeAmount(input.netAmountToman, 'net payment amount');
    if (input.netAmountToman === 0) return false;

    const rateBp = this.config.commissionRateBp();
    const { part: commissionToman, remainder: receivableToman } = splitExact(input.netAmountToman, rateBp);

    return this.dataSource.transaction(async (manager) => {
      const inserted = await this.insertEntries(manager, [
        {
          orderId: input.orderId,
          sourceId: input.sourceId,
          partyType: 'platform',
          partyId: null,
          entryType: 'commission',
          amountToman: commissionToman,
          commissionRateBp: rateBp,
          referenceType: 'order_payment',
          referenceId: input.paymentReferenceId,
        },
        {
          orderId: input.orderId,
          sourceId: input.sourceId,
          partyType: input.sellerPartyType,
          partyId: input.sellerPartyId,
          entryType: 'receivable',
          amountToman: receivableToman,
          commissionRateBp: rateBp,
          referenceType: 'order_payment',
          referenceId: input.paymentReferenceId,
        },
      ]);

      if (inserted === 0) return false;

      await emitEvent(manager, FinancialOutboxEntity, {
        aggregateType: 'ledger',
        aggregateId: input.orderId,
        eventType: 'LedgerEntriesRecorded',
        payload: {
          orderId: input.orderId,
          referenceType: 'order_payment',
          referenceId: input.paymentReferenceId,
          commissionToman,
          receivableToman,
          commissionRateBp: rateBp,
          sellerPartyType: input.sellerPartyType,
          sellerPartyId: input.sellerPartyId,
        },
      });

      this.auditLog.log({
        action: 'ledger.payment_recorded',
        orderId: input.orderId,
        commissionToman,
        receivableToman,
        commissionRateBp: rateBp,
      });
      return true;
    });
  }

  /**
   * Records the negative reversal pair for a refund.
   *
   * **Reuses the ORIGINAL entry's captured commission rate, never the
   * platform's current rate.** A refund therefore reverses exactly the
   * proportion it originally recorded, immune to a rate change made in
   * between. This is V2's single most important financial rule and it
   * transfers unchanged.
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

    const originals = await this.dataSource.getRepository(LedgerEntryEntity).find({
      where: { orderId: input.orderId, referenceType: 'order_payment' },
    });
    const originalCommission = originals.find((e) => e.entryType === 'commission');
    const originalReceivable = originals.find((e) => e.entryType === 'receivable');

    if (!originalCommission || !originalReceivable) {
      // No payment was ever recorded for this order (a refund racing ahead of
      // the payment record, or an order with no seller party). Nothing to
      // reverse -- and inventing a reversal would fabricate a financial fact.
      this.auditLog.warn({ action: 'ledger.refund_without_payment', orderId: input.orderId, refundId: input.refundId });
      return false;
    }

    const rateBp = originalCommission.commissionRateBp;
    const { part: commissionPart, remainder: receivablePart } = splitExact(-input.refundAmountToman, rateBp);

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
    const basis = this.config.basis();
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
