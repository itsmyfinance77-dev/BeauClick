import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrderEntity } from './entities/order.entity';
import { OrderItemEntity } from './entities/order-item.entity';
import { OrderAdjustmentEntity } from './entities/order-adjustment.entity';
import { OrderPaymentScheduleEntity } from './entities/order-payment-schedule.entity';
import { CommerceOutboxEntity } from './entities/commerce-outbox.entity';

import { PricingService } from './pricing/pricing.service';
import { OrderService } from './order/order.service';
import { OrderOwnerResolver } from './order/order-owner.resolver';
import { OrderController } from './order/order.controller';
import { CommerceSubjectDataContract } from './commerce-subject-data.contract';

export const COMMERCE_ENTITIES = [
  OrderEntity,
  OrderItemEntity,
  OrderAdjustmentEntity,
  // V3.3 `#41a` (ADR-043). Registered here and nowhere else: every DataSource in
  // the platform spreads `COMMERCE_ENTITIES`, so a second registration path
  // would be a second place to forget it.
  OrderPaymentScheduleEntity,
  CommerceOutboxEntity,
];

/**
 * `PRICING_RULES` is intentionally left unbound here.
 *
 * `PricingService` treats an absent rule set as "no adjustments", so Phase 2
 * ships a working pricing path with zero rules -- which is the honest state
 * of the product: membership and campaign pricing are later phases, and
 * inventing their economics now to have something to register would be
 * pulling future scope into this one. What Phase 2 does deliver is the
 * single path they will plug into, proven by tests that register real rule
 * implementations against it.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(COMMERCE_ENTITIES)],
  controllers: [OrderController],
  providers: [
    CommerceSubjectDataContract,PricingService, OrderService, OrderOwnerResolver],
  exports: [
    CommerceSubjectDataContract,OrderService, PricingService, TypeOrmModule],
})
export class CommerceModule {}
