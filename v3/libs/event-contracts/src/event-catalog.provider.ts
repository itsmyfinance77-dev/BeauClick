import { EventContractRegistry } from './registry';
import { ALL_EVENT_CONTRACTS } from './catalog';

/** Nest DI token for the one shared registry instance. */
export const EVENT_CONTRACT_REGISTRY = Symbol('BEAUCLICK_EVENT_CONTRACT_REGISTRY');

/**
 * Builds a registry pre-loaded with the full published catalog.
 *
 * A factory rather than a module-level singleton on purpose: a test that
 * wants to assert "registering a duplicate throws" or "an orphan consumer
 * fails boot" needs its own isolated instance, and a shared mutable
 * singleton would leak state between test files in the same worker.
 */
export function createEventContractRegistry(): EventContractRegistry {
  return new EventContractRegistry().register(...ALL_EVENT_CONTRACTS);
}
