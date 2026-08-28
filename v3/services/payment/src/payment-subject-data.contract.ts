import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { PaymentIntentEntity } from './entities/payment-intent.entity';

/**
 * payment's subject-data contract.
 *
 * ONE THING IS DELIBERATELY WITHHELD FROM THE EXPORT: `payment_attempts.
 * provider_response`, the raw snapshot a gateway returned. It is not the
 * subject's data in any useful sense -- it is a vendor's diagnostic blob, its
 * shape differs per provider, and it is exactly the kind of field that
 * routinely carries a masked card number, an acquirer's internal customer
 * reference, or a merchant identifier belonging to somebody else. Everything a
 * subject actually needs about a payment -- amount, status, when, whether it
 * succeeded, why it failed -- is exported as typed columns.
 *
 * Nothing is erased. A payment record is the counterpart of the order and the
 * ledger entry, and the same argument applies unchanged.
 */
@Injectable()
export class PaymentSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'payment';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'payment.payment_intents',
      disposition: 'retained',
      reason: 'The payment counterpart of a retained order. Anonymous once the identity behind customer_id is destroyed.',
    },
    {
      table: 'payment.payment_attempts',
      disposition: 'retained',
      reason: 'Gateway attempts against a retained intent. Keyed by intent, never by a person.',
    },
    {
      table: 'payment.refunds',
      disposition: 'retained',
      reason: 'Refund records reconciled against the append-only ledger.',
    },
    {
      table: 'payment.sandbox_transactions',
      disposition: 'no_subject_data',
      reason:
        'The sandbox gateway\'s own transaction store. Reference, amount, and outcome; no party id and no contact detail (see ADR-006 and the sandbox gate).',
    },
    {
      table: 'payment.outbox_events',
      disposition: 'retained',
      reason: 'Transactional outbox.',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const intents = await manager.getRepository(PaymentIntentEntity).find({
      where: { customerId: userId },
      order: { createdAt: 'DESC' },
    });

    const intentIds = intents.map((i) => i.id);
    const attempts = intentIds.length
      ? await manager.query(
          `SELECT id, payment_intent_id, provider_key, status, requested_amount_toman,
                  verified_amount_toman, failure_code, verified_at, created_at
             FROM payment.payment_attempts
            WHERE payment_intent_id = ANY($1::uuid[])
            ORDER BY created_at DESC`,
          [intentIds],
        )
      : [];
    const refunds = intentIds.length
      ? await manager.query(
          `SELECT id, order_id, payment_intent_id, amount_toman, status, kind, reason, completed_at, created_at
             FROM payment.refunds
            WHERE payment_intent_id = ANY($1::uuid[])
            ORDER BY created_at DESC`,
          [intentIds],
        )
      : [];

    return [
      {
        key: 'payment_intents',
        description: 'پرداخت‌های شما',
        rows: intents.map((i) => ({
          id: i.id,
          orderId: i.orderId,
          amountToman: i.amountToman,
          currency: i.currency,
          status: i.status,
          providerKey: i.providerKey,
          succeededAt: i.succeededAt,
          failureCode: i.failureCode,
          createdAt: i.createdAt,
        })),
      },
      { key: 'payment_attempts', description: 'تلاش‌های پرداخت', rows: attempts as Array<Record<string, unknown>> },
      { key: 'refunds', description: 'بازپرداخت‌های شما', rows: refunds as Array<Record<string, unknown>> },
    ];
  }

  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: [
        { table: 'payment.payment_intents', reason: 'financial records reconciled against the append-only ledger' },
      ],
    };
  }
}
