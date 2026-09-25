import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { ChatSubjectDataContract } from '@beauclick/chat';
import { tombstoneFor } from '@beauclick/subject-data';

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
 * The participant message projection — #327, through the real stack.
 *
 * A business conversation is the one shape with MORE than one legitimate reader
 * on a side: the owner and every active manager (and a `practitioner_chat`
 * holder, which reaches the same `seller` verdict through the same port). Two
 * defects lived exactly there:
 *
 *   1. `side` was computed from the reader — "not mine, so the other side" — so
 *      the owner saw their manager's reply as the customer's;
 *   2. every message carried `senderUserId`, so the customer could tell the
 *      salon's staff apart by raw user id, which `V32-DEC-010` keeps from them.
 *
 * The moderator's window is a different projection for a different audience and
 * KEEPS the sender id (`V32-DEC-015`); the last block pins that it did not move.
 */
describePg('chat — the participant message projection (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let chatContract: ChatSubjectDataContract;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    chatContract = app.get(ChatSubjectDataContract);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    ctx.chatClock.release();
  });

  const api = () => request(app.getHttpServer());

  const MESSAGE_KEYS = ['body', 'createdAt', 'erased', 'id', 'mine', 'sequence', 'side'];

  /** A customer, a salon that sold them a booking, its owner, and one active manager. */
  async function seedSalonThread(phoneBase: string) {
    const customer = await seedUser(app, dataSource, `${phoneBase}1`);
    const practitioner = await seedUser(app, dataSource, `${phoneBase}2`, ['professional']);
    const pro = await seedProfessional(dataSource, practitioner.id, 'متخصص سالن');
    const owner = await seedUser(app, dataSource, `${phoneBase}3`, ['business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن دو خواننده');
    const manager = await seedUser(app, dataSource, `${phoneBase}4`, ['business']);
    await dataSource.query(
      `INSERT INTO business.business_staff (id, business_id, user_id, role, status, invited_by)
       VALUES ($1, $2, $3, 'manager', 'active', $4)`,
      [uuidv7(), business.id, manager.id, owner.id],
    );

    const start = new Date(Date.now() - 7 * 86_400_000);
    const slotId = await seedSlot(dataSource, pro.id, pro.serviceId, start);
    const bookingId = uuidv7();
    await dataSource.query(
      `INSERT INTO booking.bookings (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
      [bookingId, customer.id, pro.id, pro.serviceId, slotId, start, new Date(start.getTime() + 3_600_000)],
    );
    await dataSource.query(
      `INSERT INTO commerce.orders
         (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
          status, currency, subtotal_toman, total_toman, paid_at)
       VALUES ($1, 'booking', $2, $3, 'business', $4, 'paid', 'IRT', 100000, 100000, now())`,
      [uuidv7(), bookingId, customer.id, business.id],
    );

    const created = await api()
      .post('/api/v1/chat/conversations')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ counterpartyType: 'business', counterpartyId: business.id })
      .expect(201);

    return { customer, practitioner, owner, manager, business, conversationId: created.body.data.id as string };
  }

  type Seeded = Awaited<ReturnType<typeof seedSalonThread>>;

  const send = (token: string, conversationId: string, body: string) =>
    api()
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body });

  async function readAs(token: string, conversationId: string) {
    const res = await api()
      .get(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res;
  }

  /** Customer, then manager, then owner: sequences 1, 2, 3. */
  async function exchange(s: Seeded) {
    await send(s.customer.accessToken, s.conversationId, 'سؤال مشتری').expect(201);
    const fromManager = await send(s.manager.accessToken, s.conversationId, 'پاسخ مدیر').expect(201);
    await send(s.owner.accessToken, s.conversationId, 'پاسخ مالک').expect(201);
    return fromManager;
  }

  function bySequence(items: { sequence: number; side: string | null; mine: boolean }[]) {
    return Object.fromEntries(items.map((m) => [m.sequence, { side: m.side, mine: m.mine }]));
  }

  describe('side is the author`s, identical for every reader', () => {
    it('shows the owner their manager`s reply as the salon`s, not the customer`s', async () => {
      const s = await seedSalonThread('+98915100010');
      await exchange(s);

      const asOwner = await readAs(s.owner.accessToken, s.conversationId);
      expect(bySequence(asOwner.body.data.items)).toEqual({
        1: { side: 'customer', mine: false },
        2: { side: 'seller', mine: false },
        3: { side: 'seller', mine: true },
      });
    });

    it('shows the manager the owner`s reply as the salon`s too', async () => {
      const s = await seedSalonThread('+98915100020');
      await exchange(s);

      const asManager = await readAs(s.manager.accessToken, s.conversationId);
      expect(bySequence(asManager.body.data.items)).toEqual({
        1: { side: 'customer', mine: false },
        2: { side: 'seller', mine: true },
        3: { side: 'seller', mine: false },
      });
    });

    it('shows the customer both replies as the salon`s and only their own as theirs', async () => {
      const s = await seedSalonThread('+98915100030');
      await exchange(s);

      const asCustomer = await readAs(s.customer.accessToken, s.conversationId);
      expect(bySequence(asCustomer.body.data.items)).toEqual({
        1: { side: 'customer', mine: true },
        2: { side: 'seller', mine: false },
        3: { side: 'seller', mine: false },
      });
    });

    it('answers a send with the same rule the list uses', async () => {
      const s = await seedSalonThread('+98915100040');
      const fromManager = await exchange(s);

      expect(fromManager.body.data.message).toMatchObject({ sequence: 2, side: 'seller', mine: true });
      expect(Object.keys(fromManager.body.data.message).sort()).toEqual(MESSAGE_KEYS);
    });
  });

  describe('no user id reaches a participant', () => {
    it('has exactly the contract`s keys on every message, for every reader', async () => {
      const s = await seedSalonThread('+98915100110');
      await exchange(s);

      for (const reader of [s.customer, s.owner, s.manager]) {
        const res = await readAs(reader.accessToken, s.conversationId);
        expect(res.body.data.items).toHaveLength(3);
        for (const item of res.body.data.items) {
          expect(Object.keys(item).sort()).toEqual(MESSAGE_KEYS);
        }
      }
    });

    /**
     * The whole body, not only the message objects: an id that moved into a
     * neighbouring field would pass a per-message key check.
     */
    it('never names the owner, the manager, the practitioner or the customer by user id', async () => {
      const s = await seedSalonThread('+98915100120');
      const fromManager = await exchange(s);
      const ids = [s.customer.id, s.owner.id, s.manager.id, s.practitioner.id];

      const asCustomer = JSON.stringify((await readAs(s.customer.accessToken, s.conversationId)).body);
      for (const id of ids) expect(asCustomer).not.toContain(id);

      // The send response carries the conversation summary as well as the message.
      const sendBody = JSON.stringify(fromManager.body);
      for (const id of ids) expect(sendBody).not.toContain(id);
    });
  });

  describe('an erased author', () => {
    it('leaves a placeholder with no side, no owner and no id', async () => {
      const s = await seedSalonThread('+98915100210');
      await exchange(s);

      await dataSource.transaction((m) =>
        chatContract.eraseSubjectData(m, s.manager.id, tombstoneFor(s.manager.id, new Date())),
      );

      const asOwner = await readAs(s.owner.accessToken, s.conversationId);
      const erased = asOwner.body.data.items.find((m: { sequence: number }) => m.sequence === 2);
      expect(erased).toEqual(
        expect.objectContaining({ body: null, erased: true, side: null, mine: false }),
      );
      expect(Object.keys(erased).sort()).toEqual(MESSAGE_KEYS);
      // The survivors keep their authors' sides.
      expect(bySequence(asOwner.body.data.items)[1]).toEqual({ side: 'customer', mine: false });
      expect(bySequence(asOwner.body.data.items)[3]).toEqual({ side: 'seller', mine: true });
    });
  });

  /**
   * The moderator's window is NOT the participant projection, and #327 did not
   * touch it: judging harassment needs to know who said what (`V32-DEC-015`).
   */
  describe('the moderator window keeps its own shape', () => {
    it('still carries each message`s sender id, and nothing a participant view adds', async () => {
      const s = await seedSalonThread('+98915100310');
      const fromManager = await exchange(s);
      const reported = await api()
        .post(`/api/v1/chat/conversations/${s.conversationId}/report`)
        .set('Authorization', `Bearer ${s.customer.accessToken}`)
        .send({ messageId: fromManager.body.data.message.id, reason: 'harassment' })
        .expect(201);

      const moderator = await seedUser(app, dataSource, '+989151003199', ['moderator']);
      const res = await api()
        .get(`/api/v1/admin/chat/reports/${reported.body.data.id}`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .expect(200);

      const window = res.body.data.messages as Record<string, unknown>[];
      for (const item of window) {
        expect(Object.keys(item).sort()).toEqual(['body', 'createdAt', 'erased', 'id', 'senderUserId', 'sequence']);
      }
      const senders = Object.fromEntries(window.map((m) => [m.sequence as number, m.senderUserId]));
      expect(senders).toEqual({ 1: s.customer.id, 2: s.manager.id, 3: s.owner.id });
    });
  });
});
