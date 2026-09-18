import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrderEntity } from './entities/order.entity';
import { OrderItemEntity } from './entities/order-item.entity';
import { OrderAdjustmentEntity } from './entities/order-adjustment.entity';
import { OrderPaymentScheduleEntity } from './entities/order-payment-schedule.entity';
import { CommerceOutboxEntity } from './entities/commerce-outbox.entity';
import { OrderOutcomeTermsEntity } from './entities/order-outcome-terms.entity';
import { CustomerRemedyChoiceEntity } from './entities/customer-remedy-choice.entity';

import { PricingService } from './pricing/pricing.service';
import { OrderService } from './order/order.service';
import { OrderOwnerResolver } from './order/order-owner.resolver';
import { OrderController } from './order/order.controller';
import { CommerceSubjectDataContract } from './commerce-subject-data.contract';
import { BookingOutcomeDecisionService } from './outcome-decision/booking-outcome-decision.service';
import { CustomerRemedyChoiceService } from './outcome-decision/customer-remedy-choice.service';

export const COMMERCE_ENTITIES = [
  OrderEntity,
  OrderItemEntity,
  OrderAdjustmentEntity,
  // V3.3 `#41a` (ADR-043). Registered here and nowhere else: every DataSource in
  // the platform spreads `COMMERCE_ENTITIES`, so a second registration path
  // would be a second place to forget it.
  OrderPaymentScheduleEntity,
  // V3.3 #159 (`#42b`), ADR-051 §3. The order's accepted outcome terms, 1:1.
  OrderOutcomeTermsEntity,
  // V3.3 #161 (`#42d`), ADR-051 §8. The customer's remedy after a
  // seller/platform/provider cancellation.
  CustomerRemedyChoiceEntity,
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
    CommerceSubjectDataContract,PricingService, OrderService, OrderOwnerResolver,
    // V3.3 #160 (`#42c`), ADR-051 §6. The booking outcome decision record.
    BookingOutcomeDecisionService,
    // V3.3 #161 (`#42d`), ADR-051 §8. The customer's remedy choice record.
    CustomerRemedyChoiceService],
  exports: [
    CommerceSubjectDataContract,OrderService, PricingService, TypeOrmModule, BookingOutcomeDecisionService,
    CustomerRemedyChoiceService],
})
export class CommerceModule {}
