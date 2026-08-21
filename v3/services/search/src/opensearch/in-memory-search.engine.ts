import {
  AutocompleteSuggestion,
  ProviderSearchCriteria,
  ProviderSearchDocument,
  ProviderSearchResult,
  SearchEnginePort,
} from '../ports';

/**
 * An in-memory `SearchEnginePort` for the fast test layer and for local
 * development without a search cluster.
 *
 * What it is honestly for, and what it is NOT:
 *
 * It exists so that filtering, sorting, pagination, facet assembly, the
 * degraded-path decision, and every caller of the port can be tested without
 * a cluster. Those behaviours are engine-independent, and testing them against
 * a fake is not a weaker test -- it is the same test, faster.
 *
 * It is emphatically NOT evidence about relevance, fuzzy matching, Persian
 * analysis, or scoring. Its text match is a normalized substring check, which
 * is the very mechanism GAP-14 exists to retire. Every claim about those
 * properties in this phase is backed by a test against a REAL OpenSearch
 * instance, and any future author tempted to assert Persian matching against
 * this class should read this paragraph first.
 *
 * That distinction is the same one Phase 2 drew about pg-mem: a fast layer is
 * legitimate for what it can actually vouch for, and dangerous the moment it
 * is trusted beyond that.
 */
export class InMemorySearchEngine implements SearchEnginePort {
  private readonly indices = new Map<string, Map<string, ProviderSearchDocument>>();
  private readonly aliases = new Map<string, string>();
  /** Test seam: make the engine fail so the degraded path can be exercised. */
  available = true;

  async ping(): Promise<boolean> {
    return this.available;
  }

  /**
   * Test seam: drop every index and alias.
   *
   * Needed because this engine is a process-wide singleton in the DI
   * container, so truncating PostgreSQL between cases does NOT clear it --
   * documents would accumulate across a suite and make every count assertion
   * depend on execution order.
   */
  reset(): void {
    this.indices.clear();
    this.aliases.clear();
    this.available = true;
  }

  async ensureIndex(physicalIndex: string): Promise<void> {
    this.assertAvailable();
    if (!this.indices.has(physicalIndex)) this.indices.set(physicalIndex, new Map());
  }

  async swapAlias(alias: string, physicalIndex: string): Promise<void> {
    this.assertAvailable();
    await this.ensureIndex(physicalIndex);
    this.aliases.set(alias, physicalIndex);
  }

  async indexDocuments(physicalIndex: string, documents: ProviderSearchDocument[]): Promise<void> {
    this.assertAvailable();
    await this.ensureIndex(physicalIndex);
    const index = this.indices.get(physicalIndex)!;
    for (const doc of documents) index.set(doc.professionalId, doc);
  }

  async deleteDocument(physicalIndex: string, professionalId: string): Promise<void> {
    this.assertAvailable();
    this.indices.get(physicalIndex)?.delete(professionalId);
  }

  async clear(physicalIndex: string): Promise<void> {
    this.indices.get(physicalIndex)?.clear();
  }

  async documentCount(alias: string): Promise<number> {
    return this.resolve(alias).size;
  }

  async search(alias: string, criteria: ProviderSearchCriteria): Promise<ProviderSearchResult> {
    this.assertAvailable();
    const all = Array.from(this.resolve(alias).values());
    const matched = all.filter((doc) => this.matches(doc, criteria));
    const sorted = this.sort(matched, criteria.sort);
    const from = (criteria.page - 1) * criteria.pageSize;

    return {
      total: matched.length,
      totalIsLowerBound: false,
      items: sorted.slice(from, from + criteria.pageSize),
      facets: {
        cities: this.bucket(matched, (d) => (d.cityName ? [d.cityName] : [])),
        specialties: this.bucket(matched, (d) => d.specialtyNames),
        verification: this.bucket(matched, (d) => [d.verificationStatus]),
        priceRanges: this.bucket(matched, (d) => (d.minPriceToman === null ? [] : [this.priceBand(d.minPriceToman)])),
      },
      tookMs: 0,
    };
  }

