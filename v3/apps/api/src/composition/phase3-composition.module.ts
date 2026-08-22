import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DomainEventHandler, OutboxSource } from '@beauclick/events';
import { EVENT_CONTRACT_REGISTRY, EventContractRegistry } from '@beauclick/event-contracts';

import { ProfessionalEntity, ProviderModule, ProviderOutboxEntity, ServiceOfferingEntity } from '@beauclick/provider';
import { UserEntity } from '@beauclick/identity';
import { BusinessEntity } from '@beauclick/business';
import { BookingModule } from '@beauclick/booking';
import { SearchIndexerService, SearchModule, SearchOutboxEntity } from '@beauclick/search';
import { LoyaltyModule, LoyaltyOutboxEntity } from '@beauclick/loyalty';
import { JourneyModule, JourneyOutboxEntity, JourneyService } from '@beauclick/journey';
import { NotificationModule, NotificationOutboxEntity, NotificationService } from '@beauclick/notification';
import { AnalyticsIngestionService, AnalyticsModule } from '@beauclick/analytics';

import { NotificationEnricher } from '../events/notification-enricher';
import {
  BookingSignalSearchHandler,
  ProfessionalUpdatedSearchHandler,
  ProfileViewSignalHandler,
  ServiceOfferingSearchHandler,
} from '../events/search-projection.handlers';
import {
  BookingCompletedLoyaltyHandler,
  OrderPaidLoyaltyHandler,
  buildTimelineHandlers,
} from '../events/loyalty-journey.handlers';
import { buildAnalyticsHandlers, buildNotificationHandlers } from '../events/notification-analytics.handlers';
import { Phase3SweepScheduler } from '../events/phase3-sweep.scheduler';
import { PHASE3_EVENT_HANDLERS, PHASE3_OUTBOX_SOURCES } from './phase3-tokens';

/**
 * The Phase 3 composition root.
 *
 * Everything that would otherwise be a module-boundary violation lives here,
 * as it did in Phase 2:
 *
 *  - the ports search, notification, and analytics DECLARE but must not
 *    implement (they each need data owned by another domain);
 *  - the first real pricing rule, which needs commerce's interface and
 *    loyalty's data and therefore cannot live in either;
 *  - the event handlers wiring one domain's facts to another's consequences;
 *  - the outbox sources for the five new schemas.
 *
 * `@nx/enforce-module-boundaries` now covers all eleven domains and forbids
 * every one of them from importing another, so this arrangement is checked by
 * lint rather than upheld by convention.
 */
@Module({
  imports: [
    ConfigModule,
    // Registered so the ports below can read provider/identity data without
    // any domain module depending on those services. BusinessEntity: Phase 4's
    // NotificationEnricher.sellerUserId() needs it directly -- a repository
    // provider is scoped to the module that registers it, so being available
    // in the (also @Global()) DomainPortsModule does not make it visible
    // here too; each module that injects a repository must register it.
    TypeOrmModule.forFeature([ProfessionalEntity, ServiceOfferingEntity, UserEntity, BusinessEntity]),
    ProviderModule,
    BookingModule,
    SearchModule,
    LoyaltyModule,
    JourneyModule,
    NotificationModule,
    AnalyticsModule,
  ],
  providers: [
    NotificationEnricher,
    Phase3SweepScheduler,

    // ---- event handlers
    ProfessionalUpdatedSearchHandler,
    ServiceOfferingSearchHandler,
    ProfileViewSignalHandler,
    BookingCompletedLoyaltyHandler,
    OrderPaidLoyaltyHandler,

    {
      provide: PHASE3_EVENT_HANDLERS,
      inject: [
        ProfessionalUpdatedSearchHandler,
        ServiceOfferingSearchHandler,
        ProfileViewSignalHandler,
        BookingCompletedLoyaltyHandler,
        OrderPaidLoyaltyHandler,
        SearchIndexerService,
        JourneyService,
        NotificationService,
        NotificationEnricher,
        AnalyticsIngestionService,
        EVENT_CONTRACT_REGISTRY,
      ],
      useFactory: (
        professionalUpdated: ProfessionalUpdatedSearchHandler,
        serviceUpdated: ServiceOfferingSearchHandler,
        profileView: ProfileViewSignalHandler,
        bookingLoyalty: BookingCompletedLoyaltyHandler,
        orderLoyalty: OrderPaidLoyaltyHandler,
        indexer: SearchIndexerService,
        journey: JourneyService,
        notifications: NotificationService,
        enricher: NotificationEnricher,
        ingestion: AnalyticsIngestionService,
        contracts: EventContractRegistry,
      ): DomainEventHandler[] => [
        professionalUpdated,
        serviceUpdated,
        profileView,
        bookingLoyalty,
        orderLoyalty,
        // Ranking signals. Constructed rather than injected because the three
        // differ only in which counter they move.
        new BookingSignalSearchHandler('BookingCompleted', 'booking_completed', indexer),
        new BookingSignalSearchHandler('BookingCancelled', 'booking_cancelled', indexer),
        new BookingSignalSearchHandler('BookingCreated', 'booking_created', indexer),
        ...buildTimelineHandlers(journey),
        ...buildNotificationHandlers(notifications, enricher),
        ...buildAnalyticsHandlers(ingestion, contracts),
      ],
    },

    {
      provide: PHASE3_OUTBOX_SOURCES,
      // The five new outbox tables, all on the shared application DataSource.
      // financial's remains separate and undrained for the same reason as in
      // Phase 2 -- it lives on its own connection and the relay takes one.
      useValue: [
        { name: 'provider', entity: ProviderOutboxEntity },
        { name: 'search', entity: SearchOutboxEntity },
        { name: 'loyalty', entity: LoyaltyOutboxEntity },
        { name: 'journey', entity: JourneyOutboxEntity },
        { name: 'notification', entity: NotificationOutboxEntity },
      ] satisfies OutboxSource[],
    },
  ],
  exports: [
    PHASE3_EVENT_HANDLERS,
    PHASE3_OUTBOX_SOURCES,
    Phase3SweepScheduler,
    SearchModule,
    LoyaltyModule,
    JourneyModule,
    NotificationModule,
    AnalyticsModule,
    // Phase 4's financial-outbox-relay.provider.ts (DomainCompositionModule)
    // injects NotificationEnricher directly for the settlement notification
    // rule, so it must be visible outside this module too, not only used
    // internally by this module's own NOTIFICATION_RULES handlers.
    NotificationEnricher,
  ],
})
export class Phase3CompositionModule {}
