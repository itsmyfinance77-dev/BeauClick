import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PaymentIntentEntity } from './entities/payment-intent.entity';
import { PaymentAttemptEntity } from './entities/payment-attempt.entity';
import { RefundEntity } from './entities/refund.entity';
import { PaymentOutboxEntity } from './entities/payment-outbox.entity';
import { SandboxTransactionEntity } from './entities/sandbox-transaction.entity';

import { PaymentService } from './payment.service';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { SandboxPaymentProvider } from './providers/sandbox-payment.provider';
import { PAYMENT_PROVIDERS } from './providers/payment-provider.interface';
import { PaymentSubjectDataContract } from './payment-subject-data.contract';

export const PAYMENT_ENTITIES = [
  PaymentIntentEntity,
  PaymentAttemptEntity,
  RefundEntity,
  PaymentOutboxEntity,
  SandboxTransactionEntity,
];

/**
 * The sandbox gateway is the ONLY provider V3 ships, and it gates itself shut
 * in production on two independent conditions (see SandboxPaymentProvider).
 *
 * GAP-06's production half -- a real Iranian gateway -- remains OPEN: no
 * merchant credentials exist in this environment, and shipping an adapter
 * whose money-unit and field semantics were never exercised against the live
 * API would be claiming readiness that has not been earned. What is delivered
 * instead is the abstraction that makes that adapter a drop-in, plus a
 * sandbox realistic enough that the entire lifecycle around it -- callback
 * security, amount-tampering rejection, idempotency, refunds, and the
 * financial reaction -- is genuinely proven before the adapter arrives.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(PAYMENT_ENTITIES)],
  providers: [
    PaymentSubjectDataContract,
    PaymentService,
    PaymentProviderRegistry,
    SandboxPaymentProvider,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (sandbox: SandboxPaymentProvider) => [sandbox],
      inject: [SandboxPaymentProvider],
    },
  ],
  exports: [
    PaymentSubjectDataContract,PaymentService, PaymentProviderRegistry, SandboxPaymentProvider, TypeOrmModule],
})
export class PaymentModule {}
