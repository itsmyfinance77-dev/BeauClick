import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent, AuditLogger } from '@beauclick/events';
import { DomainException } from '@beauclick/http';

import { LedgerPartyType } from './entities/ledger-entry.entity';
import { SettlementBatchEntity, SettlementItemEntity } from './entities/settlement.entity';
import { FinancialOutboxEntity } from './entities/financial-outbox.entity';
import { LedgerService } from './ledger.service';
import { FundJournalService } from './fund-journal.service';
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
  private readonly auditLog = new AuditLogger('settlement');

  constructor(
    @Inject(FINANCIAL_DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly fundJournal: FundJournalService,
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

  /**
   * `#43a` (ADR-052 §16): `receivableNetToman = legacy receivable + new-regime
   * (available + reserve + settled)`; `settledToman = legacy + new-regime
   * settled`. The nine (now ten) existing shapes are unchanged; what changed
   * is that they now ALSO read the new regime -- always zero today, since
   * `#43a` never populates `available`/`reserve`/`settled` (`release`,
   * `#43c`, is the only journal kind that does), but the formula is real now
   * rather than a documented intention to add it later.
   */
  async partySummary(partyType: LedgerPartyType, partyId: string): Promise<PartySummary> {
    const legacyReceivableNet = await this.ledger.partyReceivableNet(partyType, partyId);
    const [row]: { total: string }[] = await this.dataSource.query(
      `SELECT COALESCE(SUM(amount_toman), 0) AS total
       FROM financial.settlement_batches WHERE party_type = $1 AND party_id = $2`,
      [partyType, partyId],
    );
    const legacySettled = Number(row.total);

    const newRegimeStates =
      partyType === 'platform' ? {} : await this.fundJournal.statesForParty(partyType, partyId);
    const newRegimeAvailable = newRegimeStates.available ?? 0;
    const newRegimeReserve = newRegimeStates.reserve ?? 0;
    const newRegimeSettled = newRegimeStates.settled ?? 0;

    const receivableNetToman = legacyReceivableNet + newRegimeAvailable + newRegimeReserve + newRegimeSettled;
    const settledToman = legacySettled + newRegimeSettled;
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

  /**
   * One keyset page of a party's settlements, newest first — V3.3 #72.
   *
   * `settlementsForParty` above returns a party's ENTIRE settlement history
   * unbounded, and stays that way so the legacy singular route's response is
   * byte-for-byte what it was. The workspace-aware route uses this instead.
   *
   * Keyset rather than offset, on `id DESC`: settlement batch ids are uuidv7,
   * so `id` orders by creation time, and a page taken while a new settlement
   * lands neither skips nor repeats a row the way `OFFSET` would.
   * `ix_settlement_batches_party (party_type, party_id, id DESC)` already
   * covers exactly this, so no migration and no new index were needed.
   *
   * The party predicate is always present. `after` narrows a page WITHIN one
   * party; it never selects one.
   */
  async settlementPageForParty(
    partyType: LedgerPartyType,
    partyId: string,
    after: string | null,
    limit: number,
  ): Promise<SettlementBatchEntity[]> {
    const query = this.dataSource
      .getRepository(SettlementBatchEntity)
      .createQueryBuilder('b')
      .where('b.party_type = :partyType', { partyType })
      .andWhere('b.party_id = :partyId', { partyId })
      .orderBy('b.id', 'DESC')
      .limit(limit);

    if (after) query.andWhere('b.id < :after', { after });

    return query.getMany();
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
   * Immediate, full manual settlement -- refused for good, at the SERVICE
   * level (ADR-052 §8, §16; `V33-DEC-040` R4, R8; a `#43a` acceptance
   * criterion). "Immediately, in full" is exactly the settlement the owner
   * rejected: R4 requires money to reach `available` only on an explicit
   * completion-and-closed-window fact, then settle on an ADMINISTRATOR-
   * PUBLISHED schedule; `#43d`/`#43e` own publishing and executing that
   * schedule, and neither exists yet. R8's fail-closed rule applies to the
   * SAME absence: with no published schedule policy, no settlement batch is
   * proposable, so THIS route -- which never reads a schedule at all -- must
   * refuse unconditionally rather than propose one anyway.
   *
   * Refusing here, in the service, rather than only at the controller or
   * only by removing the route, is what "no caller bypasses it" means: any
   * future caller of this method -- a new controller, a script, a different
   * capability grant -- gets the identical refusal, because the method
   * itself carries no settlement logic left to reach.
   *
   * `reverseSettlement` below is UNCHANGED and still works: ADR-052 §8 is
   * explicit that reversing an EXISTING batch is not the immediate-route
   * behaviour it rejects -- a reversal returns money that was already
   * settled through a route this platform no longer offers, and refusing it
   * too would strand every batch settled before this deploy.
   */
  async createSettlement(_input: CreateSettlementInput): Promise<SettlementBatchEntity> {
    throw new SettlementRejectedException(
      'تسویه فوری غیرفعال است: زمان‌بندی تسویه هنوز منتشر نشده است.',
      { reason: 'settlement_schedule_unpublished' },
    );
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
