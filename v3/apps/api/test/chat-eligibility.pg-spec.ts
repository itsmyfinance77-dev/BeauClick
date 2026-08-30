import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { CHAT_SEND_WINDOW_DAYS } from '@beauclick/chat-contract';

import {
  PgTestApp,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * Eligibility, the immutable counterparty, and the send window — `V32-DEC-010`,
 * `V32-DEC-011`, `V32-DEC-012`, ADR-031.
 *
 * **The four proofs the owner required are the first four `describe` blocks
 * below**, in order:
 *
 *   1. `pending` → `cancelled` does not enable chat
 *   2. `confirmed` → `cancelled` does enable chat
 *   3. a fabricated or missing order does not trigger a current-affiliation fallback
 *   4. a professional's salon change does not move an existing conversation
 *
 * Each is the difference between what engineering originally proposed and what
 * the owner decided, so each is a case that would have PASSED against the
 * rejected design and fails against it now.
 */
describePg('chat — eligibility, immutable counterparty, send window (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const api = () => request(app.getHttpServer());

  /**
   * Walks each seeded slot to a distinct hour, from a base pinned ONCE per test.
   *
   * The base has to be pinned. Reading `Date.now()` inside each seed call meant
   * slot N+1 was computed from a base a few milliseconds later than slot N's, so
   * two nominally adjacent hours overlapped by exactly that drift -- and
   * `ex_availability_slots_no_overlap` is a `[)` range exclusion, which caught
   * it. The constraint was right; the seeder was not.
   */
  let seededSlotOffsetHours = 0;
  let slotBase = Date.now();
  beforeEach(() => {
    seededSlotOffsetHours = 0;
    slotBase = Date.now();
  });

  // -------------------------------------------------------------------------
  // Seeding helpers — real rows through the real schema
  // -------------------------------------------------------------------------

  /**
   * A booking plus its commerce order, exactly as `CheckoutService` writes them:
   * one transaction, and the order carries the seller-party snapshot.
   */
  async function seedBookingWithOrder(input: {
    customerId: string;
    professionalId: string;
    serviceId: string;
    status: string;
    sellerPartyType: 'professional' | 'business';
    sellerPartyId: string;
    slotEnd?: Date;
    withOrder?: boolean;
  }): Promise<string> {
    const bookingId = uuidv7();
    /**
     * Every seeded booking gets a DISTINCT slot time.
     *
     * `booking.availability_slots` carries an exclusion constraint forbidding
     * overlapping slots for one professional, so two bookings seeded at the same
     * default instant collide -- which is the constraint doing its job, and a
     * test-data problem rather than a product one. The counter walks each seeded
     * slot an hour further back.
     */
    seededSlotOffsetHours += 1;
    const start = input.slotEnd
      ? new Date(input.slotEnd.getTime() - 3_600_000)
      : new Date(slotBase - 7 * 86_400_000 - seededSlotOffsetHours * 3_600_000);
    const end = input.slotEnd ?? new Date(start.getTime() + 3_600_000);
    const slotId = await seedSlot(dataSource, input.professionalId, input.serviceId, start);

    await dataSource.query(
      `INSERT INTO booking.bookings
         (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [bookingId, input.customerId, input.professionalId, input.serviceId, slotId, start, end, input.status],
    );

    if (input.withOrder !== false) {
      await dataSource.query(
        `INSERT INTO commerce.orders
           (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
            status, currency, subtotal_toman, total_toman, paid_at)
         VALUES ($1, 'booking', $2, $3, $4, $5, 'paid', 'IRT', 100000, 100000, now())`,
        [uuidv7(), bookingId, input.customerId, input.sellerPartyType, input.sellerPartyId],
      );
    }
    return bookingId;
  }

  /** Appends a history row, as the booking service does on every transition. */
  async function seedHistory(bookingId: string, event: string, fromStatus: string, toStatus: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO booking.booking_history (id, booking_id, event, from_status, to_status, actor_type)
       VALUES ($1, $2, $3, $4, $5, 'customer')`,
      [uuidv7(), bookingId, event, fromStatus, toStatus],
    );
  }

  async function startConversation(token: string, type: string, id: string) {
    return api()
      .post('/api/v1/chat/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ counterpartyType: type, counterpartyId: id });
  }

  // -------------------------------------------------------------------------
  // PROOF 1 — pending → cancelled does not enable chat
  // -------------------------------------------------------------------------

  describe('PROOF: a booking cancelled from pending never enables chat', () => {
    /**
     * The owner's correction to `V32-DEC-011`, and the most important case in
     * this file.
     *
     * `pending` is the ONLY status any authenticated user can produce
     * unilaterally against any professional — it is an unpaid hold. Engineering's
     * decision packet accepted any `cancelled` booking, which would have made
     * `pending` → `cancelled` an eligibility grant anybody could mint at will:
     * V2's unauthenticated-messaging defect arriving through the cancellation
     * door.
     */
    it('refuses a customer whose only booking went pending -> cancelled', async () => {
      const customer = await seedUser(app, dataSource, '+989131000001');
      const owner = await seedUser(app, dataSource, '+989131000002', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک الف');

      const bookingId = await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'cancelled',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });
      // The history says it never reached `confirmed`.
      await seedHistory(bookingId, 'created', 'pending', 'pending');
      await seedHistory(bookingId, 'cancelled', 'pending', 'cancelled');

      const res = await startConversation(customer.accessToken, 'professional', pro.id);
      expect(res.status).toBe(403);
      expect(res.body.error.details.reason).toBe('not_eligible');

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM chat.conversations');
      expect(rows[0].n).toBe(0);
    });

    it('refuses even when the booking row alone looks identical to an eligible one', async () => {
      // Two customers, two bookings, both `cancelled`, both with orders. The ONLY
      // difference is the history -- which is exactly the point: `bookings` says
      // `cancelled` either way.
      const eligible = await seedUser(app, dataSource, '+989131000010');
      const ineligible = await seedUser(app, dataSource, '+989131000011');
      const owner = await seedUser(app, dataSource, '+989131000012', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک ب');

      const a = await seedBookingWithOrder({
        customerId: eligible.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'cancelled',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });
      await seedHistory(a, 'confirmed', 'pending', 'confirmed');
      await seedHistory(a, 'cancelled', 'confirmed', 'cancelled');

      const b = await seedBookingWithOrder({
        customerId: ineligible.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'cancelled',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });
      await seedHistory(b, 'cancelled', 'pending', 'cancelled');

      expect((await startConversation(eligible.accessToken, 'professional', pro.id)).status).toBe(201);
      expect((await startConversation(ineligible.accessToken, 'professional', pro.id)).status).toBe(403);
    });

    it.each([['pending'], ['expired']])('refuses a booking still in %s', async (status) => {
      const customer = await seedUser(app, dataSource, `+98913100${Math.floor(1000 + Math.random() * 8999)}`);
      const owner = await seedUser(
        app,
        dataSource,
        `+98913101${Math.floor(1000 + Math.random() * 8999)}`,
        ['professional'],
      );
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک ج');

      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status,
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });

      expect((await startConversation(customer.accessToken, 'professional', pro.id)).status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // PROOF 2 — confirmed → cancelled does enable chat
  // -------------------------------------------------------------------------

  describe('PROOF: a booking cancelled from confirmed does enable chat', () => {
    /**
     * The other half of the correction, and it matters as much: a cancellation is
     * frequently what the two parties most need to talk about. A rule that
     * refused every `cancelled` booking would withdraw the channel at exactly the
     * wrong moment.
     */
    it('allows a customer whose confirmed booking was later cancelled', async () => {
      const customer = await seedUser(app, dataSource, '+989131001001');
      const owner = await seedUser(app, dataSource, '+989131001002', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک د');

      const bookingId = await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'cancelled',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });
      await seedHistory(bookingId, 'confirmed', 'pending', 'confirmed');
      await seedHistory(bookingId, 'cancelled', 'confirmed', 'cancelled');

      const res = await startConversation(customer.accessToken, 'professional', pro.id);
      expect(res.status).toBe(201);
      expect(res.body.data.counterpartyType).toBe('professional');
      expect(res.body.data.counterpartyId).toBe(pro.id);
    });

    it.each([['confirmed'], ['completed'], ['no_show']])('allows a booking in %s outright', async (status) => {
      const customer = await seedUser(app, dataSource, `+98913102${Math.floor(1000 + Math.random() * 8999)}`);
      const owner = await seedUser(
        app,
        dataSource,
        `+98913103${Math.floor(1000 + Math.random() * 8999)}`,
        ['professional'],
      );
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک ه');

      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status,
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });

      expect((await startConversation(customer.accessToken, 'professional', pro.id)).status).toBe(201);
    });

    /**
     * A refund does not remove eligibility.
     *
     * Eligibility reads `booking` and `booking_history` only. A confirmed booking
     * later refunded stays eligible — the service relationship existed, and a
     * refund is frequently what people are messaging about. This keeps `chat`
     * from growing a second opinion about what a payment means.
     */
    it('keeps eligibility after the order is refunded', async () => {
      const customer = await seedUser(app, dataSource, '+989131001030');
      const owner = await seedUser(app, dataSource, '+989131001031', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک و');

      const bookingId = await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'completed',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });
      await dataSource.query(`UPDATE commerce.orders SET status = 'refunded' WHERE source_id = $1`, [bookingId]);

      expect((await startConversation(customer.accessToken, 'professional', pro.id)).status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  // PROOF 3 — a missing order does not fall back to current affiliation
  // -------------------------------------------------------------------------

  describe('PROOF: a missing or fabricated order never triggers a current-affiliation fallback', () => {
    /**
     * The owner's correction to `V32-DEC-010`.
     *
     * Engineering proposed deriving from the historical snapshot *where one
     * exists, falling back to current `business_staff` affiliation otherwise*.
     * The owner removed the fallback: a fallback fires exactly when the data is
     * least trustworthy.
     *
     * Here the professional IS actively affiliated with a business, so a fallback
     * would have produced a business conversation. It fails closed instead.
     */
    it('fails closed on a qualifying booking whose order is missing, despite an active affiliation', async () => {
      const customer = await seedUser(app, dataSource, '+989131002001');
      const owner = await seedUser(app, dataSource, '+989131002002', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک ز');
      const bizOwner = await seedUser(app, dataSource, '+989131002003', ['business']);
      const business = await seedBusiness(dataSource, bizOwner.id, 'سالن بزرگ');

      // The professional IS actively affiliated. A fallback would find this.
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, $4, 'staff', 'active', $5)`,
        [uuidv7(), business.id, owner.id, pro.id, bizOwner.id],
      );

      // A confirmed booking with NO order row.
      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'confirmed',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
        withOrder: false,
      });

      // Neither shape is permitted: not the professional, and not the business a
      // fallback would have derived.
      expect((await startConversation(customer.accessToken, 'professional', pro.id)).status).toBe(403);
      expect((await startConversation(customer.accessToken, 'business', business.id)).status).toBe(403);

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM chat.conversations');
      expect(rows[0].n).toBe(0);
    });

    it('refuses a fabricated counterparty id the caller has no booking with', async () => {
      const customer = await seedUser(app, dataSource, '+989131002010');
      const owner = await seedUser(app, dataSource, '+989131002011', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک ح');
      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'confirmed',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });

      // A real relationship exists -- with somebody else.
      const stranger = await seedUser(app, dataSource, '+989131002012', ['professional']);
      const strangerPro = await seedProfessional(dataSource, stranger.id, 'کلینیک بیگانه');

      const forged = await startConversation(customer.accessToken, 'professional', strangerPro.id);
      const invented = await startConversation(customer.accessToken, 'professional', uuidv7());

      // A professional that EXISTS but was never booked, and one that does not
      // exist at all, are byte-identical refusals. Anything else confirms which
      // professionals exist.
      expect(forged.status).toBe(403);
      expect(invented.status).toBe(403);
      expect(forged.body.error).toEqual(invented.body.error);
    });

    /**
     * The order carries the party; a booking cannot override it.
     *
     * A customer whose booking's order names the BUSINESS cannot open a
     * conversation with the professional, even though `booking.professional_id`
     * names them.
     */
    it('honours the order snapshot over the booking`s own professional id', async () => {
      const customer = await seedUser(app, dataSource, '+989131002020');
      const owner = await seedUser(app, dataSource, '+989131002021', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک ط');
      const bizOwner = await seedUser(app, dataSource, '+989131002022', ['business']);
      const business = await seedBusiness(dataSource, bizOwner.id, 'سالن ی');

      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'completed',
        // The snapshot says BUSINESS.
        sellerPartyType: 'business',
        sellerPartyId: business.id,
      });

      expect((await startConversation(customer.accessToken, 'business', business.id)).status).toBe(201);
      expect((await startConversation(customer.accessToken, 'professional', pro.id)).status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // PROOF 4 — a salon change does not move an existing conversation
  // -------------------------------------------------------------------------

  describe('PROOF: changing a professional`s affiliation moves no existing conversation', () => {
    /**
     * The property the immutable snapshot exists to deliver.
     *
     * A conversation opened when the professional was independent stays with the
     * professional after they join a salon — and the salon gets no access to it.
     * Under the rejected current-affiliation design, this conversation would have
     * silently become the salon's.
     */
    it('leaves the counterparty untouched when the professional joins a salon afterwards', async () => {
      const customer = await seedUser(app, dataSource, '+989131003001');
      const owner = await seedUser(app, dataSource, '+989131003002', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک مستقل');

      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'completed',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });

      const created = await startConversation(customer.accessToken, 'professional', pro.id);
      expect(created.status).toBe(201);
      const conversationId = created.body.data.id;

      // The professional now joins a salon, as a manager.
      const bizOwner = await seedUser(app, dataSource, '+989131003003', ['business']);
      const business = await seedBusiness(dataSource, bizOwner.id, 'سالن جدید');
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, $4, 'manager', 'active', $5)`,
        [uuidv7(), business.id, owner.id, pro.id, bizOwner.id],
      );

      const rows = await dataSource.query(
        'SELECT counterparty_type, counterparty_id FROM chat.conversations WHERE id = $1',
        [conversationId],
      );
      expect(rows[0].counterparty_type).toBe('professional');
      expect(rows[0].counterparty_id).toBe(pro.id);

      // The salon owner, who now employs this professional, still cannot read it.
      await api()
        .get(`/api/v1/chat/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${bizOwner.accessToken}`)
        .expect(404);

      // And the professional themself still can.
      await api()
        .get(`/api/v1/chat/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
    });

    it('does not move the conversation when the professional leaves a salon either', async () => {
      const customer = await seedUser(app, dataSource, '+989131003010');
      const owner = await seedUser(app, dataSource, '+989131003011', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک کارمند');
      const bizOwner = await seedUser(app, dataSource, '+989131003012', ['business']);
      const business = await seedBusiness(dataSource, bizOwner.id, 'سالن سابق');

      const staffId = uuidv7();
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, $4, 'manager', 'active', $5)`,
        [staffId, business.id, owner.id, pro.id, bizOwner.id],
      );

      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'completed',
        sellerPartyType: 'business',
        sellerPartyId: business.id,
      });

      const created = await startConversation(customer.accessToken, 'business', business.id);
      expect(created.status).toBe(201);

      // The professional leaves.
      await dataSource.query(`UPDATE business.business_staff SET status = 'inactive' WHERE id = $1`, [staffId]);

      const rows = await dataSource.query(
        'SELECT counterparty_type, counterparty_id FROM chat.conversations WHERE id = $1',
        [created.body.data.id],
      );
      // Still the salon's. The salon was paid; the salon keeps the record.
      expect(rows[0].counterparty_type).toBe('business');
      expect(rows[0].counterparty_id).toBe(business.id);
    });
  });

  // -------------------------------------------------------------------------
  // Business inbox access — the owner's second correction
  // -------------------------------------------------------------------------

  describe('business inbox access is the owner and active managers only', () => {
    async function seedBusinessConversation(phoneBase: string) {
      const customer = await seedUser(app, dataSource, `${phoneBase}1`);
      const proOwner = await seedUser(app, dataSource, `${phoneBase}2`, ['professional']);
      const pro = await seedProfessional(dataSource, proOwner.id, 'کلینیک سالن');
      const bizOwner = await seedUser(app, dataSource, `${phoneBase}3`, ['business']);
      const business = await seedBusiness(dataSource, bizOwner.id, 'سالن آزمون');

      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'completed',
        sellerPartyType: 'business',
        sellerPartyId: business.id,
      });
      const created = await startConversation(customer.accessToken, 'business', business.id);
      expect(created.status).toBe(201);
      return { customer, proOwner, pro, bizOwner, business, conversationId: created.body.data.id as string };
    }

    it('lets the business owner read it', async () => {
      const s = await seedBusinessConversation('+98913200100');
      await api()
        .get(`/api/v1/chat/conversations/${s.conversationId}`)
        .set('Authorization', `Bearer ${s.bizOwner.accessToken}`)
        .expect(200);
    });

    it('lets an active manager read it', async () => {
      const s = await seedBusinessConversation('+98913200200');
      const manager = await seedUser(app, dataSource, '+989132002099', ['business']);
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, role, status, invited_by)
         VALUES ($1, $2, $3, 'manager', 'active', $4)`,
        [uuidv7(), s.business.id, manager.id, s.bizOwner.id],
      );
      await api()
        .get(`/api/v1/chat/conversations/${s.conversationId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
    });

    /**
     * The uncomfortable consequence, asserted so it is a decision rather than a
     * surprise.
     *
     * `business_staff.role` is `manager | staff` and nothing finer, so an
     * any-active-staff rule would hand a private customer conversation to
     * everyone a salon has ever added. The practitioner-specific grant that would
     * fix this properly needs the V3.3-C role matrix.
     */
    it('refuses an ordinary active staff member, INCLUDING the booked practitioner', async () => {
      const s = await seedBusinessConversation('+98913200300');
      // The practitioner who delivered the service, affiliated as `staff`.
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, $4, 'staff', 'active', $5)`,
        [uuidv7(), s.business.id, s.proOwner.id, s.pro.id, s.bizOwner.id],
      );

      await api()
        .get(`/api/v1/chat/conversations/${s.conversationId}`)
        .set('Authorization', `Bearer ${s.proOwner.accessToken}`)
        .expect(404);
    });

    it('refuses a manager whose membership is no longer active, on the next request', async () => {
      const s = await seedBusinessConversation('+98913200400');
      const manager = await seedUser(app, dataSource, '+989132004099', ['business']);
      const staffId = uuidv7();
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, role, status, invited_by)
         VALUES ($1, $2, $3, 'manager', 'active', $4)`,
        [staffId, s.business.id, manager.id, s.bizOwner.id],
      );
      await api()
        .get(`/api/v1/chat/conversations/${s.conversationId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);

      // Deactivated. Access is evaluated per request and nothing is stored, so it
      // is gone immediately -- not at token expiry.
      await dataSource.query(`UPDATE business.business_staff SET status = 'inactive' WHERE id = $1`, [staffId]);
      await api()
        .get(`/api/v1/chat/conversations/${s.conversationId}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // The send window
  // -------------------------------------------------------------------------

  describe('the 90-day send window', () => {
    async function seedWithSlotEnd(phoneBase: string, slotEnd: Date) {
      const customer = await seedUser(app, dataSource, `${phoneBase}1`);
      const owner = await seedUser(app, dataSource, `${phoneBase}2`, ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک پنجره');
      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'completed',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
        slotEnd,
      });
      const created = await startConversation(customer.accessToken, 'professional', pro.id);
      expect(created.status).toBe(201);
      return { customer, owner, pro, conversationId: created.body.data.id as string };
    }

    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

    it('allows sending just inside the window', async () => {
      const s = await seedWithSlotEnd('+98913300100', daysAgo(CHAT_SEND_WINDOW_DAYS - 1));
      await api()
        .post(`/api/v1/chat/conversations/${s.conversationId}/messages`)
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .send({ body: 'سلام' })
        .expect(201);
    });

    it('refuses sending just outside it, while reading stays open', async () => {
      const s = await seedWithSlotEnd('+98913300200', daysAgo(CHAT_SEND_WINDOW_DAYS + 1));

      const refused = await api()
        .post(`/api/v1/chat/conversations/${s.conversationId}/messages`)
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .send({ body: 'سلام' })
        .expect(409);
      expect(refused.body.error.details.reason).toBe('send_window_closed');

      // Read is a separate question and stays answerable.
      const read = await api()
        .get(`/api/v1/chat/conversations/${s.conversationId}`)
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .expect(200);
      expect(read.body.data.canSend).toBe(false);
      expect(read.body.data.cannotSendReason).toBe('send_window_closed');
    });

    /**
     * A newer qualifying booking reopens sending by moving the maximum.
     *
     * No reactivation path exists and there is no state to get stuck in — the
     * window is recomputed from the bookings on every send.
     */
    it('reopens sending when a newer qualifying booking exists', async () => {
      const s = await seedWithSlotEnd('+98913300300', daysAgo(CHAT_SEND_WINDOW_DAYS + 30));

      await api()
        .post(`/api/v1/chat/conversations/${s.conversationId}/messages`)
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .send({ body: 'سلام' })
        .expect(409);

      await seedBookingWithOrder({
        customerId: s.customer.id,
        professionalId: s.pro.id,
        serviceId: s.pro.serviceId,
        status: 'confirmed',
        sellerPartyType: 'professional',
        sellerPartyId: s.pro.id,
        slotEnd: daysAgo(1),
      });

      await api()
        .post(`/api/v1/chat/conversations/${s.conversationId}/messages`)
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .send({ body: 'سلام دوباره' })
        .expect(201);
    });

    it('keeps sending open for a booking that has not happened yet', async () => {
      const s = await seedWithSlotEnd('+98913300400', futureSlotTime(48));
      await api()
        .post(`/api/v1/chat/conversations/${s.conversationId}/messages`)
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .send({ body: 'قبل از قرار' })
        .expect(201);
    });

    /**
     * The window is not cached on the row.
     *
     * `V32-DEC-012` requires it recomputed per send. Proved by making the
     * conversation ineligible AFTER it was created and successfully used: a
     * cached verdict would still permit the second send.
     */
    it('recomputes per send rather than trusting the conversation row', async () => {
      const s = await seedWithSlotEnd('+98913300500', daysAgo(1));
      await api()
        .post(`/api/v1/chat/conversations/${s.conversationId}/messages`)
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .send({ body: 'اول' })
        .expect(201);

      // Age the booking past the window.
      await dataSource.query(
        `UPDATE booking.bookings SET slot_end = now() - interval '200 days' WHERE customer_id = $1`,
        [s.customer.id],
      );

      const refused = await api()
        .post(`/api/v1/chat/conversations/${s.conversationId}/messages`)
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .send({ body: 'دوم' })
        .expect(409);
      expect(refused.body.error.details.reason).toBe('send_window_closed');
    });
  });

  // -------------------------------------------------------------------------
  // One conversation per counterparty
  // -------------------------------------------------------------------------

  describe('many bookings collapse into one conversation', () => {
    it('returns the same conversation for a second qualifying booking', async () => {
      const customer = await seedUser(app, dataSource, '+989134000001');
      const owner = await seedUser(app, dataSource, '+989134000002', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک تکرار');

      for (let i = 0; i < 3; i += 1) {
        await seedBookingWithOrder({
          customerId: customer.id,
          professionalId: pro.id,
          serviceId: pro.serviceId,
          status: 'completed',
          sellerPartyType: 'professional',
          sellerPartyId: pro.id,
          slotEnd: new Date(Date.now() - (i + 1) * 86_400_000),
        });
      }

      const first = await startConversation(customer.accessToken, 'professional', pro.id);
      const second = await startConversation(customer.accessToken, 'professional', pro.id);
      expect(first.body.data.id).toBe(second.body.data.id);

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM chat.conversations WHERE customer_user_id = $1', [
        customer.id,
      ]);
      expect(rows[0].n).toBe(1);
    });

    /**
     * Two concurrent starts produce one row.
     *
     * `ON CONFLICT DO NOTHING` on the pair, then re-read — so the loser gets the
     * winner's conversation rather than a unique violation. Provable only against
     * real PostgreSQL.
     */
    it('produces exactly one conversation under concurrent creation', async () => {
      const customer = await seedUser(app, dataSource, '+989134000010');
      const owner = await seedUser(app, dataSource, '+989134000011', ['professional']);
      const pro = await seedProfessional(dataSource, owner.id, 'کلینیک همزمان');
      await seedBookingWithOrder({
        customerId: customer.id,
        professionalId: pro.id,
        serviceId: pro.serviceId,
        status: 'confirmed',
        sellerPartyType: 'professional',
        sellerPartyId: pro.id,
      });

      const responses = await Promise.all(
        Array.from({ length: 8 }, () => startConversation(customer.accessToken, 'professional', pro.id)),
      );

      // Every attempt succeeded, and they all name one conversation.
      expect(responses.every((r) => r.status === 201)).toBe(true);
      expect(new Set(responses.map((r) => r.body.data.id)).size).toBe(1);

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM chat.conversations');
      expect(rows[0].n).toBe(1);
    });
  });
});
