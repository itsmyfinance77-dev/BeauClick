import type { WishlistTargetRef } from '@beauclick/wishlist-contract';

/**
 * The search engine port.
 *
 * `SearchService` and every controller above it speak only in these types.
 * The word "OpenSearch" appears nowhere outside `opensearch/`, and no
 * OpenSearch response shape leaks past this boundary -- §8's requirement that
 * the API must not expose internal search implementation details is therefore
 * a structural property, not a review checklist item.
 *
 * It also buys the thing that made this phase testable at all: an in-memory
 * implementation that the fast suite runs against, so query-construction
 * logic, ranking assembly, and the degraded path all have real unit tests
 * without a search cluster, while the analyzer/relevance behaviour -- the part
 * a fake genuinely cannot vouch for -- is verified against a real engine.
 */

export interface ProviderSearchDocument {
  professionalId: string;
  revision: number;
  displayName: string;
  bio: string | null;
  cityId: string | null;
  cityName: string | null;
  specialtyIds: string[];
  specialtyNames: string[];
  verificationStatus: string;
  isVerified: boolean;
  services: Array<{ serviceId: string; name: string; priceToman: number; durationMinutes: number }>;
  serviceNames: string[];
  minPriceToman: number | null;
  maxPriceToman: number | null;
  ratingAvg: number;
  reviewCount: number;
  completedBookings: number;
  rankingScore: number;
  rankingSignalKeys: string[];
  /**
   * Imagery (V3.1 Phase C).
   *
   * URLs rather than media ids: the consumer of this shape is a browser
   * rendering a result card, and resolving an id would mean search-service
   * knowing about the media module -- a dependency ADR-011 forbids -- or a
   * second round trip per result.
   */
  avatarUrl: string | null;
  avatarWidth: number | null;
  avatarHeight: number | null;
  portfolioCount: number;
  portfolioPreviewUrls: string[];
  indexedAt: string;
}

export type SearchSort = 'relevance' | 'ranking' | 'price_asc' | 'price_desc' | 'rating';

export interface ProviderSearchCriteria {
  /** Raw user text. Normalization is the engine's job, not the caller's. */
  query?: string;
  cityId?: string;
  specialtyIds?: string[];
  minPriceToman?: number;
  maxPriceToman?: number;
  minRating?: number;
  verifiedOnly?: boolean;
  sort: SearchSort;
  page: number;
  pageSize: number;
}

export interface SearchFacetBucket {
  key: string;
  label: string | null;
  count: number;
}

export interface ProviderSearchResult {
  total: number;
  /** True when `total` is a lower bound rather than exact (engines cap deep counts). */
  totalIsLowerBound: boolean;
  items: ProviderSearchDocument[];
  facets: {
    cities: SearchFacetBucket[];
    specialties: SearchFacetBucket[];
    verification: SearchFacetBucket[];
    priceRanges: SearchFacetBucket[];
  };
  tookMs: number;
}

export interface AutocompleteSuggestion {
  /** What to show. */
  text: string;
  /** What it refers to, so the UI can route a specialty differently from a provider. */
  kind: 'professional' | 'specialty' | 'service';
  professionalId: string | null;
}

/**
 * The engine abstraction.
 *
 * Note `ensureIndex` and `swapAlias`: index lifecycle is part of the port
 * rather than an OpenSearch-only concern, because a zero-downtime reindex is
 * a REQUIREMENT of the domain (§5) and any engine behind this port has to
 * offer some way to satisfy it. Leaving it out would push the reindex
 * procedure into the adapter and make it untestable from the service.
 */
export interface SearchEnginePort {
  /** Creates the physical index with the current mapping if absent. Idempotent. */
  ensureIndex(physicalIndex: string): Promise<void>;
  /** Points the alias at `physicalIndex`, atomically removing it from any other index. */
  swapAlias(alias: string, physicalIndex: string): Promise<void>;
  /** True if the engine is reachable. Used by health and by the degraded-path decision. */
  ping(): Promise<boolean>;

  indexDocuments(physicalIndex: string, documents: ProviderSearchDocument[]): Promise<void>;
  deleteDocument(physicalIndex: string, professionalId: string): Promise<void>;
  /** Removes every document. Used by tests and by a rebuild-in-place. */
  clear(physicalIndex: string): Promise<void>;
  documentCount(alias: string): Promise<number>;

