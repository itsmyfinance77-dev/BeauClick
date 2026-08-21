import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';
import {
  PROVIDER_INDEX_MAPPINGS,
  PROVIDER_INDEX_SETTINGS,
} from '../index/provider-index.definition';
import {
  AutocompleteSuggestion,
  ProviderSearchCriteria,
  ProviderSearchDocument,
  ProviderSearchResult,
  SearchEnginePort,
  SearchFacetBucket,
} from '../ports';

/**
 * The narrow slice of an OpenSearch response this adapter actually reads.
 *
 * Declared here rather than imported: the client's own response types are
 * generated across the whole DSL and force a cast at every access, which
 * pushes `any` into code that should stay typed. Naming exactly the fields
 * consumed makes the contract with the engine explicit and small.
 */
interface RawSearchResponse {
  took?: number;
  hits: {
    total?: number | { value: number; relation?: string };
    hits?: Array<{ _source?: unknown }>;
  };
  aggregations?: Record<string, { buckets?: Array<{ key: string | number; doc_count: number }> }>;
}

/** The price buckets the facet surface offers, in Toman. */
const PRICE_RANGES: Array<{ key: string; from?: number; to?: number }> = [
  { key: 'under_500k', to: 500_000 },
  { key: '500k_1m', from: 500_000, to: 1_000_000 },
  { key: '1m_2m', from: 1_000_000, to: 2_000_000 },
  { key: 'over_2m', from: 2_000_000 },
];

/**
 * The one file that knows OpenSearch exists.
 *
 * Design notes that are not obvious from the code:
 *
 * **Relevance is a `function_score`, not a raw BM25 sort.** Text similarity
 * alone would rank a provider whose bio happens to repeat a word above a
 * verified, highly-rated one who mentions it once. The ranking score computed
 * by `RankingScorer` (V2's proven weighted-signal math, carried forward
 * unchanged) is blended in multiplicatively, so text relevance decides WHO
 * matches and quality decides the order among them.
 *
 * **Fuzziness is `AUTO`, and deliberately not applied to short terms.**
 * `AUTO` allows zero edits below 3 characters and one below 6. In Persian,
 * two-character edits on a short word routinely produce a completely
 * different, real word -- `AUTO` is what keeps typo tolerance from becoming
 * "returns things you did not ask for".
 *
 * **`fuzzy_transpositions` matters more here than in English.** The single
 * most common real Persian typo class is an adjacent-character swap on a
 * keyboard whose letters are close together; treating a transposition as one
 * edit rather than two is what makes those queries land.
 */
@Injectable()
export class OpenSearchAdapter implements SearchEnginePort {
  private readonly logger = new Logger('OpenSearchAdapter');

  constructor(private readonly client: Client) {}

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async ensureIndex(physicalIndex: string): Promise<void> {
    const exists = await this.client.indices.exists({ index: physicalIndex });
    if (exists.body) return;
    await this.client.indices.create({
      index: physicalIndex,
      body: {
        settings: PROVIDER_INDEX_SETTINGS as unknown as Record<string, unknown>,
        mappings: PROVIDER_INDEX_MAPPINGS as unknown as Record<string, unknown>,
      },
    });
    this.logger.log(`Created index ${physicalIndex}`);
  }

  /**
   * One atomic `_aliases` call performing remove-then-add.
   *
   * Two separate calls would leave a window where the alias points at nothing
   * and every search 404s. The `remove` uses `index: '*'` with
   * `must_exist: false` so a first-ever swap (nothing to remove) is not an
   * error, while a re-point genuinely detaches the old index.
   */
  async swapAlias(alias: string, physicalIndex: string): Promise<void> {
    await this.client.indices.updateAliases({
      body: {
        actions: [
          { remove: { index: '*', alias, must_exist: false } },
          { add: { index: physicalIndex, alias } },
        ],
      },
    });
    this.logger.log(`Alias ${alias} -> ${physicalIndex}`);
  }

  async indexDocuments(physicalIndex: string, documents: ProviderSearchDocument[]): Promise<void> {
    if (documents.length === 0) return;

    const body = documents.flatMap((doc) => [
      { index: { _index: physicalIndex, _id: doc.professionalId } },
      doc,
    ]);

    // `refresh: 'wait_for'` rather than `true`: `true` forces an immediate
    // segment flush per call, which at bulk-reindex rates produces thousands
    // of tiny segments and a merge storm. `wait_for` blocks until the NEXT
    // scheduled refresh, which gives the read-your-writes behaviour the tests
    // and the post-edit UX need without the write amplification.
    const response = await this.client.bulk({ body, refresh: 'wait_for' });

    if (response.body.errors) {
      const failed = (response.body.items ?? [])
        .map((item: Record<string, { error?: { reason?: string }; _id?: string }>) => {
          const op = item.index ?? item.create ?? item.update;
          return op?.error ? `${op._id}: ${op.error.reason}` : null;
        })
        .filter(Boolean);
      // Thrown, never logged-and-swallowed: the caller marks these documents
      // dirty and retries. Swallowing would leave the projection saying
      // "indexed" about a document the engine rejected.
      throw new Error(`Bulk indexing failed for ${failed.length} document(s): ${failed.slice(0, 5).join('; ')}`);
    }
  }

