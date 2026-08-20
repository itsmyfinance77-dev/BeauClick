import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent } from '@beauclick/events';
import { DomainException } from '@beauclick/http';
import { sumAmounts } from '@beauclick/money';

import { LedgerPartyType } from './entities/ledger-entry.entity';
import { SettlementBatchEntity, SettlementItemEntity } from './entities/settlement.entity';
import { FinancialOutboxEntity } from './entities/financial-outbox.entity';
import { LedgerService } from './ledger.service';
import { FINANCIAL_DATA_SOURCE } from './ports';

export class SettlementRejectedException extends DomainException {
  constructor(message: string, detail?: unknown) {
    super('SETTLEMENT_REJECTED', message, HttpStatus.CONFLICT, detail);
  }
}

export interface PartySummary {
  partyType: LedgerPartyType;
  partyId: string;
  receivableNetToman: number;
  settledToman: number;
  outstandingToman: number;
}

export interface OutstandingOrder {
  orderId: string;
  outstandingToman: number;
}

export interface CreateSettlementInput {
  partyType: 'professional' | 'business';
  partyId: string;
  orderIds: string[];
  method: string | null;
  reference: string | null;
  note: string | null;
  actorId: string;
}

/**
 * Owns `financial.settlement_batches` / `financial.settlement_items`.
 *
 * A settlement RECORDS that a real, external transfer already happened. This
 * class never moves money, never calls a bank, and never writes to the
 * ledger -- it only reads receivable facts and records payouts against them.
 *
 * The Phase 2 model, matching V2's deliberate middle ground: an operator
 * settles one or more SPECIFIC orders, each in FULL, at the exact outstanding
 * amount the system computes. Never a free-typed figure an operator could
 * fat-finger into disagreeing with any real financial fact, and never a lump
 * sum, which would make per-order traceability impossible.
 */
@Injectable()
export class SettlementService {
  private readonly auditLog = new Logger('AUDIT:settlement');

