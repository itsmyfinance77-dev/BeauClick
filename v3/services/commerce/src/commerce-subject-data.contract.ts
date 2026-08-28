import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { OrderEntity } from './entities/order.entity';

/**
 * commerce's subject-data contract.
 *
 * Exported in full to the subject, and erased not at all.
 *
 * An order is a commercial transaction record. `V3.1_PRODUCT_ROADMAP.md` §9 is
 * explicit that erasure is anonymization rather than deletion precisely
 * because of this class of row: the ledger references orders, the ledger is
 * append-only by database role, and a deleted order would leave financial
 * entries pointing at nothing. Once `identity.users` is anonymized,
 * `orders.customer_id` names nobody -- which is the outcome erasure is for.
 *
 * There is no free text anywhere in this schema. Order items carry a service
 * NAME copied at purchase time, and adjustments carry a rule label; neither is
 * written by the customer, and both are needed to make an old order legible.
 */
@Injectable()
export class CommerceSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'commerce';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'commerce.orders',
      disposition: 'retained',
      reason:
        'A commercial transaction record referenced by the append-only ledger. Anonymous once the identity behind customer_id is destroyed.',
    },
    {
      table: 'commerce.order_items',
      disposition: 'retained',
      reason: 'Line items of a retained order. Carries a service name and price, never anything the customer wrote.',
    },
    {
      table: 'commerce.order_adjustments',
      disposition: 'retained',
      reason: 'Discounts and fees applied to a retained order, by rule key. No subject appears in it.',
    },
    {
      table: 'commerce.outbox_events',
      disposition: 'retained',
      reason: 'Transactional outbox.',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const orders = await manager.getRepository(OrderEntity).find({
      where: { customerId: userId },
      order: { createdAt: 'DESC' },
    });

    const orderIds = orders.map((o) => o.id);
    const items = orderIds.length
      ? await manager.query(
          `SELECT id, order_id, item_type, name, quantity, unit_price_toman, line_total_toman
             FROM commerce.order_items WHERE order_id = ANY($1::uuid[]) ORDER BY order_id`,
          [orderIds],
        )
      : [];
    const adjustments = orderIds.length
      ? await manager.query(
          `SELECT id, order_id, rule_key, kind, code, label, amount_toman
             FROM commerce.order_adjustments WHERE order_id = ANY($1::uuid[]) ORDER BY order_id`,
          [orderIds],
        )
      : [];

    return [
      {
        key: 'orders',
        description: 'سفارش‌های شما',
        rows: orders.map((o) => ({
          id: o.id,
          sourceType: o.sourceType,
          sourceId: o.sourceId,
          status: o.status,
          currency: o.currency,
          subtotalToman: o.subtotalToman,
          discountTotalToman: o.discountTotalToman,
          feeTotalToman: o.feeTotalToman,
          totalToman: o.totalToman,
          refundedTotalToman: o.refundedTotalToman,
          paidAt: o.paidAt,
          cancelledAt: o.cancelledAt,
          createdAt: o.createdAt,
        })),
      },
      { key: 'order_items', description: 'اقلام سفارش‌های شما', rows: items as Array<Record<string, unknown>> },
      {
        key: 'order_adjustments',
        description: 'تخفیف‌ها و کارمزدهای سفارش‌های شما',
        rows: adjustments as Array<Record<string, unknown>>,
      },
    ];
  }

  /**
   * Nothing to do, and that is a real answer rather than a stub.
   *
   * The claim list above is what proves this module was reached and considered
   * -- a module that had been forgotten would not appear in the report at all,
   * and the boot assertion would have refused to start.
   */
  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: [
        {
          table: 'commerce.orders',
          reason: 'transaction records referenced by the append-only ledger',
        },
      ],
    };
  }
}
