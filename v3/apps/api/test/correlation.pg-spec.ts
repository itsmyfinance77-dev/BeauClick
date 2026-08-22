import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { OutboxRelay, newCorrelationId, runWithCorrelation } from '@beauclick/events';
import { LOYALTY_REASONS, LoyaltyLedgerService } from '@beauclick/loyalty';
import {
  PgTestApp,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedUser,
} from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * Correlation tracing, end to end, against real PostgreSQL.
 *
 * The claim under test is not "a header is echoed". It is that ONE customer
 * action produces ONE identifier that is present on every row, in every
 * schema, that the action caused -- including rows written by handlers that
 * ran long after the request returned.
 *
 * That is only checkable against a real database and a real relay: the
 * propagation happens across a commit boundary and an async dispatch, which is
 * exactly the seam where an ambient-context mechanism silently loses its
 * value and every column quietly becomes null.
 */
describePg('correlation — one action, one id, every schema (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let relay: OutboxRelay;
  let ledger: LoyaltyLedgerService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    relay = ctx.relay;
    ledger = app.get(LoyaltyLedgerService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  /** Drains repeatedly: each pass can produce new rows for the next one to pick up. */
  const drainFully = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      const result = await relay.drain();
      if (result.dispatched === 0) return;
    }
  };

  describe('the request edge', () => {
    it('echoes a supplied correlation id back on the response', async () => {
      const supplied = newCorrelationId();
      const res = await request(app.getHttpServer())
        .get('/api/v1/search/providers')
        .set('X-Correlation-Id', supplied);

      expect(res.headers['x-correlation-id']).toBe(supplied);
    });

    it('mints one when the client supplies none', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/search/providers');

      expect(res.headers['x-correlation-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('REPLACES a client-supplied value that is not a UUID rather than storing it', async () => {
      // The id reaches nine outbox tables and every log line. A caller-chosen
      // string there is an injection vector for free, so the shape is enforced
      // at the edge and nowhere else has to think about it.
      //
      // No CR/LF in this value: Node's own http client refuses to SEND a
      // header containing one at all (ERR_INVALID_CHAR), before the request
      // reaches the server. That is a real, even earlier layer of defence
      // against the classic log/header injection payload -- but it also means
      // this test cannot exercise it through an HTTP client, only through
      // `acceptInboundCorrelationId` directly. What this test verifies is the
      // shape check for a value that a client CAN actually put on the wire.
      const hostile = 'not-a-uuid; injected=true';
      const res = await request(app.getHttpServer())
        .get('/api/v1/search/providers')
        .set('X-Correlation-Id', hostile);

      expect(res.headers['x-correlation-id']).not.toBe(hostile);
      expect(res.headers['x-correlation-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('carries the request id onto the event that request produced', async () => {
      const user = await seedUser(app, dataSource, '+989125550001');
      const supplied = newCorrelationId();

      await request(app.getHttpServer())
        .post('/api/v1/me/journey/goals')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('X-Correlation-Id', supplied)
        .send({ title: 'آماده شدن برای عروسی' })
        .expect(201);

      const rows = await dataSource.query(
        `SELECT event_type, correlation_id FROM journey.outbox_events ORDER BY id`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.correlation_id).toBe(supplied);
      }
    });
  });

  describe('propagation across the fan-out', () => {
    it('gives every schema the SAME id for one action', async () => {
      const user = await seedUser(app, dataSource, '+989125550002');
      const bookingId = uuidv7();
      const correlationId = newCorrelationId();

      // The action: points awarded for a completed booking. Its own event goes
      // to loyalty; consuming handlers then write to notification, journey,
      // and analytics -- none of which knows this test's id exists.
      await runWithCorrelation(correlationId, () =>
        ledger.award({
          userId: user.id,
          reason: LOYALTY_REASONS.bookingCompleted,
          referenceType: 'booking',
          referenceId: bookingId,
        }),
      );

      await drainFully();

      const loyalty = await dataSource.query(`SELECT correlation_id FROM loyalty.outbox_events`);
      expect(loyalty.length).toBeGreaterThan(0);
      expect(loyalty.every((r: { correlation_id: string }) => r.correlation_id === correlationId)).toBe(true);

      const facts = await dataSource.query(
        `SELECT event_type, correlation_id FROM analytics.events ORDER BY event_id`,
      );
      expect(facts.length).toBeGreaterThan(0);
      for (const fact of facts) {
        expect(fact.correlation_id).toBe(correlationId);
      }

      // Downstream schemas that emitted anything of their own must carry it
      // too -- this is the hop that breaks if the relay does not re-enter the
      // context before invoking handlers.
      const downstream = await dataSource.query(
        `SELECT correlation_id FROM notification.outbox_events
         UNION ALL
         SELECT correlation_id FROM journey.outbox_events`,
      );
      for (const row of downstream) {
        expect(row.correlation_id).toBe(correlationId);
      }
    });

    it('still records an id when the work has no request behind it', async () => {
      // A scheduler tick has no inbound header. A null here would make the
      // column unreliable, and an unreliable column stops being used.
      const user = await seedUser(app, dataSource, '+989125550003');

      await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: uuidv7(),
      });

      const rows = await dataSource.query(
        `SELECT correlation_id FROM loyalty.outbox_events WHERE correlation_id IS NULL`,
      );
      expect(rows).toHaveLength(0);
    });

    it('keeps two separate actions separately traceable', async () => {
      const user = await seedUser(app, dataSource, '+989125550004');
      const first = newCorrelationId();
      const second = newCorrelationId();

      await runWithCorrelation(first, () =>
        ledger.award({
          userId: user.id,
          reason: LOYALTY_REASONS.bookingCompleted,
          referenceType: 'booking',
          referenceId: uuidv7(),
        }),
      );
      await runWithCorrelation(second, () =>
        ledger.award({
          userId: user.id,
          reason: LOYALTY_REASONS.bookingCompleted,
          referenceType: 'booking',
          referenceId: uuidv7(),
        }),
      );

      const distinct = await dataSource.query(
        `SELECT DISTINCT correlation_id FROM loyalty.outbox_events ORDER BY correlation_id`,
      );
      expect(distinct.map((r: { correlation_id: string }) => r.correlation_id).sort()).toEqual(
        [first, second].sort(),
      );
    });
  });
});
