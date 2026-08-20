import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';

import {
  InitiatePaymentRequest,
  InitiatePaymentResult,
  PaymentProvider,
  RefundPaymentRequest,
  RefundPaymentResult,
  VerifyPaymentRequest,
  VerifyPaymentResult,
} from './payment-provider.interface';
import { MockGatewayTransactionEntity } from '../entities/mock-gateway-transaction.entity';

export const MOCK_GATEWAY_KEY = 'mock';

/**
 * A local stand-in for a real Iranian gateway, so the entire
 * initiate -> redirect -> callback -> verify -> settle loop is exercisable
 * end to end without credentials (there are none -- GAP-06 remains open).
 *
 * **It is a real simulation, not a shortcut.** `verify()` performs a genuine
 * server-side lookup against the mock gateway's own table and reports the
 * amount THAT table holds. It never reads the callback parameters to decide
 * the outcome. That distinction is what makes the callback-security tests
 * meaningful: a forged success callback fails here for the same structural
 * reason it would fail against ZarinPal.
 *
 * **Production gate, closed by default.** V2 shipped a dev-only
 * Cash-on-Delivery stand-in whose "local development only" status was UI
 * text with no mechanism behind it -- a production activation could silently
 * enable an unauthenticated "payment succeeded" path. That was caught in a
 * V2 readiness audit and fixed with an environment gate; the same gate is
 * built in here from the start, and it fails CLOSED: `NODE_ENV=production`
 * disables this provider unless someone explicitly sets
 * `PAYMENT_ALLOW_MOCK_GATEWAY=true`.
 */
@Injectable()
export class MockGatewayProvider implements PaymentProvider {
  readonly key = MOCK_GATEWAY_KEY;
  readonly displayName = 'درگاه آزمایشی محلی';
  readonly supportsAutomaticRefund = true;

  private readonly logger = new Logger('MockGatewayProvider');

  constructor(
    @InjectRepository(MockGatewayTransactionEntity)
    private readonly transactions: Repository<MockGatewayTransactionEntity>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether this provider may be used at all in the current environment.
   * Checked by the registry at resolution time, not merely at boot, so a
   * configuration change cannot leave a stale permissive decision cached.
   */
  isEnabled(): boolean {
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? 'development';
    if (nodeEnv !== 'production') return true;
    return String(this.config.get('PAYMENT_ALLOW_MOCK_GATEWAY') ?? '').toLowerCase() === 'true';
  }

  async initiate(request: InitiatePaymentRequest): Promise<InitiatePaymentResult> {
    const reference = `MOCK-${randomBytes(12).toString('hex').toUpperCase()}`;

    await this.transactions.insert({
      reference,
      amountToman: request.amountToman,
      outcome: 'pending',
      settlementReference: null,
      refundReference: null,
    });

    // The customer's browser is sent to OUR mock checkout page, which then
    // calls settle() -- exactly the shape of a real redirect gateway.
    const base = this.config.get<string>('PAYMENT_MOCK_CHECKOUT_URL') ?? '/mock-gateway';
    const redirectUrl = `${base}?reference=${encodeURIComponent(reference)}&callback=${encodeURIComponent(request.callbackUrl)}`;

    this.logger.log(`Mock gateway initiated ${reference} for order ${request.orderId}`);
    return { providerReference: reference, redirectUrl, raw: { reference } };
  }

  /**
   * The simulated bank's decision point -- what the customer clicking
   * "pay"/"cancel" on the mock checkout page triggers.
   *
   * Compare-and-swap on `outcome = 'pending'`, so a customer who
   * double-submits the mock page cannot flip an already-decided transaction.
   */
  async settle(reference: string, paid: boolean): Promise<boolean> {
    const result = await this.transactions
      .createQueryBuilder()
      .update(MockGatewayTransactionEntity)
      .set({
        outcome: paid ? 'paid' : 'declined',
        settlementReference: paid ? `MOCKTX-${randomBytes(8).toString('hex').toUpperCase()}` : null,
      })
      .where("reference = :reference AND outcome = 'pending'", { reference })
      .execute();
    return result.affected === 1;
  }

  async verify(request: VerifyPaymentRequest): Promise<VerifyPaymentResult> {
    // A genuine lookup against the gateway's own record. `callbackParams` is
    // deliberately untouched here -- it identifies the transaction, it does
    // not attest to it.
    const transaction = await this.transactions.findOne({ where: { reference: request.providerReference } });

    if (!transaction) {
      return { outcome: 'failed', paidAmountToman: null, providerTransactionId: null, failureCode: 'unknown_reference' };
    }
    if (transaction.outcome === 'pending') {
      return { outcome: 'failed', paidAmountToman: null, providerTransactionId: null, failureCode: 'not_completed' };
    }
    if (transaction.outcome === 'declined') {
      return { outcome: 'failed', paidAmountToman: null, providerTransactionId: null, failureCode: 'declined' };
    }

    return {
      outcome: 'succeeded',
      // The gateway's own figure, reported independently of what the caller
      // expected. The caller compares -- this method never asserts a match.
      paidAmountToman: transaction.amountToman,
      providerTransactionId: transaction.settlementReference,
      failureCode: null,
      raw: { reference: transaction.reference, outcome: transaction.outcome },
    };
  }

  async refund(request: RefundPaymentRequest): Promise<RefundPaymentResult> {
    const transaction = await this.transactions.findOne({ where: { reference: request.providerReference } });
    if (!transaction || transaction.outcome !== 'paid') {
      return { outcome: 'failed', providerRefundReference: null, failureCode: 'not_refundable' };
    }

    // Idempotent on the gateway side too: a replayed refund returns the
    // reference the first one produced rather than issuing a second.
    if (transaction.refundReference) {
      return { outcome: 'succeeded', providerRefundReference: transaction.refundReference, failureCode: null };
    }

    const refundReference = `MOCKRF-${randomBytes(8).toString('hex').toUpperCase()}`;
    await this.transactions.update({ reference: transaction.reference }, { refundReference });
    return { outcome: 'succeeded', providerRefundReference: refundReference, failureCode: null };
  }
}
