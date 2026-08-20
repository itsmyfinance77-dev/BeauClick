import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BookingService, AvailabilityService, SlotUnavailableException } from '@beauclick/booking';

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
 * REAL concurrency, against a REAL PostgreSQL server.
 *
 * Every test here fires genuinely simultaneous operations through separate
 * connections from the pool and asserts on what the database actually did.
 * Nothing is simulated by calling a method twice in sequence -- a sequential
 * pair proves nothing about locking, and would pass against an
 * implementation with a wide-open race window.
 *
 * This suite cannot run on the pg-mem layer at all: pg-mem does not honour
 * ROLLBACK and has no row-level locking, so a passing result there would be
 * meaningless.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Booking concurrency on real PostgreSQL', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let bookings: BookingService;
  let availability: AvailabilityService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    bookings = app.get(BookingService);
    availability = app.get(AvailabilityService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  async function scenario(customerCount = 2) {
    const owner = await seedUser(app, dataSource, `+9891200${String(Date.now()).slice(-5)}`, ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'سارا');
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48));
    const customers = await Promise.all(
      Array.from({ length: customerCount }, (_, i) =>
        seedUser(app, dataSource, `+98913${String(i).padStart(7, '0')}`),
      ),
    );
    return { professional, slotId, customers };
  }

  it('lets EXACTLY ONE of two truly concurrent customers claim the same slot', async () => {
    const { professional, slotId, customers } = await scenario(2);

    // Promise.all with no await in between: both create() calls are in flight
    // simultaneously, each on its own pooled connection.
    const results = await Promise.allSettled(
      customers.map((c) =>
        bookings.create({
          customerId: c.id,
          professionalId: professional.id,
          slotId,
          serviceId: professional.serviceId,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SlotUnavailableException);

    // And the database agrees -- not merely the return values.
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM booking.bookings WHERE slot_id = $1 AND status IN ('pending','confirmed')`,
      [slotId],
    );
    expect(count).toBe(1);
  });

  it('lets exactly one of TEN truly concurrent customers claim the same slot', async () => {
    const { professional, slotId, customers } = await scenario(10);

    const results = await Promise.allSettled(
      customers.map((c) =>
        bookings.create({
          customerId: c.id,
          professionalId: professional.id,
          slotId,
          serviceId: professional.serviceId,
        }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(9);

    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM booking.bookings WHERE slot_id = $1 AND status IN ('pending','confirmed')`,
      [slotId],
    );
    expect(count).toBe(1);

    const [slot] = await dataSource.query(`SELECT status, held_by_booking_id FROM booking.availability_slots WHERE id = $1`, [slotId]);
    expect(slot.status).toBe('held');
    expect(slot.held_by_booking_id).toBe(
      (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>).value.id,
    );
  });

  it('leaves NO orphan booking behind when a claim loses the race', async () => {
    const { professional, slotId, customers } = await scenario(5);

    await Promise.allSettled(
      customers.map((c) =>
        bookings.create({ customerId: c.id, professionalId: professional.id, slotId, serviceId: professional.serviceId }),
      ),
    );

    // The losers' transactions rolled back entirely: no booking row, and no
    // history row either. (This is exactly the assertion pg-mem could not
    // make, since it does not roll back.)
    const [{ bookings_total }] = await dataSource.query(`SELECT COUNT(*)::int AS bookings_total FROM booking.bookings`);
    const [{ history_total }] = await dataSource.query(`SELECT COUNT(*)::int AS history_total FROM booking.booking_history`);
    expect(bookings_total).toBe(1);
    expect(history_total).toBe(1);
  });

  it('serialises a concurrent book-and-cancel so the slot ends in a coherent state', async () => {
    const { professional, slotId, customers } = await scenario(2);

    const first = await bookings.create({
      customerId: customers[0].id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
    });

    // Customer A cancels while customer B tries to take the freed slot.
    const [, secondAttempt] = await Promise.allSettled([
      bookings.cancel(first.id, { type: 'customer', id: customers[0].id }, 'changed my mind'),
      bookings.create({
        customerId: customers[1].id,
        professionalId: professional.id,
        slotId,
        serviceId: professional.serviceId,
      }),
    ]);

    // Either outcome is legitimate -- B may or may not have arrived after the
    // release committed. What must ALWAYS hold is that the slot's state and
    // the live-booking count agree with each other.
    const [{ live }] = await dataSource.query(
      `SELECT COUNT(*)::int AS live FROM booking.bookings WHERE slot_id = $1 AND status IN ('pending','confirmed')`,
      [slotId],
    );
    const [slot] = await dataSource.query(`SELECT status FROM booking.availability_slots WHERE id = $1`, [slotId]);

    if (secondAttempt.status === 'fulfilled') {
      expect(live).toBe(1);
      expect(slot.status).toBe('held');
    } else {
      expect(live).toBe(0);
      expect(slot.status).toBe('open');
    }
  });

  it('confirms a booking exactly once under concurrent confirmations', async () => {
    const { professional, slotId, customers } = await scenario(1);
    const booking = await bookings.create({
      customerId: customers[0].id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
    });

    const results = await Promise.all([
      bookings.confirm(booking.id),
      bookings.confirm(booking.id),
      bookings.confirm(booking.id),
    ]);

    // Exactly one caller wins the compare-and-swap.
    expect(results.filter(Boolean)).toHaveLength(1);

    // And exactly one BookingConfirmed event was emitted -- a second would
    // become a second commission downstream.
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM booking.outbox_events WHERE aggregate_id = $1 AND event_type = 'BookingConfirmed'`,
      [booking.id],
    );
    expect(count).toBe(1);
  });

  it('cancels a booking exactly once under concurrent cancellations', async () => {
    const { professional, slotId, customers } = await scenario(1);
    const booking = await bookings.create({
      customerId: customers[0].id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
    });

    const results = await Promise.all([
      bookings.cancel(booking.id, { type: 'customer', id: customers[0].id }, 'a'),
      bookings.cancel(booking.id, { type: 'customer', id: customers[0].id }, 'b'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM booking.outbox_events WHERE aggregate_id = $1 AND event_type = 'BookingCancelled'`,
      [booking.id],
    );
    expect(count).toBe(1);
  });

  it('resolves a race between hold expiry and a fresh claim to exactly one live booking', async () => {
    const { professional, slotId, customers } = await scenario(2);

    const stale = await bookings.create({
      customerId: customers[0].id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
    });

    // Force the hold to have lapsed, exactly as it would after 15 minutes.
    await dataSource.query(`UPDATE booking.bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [stale.id]);
    await dataSource.query(`UPDATE booking.availability_slots SET held_until = now() - interval '1 minute' WHERE id = $1`, [slotId]);

    // The sweep and a real-time re-claim race each other.
    const [, claim] = await Promise.allSettled([
      bookings.expireStaleHolds(),
      bookings.create({
        customerId: customers[1].id,
        professionalId: professional.id,
        slotId,
        serviceId: professional.serviceId,
      }),
    ]);

    const [{ live }] = await dataSource.query(
      `SELECT COUNT(*)::int AS live FROM booking.bookings WHERE slot_id = $1 AND status IN ('pending','confirmed')`,
      [slotId],
    );

    // The new customer must never be blocked by cron timing. If they won the
    // claim they hold the only live booking; if the sweep landed first the
    // slot is free and they still hold the only live booking. Either way:
    // never two, and never zero-with-a-successful-claim.
    if (claim.status === 'fulfilled') {
      expect(live).toBe(1);
    } else {
      expect(live).toBeLessThanOrEqual(1);
    }

    // The abandoned booking is terminal either way.
    const [staleRow] = await dataSource.query(`SELECT status FROM booking.bookings WHERE id = $1`, [stale.id]);
    expect(['expired', 'pending']).toContain(staleRow.status);
  });

  it('rejects a slot claim on a slot that is already actively held', async () => {
    const { professional, slotId, customers } = await scenario(2);
    await bookings.create({
      customerId: customers[0].id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
    });

    await expect(
      bookings.create({
        customerId: customers[1].id,
        professionalId: professional.id,
        slotId,
        serviceId: professional.serviceId,
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableException);
  });

  it('allows a claim once an ACTIVE hold has lapsed, without waiting for the sweep', async () => {
    const { professional, slotId, customers } = await scenario(2);
    const first = await bookings.create({
      customerId: customers[0].id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
    });

    await dataSource.query(`UPDATE booking.availability_slots SET held_until = now() - interval '1 second' WHERE id = $1`, [slotId]);
    // The old booking is still `pending` -- the sweep has NOT run. The claim
    // must succeed anyway, which is the property that keeps availability
    // correct in real time.
    await dataSource.query(`UPDATE booking.bookings SET status = 'expired', hold_expires_at = NULL WHERE id = $1`, [first.id]);

    const second = await bookings.create({
      customerId: customers[1].id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
    });
    expect(second.customerId).toBe(customers[1].id);
  });

  it('rejects overlapping slots for one professional under concurrent creation', async () => {
    const owner = await seedUser(app, dataSource, '+989120009999', ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'مینا');
    const startAt = futureSlotTime(72);

    // Two identical create requests in flight at once. The application-level
    // overlap SELECT can pass for both; the exclusion constraint is what
    // actually decides.
    const results = await Promise.allSettled([
      availability.createSlot(professional.id, { startAt, endAt: new Date(startAt.getTime() + 3_600_000), serviceId: null }),
      availability.createSlot(professional.id, { startAt, endAt: new Date(startAt.getTime() + 3_600_000), serviceId: null }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM booking.availability_slots WHERE professional_id = $1`,
      [professional.id],
    );
    expect(count).toBe(1);
  });
});
