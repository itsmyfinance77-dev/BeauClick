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
import { SandboxOutcome, SandboxTransactionEntity } from '../entities/sandbox-transaction.entity';

export const SANDBOX_PROVIDER_KEY = 'sandbox';

/** The decisions a QA engineer can drive from the sandbox checkout page. */
export const SANDBOX_DECISIONS = ['success', 'failure', 'cancel'] as const;
export type SandboxDecision = (typeof SANDBOX_DECISIONS)[number];

const DECISION_TO_OUTCOME: Record<SandboxDecision, Exclude<SandboxOutcome, 'pending'>> = {
  success: 'paid',
  failure: 'declined',
  cancel: 'cancelled',
};

/**
 * A local, deterministic stand-in for a real Iranian gateway, so the entire
 * initiate -> redirect -> decide -> callback -> verify -> settle -> refund
 * loop is exercisable end to end without credentials.
 *
 * **This is a SANDBOX, not a production gateway, and never becomes one.**
 * GAP-06's production half stays open until a real adapter and real merchant
 * credentials exist; this provider exists so that everything AROUND that
 * adapter -- the lifecycle, the security properties, the financial
 * integration -- is built and proven before the adapter arrives, and so that
 * adding the adapter is the only remaining work.
 *
 * **It is a real simulation, not a shortcut.** `verify()` performs a genuine
 * server-side lookup against the sandbox's own table and reports the amount
 * THAT table holds. It never reads the callback parameters to decide the
 * outcome. That distinction is what makes the callback-security tests
 * meaningful: a forged success callback fails here for the same structural
 * reason it would fail against ZarinPal.
 *
 * **Production gate, closed by default, on TWO independent conditions.** V2
 * shipped a dev-only Cash-on-Delivery stand-in whose "local development only"
 * status was UI text with no mechanism behind it -- a production activation
 * could silently enable an unauthenticated "payment succeeded" path. That was
 * caught in a V2 readiness audit. Here the gate is structural and fails
 * CLOSED: `NODE_ENV=production` disables this provider outright, and
 * separately `PAYMENT_ENVIRONMENT` must be `sandbox`. Neither condition alone
 * is sufficient, and there is deliberately NO override flag that re-enables
 * it under `NODE_ENV=production` -- the previous `PAYMENT_ALLOW_MOCK_GATEWAY`
 * escape hatch was removed rather than carried forward, because a sandbox
 * that can be switched on in production by setting one environment variable
 * is exactly the risk this gate exists to eliminate.
 */
@Injectable()
export class SandboxPaymentProvider implements PaymentProvider {
  readonly key = SANDBOX_PROVIDER_KEY;
  readonly displayName = 'درگاه آزمایشی (Sandbox)';
  readonly supportsAutomaticRefund = true;

  private readonly logger = new Logger('SandboxPaymentProvider');

  constructor(
    @InjectRepository(SandboxTransactionEntity)
    private readonly transactions: Repository<SandboxTransactionEntity>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether this provider may be used at all in the current environment.
   *
   * Consulted by the registry on every resolution, so the decision is not
   * frozen into a boot-time flag of our own. Note the honest limit: when
   * `ConfigModule.forRoot({ validate })` is used, @nestjs/config caches a
   * validated snapshot of the environment at boot, so in practice the answer
   * changes only on restart. That is the correct granularity for a production
   * gate anyway -- what matters is that a production process cannot serve
   * payments through this provider, and it cannot.
   */
  isEnabled(): boolean {
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? 'development';
    // Hard stop. No override exists, deliberately -- see the class docblock.
    if (nodeEnv === 'production') return false;
    return this.paymentEnvironment() === 'sandbox';
  }

  /** Defaults to `sandbox` outside production, so a developer does not have to configure anything to run the app locally. */
  private paymentEnvironment(): string {
    return String(this.config.get('PAYMENT_ENVIRONMENT') ?? 'sandbox').toLowerCase();
  }

  async initiate(request: InitiatePaymentRequest): Promise<InitiatePaymentResult> {
    const reference = `SBX-${randomBytes(12).toString('hex').toUpperCase()}`;

    await this.transactions.insert({
      reference,
      amountToman: request.amountToman,
      currency: 'IRT',
      orderId: request.orderId,
      paymentIntentId: request.paymentIntentId,
      outcome: 'pending',
      settlementReference: null,
      refundReference: null,
    });

    // The customer's browser is sent to OUR sandbox checkout page, which then
    // calls decide() -- exactly the shape of a real redirect gateway.
    const base = this.config.get<string>('PAYMENT_SANDBOX_CHECKOUT_URL') ?? '/sandbox-gateway';
    const redirectUrl = `${base}?reference=${encodeURIComponent(reference)}&callback=${encodeURIComponent(request.callbackUrl)}`;

    this.logger.log(`Sandbox gateway initiated ${reference} for order ${request.orderId}`);
    return { providerReference: reference, redirectUrl, raw: { reference } };
  }

  /**
   * The simulated bank's decision point -- what the customer choosing
   * SUCCESS / FAILURE / CANCEL on the sandbox checkout page triggers.
   *
   * Compare-and-swap on `outcome = 'pending'`, so a customer who
   * double-submits the sandbox page cannot flip an already-decided
   * transaction, and two concurrent decisions resolve to exactly one winner.
   */
  async decide(reference: string, decision: SandboxDecision): Promise<boolean> {
    const outcome = DECISION_TO_OUTCOME[decision];
    const result = await this.transactions
      .createQueryBuilder()
      .update(SandboxTransactionEntity)
      .set({
        outcome,
        // A settlement reference is proof money moved. It is assigned on the
        // paid path and NOWHERE else -- a declined or cancelled transaction
        // that carried one would let a forged verify look legitimate.
        settlementReference: outcome === 'paid' ? `SBXTX-${randomBytes(8).toString('hex').toUpperCase()}` : null,
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
    if (transaction.outcome === 'cancelled') {
      // Distinct from `declined` on purpose: the customer walked away, the
      // bank did not refuse them.
      return { outcome: 'failed', paidAmountToman: null, providerTransactionId: null, failureCode: 'cancelled_by_user' };
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

    const refundReference = `SBXRF-${randomBytes(8).toString('hex').toUpperCase()}`;
    // Compare-and-swap on the refund reference still being unset, so two
    // genuinely concurrent refunds cannot each mint one and have the second
    // silently overwrite the first.
    const claimed = await this.transactions
      .createQueryBuilder()
      .update(SandboxTransactionEntity)
      .set({ refundReference })
      .where('reference = :reference AND refund_reference IS NULL', { reference: transaction.reference })
      .execute();

    if (claimed.affected !== 1) {
      // Lost the race -- the winner's reference is the real one.
      const settled = await this.transactions.findOne({ where: { reference: transaction.reference } });
      return { outcome: 'succeeded', providerRefundReference: settled?.refundReference ?? null, failureCode: null };
    }

    return { outcome: 'succeeded', providerRefundReference: refundReference, failureCode: null };
  }

  /** QA/diagnostic read of the simulated bank's own books. Never used by the payment lifecycle itself. */
  async inspect(reference: string): Promise<SandboxTransactionEntity | null> {
    return this.transactions.findOne({ where: { reference } });
  }
}
