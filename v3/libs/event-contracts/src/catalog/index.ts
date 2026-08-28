import { EventContract } from '../event-contract';
import { BOOKING_EVENTS } from './booking.events';
import { COMMERCE_EVENTS, FINANCIAL_EVENTS, PAYMENT_EVENTS } from './commerce.events';
import { JOURNEY_EVENTS } from './journey.events';
import { LOYALTY_EVENTS } from './loyalty.events';
import { NOTIFICATION_EVENTS } from './notification.events';
import { PROVIDER_EVENTS } from './provider.events';
import { SEARCH_EVENTS } from './search.events';
import { BUSINESS_EVENTS } from './business.events';
import { WAITLIST_EVENTS } from './waitlist.events';
import { PRIVACY_EVENTS } from './privacy.events';

export * from './common';
export * from './booking.events';
export * from './commerce.events';
export * from './journey.events';
export * from './loyalty.events';
export * from './notification.events';
export * from './provider.events';
export * from './search.events';
export * from './business.events';
export * from './waitlist.events';
export * from './privacy.events';

/**
 * Every contract V3 has published, in one list.
 *
 * This is the artifact ADR-007 asked for. Adding an event means adding it
 * here; there is no second place a producer could declare one, and
 * `EventContractRegistry.register` rejects a duplicate (name, version)
 * outright -- so a payload change is forced to be a new version rather than
 * an edit that silently breaks an already-deployed consumer.
 */
export const ALL_EVENT_CONTRACTS: EventContract[] = [
  ...BOOKING_EVENTS,
  ...COMMERCE_EVENTS,
  ...PAYMENT_EVENTS,
  ...FINANCIAL_EVENTS,
  ...PROVIDER_EVENTS,
  ...LOYALTY_EVENTS,
  ...JOURNEY_EVENTS,
  ...NOTIFICATION_EVENTS,
  ...SEARCH_EVENTS,
  ...BUSINESS_EVENTS,
  ...WAITLIST_EVENTS,
  ...PRIVACY_EVENTS,
];
