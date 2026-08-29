import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import {
  AiCatalogueQuery,
  AiJourneyContext,
  AiJourneyContextPort,
  AiPublicCataloguePort,
  AiPublicProfessionalSummary,
  AiPublicServiceSummary,
} from '@beauclick/ai';
import { JourneyContextProvider } from '@beauclick/journey';
import { ProfessionalEntity, ServiceOfferingEntity } from '@beauclick/provider';
import { RankingSignalsEntity } from '@beauclick/search';
import { SearchService } from '@beauclick/search';

/**
 * The two AI context ports, implemented here because this is the only place
 * ADR-011 permits a cross-domain read.
 *
 * `services/ai` declares `AI_JOURNEY_CONTEXT` and `AI_PUBLIC_CATALOGUE` and
 * provides neither. That is deliberate: a module that cannot boot without its
 * ports bound is a module whose boundary is real — there is no default
 * implementation to fall back on and no way to accidentally ship one. These are
 * the bindings, and they are the total surface through which any fact from any
 * other domain can reach a prompt.
 *
 * **Read this file as the enforcement of `V32-DEC-005`.** Everything the
 * assistant will ever know about a customer or the catalogue is constructed by
 * one of the two adapters below, field by field, from named columns. There is no
 * spread, no `toJSON`, and no pass-through of an entity.
 */

/**
 * Journey.
 *
 * A one-line delegation to `inferAiDefaults`, and that is the whole point of
 * ADR-019. `JourneyContextProvider` returns a type with no string field, so
 * `notes` and a goal's `title` cannot travel — not because this adapter
 * remembers to omit them, but because they are not in the value it receives.
 *
 * The fields are still named explicitly rather than returned wholesale. If
 * journey's context type ever grows a fourth field, this adapter keeps sending
 * three and the fourth is a deliberate edit here — which is the reviewable act
 * `V32-DEC-005` requires.
 */
@Injectable()
export class JourneyAiContextAdapter implements AiJourneyContextPort {
  constructor(private readonly journey: JourneyContextProvider) {}

  async inferAiDefaults(userId: string): Promise<AiJourneyContext> {
    const inferred = await this.journey.inferAiDefaults(userId);
    return {
      specialtyIds: inferred.specialtyIds,
      cityId: inferred.cityId,
      budgetToman: inferred.budgetToman,
    };
  }
}

/**
 * The public catalogue and search.
 *
 * ## Candidates come from the EXISTING search read model
 *
 * `findCandidates` calls `SearchService.searchProviders` — the one search
 * implementation, with the one ranking formula (ADR-021). `ai` does not rank,
 * does not index, and does not query provider's tables for discovery.
 * `V3.2_PHASE_0_DISCOVERY.md` `F-05` and ADR-029 §1 both forbid a second
 * recommendation engine, and the way to not build one is to call the first.
 *
 * The mapping to `AiPublicProfessionalSummary` DROPS fields the search document
 * carries: `bio`, `avatarUrl`, `portfolioPreviewUrls`, `rankingScore`,
 * `rankingSignalKeys`, `revision`, `indexedAt`. Some are private-ish internals
 * and some are merely useless to a prompt; `bio` is the one worth naming,
 * because it is public and is still excluded — a public string authored by one
 * party and fed into a prompt on behalf of another is an injection surface with
 * no compensating benefit (ADR-029 §5).
 *
 * ## Re-verification does NOT go through search
 *
 * `reverifyProfessionals` reads `provider.professionals` directly, and that
 * asymmetry is the most important decision in this file.
 *
 * The search projection is eventually consistent. A professional suspended
 * thirty seconds ago is still in the index until the event drains, so
 * re-verifying against search would confirm exactly the record the platform has
 * just decided must not be shown. ADR-030 T3's control is "does this record
 * CURRENTLY exist, is it CURRENTLY public, is it CURRENTLY visible" — three
 * questions only the owning domain can answer, and it answers them from a row
 * that is authoritative rather than projected.
 *
 * So discovery is fast and eventually consistent, and the gate is slow and
 * strictly consistent. That is the correct way round.
 */
@Injectable()
export class PublicCatalogueAiAdapter implements AiPublicCataloguePort {
  constructor(
    private readonly search: SearchService,
    @InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>,
    @InjectRepository(ServiceOfferingEntity) private readonly services: Repository<ServiceOfferingEntity>,
    @InjectRepository(RankingSignalsEntity) private readonly signals: Repository<RankingSignalsEntity>,
  ) {}

