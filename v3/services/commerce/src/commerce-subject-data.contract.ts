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
      /*
       * V3.3 `#41a` (ADR-043 §10). `retained`, and the absence of a `_user_id`
       * column is NOT the reason it could have been `no_subject_data`.
       *
       * The row is part of an immutable transaction record reachable through a
       * retained order, and a subject's exported receipt is incomplete without
       * the amounts they actually agreed to. Same obligation as the order
       * itself, so the same disposition.
       */
      table: 'commerce.order_payment_schedules',
      disposition: 'retained',
      reason:
        'The immutable collection schedule of a retained order: what the service cost, what BeauClick collected online, and what was payable at the venue. Part of the same commercial record as the order.',
    },
    {
      /*
       * V3.3 #159 (`#42b`), ADR-051 §10. `subject_data` via the order, although
       * the table carries no `_user_id` column — the precedent is
       * `booking.booking_resource_assignments`. The terms a customer accepted,
       * and when, are part of their own order: exported with it, and reported
       * retained on erasure for the order's own reason. Pinned by test, because
       * the coverage heuristic cannot see a subject through a join.
       */
      table: 'commerce.order_outcome_terms',
      disposition: 'subject_data',
    },
    {
      /*
       * V3.3 #160 (`#42c`), ADR-051 §10. `retained`: a financial decision about
       * a retained order must survive erasure, for the ledger's reason. The
       * table carries no subject-shaped column, so the coverage heuristic would
       * ALSO accept a dishonest `no_subject_data` claim here — which is why this
       * claim and its reason are pinned by test rather than left to the boot
       * assertion. Exported to the customer as their own amounts and instants.
       */
      table: 'commerce.booking_outcome_decisions',
      disposition: 'retained',
      reason:
        'The closed decision about what happened to the money collected for a retained order when its booking was cancelled or rescheduled. A financial fact that must survive erasure; it holds no identifying content of its own.',
    },
    {
      /*
       * V3.3 #161 (`#42d`), ADR-051 §10. `retained`, same reasoning as
       * `commerce.booking_outcome_decisions` above: the customer's remedy
       * resolution is a financial fact that must survive erasure. Exported to
       * the customer as their own choice and instants, never the reviewer or
       * seller id (there is none on this table).
       */
      table: 'commerce.customer_remedy_choices',
      disposition: 'retained',
      reason:
        'The customer\'s remedy after a seller/platform/provider cancellation and its resolution. A financial fact that must survive erasure; it holds no identifying content of its own.',
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
    // V3.3 `#41a`. Batched by order id like the two above -- an export of a
    // customer with many orders must not become one query per order.
    const schedules = orderIds.length
      ? await manager.query(
          `SELECT order_id, collection_mode, service_total_toman, platform_collectible_toman,
                  venue_balance_toman, created_at
             FROM commerce.order_payment_schedules WHERE order_id = ANY($1::uuid[]) ORDER BY order_id`,
          [orderIds],
        )
      : [];
    /*
     * V3.3 #159. The outcome terms the customer accepted, batched like the
     * sections above. What they were shown and agreed to — never the legal
     * evidence reference, the cap internals or the case-file retention period,
     * which the disclosure never showed either, and never the seller's id.
     * `accepted_at` is `resolved_at`, equal to the schedule's acceptance
     * instant by constraint.
     */
    const outcomeTerms = orderIds.length
      ? await manager.query(
          `SELECT order_id, policy_key, policy_version, copy_key, copy_version,
                  cutoff_hours, late_retention_kind, late_retention_basis_points, late_retention_amount_toman,
                  grace_minutes, no_show_retention_kind, no_show_retention_basis_points, no_show_retention_amount_toman,
                  reschedule_free_count, dispute_window_hours, bodily_harm_window_hours, appeal_window_hours,
                  resolved_at AS accepted_at
             FROM commerce.order_outcome_terms WHERE order_id = ANY($1::uuid[]) ORDER BY order_id`,
          [orderIds],
        )
      : [];
    /*
     * V3.3 #160 (`#42c`). The subject's own decisions: what was retained and
     * refunded, and the instants that decided it. Never the policy amount, the
     * Legal cap, its state, the basis or the request key — none of which the
     * customer was shown as a figure, and the cap never reaches a customer.
     */
    const outcomeDecisions = orderIds.length
      ? await manager.query(
          `SELECT order_id, decision_kind, event_instant, decided_at, timely, cutoff_instant,
                  collected_remaining_toman, retained_toman, refund_toman, execution_status
             FROM commerce.booking_outcome_decisions WHERE order_id = ANY($1::uuid[]) ORDER BY order_id, decided_at`,
          [orderIds],
        )
      : [];
    // V3.3 #161 (`#42d`). The subject's own remedy resolution: what was
    // offered, what they chose (if anything) and when. Never the fact that
    // it was a `professional`/`platform`/`provider` cancellation -- the
    // linked decision above already carries the cancellation's own facts.
    const remedyChoices = orderIds.length
      ? await manager.query(
          `SELECT order_id, offered_at, options, chosen, chosen_at, resolved_by, resolved_at
             FROM commerce.customer_remedy_choices WHERE order_id = ANY($1::uuid[]) ORDER BY order_id`,
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
          // V3.3 #82. The customer's own money fact: what BeauClick actually
          // collected from them. A server-derived integer on a row already
          // claimed for this subject -- it names no counterparty and exposes no
          // catalogue or policy internal.
          collectedTotalToman: o.collectedTotalToman,
          paidAt: o.paidAt,
          cancelledAt: o.cancelledAt,
          createdAt: o.createdAt,
        })),
      },
      { key: 'order_items', description: 'اقلام سفارش‌های شما', rows: items as Array<Record<string, unknown>> },
      {
        /*
         * The policy reference is deliberately not exported. Which published
         * terms produced these amounts is an administrative fact; what the
         * subject is entitled to is what they were charged and what remained
         * payable at the venue.
         */
        key: 'order_payment_schedules',
        description: 'تفکیک پرداخت سفارش‌های شما',
        rows: schedules as Array<Record<string, unknown>>,
      },
      {
        key: 'order_adjustments',
        description: 'تخفیف‌ها و کارمزدهای سفارش‌های شما',
        rows: adjustments as Array<Record<string, unknown>>,
      },
      {
        key: 'order_outcome_terms',
        description: 'شرایط لغو و عدم حضوری که هنگام رزرو پذیرفته‌اید',
        rows: outcomeTerms as Array<Record<string, unknown>>,
      },
      {
        key: 'booking_outcome_decisions',
        description: 'تصمیم‌های مالی لغو و تغییر زمان رزروهای شما',
        rows: outcomeDecisions as Array<Record<string, unknown>>,
      },
      {
        key: 'customer_remedy_choices',
        description: 'گزینه‌ی جبران انتخابی شما پس از لغو رزرو',
        rows: remedyChoices as Array<Record<string, unknown>>,
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
        {
          table: 'commerce.order_outcome_terms',
          reason: 'the accepted terms of a retained order; append-only and carrying no identifying content of their own',
        },
        {
          table: 'commerce.booking_outcome_decisions',
          reason: 'financial decisions about a retained order; permanent and carrying no identifying content of their own',
        },
        {
          table: 'commerce.customer_remedy_choices',
          reason: 'the customer\'s remedy resolution for a retained order; permanent and carrying no identifying content of its own',
        },
      ],
    };
  }
}
