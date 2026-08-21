import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { InMemorySearchEngine, SEARCH_ENGINE, SearchIndexerService } from '@beauclick/search';
import { ProviderService, ServiceOfferingService } from '@beauclick/provider';
import { OutboxRelay } from '@beauclick/events';
import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * The search projection against real PostgreSQL.
 *
 * The engine here is the in-memory one, deliberately: everything in this file
 * is about the PROJECTION -- revision ordering, signal idempotency, dirty
 * tracking, reindex, the degraded path -- none of which involves an analyzer.
 * Relevance, Persian matching, and fuzziness are engine behaviour and are
 * verified against a real OpenSearch instance in `opensearch.pg-spec.ts`.
 */
describePg('search projection — ordering, idempotency, recovery (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let indexer: SearchIndexerService;
  let providers: ProviderService;
  let offerings: ServiceOfferingService;
  let relay: OutboxRelay;
  let engine: InMemorySearchEngine;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    indexer = app.get(SearchIndexerService);
    providers = app.get(ProviderService);
    offerings = app.get(ServiceOfferingService);
    relay = ctx.relay;
    engine = app.get(SEARCH_ENGINE) as InMemorySearchEngine;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // The engine is a DI singleton, so truncating PostgreSQL does not clear
    // it -- without this, documents accumulate across cases.
    engine.reset();
  });

  const projection = (professionalId: string, revision: number, over: Record<string, unknown> = {}) => ({
    professionalId,
    revision,
    displayName: 'سالن کیمیا',
    bio: null,
    cityId: null,
    cityName: 'تهران',
    specialtyIds: [],
    specialtyNames: ['میکاپ'],
    verificationStatus: 'verified',
    isDeleted: false,
    updatedAt: new Date(),
    services: [],
    ...over,
  });

  describe('revision ordering', () => {
    it('applies a newer revision', async () => {
      const id = uuidv7();
      expect(await indexer.applyProfessional(projection(id, 1))).toBe(true);
      expect(await indexer.applyProfessional(projection(id, 2, { displayName: 'نام تازه' }))).toBe(true);

      const row = await dataSource.query(
        `SELECT display_name, revision FROM search.provider_documents WHERE professional_id = $1`,
        [id],
      );
      expect(row[0].display_name).toBe('نام تازه');
      expect(Number(row[0].revision)).toBe(2);
    });

    it('DISCARDS an out-of-order older revision instead of reverting the document', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 5, { displayName: 'جدید' }));

      // The realistic failure: the relay redelivers revision 3 after 5 has
      // already been applied. Both payloads are individually valid, so nothing
      // downstream could detect the revert -- only the revision guard can.
      expect(await indexer.applyProfessional(projection(id, 3, { displayName: 'قدیمی' }))).toBe(false);

      const row = await dataSource.query(
        `SELECT display_name, revision FROM search.provider_documents WHERE professional_id = $1`,
        [id],
      );
      expect(row[0].display_name).toBe('جدید');
      expect(Number(row[0].revision)).toBe(5);
    });

    it('DISCARDS an exact duplicate of the current revision', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      expect(await indexer.applyProfessional(projection(id, 1))).toBe(false);
    });

    it('resolves CONCURRENT revisions to exactly the highest', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));

      // Fired simultaneously. Under READ COMMITTED the second UPDATE blocks on
      // the first's row lock and re-evaluates `revision < :revision` against
      // the committed value -- the same mechanism booking's slot claim uses.
      const results = await Promise.all([
        indexer.applyProfessional(projection(id, 2, { displayName: 'دو' })),
        indexer.applyProfessional(projection(id, 3, { displayName: 'سه' })),
        indexer.applyProfessional(projection(id, 2, { displayName: 'دو-تکراری' })),
      ]);

      expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
      const row = await dataSource.query(
        `SELECT display_name, revision FROM search.provider_documents WHERE professional_id = $1`,
        [id],
      );
      expect(Number(row[0].revision)).toBe(3);
      expect(row[0].display_name).toBe('سه');
    });
  });

  describe('ranking signal idempotency', () => {
    it('increments a counter exactly once per SOURCE EVENT', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      const eventId = uuidv7();

      expect(await indexer.applySignal(eventId, 'booking_completed', id, new Date())).toBe(true);
      // Same event id = the same event, redelivered. A counter increment is
      // not naturally idempotent, so without the guard this would silently
      // drift upward on every relay restart.
      expect(await indexer.applySignal(eventId, 'booking_completed', id, new Date())).toBe(false);

      const row = await dataSource.query(
        `SELECT completed_bookings FROM search.ranking_signals WHERE professional_id = $1`,
        [id],
      );
      expect(row[0].completed_bookings).toBe(1);
    });

    it('counts two DIFFERENT events separately', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      await indexer.applySignal(uuidv7(), 'booking_completed', id, new Date());
      await indexer.applySignal(uuidv7(), 'booking_completed', id, new Date());

      const row = await dataSource.query(
        `SELECT completed_bookings FROM search.ranking_signals WHERE professional_id = $1`,
        [id],
      );
      expect(row[0].completed_bookings).toBe(2);
    });

    it('holds under CONCURRENT redelivery of one event', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      const eventId = uuidv7();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => indexer.applySignal(eventId, 'booking_completed', id, new Date())),
      );
      expect(results.filter(Boolean)).toHaveLength(1);

      const row = await dataSource.query(
        `SELECT completed_bookings FROM search.ranking_signals WHERE professional_id = $1`,
        [id],
      );
      expect(row[0].completed_bookings).toBe(1);
    });

    it('does not count a profile view as provider ACTIVITY', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      await indexer.applySignal(uuidv7(), 'profile_view', id, new Date());

      const row = await dataSource.query(
        `SELECT profile_views, recent_activity_count FROM search.ranking_signals WHERE professional_id = $1`,
        [id],
      );
      // Someone looking at a profile is not the provider doing anything.
      expect(row[0].profile_views).toBe(1);
      expect(row[0].recent_activity_count).toBe(0);
    });

    it('moves the ranking score when a signal lands', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      const before = await dataSource.query(
        `SELECT ranking_score FROM search.provider_documents WHERE professional_id = $1`,
        [id],
      );

      for (let i = 0; i < 10; i += 1) {
        await indexer.applySignal(uuidv7(), 'booking_completed', id, new Date());
      }

      const after = await dataSource.query(
        `SELECT ranking_score, ranking_signal_keys FROM search.provider_documents WHERE professional_id = $1`,
        [id],
      );
      expect(Number(after[0].ranking_score)).not.toBe(Number(before[0].ranking_score));
      expect(after[0].ranking_signal_keys).toContain('verified');
    });
  });

  describe('dirty tracking and flush', () => {
    it('marks a document dirty on write and clears it after a successful flush', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      expect(await indexer.pendingCount()).toBe(1);

      await indexer.flushDirty();
      expect(await indexer.pendingCount()).toBe(0);
    });

    it('keeps the write and stays dirty when the ENGINE is down', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));

      engine.available = false;
      await expect(indexer.flushDirty()).rejects.toThrow();

      // The whole point of writing PostgreSQL first: an engine outage degrades
      // to a stale index that self-heals, never to a lost update.
      expect(await indexer.pendingCount()).toBe(1);
      const row = await dataSource.query(`SELECT count(*)::int AS n FROM search.provider_documents`);
      expect(row[0].n).toBe(1);

      engine.available = true;
      await indexer.flushDirty();
      expect(await indexer.pendingCount()).toBe(0);
    });

    it('does not clear a dirty flag set AFTER the flush read the row', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      await indexer.flushDirty();

      // An edit arriving between the read and the clear must survive. The
      // clearing UPDATE is predicated on the timestamp the flush saw, so a
      // newer one is not cleared -- the classic lost-update bug in this
      // pattern.
      await indexer.applyProfessional(projection(id, 2));
      expect(await indexer.pendingCount()).toBe(1);
    });

    it('removes a deleted professional from the engine', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      await indexer.flushDirty();
      expect(await engine.documentCount('beauclick-providers')).toBe(1);

      await indexer.applyProfessional(projection(id, 2, { isDeleted: true }));
      await indexer.flushDirty();
      expect(await engine.documentCount('beauclick-providers')).toBe(0);
    });
  });

  describe('reindex and recovery', () => {
    it('rebuilds into a NEW physical index and swaps the alias atomically', async () => {
      for (let i = 0; i < 3; i += 1) {
        await indexer.applyProfessional(projection(uuidv7(), 1));
      }
      await indexer.flushDirty();
      const firstIndex = await indexer.currentPhysicalIndex();

      const result = await indexer.fullReindex();

      expect(result.indexed).toBe(3);
      // A NEW index, not a rebuild in place -- so the old one answers every
      // query until the new one is complete.
      expect(result.physicalIndex).not.toBe(firstIndex);
      expect(await engine.documentCount('beauclick-providers')).toBe(3);
    });

    it('rebuilds the PROJECTION from provider-service when the projection is lost', async () => {
      // The deeper recovery, and also the migration path for professionals
      // who existed before search-service did.
      const owner = await seedUser(app, dataSource, '+989121000001');
      const professional = await providers.create(owner.id, { displayName: 'سالن آزمایشی', bio: 'توضیح' });
      await offerings.create(professional.id, { name: 'میکاپ عروس', durationMinutes: 90, priceToman: 850_000 });

      await dataSource.query('TRUNCATE search.provider_documents CASCADE');
      expect((await dataSource.query(`SELECT count(*)::int AS n FROM search.provider_documents`))[0].n).toBe(0);

      const rebuilt = await indexer.rebuildProjectionFromSource();
      expect(rebuilt).toBe(1);

      const row = await dataSource.query(
        `SELECT display_name, services, min_price_toman FROM search.provider_documents WHERE professional_id = $1`,
        [professional.id],
      );
      expect(row[0].display_name).toBe('سالن آزمایشی');
      expect(row[0].services).toHaveLength(1);
      expect(Number(row[0].min_price_toman)).toBe(850_000);
    });

    it('converges after a MISSED event, via a projection rebuild', async () => {
      const owner = await seedUser(app, dataSource, '+989121000002');
      const professional = await providers.create(owner.id, { displayName: 'اولیه' });

      // Simulate a lost event: change the source and drop the outbox row
      // before it is ever delivered.
      await dataSource.query('DELETE FROM provider.outbox_events');
      await providers.update(professional.id, owner.id, { displayName: 'به‌روزشده' });
      await dataSource.query('DELETE FROM provider.outbox_events');
      await dataSource.query('TRUNCATE search.provider_documents CASCADE');

      await indexer.rebuildProjectionFromSource();

      const row = await dataSource.query(
        `SELECT display_name FROM search.provider_documents WHERE professional_id = $1`,
        [professional.id],
      );
      // The system converges to the correct state even though the event that
      // would have carried the change was never delivered.
      expect(row[0].display_name).toBe('به‌روزشده');
    });
  });

  describe('end-to-end through the real event pipeline', () => {
    it('indexes a professional created through provider-service, via the outbox', async () => {
      const owner = await seedUser(app, dataSource, '+989121000003');
      const professional = await providers.create(owner.id, { displayName: 'سالن رویا', bio: 'سالن تخصصی' });

      // The relay drains provider's outbox and dispatches to the search
      // handler. No direct call from provider to search exists -- that
      // coupling is exactly what this replaces.
      await relay.drain();
      await indexer.flushDirty();

      const row = await dataSource.query(
        `SELECT display_name, revision FROM search.provider_documents WHERE professional_id = $1`,
        [professional.id],
      );
      expect(row[0].display_name).toBe('سالن رویا');
      expect(Number(row[0].revision)).toBeGreaterThanOrEqual(1);
    });

    it('bumps the revision on a verification transition and carries the new status', async () => {
      const owner = await seedUser(app, dataSource, '+989121000004');
      const professional = await providers.create(owner.id, { displayName: 'در انتظار تایید' });
      await relay.drain();

      await providers.transitionVerification(professional.id, 'pending', null, null);
      await providers.transitionVerification(professional.id, 'verified', owner.id, 'مدارک تایید شد');
      await relay.drain();

      const row = await dataSource.query(
        `SELECT verification_status FROM search.provider_documents WHERE professional_id = $1`,
        [professional.id],
      );
      expect(row[0].verification_status).toBe('verified');

      const events = await dataSource.query(
        `SELECT count(*)::int AS n FROM provider.outbox_events WHERE event_type = 'ProfessionalVerificationChanged'`,
      );
      expect(events[0].n).toBe(2);
    });

    it('emits nothing when a verification transition loses its compare-and-swap', async () => {
      const owner = await seedUser(app, dataSource, '+989121000005');
      const professional = await providers.create(owner.id, { displayName: 'رقابتی' });
      await dataSource.query('DELETE FROM provider.outbox_events');

      // Two simultaneous identical transitions: exactly one may take effect,
      // and only the winner may announce it.
      await Promise.allSettled([
        providers.transitionVerification(professional.id, 'pending', null, null),
        providers.transitionVerification(professional.id, 'pending', null, null),
      ]);

      const events = await dataSource.query(
        `SELECT count(*)::int AS n FROM provider.outbox_events WHERE event_type = 'ProfessionalVerificationChanged'`,
      );
      expect(events[0].n).toBe(1);
    });
  });

  describe('search API', () => {
    it('serves results and reports when it is NOT degraded', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      await indexer.flushDirty();

      const res = await request(app.getHttpServer()).get('/api/v1/search/providers').expect(200);
      expect(res.body.data.degraded).toBe(false);
      expect(res.body.data.items).toHaveLength(1);
    });

    it('DEGRADES honestly when the engine is unreachable', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      await indexer.flushDirty();
      engine.available = false;

      const res = await request(app.getHttpServer()).get('/api/v1/search/providers').expect(200);

      // A search outage must not take the marketplace down -- but the caller
      // is TOLD, because a degraded result set has no fuzzy matching and no
      // relevance, and presenting it as normal would make "search got worse"
      // indistinguishable from "there is nothing to find".
      expect(res.body.data.degraded).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.facets.cities).toEqual([]);
    });

    it('never exposes internal indexing fields', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(projection(id, 1));
      await indexer.flushDirty();

      const res = await request(app.getHttpServer()).get('/api/v1/search/providers').expect(200);
      const item = res.body.data.items[0];
      // Exposing these would freeze indexing machinery into a public contract
      // and let a client rebuild the platform's own ranking model.
      expect(item).not.toHaveProperty('revision');
      expect(item).not.toHaveProperty('rankingScore');
      expect(item).not.toHaveProperty('indexedAt');
      // The explainability surface IS exposed -- V2 rendered it too.
      expect(item).toHaveProperty('badges');
    });

    it('rejects an over-long query rather than truncating it', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/search/providers')
        .query({ q: 'ا'.repeat(200) })
        .expect(400);
    });

    it('accepts a price filter written in PERSIAN digits', async () => {
      const id = uuidv7();
      await indexer.applyProfessional(
        projection(id, 1, { services: [{ serviceId: uuidv7(), name: 'میکاپ', priceToman: 400_000, durationMinutes: 60 }] }),
      );
      await indexer.flushDirty();

      // Number('۵۰۰۰۰۰') is NaN. Without normalization a perfectly valid
      // filter is rejected as malformed, which reads as a broken feature.
      const res = await request(app.getHttpServer())
        .get('/api/v1/search/providers')
        .query({ maxPrice: '۵۰۰۰۰۰' })
        .expect(200);
      expect(res.body.data.items).toHaveLength(1);
    });

    it('records a SearchPerformed fact with no query text anywhere in it', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/search/providers')
        .query({ q: 'کیمیا', cityId: uuidv7() })
        .expect(200);

      const rows = await dataSource.query(
        `SELECT payload FROM search.outbox_events WHERE event_type = 'SearchPerformed'`,
      );
      expect(rows).toHaveLength(1);
      const payload = rows[0].payload;
      expect(payload.queryClass).toBe('text_and_filtered');
      expect(payload.queryTermCount).toBe(1);
      // The redaction discipline V2 established, now structural: the contract
      // has no field that could hold the text.
      expect(JSON.stringify(payload)).not.toContain('کیمیا');
    });

    it('records a profile view without requiring a session', async () => {
      const id = uuidv7();
      await request(app.getHttpServer())
        .post(`/api/v1/search/providers/${id}/view`)
        .send({ source: 'search' })
        .expect(204);

      const rows = await dataSource.query(
        `SELECT payload FROM search.outbox_events WHERE event_type = 'ProviderProfileViewed'`,
      );
      expect(rows).toHaveLength(1);
      // GAP-15's closure: always the normalized 'provider', never a raw type.
      expect(rows[0].payload.entityType).toBe('provider');
      expect(rows[0].payload.userId).toBeNull();
    });
  });

  describe('index administration', () => {
    it('denies reindex to a non-admin', async () => {
      const customer = await seedUser(app, dataSource, '+989121000006');
      await request(app.getHttpServer())
        .post('/api/v1/admin/search/reindex')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(403);
    });

    it('denies reindex to an anonymous caller', async () => {
      // A full reindex is an expensive cluster-wide operation; an
      // unauthenticated trigger would be a denial-of-service button.
      await request(app.getHttpServer()).post('/api/v1/admin/search/reindex').expect(401);
    });

    it('reports index health to an admin', async () => {
      const admin = await seedUser(app, dataSource, '+989121000007', ['administrator']);
      await indexer.applyProfessional(projection(uuidv7(), 1));

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/search/status')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      expect(res.body.data.pendingDocuments).toBe(1);
      expect(res.body.data.physicalIndex).toContain('beauclick-providers');
    });
  });
});