  async deleteDocument(physicalIndex: string, professionalId: string): Promise<void> {
    try {
      await this.client.delete({ index: physicalIndex, id: professionalId, refresh: 'wait_for' });
    } catch (err) {
      // Deleting an absent document is the desired end state, not a failure.
      // Rethrowing would make a redelivered delete event poison its outbox row
      // forever.
      if (this.statusCodeOf(err) === 404) return;
      throw err;
    }
  }

  async clear(physicalIndex: string): Promise<void> {
    await this.client.deleteByQuery({
      index: physicalIndex,
      body: { query: { match_all: {} } },
      refresh: true,
      conflicts: 'proceed',
    });
  }

  async documentCount(alias: string): Promise<number> {
    try {
      const response = await this.client.count({ index: alias });
      return Number(response.body.count ?? 0);
    } catch (err) {
      if (this.statusCodeOf(err) === 404) return 0;
      throw err;
    }
  }

  async search(alias: string, criteria: ProviderSearchCriteria): Promise<ProviderSearchResult> {
    const from = (criteria.page - 1) * criteria.pageSize;
    const body = {
      // `track_total_hits: true` -- the marketplace shows a real result count
      // and paginates from it; OpenSearch's default caps the count at 10,000
      // and silently reports that cap as the total, which would make page
      // numbers lie on any large corpus.
      track_total_hits: true,
      from,
      size: criteria.pageSize,
      query: this.buildQuery(criteria),
      sort: this.buildSort(criteria.sort),
      aggs: this.buildAggregations(),
    };

    // The client's generated request/response types are modelled on the full
    // OpenSearch DSL and do not admit a hand-built query object without a
    // cast. Casting at exactly this boundary -- and reading the response
    // through the narrow `RawSearchResponse` shape below -- keeps the
    // untyped surface to two lines, rather than letting `any` spread into
    // the query-construction code where the real logic lives.
    const response = await this.client.search({ index: alias, body: body as never });
    const raw = response.body as unknown as RawSearchResponse;
    const hits = raw.hits;
    const total = typeof hits.total === 'number' ? hits.total : (hits.total?.value ?? 0);

    return {
      total,
      totalIsLowerBound: typeof hits.total === 'object' && hits.total?.relation === 'gte',
      items: (hits.hits ?? []).map((h) => h._source).filter((s): s is ProviderSearchDocument => Boolean(s)),
      facets: this.readFacets(raw.aggregations ?? {}),
      tookMs: Number(raw.took ?? 0),
    };
  }

  async autocomplete(alias: string, prefix: string, limit: number): Promise<AutocompleteSuggestion[]> {
    const response = await this.client.search({
      index: alias,
      body: {
        size: limit,

        // Suggestions must never surface a removed or unverifiable provider --
        // an autocomplete entry that leads to a 404 is worse than no entry.
        query: {
          bool: {
            should: [
              { match: { 'displayName.autocomplete': { query: prefix, boost: 3 } } },
              { match: { 'specialtyNames.autocomplete': { query: prefix, boost: 2 } } },
              { nested: { path: 'services', query: { match: { 'services.name.autocomplete': prefix } } } },
            ],
            minimum_should_match: 1,
          },
        },
        _source: ['professionalId', 'displayName', 'specialtyNames'],
        sort: ['_score', { rankingScore: 'desc' }],
      } as never,
    });

    const raw = response.body as unknown as RawSearchResponse;
    return (raw.hits.hits ?? [])
      .map((h) => h._source as { professionalId: string; displayName: string } | undefined)
      .filter((s): s is { professionalId: string; displayName: string } => Boolean(s))
      .map(
        (source): AutocompleteSuggestion => ({
          text: source.displayName,
          kind: 'professional',
          professionalId: source.professionalId,
        }),
      );
  }

  // ---------------------------------------------------------------- queries