  constructor(
    @Inject(FINANCIAL_DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * What is still owed on one order.
   *
   * Always computed fresh from the ledger and the settlement items, never
   * cached or stored. **It can legitimately be negative** -- a refund that
   * lands after a full settlement means the seller was paid more than they
   * ended up earning. That is an honest fact the platform needs to see and
   * act on; clamping it to zero would silently hide real money owed back.
   */
  async outstandingForOrder(orderId: string): Promise<number> {
    const receivableNet = await this.ledger.orderReceivableNet(orderId);
    const settled = await this.settledForOrder(orderId);
    return receivableNet - settled;
  }

  /**
   * Sum of every settlement item for this order.
   *
   * One `SUM` with no status filter and no join, because reversals are
   * negative rows rather than a status flip. That is the concrete payoff of
   * making settlements append-only: there is no "which batches still count?"
   * predicate to get wrong.
   */
  private async settledForOrder(orderId: string): Promise<number> {
    const [row]: { total: string }[] = await this.dataSource.query(
      `SELECT COALESCE(SUM(amount_toman), 0) AS total FROM financial.settlement_items WHERE order_id = $1`,
      [orderId],
    );
    return Number(row.total);
  }

  async partySummary(partyType: LedgerPartyType, partyId: string): Promise<PartySummary> {
    const receivableNetToman = await this.ledger.partyReceivableNet(partyType, partyId);
    const [row]: { total: string }[] = await this.dataSource.query(
      `SELECT COALESCE(SUM(amount_toman), 0) AS total
       FROM financial.settlement_batches WHERE party_type = $1 AND party_id = $2`,
      [partyType, partyId],
    );
    const settledToman = Number(row.total);
    return {
      partyType,
      partyId,
      receivableNetToman,
      settledToman,
      outstandingToman: receivableNetToman - settledToman,
    };
  }

  /** Only orders with a genuinely positive outstanding amount -- what an operator can actually settle. */
  async outstandingOrdersForParty(partyType: LedgerPartyType, partyId: string): Promise<OutstandingOrder[]> {
    // One grouped query rather than a per-order loop. V2 iterated
    // `order_ids_for_party()` and called `outstanding_for_order()` per id --
    // a textbook N+1 that grows with a party's entire trading history.
    const rows: { order_id: string; outstanding: string }[] = await this.dataSource.query(
      `SELECT l.order_id,
              COALESCE(SUM(l.amount_toman), 0) - COALESCE((
                SELECT SUM(si.amount_toman) FROM financial.settlement_items si WHERE si.order_id = l.order_id
              ), 0) AS outstanding
         FROM financial.ledger_entries l
        WHERE l.party_type = $1 AND l.party_id = $2 AND l.entry_type = 'receivable'
        GROUP BY l.order_id
       HAVING COALESCE(SUM(l.amount_toman), 0) - COALESCE((
                SELECT SUM(si.amount_toman) FROM financial.settlement_items si WHERE si.order_id = l.order_id
              ), 0) > 0
        ORDER BY l.order_id DESC`,
      [partyType, partyId],
    );
    return rows.map((r) => ({ orderId: r.order_id, outstandingToman: Number(r.outstanding) }));
  }

  async settlementsForParty(partyType: LedgerPartyType, partyId: string): Promise<SettlementBatchEntity[]> {
    return this.dataSource.getRepository(SettlementBatchEntity).find({
      where: { partyType, partyId },
      order: { id: 'DESC' },
    });
  }

  async itemsFor(settlementId: string): Promise<SettlementItemEntity[]> {
    return this.dataSource.getRepository(SettlementItemEntity).find({
      where: { settlementId },
      order: { id: 'ASC' },
    });
  }

  async findSettlement(settlementId: string): Promise<SettlementBatchEntity | null> {
    return this.dataSource.getRepository(SettlementBatchEntity).findOne({ where: { id: settlementId } });
  }

  /**
   * Records a payout covering specific orders.
   *
   * Every order's outstanding amount is re-read INSIDE the transaction,
   * immediately before writing. That re-read -- not the operator's UI
   * selection, which is advisory only -- is the real guard against settling
   * an order twice or above its outstanding amount.
   *
   * Ownership is re-verified per order too: an order's receivable must
   * genuinely belong to the party being settled. A caller-supplied order id
   * list is never trusted on its own.
   */
  async createSettlement(input: CreateSettlementInput): Promise<SettlementBatchEntity> {
    if (input.orderIds.length === 0) {
      throw new SettlementRejectedException('حداقل یک سفارش باید انتخاب شود.');
    }

    const uniqueOrderIds = Array.from(new Set(input.orderIds));

    return this.dataSource.transaction(async (manager) => {
      const eligible = await this.outstandingOrdersForParty(input.partyType, input.partyId);
      const byOrderId = new Map(eligible.map((o) => [o.orderId, o.outstandingToman]));

      const items = uniqueOrderIds.map((orderId) => {
        const outstanding = byOrderId.get(orderId);
        if (outstanding === undefined) {
          // Covers both "not this party's order" and "nothing outstanding"
          // with one message -- an operator has no need to distinguish them,
          // and separate messages would let a caller probe which orders
          // belong to which party.
          throw new SettlementRejectedException(`سفارش ${orderId} برای این طرف حساب قابل تسویه نیست.`, { orderId });
        }
        return { orderId, amountToman: outstanding };
      });

      const totalToman = sumAmounts(items.map((i) => i.amountToman));
      const settlementId = uuidv7();

      await manager.insert(SettlementBatchEntity, {
        id: settlementId,
        kind: 'settlement',
        reversesSettlementId: null,
        partyType: input.partyType,
        partyId: input.partyId,
        amountToman: totalToman,
        currency: 'IRT',
        method: input.method,
        reference: input.reference,
        note: input.note,
        createdBy: input.actorId,
      });

      await manager.insert(
        SettlementItemEntity,
        items.map((item) => ({
          id: uuidv7(),
          settlementId,
          orderId: item.orderId,
          amountToman: item.amountToman,
        })),
      );

      await emitEvent(manager, FinancialOutboxEntity, {
        aggregateType: 'settlement',
        aggregateId: settlementId,
        eventType: 'SettlementRecorded',
        payload: {
          settlementId,
          partyType: input.partyType,
          partyId: input.partyId,
          amountToman: totalToman,
          orderCount: items.length,
          method: input.method,
        },
      });

      this.auditLog.log({
        action: 'settlement.created',
        settlementId,
        partyType: input.partyType,
        partyId: input.partyId,
        amountToman: totalToman,
        orderCount: items.length,
        actorId: input.actorId,
      });

      return manager.findOneOrFail(SettlementBatchEntity, { where: { id: settlementId } });
    });
  }

  /**
   * Reverses a settlement by writing a NEW, mirrored negative batch.
   *
   * Non-destructive: the original batch and its items remain exactly as
   * recorded, forever. `uq_settlement_batches_reversal` (a partial UNIQUE on
   * `reverses_settlement_id`) makes a double reversal impossible at the
   * database level, so a retried operator action cannot un-settle twice.
   */
  async reverseSettlement(settlementId: string, actorId: string, reason: string): Promise<SettlementBatchEntity> {
    const original = await this.findSettlement(settlementId);
    if (!original) throw new SettlementRejectedException('تسویه پیدا نشد.');
    if (original.kind !== 'settlement') throw new SettlementRejectedException('این ردیف خودش یک برگشت است.');

    const items = await this.itemsFor(settlementId);
    const reversalId = uuidv7();

    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.insert(SettlementBatchEntity, {
          id: reversalId,
          kind: 'reversal',
          reversesSettlementId: settlementId,
          partyType: original.partyType,
          partyId: original.partyId,
          amountToman: -original.amountToman,
          currency: original.currency,
          method: original.method,
          reference: original.reference,
          note: reason,
          createdBy: actorId,
        });

        if (items.length > 0) {
          await manager.insert(
            SettlementItemEntity,
            items.map((item) => ({
              id: uuidv7(),
              settlementId: reversalId,
              orderId: item.orderId,
              amountToman: -item.amountToman,
            })),
          );
        }

        await emitEvent(manager, FinancialOutboxEntity, {
          aggregateType: 'settlement',
          aggregateId: reversalId,
          eventType: 'SettlementReversed',
          payload: {
            settlementId: reversalId,
            reversesSettlementId: settlementId,
            partyType: original.partyType,
            partyId: original.partyId,
            amountToman: -original.amountToman,
            reason,
          },
        });

        this.auditLog.log({ action: 'settlement.reversed', settlementId, reversalId, actorId, reason });
        return manager.findOneOrFail(SettlementBatchEntity, { where: { id: reversalId } });
      });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === '23505') {
        throw new SettlementRejectedException('این تسویه قبلاً برگشت خورده است.');
      }
      throw err;
    }
  }
}
