import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { RequireCapability } from '@beauclick/auth';
import { AutocompleteDto, RecordProfileViewDto, SearchProvidersDto } from './dto/search.dto';
import { SearchIndexerService } from './indexing/search-indexer.service';
import { SearchService } from './search.service';
import { ProviderSearchDocument } from './ports';

/**
 * The public search API.
 *
 * The response shape is deliberately NOT the internal document. `revision`,
 * `rankingScore`, and `indexedAt` are indexing machinery -- exposing them
 * would let a client build a competing ranking model out of the platform's
 * own scores and would freeze internal fields into a public contract.
 * `rankingSignalKeys` IS exposed, because it is the explainability surface a
 * customer benefits from ("verified", "reliable") and V2 already rendered it.
 */
interface PublicProviderResult {
  id: string;
  displayName: string;
  bio: string | null;
  city: { id: string; name: string } | null;
  specialties: string[];
  isVerified: boolean;
  services: Array<{ id: string; name: string; priceToman: number; durationMinutes: number }>;
  priceFromToman: number | null;
  rating: { average: number; count: number };
  badges: string[];
}

function toPublic(doc: ProviderSearchDocument): PublicProviderResult {
  return {
    id: doc.professionalId,
    displayName: doc.displayName,
    bio: doc.bio,
    city: doc.cityId && doc.cityName ? { id: doc.cityId, name: doc.cityName } : null,
    specialties: doc.specialtyNames,
    isVerified: doc.isVerified,
    services: doc.services.map((s) => ({
      id: s.serviceId,
      name: s.name,
      priceToman: s.priceToman,
      durationMinutes: s.durationMinutes,
    })),
    priceFromToman: doc.minPriceToman,
    rating: { average: doc.ratingAvg, count: doc.reviewCount },
    badges: doc.rankingSignalKeys,
  };
}

/**
 * The `read` policy, not `default`: autocomplete is debounced at 250ms by
 * `apps/web/app/search/page.tsx`, so a customer typing normally can
 * legitimately issue ~240 requests a minute. Under the default limit,
 * ordinary typing would rate-limit itself.
 */
@Throttle({ read: {} })
@Controller('v1/search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly indexer: SearchIndexerService,
  ) {}

  /**
   * Public: discovery must work before sign-in, or the marketplace has no
   * front door. `@CurrentUser` is still read when a token happens to be
   * present, so a signed-in customer's searches carry their id for analytics
   * -- but its absence is never an error.
   */
  @Public()
  @Get('providers')
  async searchProviders(@Query() dto: SearchProvidersDto, @CurrentUser() user?: AuthenticatedUser) {
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? 20;

    const result = await this.search.searchProviders(
      {
        query: dto.q,
        cityId: dto.cityId,
        specialtyIds: dto.specialtyIds,
        minPriceToman: dto.minPrice,
        maxPriceToman: dto.maxPrice,
        minRating: dto.minRating,
        verifiedOnly: dto.verifiedOnly,
        sort: dto.sort ?? 'relevance',
        page,
        pageSize,
      },
      user?.userId ?? null,
    );

    return {
      items: result.items.map(toPublic),
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalIsApproximate: result.totalIsLowerBound,
        totalPages: Math.ceil(result.total / pageSize),
      },
      facets: result.facets,
      // Told, not hidden. The UI shows a "results may be incomplete" notice
      // rather than silently presenting a worse result set as a normal one.
      degraded: result.degraded,
    };
  }

  @Public()
  @Get('autocomplete')
  async autocomplete(@Query() dto: AutocompleteDto) {
    const suggestions = await this.search.autocomplete(dto.q, dto.limit ?? 8);
    return { suggestions };
  }

  /**
   * The view half of the conversion ranking signal.
   *
   * A POST from the client, which means it is client-assertable: someone can
   * curl it in a loop. That is accepted deliberately and bounded rather than
   * prevented, because the alternative -- inferring views server-side from
   * profile GETs -- counts crawlers and prefetches as customers, which is
   * worse. What keeps it honest is that the signal it feeds is CAPPED: the
   * conversion term is a bounded 0-1 ratio, is ignored entirely below
   * CONVERSION_MIN_VIEWS, and carries the lowest weight of any signal (0.06).
   * Inflating views can therefore only ever push one provider's conversion
   * toward zero -- it can lower their own score, never raise it.
   */
  @Public()
  @Post('providers/:id/view')
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordView(
    @Param('id', new ParseUUIDPipe()) professionalId: string,
    @Body() dto: RecordProfileViewDto,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<void> {
    await this.search.recordProfileView(professionalId, dto.source ?? 'unknown', user?.userId ?? null);
  }
}

/**
 * Index administration. Capability-gated, never public: a reindex is an
 * expensive, cluster-wide operation and an unauthenticated trigger is a
 * denial-of-service button.
 */
@Controller('v1/admin/search')
export class SearchAdminController {
  constructor(private readonly indexer: SearchIndexerService) {}

  @RequireCapability('bc_manage_platform')
  @Get('status')
  async status() {
    return {
      physicalIndex: await this.indexer.currentPhysicalIndex(),
      pendingDocuments: await this.indexer.pendingCount(),
      stalePendingOverFiveMinutes: await this.indexer.stalePendingCount(300),
    };
  }

  @RequireCapability('bc_manage_platform')
  @Post('reindex')
  @HttpCode(HttpStatus.OK)
  async reindex() {
    return this.indexer.fullReindex();
  }

  /** The deeper recovery: rebuild the projection itself from provider-service. */
  @RequireCapability('bc_manage_platform')
  @Post('rebuild-projection')
  @HttpCode(HttpStatus.OK)
  async rebuildProjection() {
    const rebuilt = await this.indexer.rebuildProjectionFromSource();
    const reindexed = await this.indexer.fullReindex();
    return { projectionRows: rebuilt, ...reindexed };
  }
}
