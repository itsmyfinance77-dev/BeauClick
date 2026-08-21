import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { currency, instant, orderSourceType, partyType, positiveToman, toman, uuid } from './common';

export const OrderCreated = defineEvent({
  name: 'OrderCreated',
  version: 1,
  aggregateType: 'order',
  producer: 'commerce',
  description: 'An order exists with a priced, itemized total. Not yet paid.',
  idempotency: 'UNIQUE(source_type, source_id) -- the structural closure of GAP-03.',
  schema: z.object({
    orderId: uuid(),
    sourceType: orderSourceType(),
    sourceId: uuid(),
    customerId: uuid(),
    sellerPartyType: partyType(),
    sellerPartyId: uuid(),
    subtotalToman: positiveToman(),
    totalToman: positiveToman(),
    currency: currency(),
  }),
});

export const OrderPaid = defineEvent({
  name: 'OrderPaid',
  version: 1,
  aggregateType: 'order',
  producer: 'commerce',
  description: 'A gateway confirmed money actually moved. Never merely "status looks paid".',
  idempotency: 'Order status CAS; financial dedupes on UNIQUE(entry_type, reference_type, reference_id).',
  schema: z.object({
    orderId: uuid(),
    sourceType: orderSourceType(),
    sourceId: uuid(),
    customerId: uuid(),
    sellerPartyType: partyType(),
    sellerPartyId: uuid(),
    totalToman: positiveToman(),
    currency: currency(),
    paidAt: instant(),
  }),
});

export const OrderCancelled = defineEvent({
  name: 'OrderCancelled',
  version: 1,
  aggregateType: 'order',
  producer: 'commerce',
  description: 'A real terminal-failure transition, not any status write.',
  idempotency: 'Status CAS on a pending order.',
  schema: z.object({
    orderId: uuid(),
    cancelledAt: instant(),
    reason: z.string().nullable(),
  }),
});

export const OrderRefunded = defineEvent({
  name: 'OrderRefunded',
  version: 1,
  aggregateType: 'order',
  producer: 'commerce',
  description: 'Money was returned against this order. Drives the ledger reversal at the ORIGINAL captured rate.',
  idempotency: 'Ledger unique constraint on (entry_type, reference_type, refundId).',
  schema: z.object({
    orderId: uuid(),
    refundId: uuid(),
    refundAmountToman: positiveToman(),
    refundedTotalToman: positiveToman(),
    currency: currency(),
    refundedAt: instant(),
  }),
});

export const COMMERCE_EVENTS = [OrderCreated, OrderPaid, OrderCancelled, OrderRefunded];

export const PaymentInitiated = defineEvent({
  name: 'PaymentInitiated',
  version: 1,
  aggregateType: 'payment',
  producer: 'payment',
  description: 'A gateway reference was created and the customer is being redirected.',
  idempotency: 'UNIQUE(provider_key, provider_reference); a live attempt is reused, never duplicated.',
  schema: z.object({
    paymentIntentId: uuid(),
    paymentAttemptId: uuid(),
    orderId: uuid(),
    provider: z.string(),
    amountToman: positiveToman(),
    currency: currency(),
  }),
});

const paymentOutcomeSchema = z.object({
  paymentIntentId: uuid(),
  paymentAttemptId: uuid(),
  orderId: uuid(),
  customerId: uuid(),
  provider: z.string(),
  amountToman: positiveToman(),
  currency: currency(),
  providerTransactionId: z.string().nullable().optional(),
  failureCode: z.string().nullable().optional(),
});

export const PaymentSucceeded = defineEvent({
  name: 'PaymentSucceeded',
  version: 1,
  aggregateType: 'payment',
  producer: 'payment',
  description: 'Server-to-server verification confirmed the charge, with the amount matching the captured intent.',
  idempotency: 'Attempt-status CAS -- exactly one callback wins.',
  schema: paymentOutcomeSchema,
});

export const PaymentFailed = defineEvent({
  name: 'PaymentFailed',
  version: 1,
  aggregateType: 'payment',
  producer: 'payment',
  description: 'Verification returned a real failure. failureCode distinguishes a decline from a tampering signal.',
  idempotency: 'Attempt-status CAS.',
  schema: paymentOutcomeSchema,
});

export const RefundCompleted = defineEvent({
  name: 'RefundCompleted',
  version: 1,
  aggregateType: 'payment',
  producer: 'payment',
  description: 'A refund settled at the gateway. Consumers MUST branch on `kind`.',
  idempotency: 'Refund-status CAS; UNIQUE(order_id, request_key) prevents a second refund for one cause.',
  schema: z.object({
    refundId: uuid(),
    paymentIntentId: uuid(),
    orderId: uuid(),
    amountToman: positiveToman(),
    // A duplicate_charge correction is NOT a refund of the order: the order
    // was legitimately paid once, and recording it as an order refund would
    // strip a commission the professional genuinely earned.
    kind: z.enum(['order', 'duplicate_charge']),
    providerRefundReference: z.string().nullable().optional(),
    completedAt: instant(),
  }),
});

export const PAYMENT_EVENTS = [PaymentInitiated, PaymentSucceeded, PaymentFailed, RefundCompleted];

export const LedgerEntriesRecorded = defineEvent({
  name: 'LedgerEntriesRecorded',
  version: 1,
  aggregateType: 'ledger',
  producer: 'financial',
  description: 'Commission + receivable (or their reversal) were written to the append-only ledger.',
  idempotency: 'UNIQUE(entry_type, reference_type, reference_id) on the ledger itself.',
  schema: z.object({
    orderId: uuid(),
    referenceType: z.enum(['order_payment', 'order_refund']),
    referenceId: uuid(),
    // Signed on purpose: a reversal carries negative parts, and clamping
    // them would make "how much was reversed" unanswerable from the event.
    commissionToman: toman(),
    receivableToman: toman(),
    commissionRateBp: z.number().int().nonnegative(),
    // Absent on the refund path, where the party is already fixed by the
    // original entry being reversed.
    sellerPartyType: partyType().optional(),
    sellerPartyId: uuid().optional(),
  }),
});

export const SettlementRecorded = defineEvent({
  name: 'SettlementRecorded',
  version: 1,
  aggregateType: 'settlement',
  producer: 'financial',
  description: 'An operator settled specific orders in full at the system-computed amount.',
  idempotency: 'Append-only batch; the per-order outstanding recheck inside the transaction is the real guard.',
  schema: z.object({
    settlementId: uuid(),
    partyType: partyType(),
    partyId: uuid(),
    amountToman: toman(),
    orderCount: z.number().int().nonnegative(),
    method: z.string(),
  }),
});

export const SettlementReversed = defineEvent({
  name: 'SettlementReversed',
  version: 1,
  aggregateType: 'settlement',
  producer: 'financial',
  description: 'A settlement was reversed by a NEW mirrored row -- never by mutating the original.',
  idempotency: 'UNIQUE(reverses_settlement_id).',
  schema: z.object({
    settlementId: uuid(),
    reversesSettlementId: uuid(),
    partyType: partyType(),
    partyId: uuid(),
    amountToman: toman(),
    reason: z.string().nullable(),
  }),
});

export const FINANCIAL_EVENTS = [LedgerEntriesRecorded, SettlementRecorded, SettlementReversed];