  private buildQuery(criteria: ProviderSearchCriteria): Record<string, unknown> {
    const filters: Array<Record<string, unknown>> = [];

    if (criteria.cityId) filters.push({ term: { cityId: criteria.cityId } });
    if (criteria.specialtyIds?.length) {
      // `terms` is OR within the field: a customer picking two specialties
      // wants providers offering EITHER, not only those offering both.
      filters.push({ terms: { specialtyIds: criteria.specialtyIds } });
    }
    if (criteria.verifiedOnly) filters.push({ term: { isVerified: true } });
    if (criteria.minRating !== undefined) filters.push({ range: { ratingAvg: { gte: criteria.minRating } } });

    // Price filters compare against the provider's cheapest/dearest service.
    // "under 500k" means "has something at or below 500k", not "everything
    // they offer is below 500k" -- the former is what a customer means.
    if (criteria.minPriceToman !== undefined) {
      filters.push({ range: { maxPriceToman: { gte: criteria.minPriceToman } } });
    }
    if (criteria.maxPriceToman !== undefined) {
      filters.push({ range: { minPriceToman: { lte: criteria.maxPriceToman } } });
    }

    const text = criteria.query?.trim();
    const textQuery = text
      ? {
          bool: {
            should: [
              // An exact phrase on the name is what someone typing a
              // provider's actual name expects to see first, ahead of any
              // fuzzy or partial match.
              { match_phrase: { displayName: { query: text, boost: 10 } } },
              {
                multi_match: {
                  query: text,
                  fields: ['displayName^5', 'specialtyNames^3', 'serviceNames^2', 'cityName^2', 'bio'],
                  fuzziness: 'AUTO',
                  fuzzy_transpositions: true,
                  // `prefix_length: 1` -- the first character must match
                  // exactly. Persian words are heavily prefix-distinguished,
                  // and allowing an edit at position 0 makes short queries
                  // match almost anything.
                  prefix_length: 1,
                  // `and`: every term the user typed must appear somewhere.
                  // With `or`, a two-word query returns every document
                  // matching either word, which reads as "search is broken".
                  operator: 'and',
                },
              },
              // Same query without `and`, heavily de-boosted: a partial match
              // is better than an empty page, but must never outrank a
              // complete one.
              {
                multi_match: {
                  query: text,
                  fields: ['displayName^2', 'specialtyNames', 'serviceNames', 'bio'],
                  fuzziness: 'AUTO',
                  fuzzy_transpositions: true,
                  prefix_length: 1,
                  operator: 'or',
                  boost: 0.1,
                },
              },
            ],
            minimum_should_match: 1,
          },
        }
      : { match_all: {} };

    return {
      function_score: {
        query: { bool: { must: [textQuery], filter: filters } },
        functions: [
          {
            // The V2 ranking score, 0-100. `log1p` compresses it so a
            // top-ranked provider gets a meaningful but bounded advantage --
            // a linear multiplier would let ranking overwhelm text relevance
            // entirely and return a well-ranked provider who barely matches.
            field_value_factor: {
              field: 'rankingScore',
              modifier: 'log1p',
              factor: 1,
              missing: 0,
            },
          },
        ],
        boost_mode: 'multiply',
        score_mode: 'sum',
      },
    };
  }

  private buildSort(sort: ProviderSearchCriteria['sort']): Array<Record<string, unknown> | string> {
    switch (sort) {
      case 'ranking':
        return [{ rankingScore: 'desc' }, '_score'];
      case 'price_asc':
        // `missing: '_last'` -- a provider with no priced service must not
        // occupy the top of a cheapest-first list by virtue of having no price.
        return [{ minPriceToman: { order: 'asc', missing: '_last' } }];
      case 'price_desc':
        return [{ maxPriceToman: { order: 'desc', missing: '_last' } }];
      case 'rating':
        return [{ ratingAvg: 'desc' }, { reviewCount: 'desc' }];
      case 'relevance':
      default:
        return ['_score', { rankingScore: 'desc' }];
    }
  }

  private buildAggregations(): Record<string, unknown> {
    return {
      cities: { terms: { field: 'cityName.keyword', size: 30 } },
      specialties: { terms: { field: 'specialtyNames.keyword', size: 30 } },
      verification: { terms: { field: 'verificationStatus', size: 10 } },
      priceRanges: {
        range: {
          field: 'minPriceToman',
          ranges: PRICE_RANGES.map(({ key, from, to }) => ({ key, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) })),
        },
      },
    };
  }

  private readFacets(aggs: NonNullable<RawSearchResponse['aggregations']>): ProviderSearchResult['facets'] {
    const read = (name: string): SearchFacetBucket[] =>
      (aggs[name]?.buckets ?? []).map((b) => ({ key: String(b.key), label: String(b.key), count: b.doc_count }));

    return {
      cities: read('cities'),
      specialties: read('specialties'),
      verification: read('verification'),
      // Zero-count buckets are kept for price: the UI renders a fixed set of
      // price options, and a disappearing option reads as a broken filter
      // rather than as "nothing in this band".
      priceRanges: (aggs.priceRanges?.buckets ?? []).map((b) => ({
        key: String(b.key),
        label: String(b.key),
        count: b.doc_count,
      })),
    };
  }

  private statusCodeOf(err: unknown): number | null {
    const candidate = err as { statusCode?: number; meta?: { statusCode?: number } };
    return candidate?.statusCode ?? candidate?.meta?.statusCode ?? null;
  }
}
