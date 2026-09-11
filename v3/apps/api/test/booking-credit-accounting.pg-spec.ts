import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BookingService } from '@beauclick/booking';
import { SandboxPaymentProvider } from '@beauclick/payment';
import {
  BookingCreditAccountingService,
  SellerSubscriptionService,
  SubscriberPartyType,
} from '@beauclick/commercial-policy';

import { SUBJECT_DATA_CONTRACTS, SubjectDataContract } from '@beauclick/subject-data';

import { CheckoutService } from '../src/checkout/checkout.service';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/**
 * Booking-credit accounting — V3.3 #58 (`#58a`), ADR-046, `V33-DEC-025`.
 *
 * ## Why here
 *
 * Every claim this story makes is about rows under contention: that two
 * different bookings cannot both spend the last credit, that the same booking
 * cannot be charged twice, that a rollback leaves no consumption, that the
 * ledger refuses UPDATE and DELETE, and that a return credits the party
 * snapshotted at consumption rather than whoever the seller is affiliated with
 * now. pg-mem enforces no CHECK, honours no ROLLBACK, runs no PL/pgSQL and has
 * no advisory locks, so none of it is observable on the fast layer.
 *
 * ## The dormant/exhausted pair is the point
 *
 * Both are a balance of zero. One confirms and one refuses. They are asserted
 * side by side, because a test that only checked "balance zero refuses" would
 * pass against an implementation that locked every seller out, and a test that
 * only checked "balance zero confirms" would pass against one that gave credit
 * away for ever.
 */
