import { Inject, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { DOMAIN_EVENT_HANDLERS, DomainEventHandler, OUTBOX_SOURCES, OutboxRelay, OutboxSource } from '@beauclick/events';
import { ALL_EVENT_CONTRACTS, EVENT_CONTRACT_REGISTRY, EventContractRegistry } from '@beauclick/event-contracts';
import { ProviderModule } from '@beauclick/provider';
import { AvailabilitySlotEntity, BookingModule, BookingOutboxEntity } from '@beauclick/booking';
import { CommerceModule, CommerceOutboxEntity } from '@beauclick/commerce';
import { PaymentModule, PaymentOutboxEntity } from '@beauclick/payment';
import { FinancialModule } from '@beauclick/financial';
import { BusinessModule, BusinessOutboxEntity } from '@beauclick/business';
import { WaitlistModule, WaitlistOutboxEntity, WaitlistService } from '@beauclick/waitlist';
import { MediaModule } from '@beauclick/media';
import { PrivacyModule, PrivacyOutboxEntity } from '@beauclick/privacy';

import { Phase3CompositionModule } from './phase3-composition.module';
import { PHASE3_EVENT_HANDLERS, PHASE3_OUTBOX_SOURCES } from './phase3-tokens';

import { DomainPortsModule } from './domain-ports.module';
import { CheckoutService } from '../checkout/checkout.service';
import { CheckoutController, SandboxGatewayController, PaymentCallbackController } from '../checkout/checkout.controller';
import { OrderPaymentController } from '../checkout/order-payment.controller';
import { OutboxSweepScheduler } from '../events/outbox-sweep.scheduler';
import {
  BookingCancelledRefundHandler,
  BookingConfirmedLogHandler,
  BookingExpiredOrderHandler,
  OrderPaidLedgerHandler,
  OrderRefundedLedgerHandler,
  RefundCompletedCommerceHandler,
} from '../events/financial-projection.handlers';
import { WaitlistAcceptanceService } from '../waitlist/waitlist-acceptance.service';
import { WaitlistAcceptanceController } from '../waitlist/waitlist-acceptance.controller';
import { WaitlistMatcherHandler } from '../waitlist/waitlist-matcher.handler';
import {
  FINANCIAL_DOMAIN_EVENT_HANDLERS,
  FINANCIAL_OUTBOX_RELAY,
  financialDomainEventHandlersProvider,
  financialOutboxRelayProvider,
} from './financial-outbox-relay.provider';

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
    BusinessModule,
    WaitlistModule,
    // V3.1 Phase C: the sweep scheduler reaps expired upload grants.
    MediaModule,
    // V3.1 Phase E. Imported for its outbox table and its sweep, both of which
    // the shared relay and the shared scheduler own -- the privacy DOMAIN is
    // composed in `PrivacyCompositionModule`, which is where its contracts and
    // the coverage assertion live.
    PrivacyModule,
    // Phase 3's domains and their handlers/outboxes, contributed under their
    // own tokens and merged into the single relay below.
    Phase3CompositionModule,
  ],
  controllers: [
    CheckoutController,
    PaymentCallbackController,
    SandboxGatewayController,
    // V3.1 Phase F. `POST /v1/orders/:id/payment/retry` -- order-scoped, so
    // the redirect contract never has to carry an intent id. Registered here
    // rather than in commerce because deciding whether a retry is permitted
    // needs both the order's status and the intent's stored failure code, and
    // ADR-011 forbids either service importing the other.
    OrderPaymentController,
    WaitlistAcceptanceController,
  ],
  providers: [
    CheckoutService,
    WaitlistAcceptanceService,
    OutboxSweepScheduler,

    OrderPaidLedgerHandler,
    OrderRefundedLedgerHandler,
    RefundCompletedCommerceHandler,
    BookingCancelledRefundHandler,
    BookingExpiredOrderHandler,
    BookingConfirmedLogHandler,

    {
      provide: OUTBOX_SOURCES,
      // Phase 2's three tables plus Phase 3's five, merged here because the
      // relay takes ONE list. Order matters only for tidiness -- each source
      // is drained independently and every handler is idempotent.
      inject: [PHASE3_OUTBOX_SOURCES],
      useFactory: (phase3: OutboxSource[]): OutboxSource[] => [
        { name: 'booking', entity: BookingOutboxEntity },
        { name: 'commerce', entity: CommerceOutboxEntity },
        { name: 'payment', entity: PaymentOutboxEntity },
        { name: 'business', entity: BusinessOutboxEntity },
        { name: 'waitlist', entity: WaitlistOutboxEntity },
        // V3.1 Phase E. On the shared DataSource like every source here except
        // financial's, so `DataErasureRequested` reaches notification and
        // analytics through the one relay rather than a second mechanism.
        { name: 'privacy', entity: PrivacyOutboxEntity },
        ...phase3,
      ],
    },
    {
      provide: DOMAIN_EVENT_HANDLERS,
      // Phase 2's handlers plus Phase 3's, in one list. Several event types
      // now have MULTIPLE handlers -- `OrderPaid` reaches the ledger, loyalty,
      // the journey timeline, a notification, and analytics. The relay
      // dispatches to every handler registered for a type, and each is
      // independently idempotent, so the fan-out needs no coordination.
      useFactory: (
        orderPaid: OrderPaidLedgerHandler,
        orderRefunded: OrderRefundedLedgerHandler,
        refundCompleted: RefundCompletedCommerceHandler,
        bookingCancelled: BookingCancelledRefundHandler,
        bookingExpired: BookingExpiredOrderHandler,
        bookingConfirmed: BookingConfirmedLogHandler,
        waitlistSvc: WaitlistService,
        slots: Repository<AvailabilitySlotEntity>,
        phase3: DomainEventHandler[],
      ) => [
        orderPaid,
        orderRefunded,
        refundCompleted,
        bookingCancelled,
        bookingExpired,
        bookingConfirmed,
        // Four triggers, one reaction (WaitlistMatcherHandler.handle) --
        // every event that can mean "this professional's slot might be open
        // again". See waitlist-matcher.handler.ts.
        new WaitlistMatcherHandler('BookingCancelled', waitlistSvc, slots),
        new WaitlistMatcherHandler('BookingExpired', waitlistSvc, slots),
        new WaitlistMatcherHandler('WaitlistDeclined', waitlistSvc, slots),
        new WaitlistMatcherHandler('WaitlistExpired', waitlistSvc, slots),
        ...phase3,
      ],
      inject: [
        OrderPaidLedgerHandler,
        OrderRefundedLedgerHandler,
        RefundCompletedCommerceHandler,
        BookingCancelledRefundHandler,
        BookingExpiredOrderHandler,
        BookingConfirmedLogHandler,
        WaitlistService,
        getRepositoryToken(AvailabilitySlotEntity),
        PHASE3_EVENT_HANDLERS,
      ],
    },
    OutboxRelay,
    financialDomainEventHandlersProvider,
    financialOutboxRelayProvider,
  ],
  exports: [
    CheckoutService,
    OutboxRelay,
    OutboxSweepScheduler,
    Phase3CompositionModule,
    FINANCIAL_OUTBOX_RELAY,
    PrivacyModule,
    // V3.1 Phase F. Re-exported so the root injector can resolve
    // `PaymentProviderRegistry` for the readiness report -- which is the only
    // place that can answer "is this deployment pointed at a simulated bank?".
    PaymentModule,
  ],
})
export class DomainCompositionModule implements OnApplicationBootstrap {
  private readonly logger = new Logger('EventContracts');

