import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { BookingService, BookingEntity, AvailabilitySlotEntity } from '@beauclick/booking';
import { WaitlistService, WaitlistEntryEntity, OfferNotAvailableException } from '@beauclick/waitlist';
import { OutboxRelay } from '@beauclick/events';

import {
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';
import { WaitlistAcceptanceService } from '../src/waitlist/waitlist-acceptance.service';

/**
 * REAL concurrency, against REAL PostgreSQL -- proving GAP-26's invariant
 * (an offer never reserves the slot) rather than merely asserting the
 * design intended it. Same discipline `booking-concurrency.pg-spec.ts`
 * established: genuinely simultaneous operations through separate
 * connections, never a sequential pair standing in for a race.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Waitlist concurrency on real PostgreSQL', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let bookings: BookingService;
  let waitlist: WaitlistService;
  let acceptance: WaitlistAcceptanceService;
  let relay: OutboxRelay;

  beforeAll(async () => {
    const ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    bookings = app.get(BookingService);
    waitlist = app.get(WaitlistService);
    acceptance = app.get(WaitlistAcceptanceService);
    relay = ctx.relay;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  async function scenario() {
    const owner = await seedUser(app, dataSource, `+9891201${String(Date.now()).slice(-5)}`, ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'آرایشگاه سارا');
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(72));
    const firstCustomer = await seedUser(app, dataSource, `+98914${String(Date.now()).slice(-6)}0`);
    const secondCustomer = await seedUser(app, dataSource, `+98914${String(Date.now()).slice(-6)}1`);
    return { professional, slotId, firstCustomer, secondCustomer };
  }

  it('never reserves the slot -- the slot stays "open" while an entry is only waiting', async () => {
    const { professional, firstCustomer } = await scenario();
    await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });

    // A completely unrelated direct customer can still book normally --
    // joining the waitlist claimed nothing.
    const directCustomer = await seedUser(app, dataSource, `+98915${String(Date.now()).slice(-6)}`);
    const slot2 = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(80));
    const directBooking = await bookings.create({ customerId: directCustomer.id, professionalId: professional.id, slotId: slot2 });
    expect(directBooking.status).toBe('pending');
  });

  it('offers a reopened slot to the EARLIEST waiting entry only -- the second stays waiting', async () => {
    const { professional, slotId, firstCustomer, secondCustomer } = await scenario();
    const entry1 = await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });
    // Ensure a distinct created_at ordering regardless of clock resolution.
    await new Promise((r) => setTimeout(r, 5));
    const entry2 = await waitlist.join({ customerId: secondCustomer.id, professionalId: professional.id, serviceId: null });

    // Open a booking on the slot, then cancel it -- the real trigger path
    // (BookingCancelled), not a call directly into the matcher.
    const holder = await seedUser(app, dataSource, `+98916${String(Date.now()).slice(-6)}`);
    const holdingBooking = await bookings.create({ customerId: holder.id, professionalId: professional.id, slotId });
    await bookings.cancel(holdingBooking.id, { type: 'customer', id: holder.id }, 'تغییر نظر دادم');
    await relay.drain();

    const offered1 = await waitlist.findById(entry1.id);
    const stillWaiting2 = await waitlist.findById(entry2.id);
    expect(offered1?.status).toBe('offered');
    expect(offered1?.offeredSlotId).toBe(slotId);
    expect(stillWaiting2?.status).toBe('waiting');

    // The slot itself is untouched by the offer (GAP-26): still 'open'.
    const slotRow = await dataSource.getRepository(AvailabilitySlotEntity).findOne({ where: { id: slotId } });
    expect(slotRow?.status).toBe('open');
  });

  it('accepting a valid offer produces exactly one real booking, via the SAME atomic claim', async () => {
    const { professional, slotId, firstCustomer } = await scenario();
    const entry = await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });

    const holder = await seedUser(app, dataSource, `+98917${String(Date.now()).slice(-6)}`);
    const holdingBooking = await bookings.create({ customerId: holder.id, professionalId: professional.id, slotId });
    await bookings.cancel(holdingBooking.id, { type: 'customer', id: holder.id }, null);
    await relay.drain();

    const booking = await acceptance.accept(entry.id, firstCustomer.id);
    expect(booking.slotId).toBe(slotId);
    expect(booking.customerId).toBe(firstCustomer.id);

    const accepted = await waitlist.findById(entry.id);
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.resultingBookingId).toBe(booking.id);

    const liveBookingsOnSlot = await dataSource
      .getRepository(BookingEntity)
      .count({ where: { slotId, status: 'pending' as never } });
    expect(liveBookingsOnSlot).toBe(1);
  });

  it(
    'the hard guarantee: a faster DIRECT customer racing the offered candidate wins at most one booking, ' +
      'and the waitlist candidate is told, never given a phantom booking',
    async () => {
      const { professional, slotId, firstCustomer } = await scenario();
      const entry = await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });

      const holder = await seedUser(app, dataSource, `+98918${String(Date.now()).slice(-6)}`);
      const holdingBooking = await bookings.create({ customerId: holder.id, professionalId: professional.id, slotId });
      await bookings.cancel(holdingBooking.id, { type: 'customer', id: holder.id }, null);
      await relay.drain();
      expect((await waitlist.findById(entry.id))?.status).toBe('offered');

      const racer = await seedUser(app, dataSource, `+98919${String(Date.now()).slice(-6)}`);

      // Genuinely simultaneous: the waitlist candidate's accept() and a
      // direct competitor's create() fired with no await between them.
      const [acceptResult, directResult] = await Promise.allSettled([
        acceptance.accept(entry.id, firstCustomer.id),
        bookings.create({ customerId: racer.id, professionalId: professional.id, slotId }),
      ]);

      const outcomes = [acceptResult, directResult];
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      // Exactly one side got the slot -- never both, never neither.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const liveBookingsOnSlot = await dataSource
        .getRepository(BookingEntity)
        .count({ where: { slotId, status: 'pending' as never } });
      expect(liveBookingsOnSlot).toBe(1);

      if (acceptResult.status === 'rejected') {
        // The waitlist side lost: the entry must reflect that honestly, as
        // 'missed', not linger as a stale 'offered' row implying the slot is
        // still gettable.
        const finalEntry = await waitlist.findById(entry.id);
        expect(finalEntry?.status).toBe('missed');
        expect(finalEntry?.resultingBookingId).toBeNull();
      }
    },
  );

  it('rejects accepting an offer that already expired', async () => {
    const { professional, slotId, firstCustomer } = await scenario();
    const entry = await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });
    await dataSource.getRepository(WaitlistEntryEntity).update(entry.id, {
      status: 'offered',
      offeredSlotId: slotId,
      offerExpiresAt: new Date(Date.now() - 1000),
    });

    await expect(acceptance.accept(entry.id, firstCustomer.id)).rejects.toBeInstanceOf(OfferNotAvailableException);
  });

  it('decline re-offers the still-open slot to the next candidate', async () => {
    const { professional, slotId, firstCustomer, secondCustomer } = await scenario();
    const entry1 = await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });
    await new Promise((r) => setTimeout(r, 5));
    const entry2 = await waitlist.join({ customerId: secondCustomer.id, professionalId: professional.id, serviceId: null });

    const holder = await seedUser(app, dataSource, `+98920${String(Date.now()).slice(-6)}`);
    const holdingBooking = await bookings.create({ customerId: holder.id, professionalId: professional.id, slotId });
    await bookings.cancel(holdingBooking.id, { type: 'customer', id: holder.id }, null);
    await relay.drain();
    expect((await waitlist.findById(entry1.id))?.status).toBe('offered');

    await waitlist.decline(entry1.id, firstCustomer.id);
    // Two hops: WaitlistDeclined must drain before the matcher's resulting
    // WaitlistOffered row exists to be observed.
    await relay.drain();

    const declined = await waitlist.findById(entry1.id);
    const nowOffered = await waitlist.findById(entry2.id);
    expect(declined?.status).toBe('declined');
    expect(nowOffered?.status).toBe('offered');
    expect(nowOffered?.offeredSlotId).toBe(slotId);
  });

  it('an expired offer re-offers the same still-open slot to the next candidate', async () => {
    const { professional, slotId, firstCustomer, secondCustomer } = await scenario();
    const entry1 = await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });
    await new Promise((r) => setTimeout(r, 5));
    const entry2 = await waitlist.join({ customerId: secondCustomer.id, professionalId: professional.id, serviceId: null });

    const holder = await seedUser(app, dataSource, `+98921${String(Date.now()).slice(-6)}`);
    const holdingBooking = await bookings.create({ customerId: holder.id, professionalId: professional.id, slotId });
    await bookings.cancel(holdingBooking.id, { type: 'customer', id: holder.id }, null);
    await relay.drain();
    expect((await waitlist.findById(entry1.id))?.status).toBe('offered');

    // Force the offer into the past rather than waiting out the real window.
    await dataSource.getRepository(WaitlistEntryEntity).update(entry1.id, { offerExpiresAt: new Date(Date.now() - 1000) });
    expect(await waitlist.expireStaleOffers()).toBe(1);
    await relay.drain();

    expect((await waitlist.findById(entry1.id))?.status).toBe('expired');
    const nowOffered = await waitlist.findById(entry2.id);
    expect(nowOffered?.status).toBe('offered');
    expect(nowOffered?.offeredSlotId).toBe(slotId);
  });

  it('a redelivered slot-reopened event does not offer the same slot twice (idempotent matching)', async () => {
    const { professional, slotId, firstCustomer, secondCustomer } = await scenario();
    const entry1 = await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });
    await new Promise((r) => setTimeout(r, 5));
    const entry2 = await waitlist.join({
      customerId: secondCustomer.id,
      professionalId: professional.id,
      serviceId: null,
    });

    // Two concurrent matcher invocations for the identical slot -- simulates
    // an at-least-once redelivery racing the first dispatch.
    const results = await Promise.allSettled([
      waitlist.offerNextFor(professional.id, slotId, null),
      waitlist.offerNextFor(professional.id, slotId, null),
    ]);
    // Neither call should REJECT -- a genuine error here must fail loudly,
    // not be silently filtered out by the 'fulfilled' check below (exactly
    // the failure mode that hid this method's own real bugs during
    // development: Promise.allSettled swallows a rejection's reason unless
    // it is inspected directly).
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    const offeredEntries = results
      .filter((r): r is PromiseFulfilledResult<WaitlistEntryEntity | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((v): v is WaitlistEntryEntity => v !== null);

    // Only ONE of the two concurrent calls actually created an offer. THIS is
    // the invariant redelivery must not break, and it holds.
    expect(offeredEntries).toHaveLength(1);

    // Deliberately NOT asserting the winner is entry1. Under genuine
    // concurrency the FIFO ordering is not promised, by design: the matcher
    // selects with `FOR UPDATE SKIP LOCKED`, so when call A has already
    // locked the earliest row, call B is SUPPOSED to skip past it to the next
    // candidate rather than block -- that skip is the whole point of the
    // clause. Whichever transaction commits first wins, and the loser is
    // rejected by the partial unique index on `offered_slot_id`.
    //
    // This originally asserted `entry1`, passed for several runs by timing
    // luck, and then failed once unrelated load shifted the interleaving --
    // i.e. it was testing a guarantee the system never made. FIFO ordering IS
    // real and IS tested, in the non-concurrent case above ("offers a
    // reopened slot to the EARLIEST waiting entry only"), which is where that
    // property is actually well-defined.
    expect([entry1.id, entry2.id]).toContain(offeredEntries[0].id);

    const activeOffersOnSlot = await dataSource
      .getRepository(WaitlistEntryEntity)
      .count({ where: { offeredSlotId: slotId, status: 'offered' as never } });
    expect(activeOffersOnSlot).toBe(1);
  });

  it('rejects a duplicate active join for the same (customer, professional) with serviceId=null -- the real COALESCE index', async () => {
    const { professional, firstCustomer } = await scenario();
    await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });
    await expect(waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null })).rejects.toThrow();
  });

  describe('offerNextFor -- service eligibility (matching booking.service.ts\'s own claim rule)', () => {
    it('matches an "any service" entry to a slot with a specific service', async () => {
      const { professional, firstCustomer } = await scenario();
      const entry = await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: null });
      const offered = await waitlist.offerNextFor(professional.id, uuidv7(), professional.serviceId);
      expect(offered?.id).toBe(entry.id);
    });

    it('matches a specific-service entry to a GENERIC (no-service) slot', async () => {
      const { professional, firstCustomer } = await scenario();
      const entry = await waitlist.join({
        customerId: firstCustomer.id,
        professionalId: professional.id,
        serviceId: professional.serviceId,
      });
      const offered = await waitlist.offerNextFor(professional.id, uuidv7(), null);
      expect(offered?.id).toBe(entry.id);
    });

    it('does NOT match a specific-service entry to a slot for a DIFFERENT service', async () => {
      const { professional, firstCustomer } = await scenario();
      await waitlist.join({ customerId: firstCustomer.id, professionalId: professional.id, serviceId: professional.serviceId });
      const otherServiceId = '00000000-0000-7000-8000-000000000000';
      expect(await waitlist.offerNextFor(professional.id, uuidv7(), otherServiceId)).toBeNull();
    });
  });
});
