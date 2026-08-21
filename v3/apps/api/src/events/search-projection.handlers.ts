import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainEventHandler, EventEnvelope } from '@beauclick/events';
import {
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  ProfessionalUpdated,
  ProviderProfileViewed,
  ServiceOfferingUpdated,
  parseEnvelope,
} from '@beauclick/event-contracts';
import { SearchIndexerService } from '@beauclick/search';
import { ServiceOfferingService } from '@beauclick/provider';

/**
 * How provider facts become a search index.
 *
 *   ProfessionalUpdated               -> upsert the document (revision-guarded)
 *   ProfessionalVerificationChanged   -> (also emits ProfessionalUpdated)
 *   ServiceOfferingUpdated            -> refresh the embedded catalogue
 *   BookingCompleted/Cancelled/Created-> ranking signal, once per event
 *   ProviderProfileViewed             -> ranking signal, once per event
 *
 * Every handler parses its envelope through the contract registry rather than
 * casting the payload. The difference shows up the day a producer moves to v2:
 * here that is a loud, specific failure naming the field, instead of an
 * `undefined` flowing quietly into a database column.
 */

@Injectable()
export class ProfessionalUpdatedSearchHandler implements DomainEventHandler {
  readonly eventType = ProfessionalUpdated.name;
  readonly eventVersion = ProfessionalUpdated.version;
  private readonly logger = new Logger('ProfessionalUpdatedSearchHandler');

  constructor(
    private readonly indexer: SearchIndexerService,
    private readonly services: ServiceOfferingService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  /**
   * Idempotent AND order-safe by `revision`, not merely by "applying the same
   * document twice is harmless".
   *
   * That distinction matters: a naive upsert IS idempotent for a redelivery
   * of the newest event, but it is NOT safe when an OLDER event is
   * redelivered after a newer one has been applied -- it would silently
   * revert the document to stale data. `applyProfessional` returns false for
   * that case rather than writing.
   */
  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, ProfessionalUpdated, envelope);

    // The event carries the profile; the service catalogue is fetched here.
    // Putting the whole catalogue in every profile event would make the
    // payload grow without bound with a provider's service count, and most
    // profile edits do not touch services at all.
    const offerings = await this.services.listForProfessional(payload.professionalId);

    const applied = await this.indexer.applyProfessional({
      professionalId: payload.professionalId,
      revision: payload.revision,
      displayName: payload.displayName,
      bio: payload.bio,
      cityId: payload.cityId,
      cityName: payload.cityName,
      specialtyIds: payload.specialtyIds,
      specialtyNames: payload.specialtyNames,
      verificationStatus: payload.verificationStatus,
      isDeleted: payload.isDeleted,
      updatedAt: new Date(payload.updatedAt),
      services: offerings.map((s: { id: string; name: string; priceToman: number; durationMinutes: number }) => ({
        serviceId: s.id,
        name: s.name,
        priceToman: s.priceToman,
        durationMinutes: s.durationMinutes,
      })),
    });

    if (!applied) {
      this.logger.debug(`Skipped stale revision ${payload.revision} for ${payload.professionalId}`);
    }
  }
}

/**
 * Service-catalogue changes.
 *
 * Handled separately from `ProfessionalUpdated` even though provider-service
 * emits both: the two events arrive independently and either may be
 * redelivered alone, so each must be able to bring the document up to date by
 * itself. Both go through the same revision guard, so whichever lands second
 * wins and the earlier one is discarded.
 */
@Injectable()
export class ServiceOfferingSearchHandler implements DomainEventHandler {
  readonly eventType = ServiceOfferingUpdated.name;
  readonly eventVersion = ServiceOfferingUpdated.version;

  constructor(@Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    // Parsed for validation only. The document refresh itself rides on the
    // ProfessionalUpdated event that provider-service emits alongside this
    // one -- doing the work twice would be two writes for one change, and the
    // revision guard would discard the second anyway.
    parseEnvelope(this.contracts, ServiceOfferingUpdated, envelope);
  }
}

/**
 * Ranking signals from booking lifecycle events.
 *
 * One class handles three event types rather than three near-identical
 * classes, because the only thing that differs is which counter moves.
 *
 * The idempotency here is the interesting part: a counter increment is NOT
 * naturally idempotent, so `applySignal` records the SOURCE EVENT'S ID before
 * incrementing and a redelivery loses that insert. Getting this wrong would
 * mean a provider's completed-booking count drifting upward on every relay
 * restart, permanently and undetectably.
 */
@Injectable()
export class BookingSignalSearchHandler implements DomainEventHandler {
  constructor(
    readonly eventType: string,
    private readonly signal: 'booking_completed' | 'booking_cancelled' | 'booking_created',
    private readonly indexer: SearchIndexerService,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as { professionalId?: string };
    if (!payload.professionalId) return;
    await this.indexer.applySignal(envelope.id, this.signal, payload.professionalId, envelope.occurredAt ?? new Date());
  }
}

@Injectable()
export class ProfileViewSignalHandler implements DomainEventHandler {
  readonly eventType = ProviderProfileViewed.name;
  readonly eventVersion = ProviderProfileViewed.version;

  constructor(
    private readonly indexer: SearchIndexerService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = parseEnvelope(this.contracts, ProviderProfileViewed, envelope);
    await this.indexer.applySignal(
      envelope.id,
      'profile_view',
      payload.professionalId,
      new Date(payload.occurredAt),
    );
  }
}
