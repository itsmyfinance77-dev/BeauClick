import { Global, Module } from '@nestjs/common';
import { EVENT_CONTRACT_REGISTRY, createEventContractRegistry } from './event-catalog.provider';

/**
 * Makes the event-contract registry available process-wide.
 *
 * `@Global()` is the right shape here rather than a convenience. Every domain
 * that PRODUCES an event needs the registry to validate on the way into its
 * outbox, and no domain may import another (ADR-011) -- so the alternative
 * would be each of eleven modules declaring its own provider, which would
 * defeat the point entirely: the registry's job is to be the SINGLE answer to
 * "what events exist", and eleven instances would let a producer and a
 * consumer disagree about a contract while both believed they were validating
 * against the catalog.
 *
 * Same reasoning `DomainPortsModule` is global in Phase 2.
 */
@Global()
@Module({
  providers: [{ provide: EVENT_CONTRACT_REGISTRY, useFactory: () => createEventContractRegistry() }],
  exports: [EVENT_CONTRACT_REGISTRY],
})
export class EventContractsModule {}
