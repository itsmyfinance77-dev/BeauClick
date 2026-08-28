import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { returningRows } from '@beauclick/events';
import {
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  ProfessionalMediaChanged,
  ProfessionalUpdated,
  ProfessionalVerificationChanged,
  ServiceOfferingUpdated,
  emitContractEvent,
} from '@beauclick/event-contracts';
import { ProfessionalEntity } from './entities/professional.entity';
import { ProviderOutboxEntity } from './entities/provider-outbox.entity';
import { ServiceOfferingEntity } from './entities/service-offering.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CityEntity } from './entities/city.entity';

/**
 * Publishes provider-domain facts.
 *
 * This class exists to replace V2's tightest cross-plugin coupling: there,
 * `VerificationService::transition()` called `Indexer::sync()` directly and
 * synchronously, so provider changes reached the search index only via that
 * one method, and provider-service could not run without search-service
 * being available. Now provider-service states what happened and has no idea
 * a search index exists.
 *
 * **The revision counter is the correctness-bearing part.** Every indexable
 * change bumps `professionals.revision` IN THE SAME TRANSACTION as the change
 * and the outbox row, and the new value travels in the payload. A consumer
 * applying an older revision discards it. Without that, at-least-once
 * redelivery of an older event would silently overwrite newer data -- and
 * because both payloads are individually valid, nothing downstream could
 * detect that it had happened.
 */
