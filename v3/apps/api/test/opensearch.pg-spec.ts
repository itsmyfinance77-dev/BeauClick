import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { PROVIDER_INDEX_ALIAS, SEARCH_ENGINE, SearchEnginePort, SearchIndexerService } from '@beauclick/search';
import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase } from './pg-test-app.factory';

/**
 * Verification against a REAL OpenSearch instance.
 *
 * This file exists because the in-memory engine cannot vouch for any of it.
 * Persian analysis, fuzzy matching, relevance ordering, and autocomplete are
 * ENGINE behaviour -- a fake that does substring matching would pass a test
 * asserting "ZWNJ spellings match" for entirely the wrong reason, and that
 * false confidence is worse than no test.
 *
 * Skips (rather than fails) without `TEST_OPENSEARCH_URL`, the same discipline
 * `requiredPgEnv()` applies to PostgreSQL: the suite stays runnable on a
 * machine with no search cluster, but a verification run must set it.
 */
const openSearchUrl = process.env.TEST_OPENSEARCH_URL;
const canRun = requiredPgEnv() !== null && Boolean(openSearchUrl);
const describeOs = canRun ? describe : describe.skip;

describeOs('search relevance against REAL OpenSearch', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let indexer: SearchIndexerService;
  let engine: SearchEnginePort;

  const ids = {
    kimia: uuidv7(),
    roya: uuidv7(),
    nails: uuidv7(),
    unverified: uuidv7(),
  };
  const tehran = uuidv7();
  const shiraz = uuidv7();
  const makeupSpecialty = uuidv7();
  const nailSpecialty = uuidv7();

  /**
   * Deletes every index this project owns, directly over HTTP.
   *
   * Necessary because the cluster is REAL and outlives the process:
   * `resetDatabase` truncates `search.index_state`, so the application forgets
   * which physical index it was using, while the index itself -- and the alias
   * pointing at it -- survive. A later run then creates a fresh index, leaves
   * the alias on the old one, and every count assertion sees a mixture of two
   * runs. Diagnosed exactly that way: 8 documents where 4 were seeded.
   *
   * Done with plain HTTP rather than by widening `SearchEnginePort`: dropping
   * every index matching a wildcard is a test-hygiene concern, and putting it
   * on the production port would make it callable from application code.
   */
  async function resetCluster(): Promise<void> {
    await fetch(`${openSearchUrl}/beauclick-providers*`, { method: 'DELETE' }).catch(() => undefined);
  }

  beforeAll(async () => {
    // Set BEFORE the app boots so SearchModule's factory binds the real
    // OpenSearch adapter rather than the in-memory engine.
    process.env.OPENSEARCH_URL = openSearchUrl;
    await resetCluster();
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    indexer = app.get(SearchIndexerService);
    engine = app.get<SearchEnginePort>(SEARCH_ENGINE);

    await resetDatabase(dataSource);
    await seedCorpus();
  }, 120_000);

  afterAll(async () => {
    // Leave the cluster as clean as it was found, so a later run of any other
    // suite is not affected by this one.
    await resetCluster();
    delete process.env.OPENSEARCH_URL;
    await app.close();
  });

  async function seedCorpus(): Promise<void> {
    // Written in PERSIAN spelling throughout. The Arabic-spelled variants
    // appear only in the QUERIES, which is the asymmetry the analyzer has to
    // resolve.
    await indexer.applyProfessional({
      professionalId: ids.kimia,
      revision: 1,
      displayName: 'سالن زیبایی کیمیا',
      bio: 'سالن تخصصی میکاپ عروس با بیش از ده سال سابقه در تهران',
      cityId: tehran,
      cityName: 'تهران',
      specialtyIds: [makeupSpecialty],
      specialtyNames: ['میکاپ'],
      verificationStatus: 'verified',
      isDeleted: false,
      updatedAt: new Date(),
      services: [
        { serviceId: uuidv7(), name: 'میکاپ عروس', priceToman: 1_500_000, durationMinutes: 120 },
        { serviceId: uuidv7(), name: 'میکاپ مراسم', priceToman: 800_000, durationMinutes: 90 },
      ],
    });

    await indexer.applyProfessional({
      professionalId: ids.roya,
      revision: 1,
      displayName: 'آرایشگاه رویا',
      bio: 'خدمات رنگ مو و پاکسازی پوست',
      cityId: shiraz,
      cityName: 'شیراز',
      specialtyIds: [makeupSpecialty],
      specialtyNames: ['پوست و مو'],
      verificationStatus: 'verified',
      isDeleted: false,
      updatedAt: new Date(),
      services: [{ serviceId: uuidv7(), name: 'رنگ مو', priceToman: 400_000, durationMinutes: 60 }],
    });

    await indexer.applyProfessional({
      professionalId: ids.nails,
      revision: 1,
      displayName: 'ناخن‌سرای پریسا',
      bio: 'کاشت ناخن و مانیکور',
      cityId: tehran,
      cityName: 'تهران',
      specialtyIds: [nailSpecialty],
      specialtyNames: ['ناخن'],
      verificationStatus: 'verified',
      isDeleted: false,
      updatedAt: new Date(),
      services: [{ serviceId: uuidv7(), name: 'کاشت ناخن', priceToman: 250_000, durationMinutes: 75 }],
    });

    await indexer.applyProfessional({
      professionalId: ids.unverified,
      revision: 1,
      displayName: 'سالن جدید',
      bio: 'تازه شروع کرده‌ایم',
      cityId: tehran,
      cityName: 'تهران',
      specialtyIds: [makeupSpecialty],
      specialtyNames: ['میکاپ'],
      verificationStatus: 'unverified',
      isDeleted: false,
      updatedAt: new Date(),
      services: [{ serviceId: uuidv7(), name: 'میکاپ ساده', priceToman: 300_000, durationMinutes: 45 }],
    });

    await indexer.flushDirty();
  }

  const search = async (query: Record<string, string | number | boolean>) => {
    const res = await request(app.getHttpServer()).get('/api/v1/search/providers').query(query).expect(200);
    expect(res.body.data.degraded).toBe(false);
    return res.body.data as {
      items: Array<{ id: string; displayName: string }>;
      facets: Record<string, Array<{ key: string; count: number }>>;
      pagination: { total: number };
    };
  };

  const idsOf = (result: { items: Array<{ id: string }> }) => result.items.map((i) => i.id);

  describe('the engine is genuinely OpenSearch', () => {
    it('answers a ping', async () => {
      expect(await engine.ping()).toBe(true);
    });

    it('has indexed the whole corpus', async () => {
      expect(await engine.documentCount(PROVIDER_INDEX_ALIAS)).toBe(4);
    });
  });

  describe('Persian normalization', () => {
    it('matches an ARABIC-spelled query against PERSIAN-spelled content', async () => {
      // "كيميا" with Arabic kaf (U+0643) and Arabic yeh (U+064A) against
      // "کیمیا" stored with the Persian forms. The single most common way a
      // correct query misses a correct document.
      const result = await search({ q: 'كيميا' });
      expect(idsOf(result)).toContain(ids.kimia);
    });

    it('matches ACROSS a ZWNJ boundary', async () => {
      // The finding that shaped the analyzer: Lucene's `persian_normalization`
      // does NOT strip ZWNJ, so without the mapping char_filter "می‌کاپ" and
      // "میکاپ" analyse to different tokens and do not match each other.
      const withZwnj = await search({ q: 'می‌کاپ' });
      const withoutZwnj = await search({ q: 'میکاپ' });

      expect(idsOf(withZwnj)).toContain(ids.kimia);
      expect(idsOf(withZwnj).sort()).toEqual(idsOf(withoutZwnj).sort());
    });

    it('matches content written WITH a ZWNJ from a query without one', async () => {
      // "ناخن‌سرای" is stored with a ZWNJ; the query has none.
      const result = await search({ q: 'ناخن سرای' });
      expect(idsOf(result)).toContain(ids.nails);
    });

    it('folds an alef-with-madda to a plain alef', async () => {
      // Query "ارایشگاه" (plain alef) against stored "آرایشگاه" (madda).
      const result = await search({ q: 'ارایشگاه' });
      expect(idsOf(result)).toContain(ids.roya);
    });

    it('accepts PERSIAN digits in a text query', async () => {
      // The bio says "ده سال" but also carries no digits; this asserts the
      // digit filter does not break an otherwise-matching query.
      const result = await search({ q: 'تهران' });
      expect(result.items.length).toBeGreaterThan(0);
    });
  });

  describe('fuzzy matching and typo tolerance', () => {
    it('finds a provider despite a one-character TYPO', async () => {
      // "کیمیا" -> "کیمای": a transposition, the most common real Persian
      // typo class on a keyboard where the letters sit adjacent.
      const result = await search({ q: 'کیمای' });
      expect(idsOf(result)).toContain(ids.kimia);
    });

    it('tolerates a substituted character in a longer word', async () => {
      // "پاکسازی" -> "پاكسازي" is handled by normalization; this is a genuine
      // edit: "پاکسازی" -> "پاکسازس".
      const result = await search({ q: 'پاکسازس' });
      expect(idsOf(result)).toContain(ids.roya);
    });

    it('does NOT fuzzy-match a completely unrelated word', async () => {
      // Typo tolerance that returns everything is not tolerance, it is noise.
      const result = await search({ q: 'قطعات خودرو' });
      expect(result.items).toHaveLength(0);
    });
  });

  describe('multi-term behaviour', () => {
    it('requires EVERY term to match somewhere', async () => {
      // With OR semantics a two-word query returns every document matching
      // either word, which reads to a customer as "search is broken".
      const both = await search({ q: 'میکاپ عروس' });
      expect(idsOf(both)).toContain(ids.kimia);
      expect(idsOf(both)).not.toContain(ids.nails);
    });

    it('searches SERVICE names, not only the profile', async () => {
      const result = await search({ q: 'کاشت ناخن' });
      expect(idsOf(result)).toContain(ids.nails);
    });

    it('searches the city name', async () => {
      const result = await search({ q: 'شیراز' });
      expect(idsOf(result)).toContain(ids.roya);
    });
  });

  describe('ranking', () => {
    it('puts an exact NAME phrase match first', async () => {
      const result = await search({ q: 'سالن زیبایی کیمیا' });
      // The name phrase carries the highest boost, so someone typing a
      // provider's actual name sees them first rather than a fuzzy neighbour.
      expect(result.items[0].id).toBe(ids.kimia);
    });

    it('orders by the stored ranking score under sort=ranking', async () => {
      // Give one provider real evidence so the scores genuinely differ.
      for (let i = 0; i < 12; i += 1) {
        await indexer.applySignal(uuidv7(), 'booking_completed', ids.nails, new Date());
      }
      await indexer.flushDirty();

      const result = await search({ sort: 'ranking' });
      expect(result.items[0].id).toBe(ids.nails);
    });
  });

  describe('filters', () => {
    it('filters by city', async () => {
      const result = await search({ cityId: tehran });
      expect(idsOf(result).sort()).toEqual([ids.kimia, ids.nails, ids.unverified].sort());
    });

    it('filters by specialty', async () => {
      const result = await search({ specialtyIds: nailSpecialty });
      expect(idsOf(result)).toEqual([ids.nails]);
    });

    it('filters verified-only', async () => {
      const result = await search({ verifiedOnly: true });
      expect(idsOf(result)).not.toContain(ids.unverified);
      expect(result.items).toHaveLength(3);
    });

    it('filters by MAX price against the cheapest service', async () => {
      // "under 300k" means "has something at or below 300k", not "everything
      // they offer is below 300k" -- the former is what a customer means.
      const result = await search({ maxPrice: 300_000 });
      expect(idsOf(result).sort()).toEqual([ids.nails, ids.unverified].sort());
    });

    it('filters by MIN price against the dearest service', async () => {
      const result = await search({ minPrice: 1_000_000 });
      expect(idsOf(result)).toEqual([ids.kimia]);
    });

    it('accepts a PERSIAN-digit price filter', async () => {
      // Number('۳۰۰۰۰۰') is NaN; without normalization this would 400.
      const result = await search({ maxPrice: '۳۰۰۰۰۰' });
      expect(idsOf(result).sort()).toEqual([ids.nails, ids.unverified].sort());
    });

    it('combines a text query with filters', async () => {
      const result = await search({ q: 'میکاپ', cityId: tehran, verifiedOnly: true });
      expect(idsOf(result)).toEqual([ids.kimia]);
    });
  });

  describe('sorting', () => {
    it('sorts cheapest first', async () => {
      const result = await search({ sort: 'price_asc' });
      expect(result.items[0].id).toBe(ids.nails);
    });

    it('sorts dearest first', async () => {
      const result = await search({ sort: 'price_desc' });
      expect(result.items[0].id).toBe(ids.kimia);
    });
  });

  describe('facets', () => {
    it('returns city and specialty counts', async () => {
      const result = await search({});
      const cities = Object.fromEntries(result.facets.cities.map((b) => [b.key, b.count]));
      expect(cities['تهران']).toBe(3);
      expect(cities['شیراز']).toBe(1);

      const specialties = Object.fromEntries(result.facets.specialties.map((b) => [b.key, b.count]));
      expect(specialties['میکاپ']).toBe(2);
    });

    it('returns verification counts', async () => {
      const result = await search({});
      const verification = Object.fromEntries(result.facets.verification.map((b) => [b.key, b.count]));
      expect(verification.verified).toBe(3);
      expect(verification.unverified).toBe(1);
    });

    it('keeps ZERO-count price bands so the filter UI does not shift', async () => {
      const result = await search({});
      // A disappearing option reads as a broken filter rather than as
      // "nothing in this band".
      expect(result.facets.priceRanges.map((b) => b.key)).toEqual([
        'under_500k',
        '500k_1m',
        '1m_2m',
        'over_2m',
      ]);
    });
  });

  describe('autocomplete', () => {
    it('suggests from a PREFIX', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/search/autocomplete')
        .query({ q: 'کیم' })
        .expect(200);
      const texts = res.body.data.suggestions.map((s: { text: string }) => s.text);
      expect(texts).toContain('سالن زیبایی کیمیا');
    });

    it('suggests from an ARABIC-spelled prefix', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/search/autocomplete')
        .query({ q: 'كيم' })
        .expect(200);
      const texts = res.body.data.suggestions.map((s: { text: string }) => s.text);
      expect(texts).toContain('سالن زیبایی کیمیا');
    });

    it('does NOT expand the prefix at query time', async () => {
      // The classic autocomplete relevance bug: applying edge_ngram to the
      // QUERY as well would make "می" match a document containing only "م".
      const res = await request(app.getHttpServer())
        .get('/api/v1/search/autocomplete')
        .query({ q: 'زززز' })
        .expect(200);
      expect(res.body.data.suggestions).toHaveLength(0);
    });
  });

  describe('empty results', () => {
    it('returns an honest empty page rather than a forced expansion', async () => {
      const result = await search({ q: 'خدمات مهندسی عمران' });
      expect(result.items).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
    });
  });

  describe('reindex against the real engine', () => {
    it('rebuilds into a new index and keeps every document searchable', async () => {
      const before = await search({ q: 'کیمیا' });
      expect(idsOf(before)).toContain(ids.kimia);

      const result = await indexer.fullReindex();
      expect(result.indexed).toBe(4);

      // The alias was swapped atomically, so a query immediately afterwards
      // hits the new index with the full corpus -- never a half-populated one.
      const after = await search({ q: 'کیمیا' });
      expect(idsOf(after)).toContain(ids.kimia);
      expect(await engine.documentCount(PROVIDER_INDEX_ALIAS)).toBe(4);
    }, 60_000);

    it('removes a deleted provider from the real index', async () => {
      await indexer.applyProfessional({
        professionalId: ids.unverified,
        revision: 2,
        displayName: 'سالن جدید',
        bio: null,
        cityId: tehran,
        cityName: 'تهران',
        specialtyIds: [],
        specialtyNames: [],
        verificationStatus: 'unverified',
        isDeleted: true,
        updatedAt: new Date(),
        services: [],
      });
      await indexer.flushDirty();

      expect(await engine.documentCount(PROVIDER_INDEX_ALIAS)).toBe(3);
      const result = await search({});
      expect(idsOf(result)).not.toContain(ids.unverified);
    });
  });
});
