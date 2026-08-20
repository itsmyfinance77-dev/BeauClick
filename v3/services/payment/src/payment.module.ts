import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PaymentIntentEntity } from './entities/payment-intent.entity';
import { PaymentAttemptEntity } from './entities/payment-attempt.entity';
import { RefundEntity } from './entities/refund.entity';
import { PaymentOutboxEntity } from './entities/payment-outbox.entity';
import { MockGatewayTransactionEntity } from './entities/mock-gateway-transaction.entity';

import { PaymentService } from './payment.service';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { MockGatewayProvider } from './providers/mock-gateway.provider';
import { PAYMENT_PROVIDERS } from './providers/payment-provider.interface';

export const PAYMENT_ENTITIES = [
  PaymentIntentEntity,
  PaymentAttemptEntity,
  RefundEntity,
  PaymentOutboxEntity,
  MockGatewayTransactionEntity,
];

/**
 * The mock gateway is the ONLY provider Phase 2 ships, and it gates itself
 * shut in production (see MockGatewayProvider). GAP-06 -- a real Iranian
 * gateway -- remains open: no merchant credentials exist in this
 * environment, and shipping an adapter whose money-unit and field semantics
 * were never exercised against the live API would be claiming readiness
 * this phase has not earned. What Phase 2 delivers is the abstraction that
 * makes that adapter a drop-in.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(PAYMENT_ENTITIES)],
  providers: [
    PaymentService,
    PaymentProviderRegistry,
    MockGatewayProvider,
    { provide: PAYMENT_PROVIDERS, useFactory: (mock: MockGatewayProvider) => [mock], inject: [MockGatewayProvider] },
  ],
  exports: [PaymentService, PaymentProviderRegistry, MockGatewayProvider, TypeOrmModule],
})
export class PaymentModule {}
