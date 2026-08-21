import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { AnalyticsIngestionService, MetricsService, RollupService } from '@beauclick/analytics';
import { ProviderService } from '@beauclick/provider';
import { EventEnvelope } from '@beauclick/events';
import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

describePg('analytics — ingestion, isolation, privacy (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let ingestion: AnalyticsIngestionService;
  let metrics: MetricsService;
  let rollups: RollupService;
  let providers: ProviderService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    ingestion = app.get(AnalyticsIngestionService);
    metrics = app.get(MetricsService);
    rollups = app.get(RollupService);
    providers = app.get(ProviderService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const envelope = (
    eventType: string,
    payload: Record<string, unknown>,
    id = uuidv7(),
  ): EventEnvelope => ({
    id,
    aggregateType: 'test',
    aggregateId: uuidv7(),
    eventType,
    eventVersion: 1,
    payload,
    occurredAt: new Date(),
  });

  const bookingCompleted = (professionalId: string, customerId: string, id = uuidv7()) =>
    envelope(
      'BookingCompleted',
      {
        bookingId: uuidv7(),
        professionalId,
        customerId,
        serviceId: uuidv7(),
        completedAt: new Date().toISOString(),
      },
      id,
    );

  describe('ingestion idempotency', () => {
    it('records a fact once per SOURCE EVENT', async () => {
      const eventId = uuidv7();
      const event = bookingCompleted(uuidv7(), uuidv7(), eventId);

      expect(await ingestion.ingest(event)).toBe(true);
      // The primary key is the producing event's id, so a redelivery is a
      // no-op INSERT rather than a double count. An inflated analytics number
      // is uniquely bad: wrong, plausible, and with nothing to compare against.
      expect(await ingestion.ingest(event)).toBe(false);

      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM analytics.events`);
      expect(rows[0].n).toBe(1);
    });

    it('holds under CONCURRENT redelivery', async () => {
      const event = bookingCompleted(uuidv7(), uuidv7());
      const results = await Promise.all(Array.from({ length: 5 }, () => ingestion.ingest(event)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('silently ignores an event type it does not map', async () => {
      // A domain may publish facts analytics has no question about; throwing
      // would leave those outbox rows retrying forever.
      expect(await ingestion.ingest(envelope('SomethingUnmapped', {}))).toBe(false);
    });

    it('buckets by the event own timestamp, not by ingestion time', async () => {
      const professionalId = uuidv7();
      const completedAt = new Date('2026-08-20T19:30:00.000Z'); // 23:00 Tehran, the 20th
      await ingestion.ingest(
        envelope('BookingCompleted', {
          bookingId: uuidv7(),
          professionalId,
          customerId: uuidv7(),
          serviceId: uuidv7(),
          completedAt: completedAt.toISOString(),
        }),
      );

      // Selected as TEXT: node-postgres hydrates a `date` into a JS Date at
      // local midnight, so re-serialising it through toISOString() would shift
      // it back across the timezone and test the wrong thing.
      const rows = await dataSource.query(`SELECT occurred_on::text AS day FROM analytics.events`);
      // A booking completed at 23:00 Tehran must not land on the next day's
      // numbers because the relay was catching up after midnight.
      expect(rows[0].day).toBe('2026-08-20');
    });
  });

  describe('privacy of ingested facts', () => {
    it('keeps a search query out of the fact table', async () => {
      await ingestion.ingest(
        envelope('SearchPerformed', {
          searchId: uuidv7(),
          queryClass: 'text',
          queryTermCount: 2,
          filterKeys: ['city'],
          sort: 'relevance',
          resultCount: 4,
          page: 1,
          tookMs: 10,
          degraded: false,
          userId: null,
          occurredAt: new Date().toISOString(),
          // Even if a producer somehow supplied it, the mapping is an
          // allow-list and names no query field.
          query: 'سالن زیبایی کیمیا',
        }),
      );

      const rows = await dataSource.query(`SELECT dimensions FROM analytics.events`);
      expect(JSON.stringify(rows[0].dimensions)).not.toContain('کیمیا');
      expect(rows[0].dimensions.queryClass).toBe('text');
    });

    it('keeps a cancellation REASON out of the fact table', async () => {
      await ingestion.ingest(
        envelope('BookingCancelled', {
          bookingId: uuidv7(),
          professionalId: uuidv7(),
          customerId: uuidv7(),
          slotId: uuidv7(),
          previousStatus: 'confirmed',
          cancelledAt: new Date().toISOString(),
          actorType: 'customer',
          actorId: null,
          reason: 'به دلیل بیماری شخصی نمی‌توانم بیایم',
        }),
      );

      const rows = await dataSource.query(`SELECT dimensions FROM analytics.events`);
      // Who cancelled is the analytically interesting part; the customer's
      // stated reason is prose about their private life.
      expect(rows[0].dimensions.actorType).toBe('customer');
      expect(JSON.stringify(rows[0].dimensions)).not.toContain('بیماری');
    });

    it('stores only the NORMALIZED subject type', async () => {
      const professionalId = uuidv7();
      await ingestion.ingest(
        envelope('ProviderProfileViewed', {
          entityType: 'provider',
          professionalId,
          source: 'search',
          userId: null,
          occurredAt: new Date().toISOString(),
        }),
      );

      const rows = await dataSource.query(`SELECT subject_type, subject_id FROM analytics.events`);
      // GAP-15's closure: V2 logged the raw CPT post type here while every
      // other event logged 'provider', making the two uncomparable.
      expect(rows[0].subject_type).toBe('provider');
      expect(rows[0].subject_id).toBe(professionalId);
    });

    it('rejects a non-normalized subject type at the DATABASE layer', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO analytics.events (event_id, event_type, event_version, aggregate_type, aggregate_id, subject_type, subject_id, occurred_at, occurred_on)
           VALUES ($1, 'X', 1, 'x', $2, 'bc_professional', $3, now(), current_date)`,
          [uuidv7(), uuidv7(), uuidv7()],
        ),
      ).rejects.toThrow(/ck_analytics_events_subject_normalized/);
    });
  });

  describe('professional analytics isolation', () => {
    it('returns ONLY the caller own figures', async () => {
      const ownerA = await seedUser(app, dataSource, '+989124000001');
      const ownerB = await seedUser(app, dataSource, '+989124000002');
      const proA = await providers.create(ownerA.id, { displayName: 'الف' });
      const proB = await providers.create(ownerB.id, { displayName: 'ب' });

      await ingestion.ingest(bookingCompleted(proA.id, uuidv7()));
      for (let i = 0; i < 5; i += 1) await ingestion.ingest(bookingCompleted(proB.id, uuidv7()));

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/analytics')
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .expect(200);

      // Professional A cannot express a request for B's numbers -- the route
      // has no provider parameter at all.
      expect(res.body.data.funnel.completed.value).toBe(1);
    });

    it('gives a session with NO professional profile the same 404 as a nonexistent resource', async () => {
      const customer = await seedUser(app, dataSource, '+989124000003');
      await request(app.getHttpServer())
        .get('/api/v1/me/analytics')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(404);
    });

    it('rejects an unauthenticated analytics read', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/analytics').expect(401);
    });

    it('offers no route parameter that could name another professional', async () => {
      const ownerA = await seedUser(app, dataSource, '+989124000004');
      const ownerB = await seedUser(app, dataSource, '+989124000005');
      await providers.create(ownerA.id, { displayName: 'الف' });
      const proB = await providers.create(ownerB.id, { displayName: 'ب' });
      await ingestion.ingest(bookingCompleted(proB.id, uuidv7()));

      // Query params are whitelisted, so a smuggled professionalId is
      // REJECTED outright rather than silently stripped -- the caller learns
      // the field is not accepted instead of receiving plausible wrong data.
      await request(app.getHttpServer())
        .get('/api/v1/me/analytics')
        .query({ professionalId: proB.id })
        .set('Authorization', `Bearer ${ownerA.accessToken}`)
        .expect(400);
    });

    it('denies the platform-wide surface to a professional', async () => {
      const owner = await seedUser(app, dataSource, '+989124000006');
      await providers.create(owner.id, { displayName: 'الف' });
      await request(app.getHttpServer())
        .get('/api/v1/admin/analytics')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(403);
    });

    it('serves the platform-wide surface to an admin', async () => {
      const admin = await seedUser(app, dataSource, '+989124000007', ['administrator']);
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/analytics')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(res.body.data.search).toBeDefined();
      expect(res.body.data.bookings).toBeDefined();
    });

    it('rejects an arbitrary event type on the series endpoint', async () => {
      const admin = await seedUser(app, dataSource, '+989124000008', ['administrator']);
      // An allow-list, so internal event names are not a public, enumerable
      // surface.
      await request(app.getHttpServer())
        .get('/api/v1/admin/analytics/series')
        .query({ eventType: 'LedgerEntriesRecorded' })
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(400);
    });
  });

  describe('metric honesty', () => {
    it('labels a genuine funnel step as event-derived', async () => {
      const owner = await seedUser(app, dataSource, '+989124000009');
      const pro = await providers.create(owner.id, { displayName: 'الف' });
      await ingestion.ingest(bookingCompleted(pro.id, uuidv7()));

      const result = await metrics.forProvider(pro.id);
      expect(result.funnel.completionRate.kind).toBe('event_derived');
    });

    it('labels view-to-booking as a CORRELATION, with the caveat attached', async () => {
      const owner = await seedUser(app, dataSource, '+989124000010');
      const pro = await providers.create(owner.id, { displayName: 'الف' });

      const result = await metrics.forProvider(pro.id);
      // Nothing links a particular view to a particular booking. Presenting
      // that as tracked conversion is the quiet dishonesty §26 exists to stop,
      // so the caveat travels WITH the number into any report.
      expect(result.funnel.viewToBookingRate.kind).toBe('correlation_derived');
      expect(result.funnel.viewToBookingRate.note).toBeTruthy();
    });

    it('returns zero rather than dividing by zero on an empty range', async () => {
      const owner = await seedUser(app, dataSource, '+989124000011');
      const pro = await providers.create(owner.id, { displayName: 'الف' });
      const result = await metrics.forProvider(pro.id);
      expect(result.funnel.completionRate.value).toBe(0);
      expect(result.funnel.viewToBookingRate.value).toBe(0);
    });

    it('CLAMPS an absurd date range instead of scanning the whole table', async () => {
      const owner = await seedUser(app, dataSource, '+989124000012');
      const pro = await providers.create(owner.id, { displayName: 'الف' });
      const result = await metrics.forProvider(pro.id, '0001-01-01', '2026-08-20');
      const span = Math.round(
        (Date.parse(`${result.range.to}T00:00:00Z`) - Date.parse(`${result.range.from}T00:00:00Z`)) / 86_400_000,
      );
      expect(span).toBe(366);
    });
  });

  describe('rollups', () => {
    it('REPLACES a day rather than appending on recompute', async () => {
      const professionalId = uuidv7();
      await ingestion.ingest(bookingCompleted(professionalId, uuidv7()));

      await rollups.runRecent();
      await rollups.runRecent();
      await rollups.runRecent();

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n, max(count_value)::int AS v FROM analytics.daily_metrics
         WHERE metric_key = 'bookings_completed' AND scope_type = 'provider'`,
      );
      // Three runs must not triple the figure -- unlike a duplicated fact row,
      // a doubled rollup has nothing afterwards able to detect it.
      expect(rows[0].n).toBe(1);
      expect(rows[0].v).toBe(1);
    });

    it('computes both a platform-wide and a per-provider row', async () => {
      const professionalId = uuidv7();
      await ingestion.ingest(bookingCompleted(professionalId, uuidv7()));
      await rollups.runRecent();

      const platform = await dataSource.query(
        `SELECT count_value FROM analytics.daily_metrics WHERE metric_key='bookings_completed' AND scope_type=''`,
      );
      const scoped = await dataSource.query(
        `SELECT count_value FROM analytics.daily_metrics WHERE metric_key='bookings_completed' AND scope_id=$1`,
        [professionalId],
      );
      expect(Number(platform[0].count_value)).toBe(1);
      expect(Number(scoped[0].count_value)).toBe(1);
    });

    it('carries the metric KIND into the stored rollup', async () => {
      await ingestion.ingest(bookingCompleted(uuidv7(), uuidv7()));
      await rollups.runRecent();
      const rows = await dataSource.query(
        `SELECT DISTINCT metric_kind FROM analytics.daily_metrics WHERE metric_key='bookings_completed'`,
      );
      expect(rows[0].metric_kind).toBe('event_derived');
    });
  });
});