describePg('booking-credit accounting (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let checkout: CheckoutService;
  let bookings: BookingService;
  let credits: BookingCreditAccountingService;
  let subscriptions: SellerSubscriptionService;
  let sandbox: SandboxPaymentProvider;

  let sequence = 0;
  const nextPhone = (): string => `+98914${String(1000000 + (sequence += 1)).slice(-7)}`;
  const CALLBACK_BASE = 'http://localhost:3099/api/v1/payments/callback';

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    checkout = app.get(CheckoutService);
    bookings = app.get(BookingService);
    credits = app.get(BookingCreditAccountingService);
    subscriptions = app.get(SellerSubscriptionService);
    sandbox = app.get(SandboxPaymentProvider);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  interface Booked {
    customer: SeededUser;
    bookingId: string;
    orderId: string;
    partyType: SubscriberPartyType;
    partyId: string;
  }

  /** A zero-priced booking through the real public route: #81's confirmation path. */
  async function bookZeroCollectible(): Promise<Booked> {
    sequence += 1;
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص اعتبار', 0);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48 + sequence));

    const result = await checkout.checkout({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
      callbackBaseUrl: CALLBACK_BASE,
    });

    const [order] = await dataSource.query(
      'SELECT seller_party_type, seller_party_id FROM commerce.orders WHERE id = $1',
      [result.order.order.id],
    );
    return {
      customer,
      bookingId: result.bookingId,
      orderId: result.order.order.id,
      partyType: order.seller_party_type as SubscriberPartyType,
      partyId: order.seller_party_id,
    };
  }

  const consumptions = async (bookingId?: string) =>
    bookingId
      ? dataSource.query('SELECT * FROM commercial.booking_credit_consumptions WHERE booking_id = $1', [bookingId])
      : dataSource.query('SELECT * FROM commercial.booking_credit_consumptions');

  const returns = async () => dataSource.query('SELECT * FROM commercial.booking_credit_returns');

  const bookingRow = async (bookingId: string) => {
    const [row] = await dataSource.query('SELECT * FROM booking.bookings WHERE id = $1', [bookingId]);
    return row;
  };

  /**
   * Re-publish a base plan version, because `resetDatabase` truncates the
   * migration's own `D-7` seed away.
   *
   * Inserted as a DRAFT and then published, exactly as the migration does: both
   * lifecycle triggers refuse a row born published, so a fixture that tried to
   * shortcut that would be refused by the same rules an administrator meets.
   * Zero included credits, matching the real seed -- the positive grants this
   * suite needs are planted separately and deliberately.
   */
  async function ensureBasePlan(): Promise<void> {
    const [existing] = await dataSource.query(
      "SELECT id FROM commercial.plan_versions WHERE auto_assignable = true AND lifecycle_state = 'published' LIMIT 1",
    );
    if (existing) return;

    const scheduleVersionId = uuidv7();
    await dataSource.query(
      "INSERT INTO commercial.price_schedules (schedule_key, purpose, created_by_label) VALUES ('suite-base', 'seller_plan', 'suite') ON CONFLICT DO NOTHING",
    );
    await dataSource.query(
      `INSERT INTO commercial.price_schedule_versions
         (id, schedule_key, version, display_name, currency_code, min_purchase_quantity,
          max_purchase_quantity, ui_preset_quantities, activation_starts_at, created_by_label)
       VALUES ($1, 'suite-base', 1, 'suite base', 'IRT', 1, 1, '{}', '1970-01-01T00:00:00Z', 'suite')`,
      [scheduleVersionId],
    );
    await dataSource.query(
      `INSERT INTO commercial.price_tiers (id, schedule_version_id, min_quantity, max_quantity, unit_price_toman, created_by_label)
       VALUES ($1, $2, 1, 1, 0, 'suite')`,
      [uuidv7(), scheduleVersionId],
    );
    await dataSource.query(
      "UPDATE commercial.price_schedule_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1",
      [scheduleVersionId],
    );

    const planVersionId = uuidv7();
    await dataSource.query(
      "INSERT INTO commercial.plans (plan_key, created_by_label) VALUES ('SUITE-BASE', 'suite') ON CONFLICT DO NOTHING",
    );
    await dataSource.query(
      `INSERT INTO commercial.plan_versions
         (id, plan_key, version, display_name, billing_term_days, included_booking_credits,
          staff_seats, included_locations, capability_keys, price_schedule_version_id,
          auto_assignable, activation_starts_at, created_by_label)
       VALUES ($1, 'SUITE-BASE', 1, 'suite base', NULL, 0, 0, 0, '{}', $2, true, '1970-01-01T00:00:00Z', 'suite')`,
      [planVersionId, scheduleVersionId],
    );
    await dataSource.query(
      "UPDATE commercial.plan_versions SET lifecycle_state = 'published', published_at = now(), published_by_label = 'suite' WHERE id = $1",
      [planVersionId],
    );
  }

  /**
   * Give a party a positive grant.
   *
   * Planted rather than produced, because no production path grants a positive
   * quantity — `D-7` confers zero and #57 is unimplemented. That absence is the
   * reason `#58a` enforces selectively, and this fixture is how the *active*
   * half is exercised at all.
   */
  async function grantCredits(party: { partyType: SubscriberPartyType; partyId: string }, quantity: number): Promise<string> {
    /*
     * #56's lazy ensure fires on the SUBSCRIPTION surface, not on booking, so a
     * seller who has only ever taken bookings has no subscription row at all.
     * That is a real state -- and one the service already handles, because no
     * subscription means no positive grant means dormant. Here it just means
     * the fixture has to create what it wants to grant against.
     */
    await ensureBasePlan();
    await subscriptions.ensureBaseSubscription(party);
    const [sub] = await dataSource.query(
      `SELECT id, plan_version_id FROM commercial.seller_subscriptions
        WHERE subscriber_party_type = $1 AND subscriber_party_id = $2 LIMIT 1`,
      [party.partyType, party.partyId],
    );
    const id = uuidv7();
    /*
     * A distinct `period_index` per planted grant.
     *
     * `uq_booking_credit_grants_once` is UNIQUE (subscription_id, source,
     * period_index), and the lazy ensure has already written the zero grant at
     * period 0 -- so a second `plan_included` grant for the same period is
     * refused by the database. That constraint is #56's, it is correct for
     * plan-included grants, and #58a does not touch it; the fixture works
     * within it rather than around it, which also gives the allocation tests a
     * genuine multi-grant party.
     */
    const [{ next_period }] = await dataSource.query(
      `SELECT coalesce(max(period_index), 0) + 1 AS next_period
         FROM commercial.booking_credit_grants WHERE subscription_id = $1`,
      [sub.id],
    );
    await dataSource.query(
      `INSERT INTO commercial.booking_credit_grants
         (id, subscription_id, plan_version_id, subscriber_party_type, subscriber_party_id,
          source, quantity, period_index)
       VALUES ($1, $2, $3, $4, $5, 'plan_included', $6, $7)`,
      [id, sub.id, sub.plan_version_id, party.partyType, party.partyId, quantity, Number(next_period)],
    );
    return id;
  }

  // =========================================================================
  // 1. Dormant versus exhausted — the same zero, opposite outcomes
  // =========================================================================

  describe('selective enforcement', () => {
    it('a party that never held a positive grant confirms and consumes nothing', async () => {
      const booked = await bookZeroCollectible();

      expect((await bookingRow(booked.bookingId)).status).toBe('confirmed');
      expect(await consumptions(booked.bookingId)).toHaveLength(0);
      /*
       * Dormant means NO POSITIVE grant -- which covers both shapes a seller can
       * be in today: no subscription at all (the lazy ensure fires on the
       * subscription surface, not on booking), or the seeded `D-7` zero grant.
       * Neither is an entitlement, and the balance is zero either way.
       */
      const positive = await dataSource.query(
        `SELECT quantity FROM commercial.booking_credit_grants
          WHERE subscriber_party_type = $1 AND subscriber_party_id = $2 AND quantity > 0`,
        [booked.partyType, booked.partyId],
      );
      expect(positive).toHaveLength(0);
      expect(await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId })).toBe(0);
    });

    it('control: a party WITH a positive grant consumes exactly one credit', async () => {
      // The non-vacuity control for the dormant case above: same route, same
      // zero-collectible confirmation, ONE fact changed -- the party now holds a
      // positive grant -- and a consumption must appear.
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص فعال', 0);
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);

      // Confirm once to create the subscription, then configure it.
      const warmSlot = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(200));
      const warm = await checkout.checkout({
        customerId: customer.id,
        professionalId: professional.id,
        slotId: warmSlot,
        serviceId: professional.serviceId,
        callbackBaseUrl: CALLBACK_BASE,
      });
      const [order] = await dataSource.query(
        'SELECT seller_party_type, seller_party_id FROM commerce.orders WHERE id = $1',
        [warm.order.order.id],
      );
      const party = { partyType: order.seller_party_type as SubscriberPartyType, partyId: order.seller_party_id };
      expect(await consumptions(warm.bookingId)).toHaveLength(0);

      await grantCredits(party, 1);

      const slot = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(224));
      const booked = await checkout.checkout({
        customerId: customer.id,
        professionalId: professional.id,
        slotId: slot,
        serviceId: professional.serviceId,
        callbackBaseUrl: CALLBACK_BASE,
      });

      expect((await bookingRow(booked.bookingId)).status).toBe('confirmed');
      expect(await consumptions(booked.bookingId)).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, party)).toBe(0);
    });

    it('an exhausted party is REFUSED at the same balance a dormant party confirms at', async () => {
      // Grant one credit, spend it, then try again with the same seller.
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص سهمیه', 0);
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);

      const slotA = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(72));
      const first = await checkout.checkout({
        customerId: customer.id,
        professionalId: professional.id,
        slotId: slotA,
        serviceId: professional.serviceId,
        callbackBaseUrl: CALLBACK_BASE,
      });
      const [orderA] = await dataSource.query(
        'SELECT seller_party_type, seller_party_id FROM commerce.orders WHERE id = $1',
        [first.order.order.id],
      );
      const party = { partyType: orderA.seller_party_type as SubscriberPartyType, partyId: orderA.seller_party_id };

      // Dormant at this point: the first booking confirmed and consumed nothing.
      expect(await consumptions(first.bookingId)).toHaveLength(0);

      // Now configure the party with exactly one credit and spend it.
      await grantCredits(party, 1);
      const slotB = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(96));
      const second = await checkout.checkout({
        customerId: customer.id,
        professionalId: professional.id,
        slotId: slotB,
        serviceId: professional.serviceId,
        callbackBaseUrl: CALLBACK_BASE,
      });
      expect(await consumptions(second.bookingId)).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, party)).toBe(0);

      // Balance is zero again — exactly as it was for the dormant case above —
      // and this time the confirmation must be REFUSED.
      const slotC = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(120));
      await expect(
        checkout.checkout({
          customerId: customer.id,
          professionalId: professional.id,
          slotId: slotC,
          serviceId: professional.serviceId,
          callbackBaseUrl: CALLBACK_BASE,
        }),
      ).rejects.toThrow();

      expect(await consumptions()).toHaveLength(1);
    });

    it('a zero-quantity grant neither activates enforcement nor adds balance', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 0);

      expect(await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId })).toBe(0);
      const outcome = await dataSource.transaction((m) =>
        credits.consumeForConfirmation(m, uuidv7(), { partyType: booked.partyType, partyId: booked.partyId }),
      );
      expect(outcome).toEqual({ outcome: 'not_configured' });
    });
  });

  // =========================================================================
  // 2. Concurrency
  // =========================================================================

  describe('concurrency', () => {
    it('two different bookings racing for the last credit produce exactly one consumption', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 1);

      const a = uuidv7();
      const b = uuidv7();
      const outcomes = await Promise.all([
        dataSource.transaction((m) => credits.consumeForConfirmation(m, a, { partyType: booked.partyType, partyId: booked.partyId })),
        dataSource.transaction((m) => credits.consumeForConfirmation(m, b, { partyType: booked.partyType, partyId: booked.partyId })),
      ]);

      expect(outcomes.filter((o) => o.outcome === 'consumed')).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === 'insufficient_credit')).toHaveLength(1);
      expect(await consumptions()).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId })).toBe(0);
    });

    it('the same booking twice produces one consumption and a replay outcome', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 5);
      const bookingId = uuidv7();

      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () =>
          dataSource.transaction((m) => credits.consumeForConfirmation(m, bookingId, { partyType: booked.partyType, partyId: booked.partyId })),
        ),
      );

      expect(outcomes.filter((o) => o.outcome === 'consumed')).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === 'already_consumed')).toHaveLength(3);
      expect(await consumptions(bookingId)).toHaveLength(1);
      // Four attempts, one credit spent.
      expect(await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId })).toBe(4);
    });

    it('raw SQL cannot charge one booking twice — the unique constraint is the guarantee', async () => {
      const booked = await bookZeroCollectible();
      const grantId = await grantCredits(booked, 2);
      const bookingId = uuidv7();
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, bookingId, { partyType: booked.partyType, partyId: booked.partyId }));

      const [g] = await dataSource.query(
        'SELECT subscription_id, period_index FROM commercial.booking_credit_grants WHERE id = $1',
        [grantId],
      );
      await expect(
        dataSource.query(
          `INSERT INTO commercial.booking_credit_consumptions
             (id, booking_id, grant_id, subscription_id, period_index, subscriber_party_type, subscriber_party_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [uuidv7(), bookingId, grantId, g.subscription_id, g.period_index, booked.partyType, booked.partyId],
        ),
      ).rejects.toThrow(/uq_bcc_booking_once/);
    });
  });

  // =========================================================================
  // 3. Allocation, immutability, returns
  // =========================================================================

  describe('allocation and the ledger', () => {
    it('allocates the oldest grant first and snapshots its period', async () => {
      const booked = await bookZeroCollectible();
      const older = await grantCredits(booked, 1);
      await new Promise((r) => setTimeout(r, 15));
      await grantCredits(booked, 1);

      const bookingId = uuidv7();
      const outcome = await dataSource.transaction((m) => credits.consumeForConfirmation(m, bookingId, { partyType: booked.partyType, partyId: booked.partyId }));

      expect(outcome).toMatchObject({ outcome: 'consumed', grantId: older });
      const [row] = await consumptions(bookingId);
      expect(row.grant_id).toBe(older);
      // The period is copied FROM the chosen grant, whatever it is -- that copy
      // is what makes term-N permanence structural, so assert the equality
      // rather than a hard-coded zero.
      const [g] = await dataSource.query('SELECT period_index FROM commercial.booking_credit_grants WHERE id = $1', [older]);
      expect(Number(row.period_index)).toBe(Number(g.period_index));
    });

    it('the ledger refuses UPDATE and DELETE on both tables', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 1);
      const bookingId = uuidv7();
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, bookingId, { partyType: booked.partyType, partyId: booked.partyId }));
      const [row] = await consumptions(bookingId);

      await expect(
        dataSource.query('UPDATE commercial.booking_credit_consumptions SET period_index = 1 WHERE id = $1', [row.id]),
      ).rejects.toThrow(/immutable/);
      await expect(
        dataSource.query('DELETE FROM commercial.booking_credit_consumptions WHERE id = $1', [row.id]),
      ).rejects.toThrow(/immutable/);

      await dataSource.transaction((m) => credits.returnForCancellation(m, bookingId, 'seller_cancelled'));
      const [ret] = await returns();
      await expect(
        dataSource.query('DELETE FROM commercial.booking_credit_returns WHERE id = $1', [ret.id]),
      ).rejects.toThrow(/immutable/);
    });

    it('a return restores balance once and is idempotent', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 1);
      const bookingId = uuidv7();
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, bookingId, { partyType: booked.partyType, partyId: booked.partyId }));
      expect(await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId })).toBe(0);

      const first = await dataSource.transaction((m) =>
        credits.returnForCancellation(m, bookingId, 'seller_cancelled'),
      );
      const second = await dataSource.transaction((m) =>
        credits.returnForCancellation(m, bookingId, 'seller_cancelled'),
      );

      expect(first.outcome).toBe('returned');
      expect(second.outcome).toBe('already_returned');
      expect(await returns()).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId })).toBe(1);
    });

    it('a return credits the party snapshotted on consumption, not current affiliation', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits({ partyType: booked.partyType, partyId: booked.partyId }, 1);

      /*
       * The REAL booking id, deliberately: a live order exists for it, so an
       * implementation that re-resolved the party from `commerce.orders` would
       * find something to re-resolve. A synthetic id would leave that lookup
       * empty and the test would pass against exactly the bug it exists to
       * catch -- a mutation probe found precisely that.
       */
      await dataSource.transaction((m) =>
        credits.consumeForConfirmation(m, booked.bookingId, {
          partyType: booked.partyType,
          partyId: booked.partyId,
        }),
      );
      const [before] = await consumptions(booked.bookingId);

      // The affiliation "changes": the order's seller snapshot moves to another
      // party. The consumption's own snapshot must be what the return follows.
      const movedTo = uuidv7();
      await dataSource.query('UPDATE commerce.orders SET seller_party_id = $2 WHERE source_id = $1', [
        booked.bookingId,
        movedTo,
      ]);
      const [check] = await dataSource.query('SELECT seller_party_id FROM commerce.orders WHERE source_id = $1', [
        booked.bookingId,
      ]);
      expect(check.seller_party_id).toBe(movedTo);

      const outcome = await dataSource.transaction((m) =>
        credits.returnForCancellation(m, booked.bookingId, 'seller_cancelled'),
      );

      expect(outcome.outcome).toBe('returned');
      const [ret] = await returns();
      expect(ret.consumption_id).toBe(before.id);
      // The balance came back to the ORIGINAL party, not the one the order now names.
      expect(
        await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId }),
      ).toBe(1);
    });

    it('nothing consumed means nothing returned', async () => {
      const outcome = await dataSource.transaction((m) =>
        credits.returnForCancellation(m, uuidv7(), 'platform_cancelled'),
      );
      expect(outcome).toEqual({ outcome: 'nothing_consumed' });
      expect(await returns()).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. Cancellation wiring and boundaries
  // =========================================================================

  describe('cancellation', () => {
    it('a professional cancellation of a confirmed booking returns the credit, once', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 1);

      // Re-confirm through the real service so a consumption exists for a REAL
      // booking id that the cancellation path can find.
      const bookingId = booked.bookingId;
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, bookingId, { partyType: booked.partyType, partyId: booked.partyId }));
      expect(await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId })).toBe(0);

      await bookings.cancel(bookingId, { type: 'professional', id: null }, 'تغییر برنامه');
      await bookings.cancel(bookingId, { type: 'professional', id: null }, 'تغییر برنامه');

      expect(await returns()).toHaveLength(1);
      expect(await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId })).toBe(1);
    });

    it('a CUSTOMER cancellation returns nothing — retention is #46, not this story', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 1);
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, booked.bookingId, { partyType: booked.partyType, partyId: booked.partyId }));

      await bookings.cancel(booked.bookingId, { type: 'customer', id: booked.customer.id }, null);

      expect(await returns()).toHaveLength(0);
      expect(await credits.balanceFor(dataSource.manager, { partyType: booked.partyType, partyId: booked.partyId })).toBe(0);
    });

    it('cancelling a booking that was never confirmed returns nothing', async () => {
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص معلق', 250_000);
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(140));

      // Positive price: the booking stays pending awaiting payment.
      const result = await checkout.checkout({
        customerId: customer.id,
        professionalId: professional.id,
        slotId,
        serviceId: professional.serviceId,
        callbackBaseUrl: CALLBACK_BASE,
      });
      expect((await bookingRow(result.bookingId)).status).toBe('pending');

      /*
       * Plant a consumption for the still-pending booking.
       *
       * Without this the test proves nothing: a pending booking has no
       * consumption, so `returnForCancellation` would answer `nothing_consumed`
       * whatever the `wasConfirmed` guard did -- and a probe that deleted the
       * guard survived exactly that way. With a consumption present, the guard
       * is the only thing standing between this cancellation and a return.
       */
      const [order] = await dataSource.query(
        'SELECT seller_party_type, seller_party_id FROM commerce.orders WHERE id = $1',
        [result.order.order.id],
      );
      const party = {
        partyType: order.seller_party_type as SubscriberPartyType,
        partyId: order.seller_party_id,
      };
      await grantCredits(party, 1);
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, result.bookingId, party));
      expect(await consumptions(result.bookingId)).toHaveLength(1);

      await bookings.cancel(result.bookingId, { type: 'professional', id: null }, null);

      // The booking was never confirmed, so nothing comes back.
      expect(await returns()).toHaveLength(0);
      expect(await credits.balanceFor(dataSource.manager, party)).toBe(0);
    });
  });

  // =========================================================================
  // 5. Structural boundaries
  // =========================================================================

  describe('boundaries', () => {
    it('the grant source vocabulary is still exactly plan_included', async () => {
      const [row] = await dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'ck_booking_credit_grants_source'`,
      );
      expect(row.def).toContain('plan_included');
      expect(row.def).not.toContain('custom_purchase');
    });

    it('a consumption cannot claim a subscription or party its grant does not have', async () => {
      const booked = await bookZeroCollectible();
      const grantId = await grantCredits(booked, 1);

      await expect(
        dataSource.query(
          `INSERT INTO commercial.booking_credit_consumptions
             (id, booking_id, grant_id, subscription_id, period_index, subscriber_party_type, subscriber_party_id)
           VALUES ($1, $2, $3, $4, 0, $5, $6)`,
          [uuidv7(), uuidv7(), grantId, uuidv7(), booked.partyType, booked.partyId],
        ),
      ).rejects.toThrow(/fk_bcc_grant_identity|violates foreign key/);
    });

    it('both ledger tables are claimed by the privacy contract as retained', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const contract = contracts.find((c) => c.moduleKey === 'commercial-subscription');
      // The three LEDGER tables, by name. V3.3 #95 (`#58b-1`) added two
      // control-plane tables under the same `booking_credit_` prefix
      // (ADR-050 §2) with their own dispositions, pinned by their own suite;
      // a prefix filter here would assert their absence, which was never this
      // test's claim.
      const LEDGER_TABLES = ['commercial.booking_credit_grants', 'commercial.booking_credit_consumptions', 'commercial.booking_credit_returns'];
      const claimed = (contract?.tables ?? [])
        .filter((c) => LEDGER_TABLES.includes(c.table))
        .map((c) => `${c.table}:${c.disposition}`)
        .sort();
      expect(claimed).toEqual([
        'commercial.booking_credit_consumptions:retained',
        'commercial.booking_credit_grants:retained',
        'commercial.booking_credit_returns:retained',
      ]);
    });
  });

  // =========================================================================
  // 6. The verified-capture path — the seam #58a added, and the money rule
  // =========================================================================

  /**
   * A positively priced booking, taken through the real public checkout route
   * and left waiting on the gateway.
   *
   * The zero-collectible fixture above cannot exercise any of this: it never
   * creates an intent, so there is no capture to preserve and no amount to
   * refund. This is the second production confirmation path (#82), and the one
   * that had no entitlement seam at all before this story.
   */
  interface PaidBooked extends Booked {
    reference: string;
    priceToman: number;
  }

  async function bookPaid(priceToman: number, hours: number): Promise<PaidBooked> {
    sequence += 1;
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص پرداختی', priceToman);
    const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(hours + sequence));

    const result = await checkout.checkout({
      customerId: customer.id,
      professionalId: professional.id,
      slotId,
      serviceId: professional.serviceId,
      callbackBaseUrl: CALLBACK_BASE,
    });

    const [attempt] = await dataSource.query(
      'SELECT provider_reference FROM payment.payment_attempts WHERE payment_intent_id = $1',
      [result.paymentIntentId],
    );
    const [order] = await dataSource.query(
      'SELECT seller_party_type, seller_party_id FROM commerce.orders WHERE id = $1',
      [result.order.order.id],
    );

    return {
      customer,
      bookingId: result.bookingId,
      orderId: result.order.order.id,
      partyType: order.seller_party_type as SubscriberPartyType,
      partyId: order.seller_party_id,
      reference: attempt.provider_reference as string,
      priceToman,
    };
  }

  /** Drive a booked order through a successful sandbox capture, as production does. */
  const captureOf = async (booked: PaidBooked) => {
    await sandbox.decide(booked.reference, 'success');
    return checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });
  };

  const orderRow = async (orderId: string) => {
    const [row] = await dataSource.query('SELECT * FROM commerce.orders WHERE id = $1', [orderId]);
    return row;
  };

  const refundsFor = async (orderId: string) =>
    dataSource.query('SELECT amount_toman, request_key FROM payment.refunds WHERE order_id = $1', [orderId]);

  /** Spend a party's entire balance against synthetic bookings, leaving it exhausted. */
  async function exhaust(party: { partyType: SubscriberPartyType; partyId: string }): Promise<void> {
    let balance = await credits.balanceFor(dataSource.manager, party);
    while (balance > 0) {
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, uuidv7(), party));
      balance -= 1;
    }
    expect(await credits.balanceFor(dataSource.manager, party)).toBe(0);
  }

  describe('the verified-capture path', () => {
    it('control: a verified capture consumes exactly one credit and confirms', async () => {
      const booked = await bookPaid(250_000, 300);
      await grantCredits(booked, 1);

      const result = await captureOf(booked);

      expect(result.outcome.status).toBe('succeeded');
      expect(result.refundIssued).toBe(false);
      expect((await bookingRow(booked.bookingId)).status).toBe('confirmed');
      expect(await consumptions(booked.bookingId)).toHaveLength(1);
      expect(await refundsFor(booked.orderId)).toHaveLength(0);
      expect(await credits.balanceFor(dataSource.manager, booked)).toBe(0);
    });

    it('an exhausted party keeps the captured money and is refunded exactly what was collected', async () => {
      const booked = await bookPaid(250_000, 340);
      await grantCredits(booked, 1);
      await exhaust(booked);

      const result = await captureOf(booked);

      /*
       * The whole resolution of "money must commit but credit must be atomic",
       * asserted as four facts that have to hold together:
       *
       *   the capture is RECORDED -- `collected_total_toman` carries the
       *   gateway-verified amount and the money fact was never rolled back;
       *   the booking is NOT confirmed;
       *   NO consumption exists;
       *   exactly ONE refund exists, for exactly the collected amount.
       */
      const order = await orderRow(booked.orderId);
      expect(Number(order.collected_total_toman)).toBe(booked.priceToman);
      expect((await bookingRow(booked.bookingId)).status).toBe('pending');
      expect(await consumptions(booked.bookingId)).toHaveLength(0);

      const refunds = await refundsFor(booked.orderId);
      expect(refunds).toHaveLength(1);
      expect(Number(refunds[0].amount_toman)).toBe(booked.priceToman);
      expect(result.refundIssued).toBe(true);
    });

    it('a replayed callback after an entitlement refusal refunds nothing further', async () => {
      const booked = await bookPaid(250_000, 380);
      await grantCredits(booked, 1);
      await exhaust(booked);

      await captureOf(booked);
      const afterFirst = await refundsFor(booked.orderId);
      expect(afterFirst).toHaveLength(1);

      // The same callback again, exactly as a gateway retry delivers it.
      await checkout.handleCallback('sandbox', booked.reference, { reference: booked.reference });

      const afterReplay = await refundsFor(booked.orderId);
      expect(afterReplay).toHaveLength(1);
      // Deterministic key, so the replay reuses the refund rather than issuing a
      // second one -- #82's idempotency, unchanged by this story.
      expect(afterReplay[0].request_key).toBe(afterFirst[0].request_key);
      expect(await consumptions(booked.bookingId)).toHaveLength(0);
    });

    it('both production confirmation paths call the one entitlement port', () => {
      /*
       * A structural assertion, because the behavioural halves live in two
       * different describes and neither of them alone catches a call site
       * DELETED from the other. Two mutation probes remove one call each and
       * both are killed by the behavioural tests; this asserts the shape those
       * probes mutate.
       */
      const source = readFileSync(join(__dirname, '..', 'src', 'checkout', 'checkout.service.ts'), 'utf8');
      const calls = source.match(/onBookingConfirmation\(/g) ?? [];
      // One per production confirmation path, and no third.
      expect(calls).toHaveLength(2);
      expect(source).toContain('onBookingConfirmation(manager, bookingId)');
      expect(source).toContain('onBookingConfirmation(manager, order.sourceId)');
    });
  });

  // =========================================================================
  // 7. The zero-collectible refusal — a rollback, and no money anywhere
  // =========================================================================

  describe('the zero-collectible refusal', () => {
    it('rolls the order transition back, leaves the booking pending and calls no refund', async () => {
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص رایگان', 0);
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);

      // One free booking to create the party, then configure and exhaust it.
      const warmSlot = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(420));
      const warm = await checkout.checkout({
        customerId: customer.id,
        professionalId: professional.id,
        slotId: warmSlot,
        serviceId: professional.serviceId,
        callbackBaseUrl: CALLBACK_BASE,
      });
      const [o] = await dataSource.query(
        'SELECT seller_party_type, seller_party_id FROM commerce.orders WHERE id = $1',
        [warm.order.order.id],
      );
      const party = { partyType: o.seller_party_type as SubscriberPartyType, partyId: o.seller_party_id };
      await grantCredits(party, 1);
      await exhaust(party);

      const before = await consumptions();
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(444));
      await expect(
        checkout.checkout({
          customerId: customer.id,
          professionalId: professional.id,
          slotId,
          serviceId: professional.serviceId,
          callbackBaseUrl: CALLBACK_BASE,
        }),
      ).rejects.toThrow();

      /*
       * Nothing moved. The order never reached
       * `online_collection_not_required`, the booking is still pending, no
       * consumption was written -- and, the part that matters most, no refund
       * exists, because no money was ever collected. A refund here would be the
       * platform inventing a payment to give back.
       */
      const stranded = await dataSource.query(
        `SELECT o.status AS order_status, b.status AS booking_status
           FROM commerce.orders o JOIN booking.bookings b ON b.id = o.source_id
          WHERE b.slot_id = $1`,
        [slotId],
      );
      expect(stranded).toHaveLength(1);
      expect(stranded[0].order_status).toBe('pending');
      expect(stranded[0].booking_status).toBe('pending');
      expect(await consumptions()).toHaveLength(before.length);
      const [{ count }] = await dataSource.query('SELECT count(*)::int AS count FROM payment.refunds');
      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // 8. A charge stays in the term it was made in
  // =========================================================================

  describe('reschedule', () => {
    it('rescheduling across a future term boundary leaves the charge byte-identical', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 1);
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, booked.bookingId, booked));
      const [before] = await consumptions(booked.bookingId);

      /*
       * A LATER grant, standing in for the next billing term.
       *
       * If anything re-derived the charge at reschedule time it would find this
       * newer grant and a higher period, so the four snapshotted columns are
       * exactly where a re-derivation would show up.
       */
      await grantCredits(booked, 5);

      const row = await bookingRow(booked.bookingId);
      const newSlot = await seedSlot(dataSource, row.professional_id, row.service_id, futureSlotTime(500));
      await bookings.reschedule(booked.bookingId, newSlot, { type: 'professional', id: null });

      const [after] = await consumptions(booked.bookingId);
      expect(after.id).toBe(before.id);
      expect(after.grant_id).toBe(before.grant_id);
      expect(after.subscription_id).toBe(before.subscription_id);
      expect(Number(after.period_index)).toBe(Number(before.period_index));
      // And the reschedule itself consumed and returned nothing.
      expect(await consumptions()).toHaveLength(1);
      expect(await returns()).toHaveLength(0);
    });
  });

  // =========================================================================
  // 9. Audit — one row per real mutation, and none for a no-op
  // =========================================================================

  /**
   * The credit audit rows for ONE party's subscription.
   *
   * Scoped rather than global on purpose: `admin.admin_audit_log` is
   * deliberately absent from `RESETTABLE_TABLES` -- an append-only audit trail
   * that a test helper truncates is not one -- so it carries every earlier
   * case's rows. A global count here would have asserted the suite's own
   * history, which is how a test ends up measuring nothing.
   */
  const subscriptionIdFor = async (party: { partyType: SubscriberPartyType; partyId: string }): Promise<string> => {
    const [row] = await dataSource.query(
      `SELECT id FROM commercial.seller_subscriptions
        WHERE subscriber_party_type = $1 AND subscriber_party_id = $2 LIMIT 1`,
      [party.partyType, party.partyId],
    );
    return row?.id ?? null;
  };

  const creditAudit = async (subscriptionId: string | null) =>
    subscriptionId === null
      ? []
      : dataSource.query(
          `SELECT action, target_type, target_id, actor_user_id, actor_label, reason, after_state
             FROM admin.admin_audit_log
            WHERE action IN ('commercial.credit_consumed', 'commercial.credit_returned')
              AND target_id = $1
            ORDER BY id`,
          [subscriptionId],
        );

  describe('audit', () => {
    it('writes exactly one row per real consumption and return, and none for a no-op', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 1);

      // A no-op first: a DIFFERENT party that is dormant.
      const other = await bookZeroCollectible();
      const dormant = await dataSource.transaction((m) =>
        credits.consumeForConfirmation(m, uuidv7(), { partyType: other.partyType, partyId: other.partyId }),
      );
      expect(dormant.outcome).toBe('not_configured');
      // Dormant writes nothing at all -- there is not even a subscription to
      // attribute a row to.
      expect(await creditAudit(await subscriptionIdFor(other))).toHaveLength(0);

      await dataSource.transaction((m) => credits.consumeForConfirmation(m, booked.bookingId, booked));
      // A replay: an outcome, but not a mutation.
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, booked.bookingId, booked));
      await dataSource.transaction((m) => credits.returnForCancellation(m, booked.bookingId, 'seller_cancelled'));
      await dataSource.transaction((m) => credits.returnForCancellation(m, booked.bookingId, 'seller_cancelled'));

      const rows = await creditAudit(await subscriptionIdFor(booked));
      expect(rows.map((r: { action: string }) => r.action)).toEqual([
        'commercial.credit_consumed',
        'commercial.credit_returned',
      ]);
      // No fabricated human actor, and a server label instead.
      expect(rows.every((r: { actor_user_id: string | null }) => r.actor_user_id === null)).toBe(true);
      expect(rows.every((r: { actor_label: string | null }) => r.actor_label === 'system')).toBe(true);
      // Closed reasons, and no counterparty identifier anywhere in the record.
      const serialized = JSON.stringify(rows);
      expect(serialized).toContain('one booking credit consumed at first booking confirmation');
      expect(serialized).toContain('seller_cancelled');
      expect(serialized).not.toContain(booked.bookingId);
      expect(serialized).not.toContain(booked.customer.id);
    });

    it('a rolled-back consumption leaves no audit row either', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 1);
      const bookingId = uuidv7();
      const subscriptionId = await subscriptionIdFor(booked);
      expect(await creditAudit(subscriptionId)).toHaveLength(0);

      await expect(
        dataSource.transaction(async (m) => {
          const outcome = await credits.consumeForConfirmation(m, bookingId, booked);
          expect(outcome.outcome).toBe('consumed');
          // The audit row is already there, INSIDE this transaction...
          const [{ n }] = await m.query(
            `SELECT count(*)::int AS n FROM admin.admin_audit_log
              WHERE action = 'commercial.credit_consumed' AND target_id = $1`,
            [subscriptionId],
          );
          expect(n).toBe(1);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      // ...and it left with the consumption, because they are one transaction.
      expect(await consumptions(bookingId)).toHaveLength(0);
      expect(await creditAudit(subscriptionId)).toHaveLength(0);
      expect(await credits.balanceFor(dataSource.manager, booked)).toBe(1);
    });
  });

  // =========================================================================
  // 10. No new surface — routes, events, producers
  // =========================================================================

  describe('no new surface', () => {
    it('adds no HTTP route for credits, consumption, returns or balance', () => {
      const server = app.getHttpServer();
      const router = server._events.request._router as {
        stack: Array<{ route?: { path: string } }>;
      };
      const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route!.path);

      // Non-vacuity: the enumerator really can see this application's routes.
      expect(paths.length).toBeGreaterThan(20);
      expect(paths).toContain('/api/v1/me/subscriptions');

      /*
       * Amended by V3.3 Story #57 (`#40c-1`), which added three
       * credit-PURCHASE routes. They are named exactly, and the claim this
       * case makes is unchanged and still exact: #58a's own surface —
       * consumption, return, balance, allowance, entitlement — is still
       * empty, and a route from any of those families fails here.
       *
       * Amended again by V3.3 Story #95 (`#58b-1`, ADR-050 §5, `V33-DEC-036`
       * R7), which added the PRIVILEGED ADMINISTRATOR sub-resource for the
       * enforcement control plane -- preview, explicit governance transition
       * and exemption, and the emergency kill switch -- under
       * `v1/admin/commercial`. Named exactly, and the claim is still exact:
       * no seller- or customer-facing credit route, no balance surface, no
       * consumption or return route exists, and no activation route (#141)
       * exists yet. A seventh enforcement route, or any route under `v1/me`
       * naming credits beyond #57's three, fails here.
       */
      expect(paths.filter((p) => /credit|consumption|entitlement|balance|allowance/i.test(p)).sort()).toEqual(
        [
          '/api/v1/me/subscriptions/:workspaceRef/credit-purchases/quote',
          '/api/v1/me/subscriptions/:workspaceRef/credit-purchases',
          '/api/v1/me/subscriptions/:workspaceRef/credit-purchases',
          '/api/v1/admin/commercial/booking-credit-enforcement',
          '/api/v1/admin/commercial/booking-credit-enforcement/preview',
          '/api/v1/admin/commercial/booking-credit-enforcement/transitions',
          '/api/v1/admin/commercial/booking-credit-enforcement/exemptions',
          '/api/v1/admin/commercial/booking-credit-enforcement/kill-switch/engage',
          '/api/v1/admin/commercial/booking-credit-enforcement/kill-switch/release',
        ].sort(),
      );
      expect(paths.filter((p) => /consumption|entitlement|balance|allowance/i.test(p))).toEqual([]);
      expect(paths.filter((p) => /credit/i.test(p) && /\/me\//.test(p) && !/credit-purchases/.test(p))).toEqual([]);
      expect(paths.filter((p) => /activation/i.test(p))).toEqual([]);
    });

    it('emits no event: the commercial domain still has no outbox at all', async () => {
      const booked = await bookZeroCollectible();
      await grantCredits(booked, 1);
      await dataSource.transaction((m) => credits.consumeForConfirmation(m, booked.bookingId, booked));
      await dataSource.transaction((m) => credits.returnForCancellation(m, booked.bookingId, 'seller_cancelled'));

      const outboxes = await dataSource.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'commercial' AND tablename = 'outbox_events'",
      );
      expect(outboxes).toEqual([]);

      // And nothing leaked into a neighbour's outbox either. The control is the
      // booking's own real event, which must be present in the same query.
      const types: Array<{ event_type: string }> = await dataSource.query(
        `SELECT event_type FROM booking.outbox_events
          UNION ALL SELECT event_type FROM commerce.outbox_events`,
      );
      expect(types.length).toBeGreaterThan(0);
      expect(types.map((r) => r.event_type)).toContain('BookingConfirmed');
      expect(types.filter((r) => /Credit|Entitlement|Consumption/i.test(r.event_type))).toEqual([]);
    });

    it('adds no producer to the closed ServiceName union', () => {
      const source = readFileSync(
        join(__dirname, '..', '..', '..', 'libs', 'event-contracts', 'src', 'event-contract.ts'),
        'utf8',
      );
      const union = source.slice(source.indexOf('export type ServiceName'));
      const members = (union.slice(0, union.indexOf(';')).match(/'[a-z-]+'/g) ?? []).map((m) => m.slice(1, -1));

      // Non-vacuity: the parser found the real union.
      expect(members).toContain('commerce');
      expect(members).toContain('booking');
      expect(members).not.toContain('commercial');
      expect(members).not.toContain('commercial-policy');
    });
  });
});
