import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { BookingOutboxEntity, BookingService } from '@beauclick/booking';
import { emitEvent } from '@beauclick/events';

import {
  PgTestApp,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

/**
 * The outbox's defining guarantee, asserted where it can actually be
 * asserted.
 *
 * This lives here rather than in `libs/events`' own spec for a specific
 * reason: **pg-mem does not honour TypeORM's ROLLBACK.** A row written
 * inside a transaction that throws survives it there, so the central claim
 * -- that a staged event is rolled back together with a failed business
 * write -- would pass or fail for reasons unrelated to our code. On a real
 * server it means what it says.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Transactional outbox on real PostgreSQL', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let bookings: BookingService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    bookings = app.get(BookingService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  it('ROLLS BACK a staged event when the business transaction fails', async () => {
    const aggregateId = uuidv7();

    await expect(
      dataSource.transaction(async (manager) => {
        await emitEvent(manager, BookingOutboxEntity, {
          aggregateType: 'booking',
          aggregateId,
          eventType: 'BookingCreated',
          payload: { bookingId: aggregateId },
        });
        throw new Error('business write failed after the event was staged');
      }),
    ).rejects.toThrow('business write failed');

    // No orphaned event announcing something that never happened.
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM booking.outbox_events WHERE aggregate_id = $1`,
      [aggregateId],
    );
    expect(count).toBe(0);
  });

  it('COMMITS the event together with the business write', async () => {
    const owner = await seedUser(app, dataSource, '+989129990001', ['professional']);
    const customer = await seedUser(app, dataSource, '+989139990001');
    const professional = await seedProfessional(dataSource, owner.id, 'سارا');
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48));

    const booking = await bookings.create({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
    });

    const rows = await dataSource.query(
      `SELECT event_type, published_at FROM booking.outbox_events WHERE aggregate_id = $1`,
      [booking.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('BookingCreated');
    expect(rows[0].published_at).toBeNull();
  });

  it('leaves NO event behind when a slot claim loses its race', async () => {
    const owner = await seedUser(app, dataSource, '+989129990002', ['professional']);
    const a = await seedUser(app, dataSource, '+989139990002');
    const b = await seedUser(app, dataSource, '+989139990003');
    const professional = await seedProfessional(dataSource, owner.id, 'مینا');
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(52));

    await Promise.allSettled([
      bookings.create({ customerId: a.id, professionalId: professional.id, slotId, serviceId: professional.serviceId }),
      bookings.create({ customerId: b.id, professionalId: professional.id, slotId, serviceId: professional.serviceId }),
    ]);

    // One booking, one event -- the loser staged nothing that survived.
    const [{ events }] = await dataSource.query(
      `SELECT COUNT(*)::int AS events FROM booking.outbox_events WHERE event_type = 'BookingCreated'`,
    );
    expect(events).toBe(1);
  });

  it('marks a row published exactly once, and never redelivers it', async () => {
    const owner = await seedUser(app, dataSource, '+989129990004', ['professional']);
    const customer = await seedUser(app, dataSource, '+989139990004');
    const professional = await seedProfessional(dataSource, owner.id, 'نگار');
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(56));
    const booking = await bookings.create({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId });

    await ctx.relay.drain();
    const afterFirst = await dataSource.query(`SELECT published_at FROM booking.outbox_events WHERE aggregate_id = $1`, [booking.id]);
    expect(afterFirst[0].published_at).not.toBeNull();

    const second = await ctx.relay.drain();
    expect(second.dispatched).toBe(0);
  });

  it('drains events from every registered schema in one pass', async () => {
    const owner = await seedUser(app, dataSource, '+989129990005', ['professional']);
    const customer = await seedUser(app, dataSource, '+989139990005');
    const professional = await seedProfessional(dataSource, owner.id, 'الهام');
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(58));

    const checkout = app.get(await import('../src/checkout/checkout.service').then((m) => m.CheckoutService));
    await checkout.checkout({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
      callbackUrl: 'http://x/cb',
    });

    // checkout already drained post-commit; every staged row across booking,
    // commerce, and payment should be published.
    const [{ unpublished }] = await dataSource.query(`
      SELECT (
        (SELECT COUNT(*) FROM booking.outbox_events WHERE published_at IS NULL) +
        (SELECT COUNT(*) FROM commerce.outbox_events WHERE published_at IS NULL) +
        (SELECT COUNT(*) FROM payment.outbox_events WHERE published_at IS NULL)
      )::int AS unpublished
    `);
    expect(unpublished).toBe(0);
  });

  it('never writes a credential into an outbox payload', async () => {
    // Structural, not a spot check: every payload ever staged is scanned for
    // the forbidden keys the event catalog names.
    const owner = await seedUser(app, dataSource, '+989129990006', ['professional']);
    const customer = await seedUser(app, dataSource, '+989139990006');
    const professional = await seedProfessional(dataSource, owner.id, 'رها');
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(64));

    const checkout = app.get(await import('../src/checkout/checkout.service').then((m) => m.CheckoutService));
    await checkout.checkout({ customerId: customer.id, professionalId: professional.id, slotId, serviceId: professional.serviceId, callbackUrl: 'http://x/cb' });

    const rows = await dataSource.query(`
      SELECT payload FROM booking.outbox_events
      UNION ALL SELECT payload FROM commerce.outbox_events
      UNION ALL SELECT payload FROM payment.outbox_events
    `);
    expect(rows.length).toBeGreaterThan(0);

    const forbidden = ['code', 'otp', 'password', 'token', 'accessToken', 'refreshToken', 'secret', 'merchantId'];
    for (const row of rows) {
      const keys = Object.keys(row.payload).map((k) => k.toLowerCase());
      for (const bad of forbidden) {
        expect(keys).not.toContain(bad.toLowerCase());
      }
    }
  });
});
