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
    }>
  >;
}

export const PROVIDER_REINDEX_SOURCE = Symbol('BEAUCLICK_PROVIDER_REINDEX_SOURCE');
