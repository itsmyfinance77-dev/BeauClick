import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public, policy } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { RequireCapability } from '@beauclick/auth';
import { AdminAuditService, AuditAction } from '@beauclick/audit';
import { wishlistTargetKey } from '@beauclick/wishlist-contract';
import type { WishlistSavedState } from '@beauclick/wishlist-contract';
import { AutocompleteDto, RecordProfileViewDto, SearchProvidersDto } from './dto/search.dto';
import { SearchIndexerService } from './indexing/search-indexer.service';
import { SearchService } from './search.service';
import { ProviderSearchDocument, WISHLIST_SAVED_TARGETS, WishlistSavedTargetsPort } from './ports';

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
  /**
   * Whether the AUTHENTICATED caller has saved this professional (V3.2-C Story
   * #9), or `null` when there is no caller.
   *
   * `null` rather than `false` for an anonymous visitor, because `false` is a
   * claim about somebody the server cannot identify. `WishlistSavedState`
   * documents the tri-state; the same always-present-with-explicit-nulls
   * treatment the public professional shape already gives `images` and `rating`.
   *
   * **This is never an aggregate.** There is no count of how many customers
   * saved this professional anywhere in this response, and no such field exists
   * to be added by accident — `V32-DEC-021` refuses a public popularity signal
   * outright, and `badges` continues to carry `rankingSignalKeys` and nothing
   * else.
   *
   * The nested `services` deliberately do NOT carry this field. A service's own
   * saved state is served by `GET /v1/providers/:id/services`, where the batch is
   * bounded by one professional's catalogue; hydrating every service of every
   * result here would make the batch grow with a product nobody controls, and a
   * capped batch would report saved services as unsaved — a wrong answer where
   * an absent field is an honest one.
   */
  saved: WishlistSavedState;
}

function toPublic(doc: ProviderSearchDocument, saved: WishlistSavedState): PublicProviderResult {
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
    // Last, so the additive field is additive in the serialised order too.
    saved,
  };
}

/**
 * The `read` policy, not `default`: autocomplete is debounced at 250ms by
 * `apps/web/app/search/page.tsx`, so a customer typing normally can
 * legitimately issue ~240 requests a minute. Under the default limit,
 * ordinary typing would rate-limit itself.
 */
@Throttle(policy('read'))
@Controller('v1/search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly indexer: SearchIndexerService,
    /**
     * Bound by the composition root and by nothing else. `SearchModule` provides
     * no default, so a composition that forgets it fails to boot rather than
     * quietly reporting `saved: null` for every signed-in customer forever.
     */
    @Inject(WISHLIST_SAVED_TARGETS) private readonly wishlist: WishlistSavedTargetsPort,
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

    /**
     * ONE call for the page, after the search, for the caller alone.
     *
     * Skipped entirely for an anonymous visitor — there is no subject to ask
     * about, so there is no query and every result reports `null`. That is not
     * an optimisation: issuing a saved-state query for a caller the server
     * cannot identify would require inventing a subject.
     *
     * Ordering matters. The saved state is read AFTER the engine has chosen and
     * ranked the results, so it cannot influence which results appear or where —
     * the search is identical for a signed-in and a signed-out caller, and a
     * save can never become a ranking signal (`V32-DEC-021`).
     */
    const saved = user
      ? await this.wishlist.savedTargets(
          // From the verified JWT. `searchProviders` is `@Public()`, so this is
          // the only identity in play and it is never read from the query string.
          user.userId,
          result.items.map((doc) => ({ targetType: 'professional' as const, targetId: doc.professionalId })),
        )
      : null;

    return {
      items: result.items.map((doc) =>
        toPublic(
          doc,
          // The key is built by the contract's own function, not by a template
          // literal here — this side and the wishlist side must agree, and a
          // second format is how they would stop.
          saved ? saved.has(wishlistTargetKey({ targetType: 'professional', targetId: doc.professionalId })) : null,
        ),
      ),
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
  constructor(
    private readonly indexer: SearchIndexerService,
    private readonly audit: AdminAuditService,
  ) {}

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
  @AuditAction('search.reindex_triggered', {
    transactional: false,
    because:
      'A reindex writes to OpenSearch. No PostgreSQL transaction can span an external index, so the record follows the operation rather than accompanying it.',
  })
  @Post('reindex')
  @HttpCode(HttpStatus.OK)
  async reindex(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.indexer.fullReindex();
    await this.audit.recordDetached({
      actorUserId: user.userId,
      action: 'search.reindex_triggered',
      targetType: 'search_index',
      targetId: 'provider_index',
      after: { indexed: Number(result?.indexed ?? 0) },
      reason: null,
    });
    return result;
  }

  /** The deeper recovery: rebuild the projection itself from provider-service. */
  @RequireCapability('bc_manage_platform')
  @AuditAction('search.projection_rebuilt', {
    transactional: false,
    because:
      'Rebuilds the projection AND reindexes OpenSearch -- the deeper of the two recovery actions, and the same external-system boundary as reindex.',
  })
  @Post('rebuild-projection')
  @HttpCode(HttpStatus.OK)
  async rebuildProjection(@CurrentUser() user: AuthenticatedUser) {
    const rebuilt = await this.indexer.rebuildProjectionFromSource();
    const reindexed = await this.indexer.fullReindex();
    await this.audit.recordDetached({
      actorUserId: user.userId,
      action: 'search.projection_rebuilt',
      targetType: 'search_index',
      targetId: 'provider_index',
      after: { projectionRows: Number(rebuilt ?? 0), indexed: Number(reindexed?.indexed ?? 0) },
      reason: null,
    });
    return { projectionRows: rebuilt, ...reindexed };
  }
}