  async autocomplete(alias: string, prefix: string, limit: number): Promise<AutocompleteSuggestion[]> {
    this.assertAvailable();
    const normalized = this.normalize(prefix);
    return Array.from(this.resolve(alias).values())
      .filter((doc) => this.normalize(doc.displayName).includes(normalized))
      .sort((a, b) => b.rankingScore - a.rankingScore)
      .slice(0, limit)
      .map((doc) => ({ text: doc.displayName, kind: 'professional' as const, professionalId: doc.professionalId }));
  }

  private assertAvailable(): void {
    if (!this.available) throw new Error('InMemorySearchEngine: simulated outage');
  }

  private resolve(alias: string): Map<string, ProviderSearchDocument> {
    const physical = this.aliases.get(alias) ?? alias;
    return this.indices.get(physical) ?? new Map();
  }

  private matches(doc: ProviderSearchDocument, c: ProviderSearchCriteria): boolean {
    if (c.cityId && doc.cityId !== c.cityId) return false;
    if (c.verifiedOnly && !doc.isVerified) return false;
    if (c.minRating !== undefined && doc.ratingAvg < c.minRating) return false;
    if (c.specialtyIds?.length && !c.specialtyIds.some((id) => doc.specialtyIds.includes(id))) return false;
    if (c.minPriceToman !== undefined && (doc.maxPriceToman ?? -1) < c.minPriceToman) return false;
    if (c.maxPriceToman !== undefined && (doc.minPriceToman ?? Number.MAX_SAFE_INTEGER) > c.maxPriceToman) return false;

    const text = c.query?.trim();
    if (!text) return true;

    // A substring check, and nothing more. See this class's header.
    const haystack = this.normalize(
      [doc.displayName, doc.bio ?? '', doc.cityName ?? '', ...doc.specialtyNames, ...doc.serviceNames].join(' '),
    );
    return this.normalize(text)
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => haystack.includes(term));
  }

  private sort(docs: ProviderSearchDocument[], sort: ProviderSearchCriteria['sort']): ProviderSearchDocument[] {
    const copy = [...docs];
    switch (sort) {
      case 'price_asc':
        return copy.sort((a, b) => (a.minPriceToman ?? Infinity) - (b.minPriceToman ?? Infinity));
      case 'price_desc':
        return copy.sort((a, b) => (b.maxPriceToman ?? -Infinity) - (a.maxPriceToman ?? -Infinity));
      case 'rating':
        return copy.sort((a, b) => b.ratingAvg - a.ratingAvg || b.reviewCount - a.reviewCount);
      case 'ranking':
      case 'relevance':
      default:
        return copy.sort((a, b) => b.rankingScore - a.rankingScore);
    }
  }

  private bucket(
    docs: ProviderSearchDocument[],
    keysOf: (doc: ProviderSearchDocument) => string[],
  ): Array<{ key: string; label: string | null; count: number }> {
    const counts = new Map<string, number>();
    for (const doc of docs) {
      for (const key of keysOf(doc)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  private priceBand(price: number): string {
    if (price < 500_000) return 'under_500k';
    if (price < 1_000_000) return '500k_1m';
    if (price < 2_000_000) return '1m_2m';
    return 'over_2m';
  }

  /**
   * The same folding the real analyzer's char_filter performs, reimplemented
   * only well enough to keep fixtures readable. Not a Persian analyzer.
   */
  private normalize(text: string): string {
    return text
      // ZWNJ, ZWJ, LRM, RLM -- all invisible in source. Written as an
      // alternation rather than a character class on purpose: several of
      // these are joining characters, and `no-misleading-character-class`
      // flags a class of them precisely because adjacent joiners inside `[]`
      // are easy to misread as a single combined glyph.
      .replace(/‌|‍|‎|‏/g, '')
      .replace(/[يى]/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/[أإآ]/g, 'ا')
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .toLowerCase()
      .trim();
  }
}