@Injectable()
export class ProviderEventsService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  /**
   * Bumps the professional's revision and returns the new value.
   *
   * A single atomic `SET revision = revision + 1 ... RETURNING` rather than a
   * read-then-write: two concurrent profile edits must produce two DIFFERENT
   * revisions, and a read-modify-write would let both read the same value and
   * emit two events claiming the same version — at which point the consumer's
   * discard rule has no way to order them.
   */
  async bumpRevision(manager: EntityManager, professionalId: string): Promise<number> {
    const raw = await manager.query(
      'UPDATE provider.professionals SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision',
      [professionalId],
    );

    // `returningRows` normalizes TypeORM's two result shapes -- see
    // sql-result.ts, which exists because this exact confusion has now caused
    // two separate production-shaped bugs.
    //
    // This was a real bug, found by a real-PostgreSQL test: with an
    // `?? 1` fallback in place, every call returned 1 while the column
    // genuinely climbed to 4. Every event then claimed revision 1, so the
    // consumer's `revision < incoming` guard discarded everything after the
    // first -- a verification change never reached the search index, and
    // nothing anywhere reported an error.
    //
    // Both shapes are handled explicitly, and there is deliberately NO
    // fallback: a revision that cannot be read is a broken ordering guarantee,
    // and failing loudly is the only safe outcome. A silently-plausible number
    // is exactly what made this hard to see.
    const rows = returningRows<{ revision: string | number }>(raw);
    const value = rows[0]?.revision;
    if (value === undefined || value === null) {
      throw new Error(
        `Failed to read the new revision for professional ${professionalId}. The event-ordering guarantee depends on it, so this must not be defaulted.`,
      );
    }

    // BIGINT comes back as a string from node-postgres, by design -- it does
    // not fit a JS number in general. It does here, but the conversion must
    // still be explicit.
    return Number(value);
  }

  /**
   * Emits `ProfessionalUpdated` with the profile's full current shape.
   *
   * The payload carries the WHOLE document rather than a diff. A diff would be
   * smaller, but it would make the consumer's state depend on having received
   * every prior event in order — which at-least-once, unordered delivery
   * cannot promise. A full snapshot plus a revision is self-sufficient: the
   * newest one wins and nothing needs replaying.
   */
  async emitProfessionalUpdated(manager: EntityManager, professionalId: string, revision?: number): Promise<void> {
    const professional = await manager.findOne(ProfessionalEntity, {
      where: { id: professionalId },
      relations: ['specialties', 'city'],
    });
    if (!professional) return;

    const nextRevision = revision ?? (await this.bumpRevision(manager, professionalId));
    const specialties: SpecialtyEntity[] = professional.specialties ?? [];
    const city: CityEntity | undefined = professional.city;

    await emitContractEvent(this.contracts, manager, ProviderOutboxEntity, ProfessionalUpdated, {
      aggregateId: professionalId,
      payload: {
        professionalId,
        revision: nextRevision,
        displayName: professional.displayName,
        bio: professional.bio,
        cityId: professional.cityId,
        cityName: city?.name ?? null,
        specialtyIds: specialties.map((s) => s.id),
        specialtyNames: specialties.map((s) => s.name),
        verificationStatus: professional.verificationStatus,
        isDeleted: professional.deletedAt !== null,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  async emitVerificationChanged(
    manager: EntityManager,
    professionalId: string,
    fromStatus: string,
    toStatus: string,
    actorId: string | null,
    reason: string | null,
  ): Promise<void> {
    const revision = await this.bumpRevision(manager, professionalId);

    await emitContractEvent(this.contracts, manager, ProviderOutboxEntity, ProfessionalVerificationChanged, {
      aggregateId: professionalId,
      payload: { professionalId, revision, fromStatus, toStatus, actorId, reason, changedAt: new Date().toISOString() },
    });

    // Also emit the full profile: search needs the new verification status on
    // the document, and re-deriving it from the transition event would mean
    // the consumer had to already hold the rest of the document -- which on a
    // cold index it does not.
    await this.emitProfessionalUpdated(manager, professionalId, revision);
  }

  /**
   * Emits `ServiceOfferingUpdated`, carrying the OWNING professional's
   * revision.
   *
   * A service edit bumps the professional's counter rather than having one of
   * its own, because the search document is per-professional: that is the
   * thing whose versions must be comparable. Two service edits and a profile
   * edit racing each other therefore produce three strictly ordered revisions
   * against one document, instead of three independent counters a consumer
   * could not reconcile.
   */
  async emitServiceUpdated(manager: EntityManager, service: ServiceOfferingEntity): Promise<void> {
    const revision = await this.bumpRevision(manager, service.professionalId);

    await emitContractEvent(this.contracts, manager, ProviderOutboxEntity, ServiceOfferingUpdated, {
      aggregateId: service.id,
      payload: {
        serviceId: service.id,
        professionalId: service.professionalId,
        revision,
        name: service.name,
        durationMinutes: service.durationMinutes,
        priceToman: service.priceToman,
        isDeleted: service.deletedAt !== null,
        updatedAt: new Date().toISOString(),
      },
    });

    // The professional document embeds the service catalogue, so the profile
    // event is what actually carries the change into the index.
    await this.emitProfessionalUpdated(manager, service.professionalId, revision);
  }

  /**
   * Emits `ProfessionalMediaChanged` with the professional's whole current
   * imagery.
   *
   * The SNAPSHOT IS PASSED IN rather than read here, and that is a deliberate
   * dependency direction: `PortfolioService` owns the query that answers
   * "what images does this professional have", and it is the same query the
   * reindex source uses. If this service read it independently there would be
   * two implementations of one question, free to disagree about a
   * professional whose avatar was taken down between them.
   */
  async emitMediaChanged(
    manager: EntityManager,
    professionalId: string,
    snapshot: {
      avatarUrl: string | null;
      avatarWidth: number | null;
      avatarHeight: number | null;
      portfolioCount: number;
      portfolioPreviewUrls: string[];
    },
  ): Promise<void> {
    // Same counter `ProfessionalUpdated` uses, for the same reason: the search
    // document is per-professional, so every change to it must be orderable
    // against every other change to it. A separate counter for imagery would
    // give the consumer two sequences it cannot reconcile.
    const revision = await this.bumpRevision(manager, professionalId);

    await emitContractEvent(this.contracts, manager, ProviderOutboxEntity, ProfessionalMediaChanged, {
      aggregateId: professionalId,
      payload: {
        professionalId,
        revision,
        avatarUrl: snapshot.avatarUrl,
        avatarWidth: snapshot.avatarWidth,
        avatarHeight: snapshot.avatarHeight,
        portfolioCount: snapshot.portfolioCount,
        portfolioPreviewUrls: snapshot.portfolioPreviewUrls,
        changedAt: new Date().toISOString(),
      },
    });
  }

  /** Convenience for callers with no transaction of their own. */
  async inTransaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(fn);
  }
}