  async findCandidates(query: AiCatalogueQuery): Promise<readonly AiPublicProfessionalSummary[]> {
    const outcome = await this.search.searchProviders(
      {
        cityId: query.cityId,
        specialtyIds: query.specialtyIds ? [...query.specialtyIds] : undefined,
        maxPriceToman: query.maxPriceToman,
        // The platform's own ranking, not a preference expressed here. `ai` has
        // no relevance opinion and must not acquire one.
        sort: 'ranking',
        page: 1,
        pageSize: query.limit,
      },
      // No user id. `searchProviders` uses it only to attribute a
      // `SearchPerformed` analytics event, and an assistant assembling context
      // is not a customer performing a search -- recording it as one would
      // inflate the search funnel with events nobody triggered.
      null,
    );

    return outcome.items.map((item) => ({
      professionalId: item.professionalId,
      displayName: item.displayName,
      cityId: item.cityId,
      cityName: item.cityName,
      specialtyNames: item.specialtyNames,
      isVerified: item.isVerified,
      minPriceToman: item.minPriceToman,
      maxPriceToman: item.maxPriceToman,
      ratingAvg: item.ratingAvg,
      reviewCount: item.reviewCount,
    }));
  }

  async findServicesFor(
    professionalIds: readonly string[],
    limit: number,
  ): Promise<readonly AiPublicServiceSummary[]> {
    if (professionalIds.length === 0) return [];
    const rows = await this.services.find({
      where: { professionalId: In([...professionalIds]), deletedAt: IsNull() },
      order: { priceToman: 'ASC' },
      take: limit,
    });
    return rows.map((row) => ({
      serviceId: row.id,
      professionalId: row.professionalId,
      name: row.name,
      priceToman: row.priceToman,
      durationMinutes: row.durationMinutes,
    }));
  }

  /**
   * The trust boundary (ADR-030 T3).
   *
   * `verificationStatus: 'verified'` and `deletedAt IS NULL`. Anything else —
   * unverified, pending, rejected, suspended, revoked, or soft-deleted — comes
   * back absent, and the caller drops the recommendation.
   *
   * `verified` rather than "not suspended" is the stricter reading, and it is
   * the right one for this surface: a platform's assistant recommending a
   * professional the platform has not verified is the platform vouching for
   * them. A customer browsing search can see unverified professionals and judge
   * for themselves; a recommendation is not browsing.
   *
   * The RATING is re-read from the ranking signals rather than carried from the
   * search document, so a recommendation card cannot show a stale average that
   * the assistant's own sentence then contradicts.
   */
  async reverifyProfessionals(ids: readonly string[]): Promise<readonly AiPublicProfessionalSummary[]> {
    if (ids.length === 0) return [];

    const rows = await this.professionals.find({
      where: { id: In([...ids]), verificationStatus: 'verified', deletedAt: IsNull() },
      relations: { city: true, specialties: true },
    });
    if (rows.length === 0) return [];

    const [signals, offerings] = await Promise.all([
      this.signals.find({ where: { professionalId: In(rows.map((r) => r.id)) } }),
      this.services.find({ where: { professionalId: In(rows.map((r) => r.id)), deletedAt: IsNull() } }),
    ]);
    const signalById = new Map(signals.map((s) => [s.professionalId, s]));

    return rows.map((row) => {
      const signal = signalById.get(row.id);
      const prices = offerings.filter((o) => o.professionalId === row.id).map((o) => o.priceToman);
      return {
        professionalId: row.id,
        displayName: row.displayName,
        cityId: row.cityId,
        cityName: row.city?.name ?? null,
        specialtyNames: (row.specialties ?? []).map((specialty) => specialty.name),
        isVerified: true,
        minPriceToman: prices.length > 0 ? Math.min(...prices) : null,
        maxPriceToman: prices.length > 0 ? Math.max(...prices) : null,
        // Divide-by-zero guarded the same way `SearchIndexerService` guards it:
        // no reviews means no average, not NaN.
        ratingAvg: signal && signal.reviewCount > 0 ? signal.ratingSum / signal.reviewCount : 0,
        reviewCount: signal?.reviewCount ?? 0,
      };
    });
  }

  /**
   * A service is showable only if it is not deleted AND its professional is
   * currently verified and not deleted.
   *
   * The second half is what makes this correct rather than merely present: a
   * service row survives its professional's suspension, so checking only
   * `services.deleted_at` would let the assistant recommend a treatment offered
   * by somebody the platform has just stopped vouching for.
   */
  async reverifyServices(ids: readonly string[]): Promise<readonly AiPublicServiceSummary[]> {
    if (ids.length === 0) return [];

    const rows = await this.services.find({ where: { id: In([...ids]), deletedAt: IsNull() } });
    if (rows.length === 0) return [];

    const owners = await this.professionals.find({
      where: {
        id: In([...new Set(rows.map((row) => row.professionalId))]),
        verificationStatus: 'verified',
        deletedAt: IsNull(),
      },
      select: { id: true },
    });
    const showable = new Set(owners.map((owner) => owner.id));

    return rows
      .filter((row) => showable.has(row.professionalId))
      .map((row) => ({
        serviceId: row.id,
        professionalId: row.professionalId,
        name: row.name,
        priceToman: row.priceToman,
        durationMinutes: row.durationMinutes,
      }));
  }
}
