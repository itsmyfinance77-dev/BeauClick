import { Inject, Injectable, Logger } from '@nestjs/common';
import { logOperation } from '@beauclick/events';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { EVENT_CONTRACT_REGISTRY, EventContractRegistry, ProviderProfileViewed, SearchPerformed, emitContractEvent } from '@beauclick/event-contracts';
import { ProviderDocumentEntity, SearchOutboxEntity } from './entities/search.entities';
import { PROVIDER_INDEX_ALIAS } from './index/provider-index.definition';
import {
  AutocompleteSuggestion,
  ProviderSearchCriteria,
  ProviderSearchResult,
  SEARCH_ENGINE,
  SearchEnginePort,
} from './ports';

export interface SearchOutcome extends ProviderSearchResult {
  /**
   * True when the engine was unreachable and results came from the
   * PostgreSQL projection instead. Surfaced to the caller and to the API
   * response rather than hidden: a degraded result set has no fuzzy matching
   * and no relevance ranking, and presenting it as a normal one would make
   * "search got worse" indistinguishable from "there is nothing to find".
   */
  degraded: boolean;
}

/**
 * The query surface.
 *
 * Two properties worth stating explicitly:
 *
 * **Nothing OpenSearch-shaped crosses this boundary.** The controller above
 * receives `ProviderSearchResult`, which is defined in `ports.ts` and has no
 * `_source`, no `hits`, no `took`-shaped nesting. §8's "do not expose internal
 * OpenSearch implementation details" is satisfied by there being no path for
 * such a detail to travel, not by remembering to strip it.
 *
 * **A search outage degrades rather than fails.** The marketplace's provider
 * list is the app's primary surface; returning a 503 there because a search
 * cluster restarted would take the product down for an infrastructure event
 * the customer has no stake in. The fallback is a plain, honest
 * filtered/ordered read of the projection -- no fuzziness, no relevance -- and
 * it says so.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger('SearchService');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ProviderDocumentEntity) private readonly documents: Repository<ProviderDocumentEntity>,
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEnginePort,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
  ) {}

  async searchProviders(criteria: ProviderSearchCriteria, userId: string | null): Promise<SearchOutcome> {
    const startedAt = Date.now();
    let outcome: SearchOutcome;

    try {
      const result = await this.engine.search(PROVIDER_INDEX_ALIAS, criteria);
      outcome = { ...result, degraded: false };
    } catch (err) {
      this.logger.error(`Search engine unavailable, serving degraded results: ${err instanceof Error ? err.message : String(err)}`);
      outcome = { ...(await this.degradedSearch(criteria)), degraded: true };
    }

    const latencyMs = Date.now() - startedAt;
    // Latency and shape, never the query text. A search query is customer
    // free text and belongs in logs no more than it belongs in an event
    // payload -- which is why the contract has no field able to hold it.
    logOperation(this.logger, 'search.providers', {
      latencyMs,
      degraded: outcome.degraded,
      results: outcome.total,
      queryClass: this.classifyQuery(criteria),
      filters: this.activeFilterKeys(criteria).length,
    });

    await this.recordSearchPerformed(criteria, outcome, userId, latencyMs);
    return outcome;
  }

  async autocomplete(prefix: string, limit: number): Promise<AutocompleteSuggestion[]> {
    try {
      return await this.engine.autocomplete(PROVIDER_INDEX_ALIAS, prefix, limit);
    } catch {
      // Autocomplete has no degraded mode worth building: a prefix query
      // against the projection would be a LIKE scan -- exactly the mechanism
      // GAP-14 exists to retire. An empty suggestion list is a correct,
      // silent, harmless outcome; a slow wrong one is not.
      return [];
    }
  }

  /**
   * Records the profile-view signal.
   *
   * Produced by search-service rather than provider-service on purpose: it is
   * a DISCOVERY fact (someone looked at this provider, having come from
   * somewhere), not a provider-domain fact, and provider-service has no
   * business knowing that ranking or analytics exist.
   */
  async recordProfileView(professionalId: string, source: 'search' | 'direct' | 'journey' | 'unknown', userId: string | null): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await emitContractEvent(this.contracts, manager, SearchOutboxEntity, ProviderProfileViewed, {
        aggregateId: professionalId,
        payload: {
          entityType: 'provider',
          professionalId,
          source,
          userId,
          occurredAt: new Date().toISOString(),
        },
      });
    });
  }

  /**
   * The privacy-safe search fact.
   *
   * The query text is reduced to a CLASS and a term count before it ever
   * reaches an event payload. `SearchPerformed`'s contract has no field that
   * could hold the text, so this is enforced by the schema rather than by this
   * function remembering to redact -- V2's redaction discipline, made
   * structural.
   */
  private async recordSearchPerformed(
    criteria: ProviderSearchCriteria,
    outcome: SearchOutcome,
    userId: string | null,
    tookMs: number,
  ): Promise<void> {
    const text = criteria.query?.trim() ?? '';
    const filterKeys = this.activeFilterKeys(criteria);
    const queryClass = this.classifyQuery(criteria);

    try {
      await this.dataSource.transaction(async (manager) => {
        await emitContractEvent(this.contracts, manager, SearchOutboxEntity, SearchPerformed, {
          aggregateId: uuidv7(),
          payload: {
            searchId: uuidv7(),
            queryClass,
            queryTermCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
            filterKeys,
            sort: criteria.sort,
            resultCount: outcome.total,
            page: criteria.page,
            tookMs,
            degraded: outcome.degraded,
            userId,
            occurredAt: new Date().toISOString(),
          },
        });
      });
    } catch (err) {
      // Analytics must never break search. A failure to record the fact is
      // logged and dropped -- the customer's results are already computed and
      // are what they came for.
      this.logger.warn(`Failed to record SearchPerformed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The shape of a query, which is the most that may be recorded about it.
   *
   * Shared by the event and the log line deliberately: two independent
   * classifications of the same thing drift, and the moment they disagree the
   * tempting fix is to log the raw query "just to compare".
   */
  private classifyQuery(criteria: ProviderSearchCriteria): 'text_and_filtered' | 'text' | 'filtered' | 'empty' {
    const hasText = (criteria.query?.trim() ?? '').length > 0;
    const hasFilters = this.activeFilterKeys(criteria).length > 0;
    if (hasText) return hasFilters ? 'text_and_filtered' : 'text';
    return hasFilters ? 'filtered' : 'empty';
  }

  private activeFilterKeys(criteria: ProviderSearchCriteria): string[] {
    const keys: string[] = [];
    if (criteria.cityId) keys.push('city');
    if (criteria.specialtyIds?.length) keys.push('specialty');
    if (criteria.minPriceToman !== undefined || criteria.maxPriceToman !== undefined) keys.push('price');
    if (criteria.minRating !== undefined) keys.push('rating');
    if (criteria.verifiedOnly) keys.push('verified');
    return keys;
  }

  /**
   * The fallback path: a plain, bounded query against the projection.
   *
   * Deliberately NOT an attempt to reproduce relevance in SQL. There is no
   * text matching here at all beyond a normalized substring -- reimplementing
   * fuzzy Persian matching in PostgreSQL would be a second, untested search
   * engine that only runs when the real one is broken, which is the worst
   * possible time to discover it is wrong.
   */
  private async degradedSearch(criteria: ProviderSearchCriteria): Promise<ProviderSearchResult> {
    const qb = this.documents
      .createQueryBuilder('d')
      .where('d.is_deleted = false');

    if (criteria.cityId) qb.andWhere('d.city_id = :cityId', { cityId: criteria.cityId });
    if (criteria.verifiedOnly) qb.andWhere("d.verification_status = 'verified'");
    if (criteria.specialtyIds?.length) {
      qb.andWhere('d.specialty_ids && :specialtyIds::uuid[]', { specialtyIds: criteria.specialtyIds });
    }
    if (criteria.minPriceToman !== undefined) {
      qb.andWhere('d.max_price_toman >= :minPrice', { minPrice: criteria.minPriceToman });
    }
    if (criteria.maxPriceToman !== undefined) {
      qb.andWhere('d.min_price_toman <= :maxPrice', { maxPrice: criteria.maxPriceToman });
    }
    if (criteria.query?.trim()) {
      qb.andWhere('(d.display_name ILIKE :q OR d.city_name ILIKE :q)', { q: `%${criteria.query.trim()}%` });
    }

    const [rows, total] = await qb
      .orderBy('d.ranking_score', 'DESC')
      .skip((criteria.page - 1) * criteria.pageSize)
      .take(criteria.pageSize)
      .getManyAndCount();

    return {
      total,
      totalIsLowerBound: false,
      items: rows.map((row) => ({
        professionalId: row.professionalId,
        revision: row.revision,
        displayName: row.displayName,
        bio: row.bio,
        cityId: row.cityId,
        cityName: row.cityName,
        specialtyIds: row.specialtyIds ?? [],
        specialtyNames: row.specialtyNames ?? [],
        verificationStatus: row.verificationStatus,
        isVerified: row.verificationStatus === 'verified',
        services: row.services ?? [],
        serviceNames: (row.services ?? []).map((s) => s.name),
        minPriceToman: row.minPriceToman,
        maxPriceToman: row.maxPriceToman,
        ratingAvg: 0,
        reviewCount: 0,
        completedBookings: 0,
        // Imagery is served from the projection on the degraded path too:
        // an engine outage should cost relevance, not pictures.
        avatarUrl: row.avatarUrl ?? null,
        avatarWidth: row.avatarWidth ?? null,
        avatarHeight: row.avatarHeight ?? null,
        portfolioCount: row.portfolioCount ?? 0,
        portfolioPreviewUrls: row.portfolioPreviewUrls ?? [],
        rankingScore: row.rankingScore,
        rankingSignalKeys: row.rankingSignalKeys ?? [],
        indexedAt: (row.indexedAt ?? row.updatedAt).toISOString(),
      })),
      // Facets are genuinely absent in the degraded path rather than faked:
      // an empty facet list renders as "no filters available", which is true.
      // Fabricated counts would silently mislead.
      facets: { cities: [], specialties: [], verification: [], priceRanges: [] },
      tookMs: 0,
    };
  }
}
