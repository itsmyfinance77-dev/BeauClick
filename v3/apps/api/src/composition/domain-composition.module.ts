import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DOMAIN_EVENT_HANDLERS, OUTBOX_SOURCES, OutboxRelay, OutboxSource } from '@beauclick/events';
import { ProviderModule } from '@beauclick/provider';
import { BookingModule, BookingOutboxEntity } from '@beauclick/booking';
import { CommerceModule, CommerceOutboxEntity } from '@beauclick/commerce';
import { PaymentModule, PaymentOutboxEntity } from '@beauclick/payment';
import { FinancialModule } from '@beauclick/financial';

import { DomainPortsModule } from './domain-ports.module';
import { CheckoutService } from '../checkout/checkout.service';
import { CheckoutController, MockGatewayController, PaymentCallbackController } from '../checkout/checkout.controller';
import { OutboxSweepScheduler } from '../events/outbox-sweep.scheduler';
import {
  BookingCancelledRefundHandler,
  BookingConfirmedLogHandler,
  BookingExpiredOrderHandler,
  OrderPaidLedgerHandler,
  OrderRefundedLedgerHandler,
  RefundCompletedCommerceHandler,
} from '../events/financial-projection.handlers';

/**
 * The composition root for Phase 2's domains.
 *
 * Everything that would otherwise be a module-boundary violation lives
 * here, and only here:
 *
 *  - the port adapters that let booking, commerce, and financial read
 *    provider data without depending on provider-service;
 *  - the financial DataSource, connected as the append-only role;
 *  - the cross-domain transaction boundaries (CheckoutService);
 *  - the event handlers that wire one domain's facts to another's
 *    consequences.
 *
 * `@nx/enforce-module-boundaries` permits `scope:app` to depend on every
 * domain and forbids every domain from depending on another, so this
 * arrangement is checked by lint rather than upheld by convention -- a
 * violation fails CI, it does not merely disappoint a reviewer.
 *
 * Note the financial outbox is NOT drained by this relay: financial-service
 * runs on a different DataSource, and the relay's constructor takes exactly
 * one. Its events (LedgerEntriesRecorded, SettlementRecorded) have no
 * consumer in Phase 2 -- they are recorded for the analytics phase that
 * will, and are drained by that phase's own relay instance rather than
 * being fabricated a consumer now.
 */
@Module({
  imports: [
    ConfigModule,
    // Global, so BookingModule/CommerceModule/FinancialModule each resolve
    // the ports they declare without importing one another.
    DomainPortsModule,
    ProviderModule,
    BookingModule,
    CommerceModule,
    PaymentModule,
    FinancialModule,
  ],
  controllers: [CheckoutController, PaymentCallbackController, MockGatewayController],
  providers: [
    CheckoutService,
    OutboxSweepScheduler,

    OrderPaidLedgerHandler,
    OrderRefundedLedgerHandler,
    RefundCompletedCommerceHandler,
    BookingCancelledRefundHandler,
    BookingExpiredOrderHandler,
    BookingConfirmedLogHandler,

    {
      provide: OUTBOX_SOURCES,
      // The three outbox tables the shared DataSource can see. Order
      // matters only for tidiness -- each source is drained independently
      // and every handler is idempotent.
      useValue: [
        { name: 'booking', entity: BookingOutboxEntity },
        { name: 'commerce', entity: CommerceOutboxEntity },
        { name: 'payment', entity: PaymentOutboxEntity },
      ] satisfies OutboxSource[],
    },
    {
      provide: DOMAIN_EVENT_HANDLERS,
      useFactory: (
        orderPaid: OrderPaidLedgerHandler,
        orderRefunded: OrderRefundedLedgerHandler,
        refundCompleted: RefundCompletedCommerceHandler,
        bookingCancelled: BookingCancelledRefundHandler,
        bookingExpired: BookingExpiredOrderHandler,
        bookingConfirmed: BookingConfirmedLogHandler,
      ) => [orderPaid, orderRefunded, refundCompleted, bookingCancelled, bookingExpired, bookingConfirmed],
      inject: [
        OrderPaidLedgerHandler,
        OrderRefundedLedgerHandler,
        RefundCompletedCommerceHandler,
        BookingCancelledRefundHandler,
        BookingExpiredOrderHandler,
        BookingConfirmedLogHandler,
      ],
    },
    OutboxRelay,
  ],
  exports: [CheckoutService, OutboxRelay, OutboxSweepScheduler],
})
export class DomainCompositionModule {}