  constructor(
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
    // The COMPLETE handler list -- Phase 2's and Phase 3's merged. The check
    // lives here rather than in Phase3CompositionModule for exactly that
    // reason: run against Phase 3's handlers alone it reported Phase 2's
    // events (RefundCompleted, OrderCancelled, PaymentSucceeded) as having no
    // consumer, which was simply untrue and would have sent somebody hunting
    // for a broken subscription that was working fine.
    @Inject(DOMAIN_EVENT_HANDLERS) private readonly handlers: DomainEventHandler[],
    // The financial relay's own handlers, registered into the SAME registry
    // so "no orphan consumer" is checked uniformly rather than the financial
    // outbox being a blind spot this check does not cover.
    @Inject(FINANCIAL_DOMAIN_EVENT_HANDLERS) private readonly financialHandlers: DomainEventHandler[],
  ) {}

  /**
   * Boot-time contract check.
   *
   * ADR-007 asks for a producer/consumer registry that is "a real, queryable
   * artifact, not tribal knowledge". This makes it real rather than
   * documentary: a handler registered against a typo'd event name or a version
   * nobody publishes fails STARTUP, instead of sitting silently idle in
   * production until somebody asks why a notification never arrived.
   *
   * V2's `beauclick/auth/otp_generated` -- a real hook with zero subscribers,
   * found only by grepping the whole codebase -- is the mirror image of the
   * same blind spot.
   */
  onApplicationBootstrap(): void {
    for (const handler of [...(this.handlers ?? []), ...(this.financialHandlers ?? [])]) {
      this.contracts.registerConsumer({
        eventName: handler.eventType,
        // A handler that does not pin a version consumes v1 -- the only
        // version published so far. Explicit, so the day a v2 appears this
        // check starts failing for handlers nobody updated.
        eventVersion: handler.eventVersion ?? 1,
        // The handler class IS the consumer identity: one composed in the
        // composition root from two domains' collaborators has no single
        // owning service, so recording the class is the honest answer.
        consumer: handler.constructor.name,
        handler: handler.constructor.name,
        description: `${handler.constructor.name} consumes ${handler.eventType}`,
      });
    }

    this.contracts.assertConsumersHaveProducers();

    const unconsumed = this.contracts.unconsumedEvents();
    if (unconsumed.length > 0) {
      // NOT an error: an analytics-only fact with no reactive consumer is a
      // legitimate design. Logged so it is a visible, deliberate state rather
      // than something discovered by grepping.
      this.logger.log(
        `${ALL_EVENT_CONTRACTS.length} contracts registered; no reactive consumer for: ${unconsumed.join(', ')}`,
      );
    }
  }
}
