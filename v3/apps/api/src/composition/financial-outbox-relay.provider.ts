import { FactoryProvider } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DomainEventHandler, OutboxRelay } from '@beauclick/events';
import { EventContractRegistry, EVENT_CONTRACT_REGISTRY } from '@beauclick/event-contracts';
import { FINANCIAL_DATA_SOURCE, FinancialOutboxEntity } from '@beauclick/financial';
import { NotificationService } from '@beauclick/notification';
import { AnalyticsIngestionService } from '@beauclick/analytics';

import { NotificationEnricher } from '../events/notification-enricher';
import { buildFinancialAnalyticsHandlers, buildFinancialNotificationHandlers } from '../events/notification-analytics.handlers';

export const FINANCIAL_OUTBOX_RELAY = Symbol('BEAUCLICK_FINANCIAL_OUTBOX_RELAY');
export const FINANCIAL_DOMAIN_EVENT_HANDLERS = Symbol('BEAUCLICK_FINANCIAL_DOMAIN_EVENT_HANDLERS');

/**
 * A separate token for the SAME handlers `financialOutboxRelayProvider`
 * constructs the relay with -- not duplicated logic, just exposed so the
 * boot-time contract check (`DomainCompositionModule.onApplicationBootstrap`)
 * can register these consumers too, the same way it registers the main
 * relay's. `OutboxRelay` itself has no public API for "which handler
 * instances did you get", by design (it only exposes event TYPE names via
 * `registeredEventTypes()`), so this is the seam that lets both the relay
 * and the contract check agree on one real list.
 */
export const financialDomainEventHandlersProvider: FactoryProvider<DomainEventHandler[]> = {
  provide: FINANCIAL_DOMAIN_EVENT_HANDLERS,
  inject: [NotificationService, NotificationEnricher, AnalyticsIngestionService, EVENT_CONTRACT_REGISTRY],
  useFactory: (
    notifications: NotificationService,
    enricher: NotificationEnricher,
    ingestion: AnalyticsIngestionService,
    contracts: EventContractRegistry,
  ): DomainEventHandler[] => [
    ...buildFinancialAnalyticsHandlers(ingestion, contracts),
    ...buildFinancialNotificationHandlers(notifications, enricher),
  ],
};

/**
 * financial-service's OWN relay, bound to `FINANCIAL_DATA_SOURCE` -- the
 * gap Phase 2 and Phase 3 both left open on purpose: "the financial outbox
 * is NOT drained by [the main] relay: financial-service runs on a different
 * DataSource, and the relay's constructor takes exactly one."
 *
 * Not a second copy of `OutboxRelay`'s logic -- the SAME class, constructed
 * a second time with a different DataSource and a different, smaller
 * handler set. This is what makes financial facts (LedgerEntriesRecorded,
 * SettlementRecorded, SettlementReversed) reach analytics and notify a
 * seller at all: the main application role has REVOKE ALL on the financial
 * schema (ADR-017), so this relay -- running on the WRITER connection,
 * which the migration grants SELECT on its own outbox table -- is the only
 * path those facts can ever leave financial-service by.
 */
export const financialOutboxRelayProvider: FactoryProvider<OutboxRelay> = {
  provide: FINANCIAL_OUTBOX_RELAY,
  inject: [FINANCIAL_DATA_SOURCE, FINANCIAL_DOMAIN_EVENT_HANDLERS],
  useFactory: (financialDataSource: DataSource, handlers: DomainEventHandler[]): OutboxRelay =>
    new OutboxRelay(financialDataSource, [{ name: 'financial', entity: FinancialOutboxEntity }], handlers),
};
