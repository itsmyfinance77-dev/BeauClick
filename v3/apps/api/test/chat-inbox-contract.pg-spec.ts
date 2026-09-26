import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import {
  PgTestApp,
  createPgTestApp,
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
 * The three additive fields #328's screens need, through the real stack.
 *
 *   1. `GET /v1/chat/eligible-counterparties` — a customer holding a booking a
 *      SALON sold had no way to address `POST /conversations` at all: neither
 *      the booking nor the order says who the seller party is. The read answers
 *      from the eligibility port itself, with the qualifying booking ids, so a
 *      page offers «message» on exactly the bookings that allow it.
 *   2. `side` on each inbox row, and an optional `side` / `counterpartyType`
 *      narrowing — the inbox unions both sides, and for a seller-side reader
 *      the counterparty fields name their OWN party.
 *   3. `blockedByMe` — only the blocker may unblock, and the page could not
 *      tell who that was.
 *
 * Non-enumeration and the existing refusals are covered in
 * `chat-eligibility.pg-spec.ts` and `chat-privacy-moderation.pg-spec.ts`,
 * which pass unmodified.
 */
describePg('chat — the inbox contract #328 adds (real PostgreSQL)', () => {
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

  let slotOffset = 0;
  const slotBase = Date.now();
  beforeEach(async () => {
    await resetDatabase(dataSource);
    ctx.chatClock.release();
  });

  const api = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A booking plus its order, as checkout writes them; the order carries the seller snapshot. */
  async function booking(input: {
    customerId: string;
    professionalId: string;
    serviceId: string;
    status: string;
    seller: { type: 'professional' | 'business'; id: string };
    daysAgo?: number;
  }): Promise<string> {
    slotOffset += 1;
    const start = new Date(slotBase - (input.daysAgo ?? 7) * 86_400_000 - slotOffset * 3_600_000);
    const slotId = await seedSlot(dataSource, input.professionalId, input.serviceId, start);
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO booking.bookings (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, input.customerId, input.professionalId, input.serviceId, slotId, start, new Date(start.getTime() + 3_600_000), input.status],
    );
    await dataSource.query(
      `INSERT INTO commerce.orders
         (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
          status, currency, subtotal_toman, total_toman, paid_at)
       VALUES ($1, 'booking', $2, $3, $4, $5, 'paid', 'IRT', 100000, 100000, now())`,
      [uuidv7(), id, input.customerId, input.seller.type, input.seller.id],
    );
    return id;
  }

  /** One history row, as the booking service writes it on each transition. */
  async function history(bookingId: string, event: string, from: string, to: string) {
    await dataSource.query(
      `INSERT INTO booking.booking_history (id, booking_id, event, from_status, to_status, actor_type)
       VALUES ($1, $2, $3, $4, $5, 'customer')`,
      [uuidv7(), bookingId, event, from, to],
    );
  }

  async function activeManager(businessId: string, ownerId: string, phone: string) {
    const manager = await seedUser(app, dataSource, phone, ['business']);
    await dataSource.query(
      `INSERT INTO business.business_staff (id, business_id, user_id, role, status, invited_by)
       VALUES ($1, $2, $3, 'manager', 'active', $4)`,
      [uuidv7(), businessId, manager.id, ownerId],
    );
    return manager;
  }

  const start = (token: string, type: string, id: string) =>
    api().post('/api/v1/chat/conversations').set(bearer(token)).send({ counterpartyType: type, counterpartyId: id });
  const eligible = (token: string) => api().get('/api/v1/chat/eligible-counterparties').set(bearer(token));
  const inbox = (token: string, query = '') => api().get(`/api/v1/chat/conversations${query}`).set(bearer(token));

  // -------------------------------------------------------------------------
  // 1. eligible counterparties
  // -------------------------------------------------------------------------

  describe('GET /v1/chat/eligible-counterparties', () => {
    async function customerWithMixedBookings(phoneBase: string) {
      const customer = await seedUser(app, dataSource, `${phoneBase}1`);
      const soloOwner = await seedUser(app, dataSource, `${phoneBase}2`, ['professional']);
      const solo = await seedProfessional(dataSource, soloOwner.id, 'متخصص مستقل');
      const salonPro = await seedUser(app, dataSource, `${phoneBase}3`, ['professional']);
      const salonProfessional = await seedProfessional(dataSource, salonPro.id, 'متخصص سالن');
      const bizOwner = await seedUser(app, dataSource, `${phoneBase}4`, ['business']);
      const business = await seedBusiness(dataSource, bizOwner.id, 'سالن نمونه');
      const pendingOwner = await seedUser(app, dataSource, `${phoneBase}5`, ['professional']);
      const pendingPro = await seedProfessional(dataSource, pendingOwner.id, 'متخصص در انتظار');

      const soloOld = await booking({ customerId: customer.id, professionalId: solo.id, serviceId: solo.serviceId, status: 'completed', seller: { type: 'professional', id: solo.id }, daysAgo: 20 });
      const soloNew = await booking({ customerId: customer.id, professionalId: solo.id, serviceId: solo.serviceId, status: 'confirmed', seller: { type: 'professional', id: solo.id }, daysAgo: 2 });
      // Sold by the SALON, delivered by its professional: the counterparty is the business.
      const salonBooking = await booking({ customerId: customer.id, professionalId: salonProfessional.id, serviceId: salonProfessional.serviceId, status: 'completed', seller: { type: 'business', id: business.id } });
      // Never qualify: pending, and cancelled straight from pending.
      await booking({ customerId: customer.id, professionalId: pendingPro.id, serviceId: pendingPro.serviceId, status: 'pending', seller: { type: 'professional', id: pendingPro.id } });
      const cancelledFromPending = await booking({ customerId: customer.id, professionalId: pendingPro.id, serviceId: pendingPro.serviceId, status: 'cancelled', seller: { type: 'professional', id: pendingPro.id } });
      await history(cancelledFromPending, 'created', 'pending', 'pending');
      await history(cancelledFromPending, 'cancelled', 'pending', 'cancelled');

      return { customer, solo, business, soloOld, soloNew, salonBooking, pendingPro, bizOwner, salonPro };
    }

    it('returns exactly the qualifying relationships, the salon-sold one as the business, with their bookings newest first', async () => {
      const s = await customerWithMixedBookings('+98915200010');
      const res = await eligible(s.customer.accessToken).expect(200);
      const items = [...res.body.data.items].sort((a: { counterpartyType: string }, b: { counterpartyType: string }) =>
        a.counterpartyType.localeCompare(b.counterpartyType),
      );
      expect(items).toEqual([
        { counterpartyType: 'business', counterpartyId: s.business.id, bookingIds: [s.salonBooking] },
        { counterpartyType: 'professional', counterpartyId: s.solo.id, bookingIds: [s.soloNew, s.soloOld] },
      ]);
      // The pending and never-confirmed relationship is absent, not flagged.
      expect(JSON.stringify(res.body)).not.toContain(s.pendingPro.id);
    });

    it('lets that customer open the salon conversation with the pair it returned — the gap this closes', async () => {
      const s = await customerWithMixedBookings('+98915200020');
      const res = await eligible(s.customer.accessToken).expect(200);
      const salon = res.body.data.items.find((i: { counterpartyType: string }) => i.counterpartyType === 'business');
      const opened = await start(s.customer.accessToken, salon.counterpartyType, salon.counterpartyId).expect(201);
      expect(opened.body.data).toMatchObject({ side: 'customer', counterpartyType: 'business', counterpartyId: s.business.id });
      // The booking's professional is NOT the counterparty, and addressing it is refused as before.
      const refused = await start(s.customer.accessToken, 'professional', s.salonPro.id).expect(403);
      expect(refused.body.error.details.reason).toBe('not_eligible');
    });

    it('is self-scoped: another customer, the seller, and a stranger each see only their own (empty) answer', async () => {
      const s = await customerWithMixedBookings('+98915200030');
      const stranger = await seedUser(app, dataSource, '+989152000399');
      for (const token of [stranger.accessToken, s.bizOwner.accessToken]) {
        const res = await eligible(token).expect(200);
        expect(res.body.data).toEqual({ items: [] });
      }
    });

    it('carries only the documented keys', async () => {
      const s = await customerWithMixedBookings('+98915200040');
      const res = await eligible(s.customer.accessToken).expect(200);
      expect(Object.keys(res.body.data)).toEqual(['items']);
      for (const item of res.body.data.items) {
        expect(Object.keys(item).sort()).toEqual(['bookingIds', 'counterpartyId', 'counterpartyType']);
      }
    });

    it('refuses without a session, and without bc_use_chat', async () => {
      await api().get('/api/v1/chat/eligible-counterparties').expect(401);
      const moderator = await seedUser(app, dataSource, '+989152000599', ['moderator']);
      await eligible(moderator.accessToken).expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // 2. side, and the narrowing
  // -------------------------------------------------------------------------

  describe('side on every summary, and the inbox narrowing', () => {
    /**
     * A professional who has ALSO booked another professional as a customer:
     * one inbox, two sides.
     */
    async function dualRole(phoneBase: string) {
      const dual = await seedUser(app, dataSource, `${phoneBase}1`, ['customer', 'professional']);
      const ownPro = await seedProfessional(dataSource, dual.id, 'متخصص دوگانه');
      const client = await seedUser(app, dataSource, `${phoneBase}2`);
      const otherOwner = await seedUser(app, dataSource, `${phoneBase}3`, ['professional']);
      const otherPro = await seedProfessional(dataSource, otherOwner.id, 'متخصص دیگر');

      await booking({ customerId: client.id, professionalId: ownPro.id, serviceId: ownPro.serviceId, status: 'completed', seller: { type: 'professional', id: ownPro.id } });
      await booking({ customerId: dual.id, professionalId: otherPro.id, serviceId: otherPro.serviceId, status: 'completed', seller: { type: 'professional', id: otherPro.id } });

      const asSeller = (await start(client.accessToken, 'professional', ownPro.id).expect(201)).body.data.id as string;
      const asCustomer = (await start(dual.accessToken, 'professional', otherPro.id).expect(201)).body.data.id as string;
      return { dual, client, ownPro, otherPro, asSeller, asCustomer };
    }

    it('labels each row with the caller`s own side, and counterparty stays the seller party', async () => {
      const s = await dualRole('+98915201010');
      const res = await inbox(s.dual.accessToken).expect(200);
      const bySide = Object.fromEntries(res.body.data.items.map((i: { id: string; side: string }) => [i.id, i.side]));
      expect(bySide).toEqual({ [s.asSeller]: 'seller', [s.asCustomer]: 'customer' });
      const sellerRow = res.body.data.items.find((i: { id: string }) => i.id === s.asSeller);
      expect(sellerRow.counterpartyId).toBe(s.ownPro.id);

      // The other participant of each sees the opposite side.
      const client = await inbox(s.client.accessToken).expect(200);
      expect(client.body.data.items).toEqual([expect.objectContaining({ id: s.asSeller, side: 'customer' })]);
    });

    it('narrows to one side, and never widens', async () => {
      const s = await dualRole('+98915201020');
      const customerOnly = await inbox(s.dual.accessToken, '?side=customer').expect(200);
      expect(customerOnly.body.data.items.map((i: { id: string }) => i.id)).toEqual([s.asCustomer]);
      const sellerOnly = await inbox(s.dual.accessToken, '?side=seller').expect(200);
      expect(sellerOnly.body.data.items.map((i: { id: string }) => i.id)).toEqual([s.asSeller]);

      // A plain customer asking for the seller half has no seller reach: empty.
      const none = await inbox(s.client.accessToken, '?side=seller').expect(200);
      expect(none.body.data).toEqual({ items: [], nextCursor: null });
    });

    it('narrows a salon owner`s seller half to business conversations', async () => {
      const customer = await seedUser(app, dataSource, '+989152010301');
      const owner = await seedUser(app, dataSource, '+989152010302', ['business', 'professional']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن مالک');
      const ownPro = await seedProfessional(dataSource, owner.id, 'متخصص مالک');
      await booking({ customerId: customer.id, professionalId: ownPro.id, serviceId: ownPro.serviceId, status: 'completed', seller: { type: 'business', id: business.id } });
      await booking({ customerId: customer.id, professionalId: ownPro.id, serviceId: ownPro.serviceId, status: 'completed', seller: { type: 'professional', id: ownPro.id } });
      const bizConv = (await start(customer.accessToken, 'business', business.id).expect(201)).body.data.id;
      const proConv = (await start(customer.accessToken, 'professional', ownPro.id).expect(201)).body.data.id;

      const biz = await inbox(owner.accessToken, '?side=seller&counterpartyType=business').expect(200);
      expect(biz.body.data.items.map((i: { id: string }) => i.id)).toEqual([bizConv]);
      const pro = await inbox(owner.accessToken, '?side=seller&counterpartyType=professional').expect(200);
      expect(pro.body.data.items.map((i: { id: string }) => i.id)).toEqual([proConv]);
    });

    it('refuses a filter value outside the vocabulary', async () => {
      const s = await dualRole('+98915201040');
      await inbox(s.dual.accessToken, '?side=admin').expect(400);
      await inbox(s.dual.accessToken, '?counterpartyType=user').expect(400);
    });

    it('carries side on the single read and on a send`s summary too', async () => {
      const s = await dualRole('+98915201050');
      const read = await api().get(`/api/v1/chat/conversations/${s.asSeller}`).set(bearer(s.dual.accessToken)).expect(200);
      expect(read.body.data.side).toBe('seller');
      const sent = await api()
        .post(`/api/v1/chat/conversations/${s.asCustomer}/messages`)
        .set(bearer(s.dual.accessToken))
        .send({ body: 'سلام' })
        .expect(201);
      expect(sent.body.data.conversation.side).toBe('customer');
    });
  });

  // -------------------------------------------------------------------------
  // 3. blockedByMe
  // -------------------------------------------------------------------------

  describe('blockedByMe', () => {
    async function salonThread(phoneBase: string) {
      const customer = await seedUser(app, dataSource, `${phoneBase}1`);
      const practitioner = await seedUser(app, dataSource, `${phoneBase}2`, ['professional']);
      const pro = await seedProfessional(dataSource, practitioner.id, 'متخصص');
      const owner = await seedUser(app, dataSource, `${phoneBase}3`, ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن');
      const manager = await activeManager(business.id, owner.id, `${phoneBase}4`);
      await booking({ customerId: customer.id, professionalId: pro.id, serviceId: pro.serviceId, status: 'completed', seller: { type: 'business', id: business.id } });
      const id = (await start(customer.accessToken, 'business', business.id).expect(201)).body.data.id as string;
      return { customer, owner, manager, id };
    }

    const summaryOf = async (token: string, id: string) =>
      (await api().get(`/api/v1/chat/conversations/${id}`).set(bearer(token)).expect(200)).body.data;

    it('is true only for the reader who blocked; the blocked party sees the one generic refusal', async () => {
      const s = await salonThread('+98915202010');
      await api().post(`/api/v1/chat/conversations/${s.id}/block`).set(bearer(s.manager.accessToken)).expect(204);

      expect(await summaryOf(s.manager.accessToken, s.id)).toMatchObject({ blockedByMe: true, canSend: false, cannotSendReason: 'blocked' });
      // A colleague on the same side did not block, so may not unblock. Blocks
      // are between PEOPLE (`ChatAccessService.blockExistsBetween`: "a block
      // against one manager does not silently block a colleague"), so the
      // colleague's own sending is untouched — existing behaviour, unchanged here.
      expect(await summaryOf(s.owner.accessToken, s.id)).toMatchObject({ blockedByMe: false, canSend: true, cannotSendReason: null });
      // The blocked customer: the same reason, no direction.
      expect(await summaryOf(s.customer.accessToken, s.id)).toMatchObject({ blockedByMe: false, canSend: false, cannotSendReason: 'blocked' });
    });

    it('goes back to false for the blocker after unblocking', async () => {
      const s = await salonThread('+98915202020');
      await api().post(`/api/v1/chat/conversations/${s.id}/block`).set(bearer(s.customer.accessToken)).expect(204);
      expect(await summaryOf(s.customer.accessToken, s.id)).toMatchObject({ blockedByMe: true });
      await api().delete(`/api/v1/chat/conversations/${s.id}/block`).set(bearer(s.customer.accessToken)).expect(204);
      expect(await summaryOf(s.customer.accessToken, s.id)).toMatchObject({ blockedByMe: false, canSend: true, cannotSendReason: null });
    });

    it('appears on list rows with the full documented key set', async () => {
      const s = await salonThread('+98915202030');
      const res = await inbox(s.customer.accessToken).expect(200);
      expect(Object.keys(res.body.data.items[0]).sort()).toEqual(
        [
          'blockedByMe',
          'canSend',
          'cannotSendReason',
          'closedReason',
          'counterpartyId',
          'counterpartyType',
          'id',
          'lastMessageAt',
          'messageCount',
          'side',
          'startedAt',
          'unreadCount',
        ].sort(),
      );
    });
  });
});