  search(alias: string, criteria: ProviderSearchCriteria): Promise<ProviderSearchResult>;
  autocomplete(alias: string, prefix: string, limit: number): Promise<AutocompleteSuggestion[]>;
}

export const SEARCH_ENGINE = Symbol('BEAUCLICK_SEARCH_ENGINE');

/**
 * How search-service rebuilds its projection when the projection itself is
 * gone -- implemented by the composition root, which is the only place
 * allowed to read provider-service's data (ADR-011).
 *
 * Deliberately a port rather than a direct import: search-service depending on
 * provider-service would be a module-boundary violation caught by lint, and
 * more importantly would make search undeployable without provider -- the
 * exact coupling V2's synchronous `Indexer::sync()` call created.
 */
export interface ProviderReindexSourcePort {
  /** One page of professionals, ordered by id, for a full rebuild. */
  fetchProfessionalsForReindex(
    afterId: string | null,
    limit: number,
  ): Promise<
    Array<{
      professionalId: string;
      revision: number;
      displayName: string;
      bio: string | null;
      cityId: string | null;
      cityName: string | null;
      specialtyIds: string[];
      specialtyNames: string[];
      verificationStatus: string;
      isDeleted: boolean;
      updatedAt: Date;
      services: Array<{ serviceId: string; name: string; priceToman: number; durationMinutes: number }>;
      /**
       * Imagery, carried through the rebuild path (V3.1 Phase C).
       *
       * Present here for the same reason `services` is: a projection rebuilt
       * from source must produce the SAME document a live event stream would,
       * or a rebuild silently strips every professional's avatar and portfolio
       * until each of them next edits something.
       */
      media: {
        avatarUrl: string | null;
        avatarWidth: number | null;
        avatarHeight: number | null;
        portfolioCount: number;
        portfolioPreviewUrls: string[];
      };
    }>
  >;
}

export const PROVIDER_REINDEX_SOURCE = Symbol('BEAUCLICK_PROVIDER_REINDEX_SOURCE');

/**
 * The caller's own saved state, for the results this module just returned
 * (V3.2-C Story #9, ADR-034).
 *
 * ## Why a port, and why the state is not indexed
 *
 * The obvious implementation is a field on the search document, and it is wrong
 * for a reason worth writing down: a saved item belongs to ONE customer, and the
 * index holds ONE document per professional shared by every customer who
 * searches. Storing it there would mean either a document per (professional,
 * customer) pair, or a per-customer filter on a shared document — the first is
 * unbounded, the second is a privacy hazard one query-builder mistake away from
 * showing one customer another's list.
 *
 * So the saved state is **hydrated after the search**, from the authoritative
 * table, for the caller alone. That also makes it strictly consistent while the
 * results around it stay eventually consistent, which is the correct way round:
 * a customer who just tapped save must see it reflected on the next page load
 * even though the index has not moved.
 *
 * `search` may not import `wishlist` (ADR-011), so it declares this and the
 * composition root binds it — the same shape `PROVIDER_REINDEX_SOURCE` above
 * already has. `@beauclick/wishlist-contract` IS importable: `scope:shared`,
 * zero dependencies, and it exists so the two sides share a vocabulary without
 * sharing a module.
 *
 * ## What it must never become
 *
 * There is no method here that returns a count, a total, or anything about a
 * customer other than the one named in the call — and therefore no way for a
 * save to become a ranking input. `V32-DEC-021` refuses a popularity signal
 * outright, and the refusal is structural rather than a filter somebody has to
 * remember: this port cannot express one, and `ranking.ts` is not touched by
 * this story.
 */
export interface WishlistSavedTargetsPort {
  /**
   * Which of `targets` the customer `userId` has saved, as a set of
   * `"{targetType}:{targetId}"` keys.
   *
   * `userId` is always the session-resolved caller. Search is a `@Public()`
   * surface, so there may be no caller at all — in which case this port is not
   * called and the saved state is reported as `null` rather than `false`.
   *
   * Batched: one call for the whole page, never one per result.
   */
  savedTargets(userId: string, targets: readonly WishlistTargetRef[]): Promise<ReadonlySet<string>>;
}

export const WISHLIST_SAVED_TARGETS = Symbol('BEAUCLICK_SEARCH_WISHLIST_SAVED_TARGETS');
