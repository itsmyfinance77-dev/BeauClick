import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { CHAT_MAX_MESSAGES_PER_MINUTE, CHAT_MAX_MESSAGE_CHARACTERS, CHAT_MAX_REPORTS_PER_DAY } from '@beauclick/chat-contract';
import { ChatRetentionService, ChatSubjectDataContract } from '@beauclick/chat';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage, tombstoneFor } from '@beauclick/subject-data';

import {
  PgTestApp,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * Messaging, concurrency, privacy, moderation, notification, and the adversarial
 * set — `V32-DEC-013`, `V32-DEC-014`, `V32-DEC-015`, ADR-032.
 *
 * Eligibility and the immutable counterparty are proved in
 * `chat-eligibility.pg-spec.ts`. This file assumes an eligible pair and asks what
 * happens next.
 */
describePg('chat — messaging, privacy, moderation (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let retention: ChatRetentionService;
  let chatContract: ChatSubjectDataContract;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    retention = app.get(ChatRetentionService);
    chatContract = app.get(ChatSubjectDataContract);
  });

  afterAll(async () => {
    await app.close();
  });

  let slotBase = Date.now();
  let slotOffset = 0;
  beforeEach(async () => {
    await resetDatabase(dataSource);
    slotBase = Date.now();
    slotOffset = 0;
    ctx.chatClock.release();
  });

  const api = () => request(app.getHttpServer());

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  interface Pair {
    customer: Awaited<ReturnType<typeof seedUser>>;
    proOwner: Awaited<ReturnType<typeof seedUser>>;
    professionalId: string;
    conversationId: string;
  }

  /** An eligible customer↔professional pair with an open conversation. */
  async function seedPair(phoneBase: string): Promise<Pair> {
    const customer = await seedUser(app, dataSource, `${phoneBase}1`);
    const proOwner = await seedUser(app, dataSource, `${phoneBase}2`, ['professional']);
    const pro = await seedProfessional(dataSource, proOwner.id, 'کلینیک آزمون');

    slotOffset += 1;
    const start = new Date(slotBase - 7 * 86_400_000 - slotOffset * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    const slotId = await seedSlot(dataSource, pro.id, pro.serviceId, start);
    const bookingId = uuidv7();

    await dataSource.query(
      `INSERT INTO booking.bookings (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
      [bookingId, customer.id, pro.id, pro.serviceId, slotId, start, end],
    );
    await dataSource.query(
      `INSERT INTO commerce.orders
         (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
          status, currency, subtotal_toman, total_toman, paid_at)
       VALUES ($1, 'booking', $2, $3, 'professional', $4, 'paid', 'IRT', 100000, 100000, now())`,
      [uuidv7(), bookingId, customer.id, pro.id],
    );

    const created = await api()
      .post('/api/v1/chat/conversations')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .send({ counterpartyType: 'professional', counterpartyId: pro.id })
      .expect(201);

    return { customer, proOwner, professionalId: pro.id, conversationId: created.body.data.id };
  }

  const send = (token: string, conversationId: string, body: string, idempotencyKey?: string) =>
    api()
      .post(`/api/v1/chat/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send(idempotencyKey ? { body, idempotencyKey } : { body });

  // -------------------------------------------------------------------------
  // Messaging and ordering
  // -------------------------------------------------------------------------

  describe('sending and ordering', () => {
    it('lets either legitimate participant initiate', async () => {
      const pair = await seedPair('+98914000010');
      await send(pair.customer.accessToken, pair.conversationId, 'از مشتری').expect(201);
      await send(pair.proOwner.accessToken, pair.conversationId, 'از متخصص').expect(201);

      const rows = await dataSource.query(
        'SELECT sequence FROM chat.messages WHERE conversation_id = $1 ORDER BY sequence',
        [pair.conversationId],
      );
      expect(rows.map((r: { sequence: number }) => r.sequence)).toEqual([1, 2]);
    });

    it('rejects an empty or over-long message without writing anything', async () => {
      const pair = await seedPair('+98914000020');
      await send(pair.customer.accessToken, pair.conversationId, '   ').expect(400);
      await send(pair.customer.accessToken, pair.conversationId, 'ا'.repeat(CHAT_MAX_MESSAGE_CHARACTERS + 1)).expect(400);

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM chat.messages');
      expect(rows[0].n).toBe(0);
    });

    /**
     * The sequence race, closed.
     *
     * `uq_chat_messages_sequence` makes two messages claiming one position
     * unwritable, so without the conversation row lock concurrent sends both read
     * N and the loser dies on a unique violation -- a 500 where a queued 201
     * belonged. V3.2-A shipped exactly this bug twice.
     *
     * Provable only against real PostgreSQL: pg-mem does not honour the isolation
     * this rests on.
     */
    it('assigns contiguous sequences under concurrent sends, with no internal errors', async () => {
      const pair = await seedPair('+98914000030');
      const attempts = CHAT_MAX_MESSAGES_PER_MINUTE;

      const responses = await Promise.all(
        Array.from({ length: attempts }, (_, i) => send(pair.customer.accessToken, pair.conversationId, `پیام ${i}`)),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(attempts);
      // No 500s. Every attempt resolved to a real outcome.
      expect(responses.filter((r) => r.status >= 500)).toHaveLength(0);

      const rows = await dataSource.query(
        'SELECT sequence FROM chat.messages WHERE conversation_id = $1 ORDER BY sequence',
        [pair.conversationId],
      );
      expect(rows.map((r: { sequence: number }) => r.sequence)).toEqual(
        Array.from({ length: attempts }, (_, i) => i + 1),
      );
    });

    /**
     * The per-minute throttle, enforced in PostgreSQL rather than by the
     * in-memory HTTP throttler -- whose effective limit multiplies by instance
     * count while `THROTTLE-STORE` is unresolved.
     */
    it('refuses the message past the per-minute cap and writes nothing for it', async () => {
      const pair = await seedPair('+98914000040');
      // Inside one minute bucket by construction. Twenty sequential HTTP sends
      // take a couple of seconds, so an unfrozen clock crosses :00 in roughly one
      // run in twenty and the cap looks broken when it is not.
      ctx.chatClock.freeze();
      for (let i = 0; i < CHAT_MAX_MESSAGES_PER_MINUTE; i += 1) {
        await send(pair.customer.accessToken, pair.conversationId, `پیام ${i}`).expect(201);
      }

      const refused = await send(pair.customer.accessToken, pair.conversationId, 'یکی بیشتر').expect(429);
      expect(refused.body.error.details.reason).toBe('rate_limited');

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM chat.messages WHERE conversation_id = $1', [
        pair.conversationId,
      ]);
      expect(rows[0].n).toBe(CHAT_MAX_MESSAGES_PER_MINUTE);
    });

    it('never exceeds the per-minute cap under concurrent submission', async () => {
      const pair = await seedPair('+98914000050');
      ctx.chatClock.freeze();
      const attempts = CHAT_MAX_MESSAGES_PER_MINUTE + 8;

      const responses = await Promise.all(
        Array.from({ length: attempts }, (_, i) => send(pair.customer.accessToken, pair.conversationId, `همزمان ${i}`)),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(CHAT_MAX_MESSAGES_PER_MINUTE);
      expect(responses.filter((r) => r.status === 429)).toHaveLength(8);
      expect(responses.filter((r) => r.status >= 500)).toHaveLength(0);
    });

    /**
     * A retried POST returns the original message rather than creating a second.
     *
     * Checked BEFORE the throttle is charged, so a client retrying a request whose
     * response it never saw does not spend a second slot for a message that
     * already exists.
     */
    it('returns the original message for a retried idempotency key', async () => {
      const pair = await seedPair('+98914000060');
      const key = 'retry-key-0000000000000001';

      const first = await send(pair.customer.accessToken, pair.conversationId, 'یک بار', key).expect(201);
      const second = await send(pair.customer.accessToken, pair.conversationId, 'یک بار', key).expect(201);

      expect(second.body.data.message.id).toBe(first.body.data.message.id);

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM chat.messages WHERE conversation_id = $1', [
        pair.conversationId,
      ]);
      expect(rows[0].n).toBe(1);
    });

    it('scopes the idempotency key per sender, so two people may use the same string', async () => {
      const pair = await seedPair('+98914000070');
      const key = 'shared-key-000000000000001';
      await send(pair.customer.accessToken, pair.conversationId, 'از مشتری', key).expect(201);
      await send(pair.proOwner.accessToken, pair.conversationId, 'از متخصص', key).expect(201);

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM chat.messages WHERE conversation_id = $1', [
        pair.conversationId,
      ]);
      expect(rows[0].n).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Read watermarks and unread counts
  // -------------------------------------------------------------------------

  describe('read watermarks', () => {
    it('counts the other side`s messages as unread and never one`s own', async () => {
      const pair = await seedPair('+98914001010');
      await send(pair.customer.accessToken, pair.conversationId, 'یک').expect(201);
      await send(pair.customer.accessToken, pair.conversationId, 'دو').expect(201);

      // The sender has read their own by definition.
      const sender = await api()
        .get('/api/v1/chat/unread-count')
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .expect(200);
      expect(sender.body.data.total).toBe(0);

      const recipient = await api()
        .get('/api/v1/chat/unread-count')
        .set('Authorization', `Bearer ${pair.proOwner.accessToken}`)
        .expect(200);
      expect(recipient.body.data.total).toBe(2);
      expect(recipient.body.data.conversations).toBe(1);
    });

    it('clears the badge when the recipient marks read', async () => {
      const pair = await seedPair('+98914001020');
      await send(pair.customer.accessToken, pair.conversationId, 'یک').expect(201);

      const marked = await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/read`)
        .set('Authorization', `Bearer ${pair.proOwner.accessToken}`)
        .send({ upToSequence: 1 })
        .expect(200);

      // The server's own count, pushed back rather than decremented locally.
      expect(marked.body.data.unread.total).toBe(0);
    });

    /**
     * The watermark only ever increases.
     *
     * A client reporting a lower value is ignored rather than obeyed -- a
     * watermark that can go backwards is a way to make somebody else's unread
     * badge reappear, and there is no legitimate reason to un-read a message.
     */
    it('never moves the watermark backwards', async () => {
      const pair = await seedPair('+98914001030');
      await send(pair.customer.accessToken, pair.conversationId, 'یک').expect(201);
      await send(pair.customer.accessToken, pair.conversationId, 'دو').expect(201);

      await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/read`)
        .set('Authorization', `Bearer ${pair.proOwner.accessToken}`)
        .send({ upToSequence: 2 })
        .expect(200);

      const back = await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/read`)
        .set('Authorization', `Bearer ${pair.proOwner.accessToken}`)
        .send({ upToSequence: 0 })
        .expect(200);

      expect(back.body.data.lastReadSequence).toBe(2);
      expect(back.body.data.unread.total).toBe(0);
    });

    it('caps a watermark claim at the conversation`s real high-water mark', async () => {
      const pair = await seedPair('+98914001040');
      await send(pair.customer.accessToken, pair.conversationId, 'یک').expect(201);

      const res = await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/read`)
        .set('Authorization', `Bearer ${pair.proOwner.accessToken}`)
        .send({ upToSequence: 9999 })
        .expect(200);
      // A claim beyond what exists cannot pre-read future messages.
      expect(res.body.data.lastReadSequence).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Adversarial: authorization
  // -------------------------------------------------------------------------

  describe('adversarial — a non-participant reads nothing', () => {
    it('returns the same refusal for a foreign conversation and a nonexistent one', async () => {
      const pair = await seedPair('+98914002010');
      const stranger = await seedUser(app, dataSource, '+989140020199');
      await send(pair.customer.accessToken, pair.conversationId, 'خصوصی').expect(201);

      const foreign = await api()
        .get(`/api/v1/chat/conversations/${pair.conversationId}`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(404);
      const missing = await api()
        .get(`/api/v1/chat/conversations/${uuidv7()}`)
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .expect(404);

      // Byte-identical. Anything else is a membership oracle.
      expect(foreign.body.error).toEqual(missing.body.error);
      expect(foreign.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
    });

    it('never returns another pair`s conversation in a list', async () => {
      const mine = await seedPair('+98914002020');
      const theirs = await seedPair('+98914002030');
      await send(theirs.customer.accessToken, theirs.conversationId, 'راز').expect(201);

      const res = await api()
        .get('/api/v1/chat/conversations')
        .set('Authorization', `Bearer ${mine.customer.accessToken}`)
        .expect(200);

      const ids = res.body.data.items.map((c: { id: string }) => c.id);
      expect(ids).toEqual([mine.conversationId]);
      expect(JSON.stringify(res.body)).not.toContain(theirs.conversationId);
    });

    it('refuses a stranger`s send, read of messages, block, and report identically', async () => {
      const pair = await seedPair('+98914002040');
      const stranger = await seedUser(app, dataSource, '+989140020499');
      const token = stranger.accessToken;

      await send(token, pair.conversationId, 'نفوذ').expect(404);
      await api().get(`/api/v1/chat/conversations/${pair.conversationId}/messages`).set('Authorization', `Bearer ${token}`).expect(404);
      await api().post(`/api/v1/chat/conversations/${pair.conversationId}/block`).set('Authorization', `Bearer ${token}`).expect(404);
      await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send({ messageId: uuidv7(), reason: 'harassment' })
        .expect(404);
    });

    it('refuses a caller without bc_use_chat', async () => {
      // A moderator holds `bc_moderate_chat` but not `bc_use_chat`.
      const moderator = await seedUser(app, dataSource, '+989140020500', ['moderator']);
      await api().get('/api/v1/chat/conversations').set('Authorization', `Bearer ${moderator.accessToken}`).expect(403);
    });

    it('refuses an unauthenticated caller on every participant route', async () => {
      await api().get('/api/v1/chat/conversations').expect(401);
      await api().get('/api/v1/chat/unread-count').expect(401);
      await api().post('/api/v1/chat/conversations').send({}).expect(401);
    });

    /**
     * The composite foreign key, proved directly.
     *
     * A message whose `customer_user_id` disagrees with its conversation's cannot
     * be written AT ALL -- not by this service, not by a future one, and not by
     * somebody at a psql prompt.
     */
    it('makes a cross-owner message physically unwritable', async () => {
      const pair = await seedPair('+98914002060');
      const stranger = await seedUser(app, dataSource, '+989140020699');

      await expect(
        dataSource.query(
          `INSERT INTO chat.messages (id, conversation_id, customer_user_id, sender_user_id, body, sequence)
           VALUES ($1, $2, $3, $4, 'جعلی', 99)`,
          [uuidv7(), pair.conversationId, stranger.id, stranger.id],
        ),
      ).rejects.toThrow(/fk_chat_messages_conversation/);
    });
  });

  // -------------------------------------------------------------------------
  // Blocking
  // -------------------------------------------------------------------------

  describe('blocking', () => {
    it('disables sending for BOTH parties while keeping history readable', async () => {
      const pair = await seedPair('+98914003010');
      await send(pair.customer.accessToken, pair.conversationId, 'قبل از بلاک').expect(201);

      await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/block`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .expect(204);

      // The blocker cannot send either. A one-way block would leave them free to
      // keep messaging somebody who signalled they want no contact.
      const blockerRefused = await send(pair.customer.accessToken, pair.conversationId, 'بعد').expect(409);
      const blockedRefused = await send(pair.proOwner.accessToken, pair.conversationId, 'بعد').expect(409);

      expect(blockerRefused.body.error.details.reason).toBe('blocked');
      expect(blockedRefused.body.error.details.reason).toBe('blocked');

      // History survives on both sides.
      for (const token of [pair.customer.accessToken, pair.proOwner.accessToken]) {
        const messages = await api()
          .get(`/api/v1/chat/conversations/${pair.conversationId}/messages`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(messages.body.data.items).toHaveLength(1);
      }
    });

    /**
     * `V32-DEC-014`: the blocked party is never told who blocked them.
     *
     * Both sides receive byte-identical refusals, so nothing in the response
     * distinguishes "you blocked them" from "they blocked you".
     */
    it('gives the blocker and the blocked identical refusals', async () => {
      const pair = await seedPair('+98914003020');
      await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/block`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .expect(204);

      const blocker = await send(pair.customer.accessToken, pair.conversationId, 'x').expect(409);
      const blocked = await send(pair.proOwner.accessToken, pair.conversationId, 'x').expect(409);
      expect(blocker.body.error).toEqual(blocked.body.error);
    });

    it('restores sending on unblock, and only the blocker may unblock', async () => {
      const pair = await seedPair('+98914003030');
      await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/block`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .expect(204);

      // The blocked party's "unblock" removes nothing -- the row is the blocker's.
      await api()
        .delete(`/api/v1/chat/conversations/${pair.conversationId}/block`)
        .set('Authorization', `Bearer ${pair.proOwner.accessToken}`)
        .expect(204);
      await send(pair.customer.accessToken, pair.conversationId, 'هنوز نه').expect(409);

      await api()
        .delete(`/api/v1/chat/conversations/${pair.conversationId}/block`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .expect(204);
      await send(pair.customer.accessToken, pair.conversationId, 'حالا بله').expect(201);
    });

    it('is idempotent — blocking twice creates one row', async () => {
      const pair = await seedPair('+98914003040');
      for (let i = 0; i < 3; i += 1) {
        await api()
          .post(`/api/v1/chat/conversations/${pair.conversationId}/block`)
          .set('Authorization', `Bearer ${pair.customer.accessToken}`)
          .expect(204);
      }
      const rows = await dataSource.query('SELECT count(*)::int AS n FROM chat.blocks');
      expect(rows[0].n).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Reporting and moderation
  // -------------------------------------------------------------------------

  describe('reporting and moderation', () => {
    async function seedReport(phoneBase: string) {
      const pair = await seedPair(phoneBase);
      const sent = await send(pair.proOwner.accessToken, pair.conversationId, 'پیام نامناسب').expect(201);
      const messageId = sent.body.data.message.id;
      const report = await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/report`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .send({ messageId, reason: 'harassment', note: 'محتوای آزاردهنده' })
        .expect(201);
      return { pair, messageId, reportId: report.body.data.id as string };
    }

    it('files a report anchored to a specific message', async () => {
      const { reportId, messageId } = await seedReport('+98914004010');
      const rows = await dataSource.query('SELECT message_id, status, reason FROM chat.reports WHERE id = $1', [reportId]);
      expect(rows[0].message_id).toBe(messageId);
      expect(rows[0].status).toBe('open');
      expect(rows[0].reason).toBe('harassment');
    });

    it('refuses an anchor from another conversation, indistinguishably from a missing one', async () => {
      const mine = await seedPair('+98914004020');
      const theirs = await seedPair('+98914004030');
      const foreign = await send(theirs.customer.accessToken, theirs.conversationId, 'دیگری').expect(201);

      const a = await api()
        .post(`/api/v1/chat/conversations/${mine.conversationId}/report`)
        .set('Authorization', `Bearer ${mine.customer.accessToken}`)
        .send({ messageId: foreign.body.data.message.id, reason: 'spam' })
        .expect(404);
      const b = await api()
        .post(`/api/v1/chat/conversations/${mine.conversationId}/report`)
        .set('Authorization', `Bearer ${mine.customer.accessToken}`)
        .send({ messageId: uuidv7(), reason: 'spam' })
        .expect(404);
      expect(a.body.error).toEqual(b.body.error);
    });

    it('allows one open report per reporter per conversation', async () => {
      const { pair, messageId } = await seedReport('+98914004040');
      const second = await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/report`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .send({ messageId, reason: 'spam' })
        .expect(409);
      expect(second.body.error.details.reason).toBe('report_already_open');
    });

    it('enforces the daily report cap across conversations', async () => {
      const reporter = await seedUser(app, dataSource, '+989140050001');
      const conversations: string[] = [];
      const messages: string[] = [];

      for (let i = 0; i < CHAT_MAX_REPORTS_PER_DAY + 1; i += 1) {
        const proOwner = await seedUser(app, dataSource, `+9891400510${i}`, ['professional']);
        const pro = await seedProfessional(dataSource, proOwner.id, `کلینیک ${i}`);
        slotOffset += 1;
        const start = new Date(slotBase - 7 * 86_400_000 - slotOffset * 3_600_000);
        const slotId = await seedSlot(dataSource, pro.id, pro.serviceId, start);
        const bookingId = uuidv7();
        await dataSource.query(
          `INSERT INTO booking.bookings (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
          [bookingId, reporter.id, pro.id, pro.serviceId, slotId, start, new Date(start.getTime() + 3_600_000)],
        );
        await dataSource.query(
          `INSERT INTO commerce.orders (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
             status, currency, subtotal_toman, total_toman, paid_at)
           VALUES ($1, 'booking', $2, $3, 'professional', $4, 'paid', 'IRT', 100000, 100000, now())`,
          [uuidv7(), bookingId, reporter.id, pro.id],
        );
        const created = await api()
          .post('/api/v1/chat/conversations')
          .set('Authorization', `Bearer ${reporter.accessToken}`)
          .send({ counterpartyType: 'professional', counterpartyId: pro.id })
          .expect(201);
        conversations.push(created.body.data.id);
        const sent = await send(proOwner.accessToken, created.body.data.id, 'پیام').expect(201);
        messages.push(sent.body.data.message.id);
      }

      for (let i = 0; i < CHAT_MAX_REPORTS_PER_DAY; i += 1) {
        await api()
          .post(`/api/v1/chat/conversations/${conversations[i]}/report`)
          .set('Authorization', `Bearer ${reporter.accessToken}`)
          .send({ messageId: messages[i], reason: 'spam' })
          .expect(201);
      }

      const refused = await api()
        .post(`/api/v1/chat/conversations/${conversations[CHAT_MAX_REPORTS_PER_DAY]}/report`)
        .set('Authorization', `Bearer ${reporter.accessToken}`)
        .send({ messageId: messages[CHAT_MAX_REPORTS_PER_DAY], reason: 'spam' })
        .expect(429);
      expect(refused.body.error.details.reason).toBe('report_rate_limited');
    });

    // -----------------------------------------------------------------------
    // The moderation surface
    // -----------------------------------------------------------------------

    it('refuses a participant on every moderation route', async () => {
      const { pair, reportId } = await seedReport('+98914006010');
      const token = pair.customer.accessToken;
      await api().get('/api/v1/admin/chat/reports').set('Authorization', `Bearer ${token}`).expect(403);
      await api().get(`/api/v1/admin/chat/reports/${reportId}`).set('Authorization', `Bearer ${token}`).expect(403);
      await api()
        .post(`/api/v1/admin/chat/reports/${reportId}/decide`)
        .set('Authorization', `Bearer ${token}`)
        .send({ outcome: 'rejected', reason: 'nope' })
        .expect(403);
    });

    it('refuses a platform_operator, who deliberately does not hold bc_moderate_chat', async () => {
      const { reportId } = await seedReport('+98914006020');
      const operator = await seedUser(app, dataSource, '+989140060299', ['platform_operator']);
      await api()
        .get(`/api/v1/admin/chat/reports/${reportId}`)
        .set('Authorization', `Bearer ${operator.accessToken}`)
        .expect(403);
    });

    it('shows a moderator the queue without any message body or report note', async () => {
      await seedReport('+98914006030');
      const moderator = await seedUser(app, dataSource, '+989140060399', ['moderator']);

      const res = await api()
        .get('/api/v1/admin/chat/reports')
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('پیام نامناسب');
      expect(body).not.toContain('محتوای آزاردهنده');
    });

    it('lets a moderator read the bounded window, and audits the read', async () => {
      const { reportId } = await seedReport('+98914006040');
      const moderator = await seedUser(app, dataSource, '+989140060499', ['moderator']);

      const res = await api()
        .get(`/api/v1/admin/chat/reports/${reportId}`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .expect(200);

      expect(res.body.data.messages.length).toBeGreaterThan(0);
      expect(res.body.data.windowLimit).toBe(50);

      // Reading -- not only acting -- is audited. A privilege that leaves no
      // trace when exercised is the one most worth tracing.
      const audit = await dataSource.query(
        `SELECT action, target_id, actor_user_id FROM admin.admin_audit_log WHERE target_id = $1 AND action = 'chat.report.read'`,
        [reportId],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(moderator.id);
    });

    /**
     * `V32-DEC-015`: entry is possible ONLY through a report id.
     *
     * Asserted over the real route table -- no moderation route accepts a
     * conversation id, a user id, or anything else.
     */
    it('registers no moderation route addressed by anything but a report id', () => {
      const server = app.getHttpServer();
      const router = server._events.request._router as { stack: Array<{ route?: { path: string } }> };
      const paths = router.stack
        .map((l) => l.route?.path)
        .filter((p): p is string => typeof p === 'string' && p.includes('/admin/chat'));

      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path).toMatch(/^\/api\/v1\/admin\/chat\/reports/);
        expect(path).not.toMatch(/:conversationId|:userId|:customerId|:professionalId|:businessId|search/);
      }
    });

    it('has no moderation route that sends, edits, or deletes', () => {
      const server = app.getHttpServer();
      const router = server._events.request._router as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      const chatAdmin = router.stack
        .map((l) => l.route)
        .filter((r): r is { path: string; methods: Record<string, boolean> } =>
          Boolean(r && r.path.includes('/admin/chat')),
        );

      for (const route of chatAdmin) {
        expect(route.methods.delete).toBeFalsy();
        expect(route.methods.put).toBeFalsy();
        expect(route.methods.patch).toBeFalsy();
        expect(route.path).not.toMatch(/message|send|reply/);
      }
    });

    it('upholds a report, closes the conversation for sending, and audits the decision', async () => {
      const { pair, reportId } = await seedReport('+98914006050');
      const moderator = await seedUser(app, dataSource, '+989140060599', ['moderator']);

      await api()
        .post(`/api/v1/admin/chat/reports/${reportId}/decide`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .send({ outcome: 'upheld', action: 'close_conversation', reason: 'محتوای آزاردهنده تأیید شد' })
        .expect(201);

      const refused = await send(pair.customer.accessToken, pair.conversationId, 'باز هم').expect(409);
      expect(refused.body.error.details.reason).toBe('conversation_closed');

      // Reading survives a moderator's close, exactly as it survives a block.
      await api()
        .get(`/api/v1/chat/conversations/${pair.conversationId}/messages`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .expect(200);

      const audit = await dataSource.query(
        `SELECT reason FROM admin.admin_audit_log WHERE target_id = $1 AND action = 'chat.report.decided'`,
        [reportId],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].reason).toContain('تأیید');
    });

    it('lets only one moderator decide a report', async () => {
      const { reportId } = await seedReport('+98914006060');
      const a = await seedUser(app, dataSource, '+989140060698', ['moderator']);
      const b = await seedUser(app, dataSource, '+989140060699', ['moderator']);

      await api()
        .post(`/api/v1/admin/chat/reports/${reportId}/decide`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ outcome: 'rejected', reason: 'بی‌مورد' })
        .expect(201);

      // The loser of the race does not overwrite a colleague's verdict.
      await api()
        .post(`/api/v1/admin/chat/reports/${reportId}/decide`)
        .set('Authorization', `Bearer ${b.accessToken}`)
        .send({ outcome: 'upheld', action: 'restrict_sender', reason: 'مخالف' })
        .expect(404);

      const rows = await dataSource.query('SELECT status, decided_by FROM chat.reports WHERE id = $1', [reportId]);
      expect(rows[0].status).toBe('rejected');
      expect(rows[0].decided_by).toBe(a.id);
    });

    it('closes the moderator window 30 days after the decision', async () => {
      const { reportId } = await seedReport('+98914006070');
      const moderator = await seedUser(app, dataSource, '+989140060799', ['moderator']);
      await api()
        .post(`/api/v1/admin/chat/reports/${reportId}/decide`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .send({ outcome: 'rejected', reason: 'بی‌مورد' })
        .expect(201);

      // Inside the window.
      await api().get(`/api/v1/admin/chat/reports/${reportId}`).set('Authorization', `Bearer ${moderator.accessToken}`).expect(200);

      await dataSource.query(`UPDATE chat.reports SET decided_at = now() - interval '31 days' WHERE id = $1`, [reportId]);

      // Past it -- and indistinguishable from an invented id.
      const lapsed = await api()
        .get(`/api/v1/admin/chat/reports/${reportId}`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .expect(404);
      const invented = await api()
        .get(`/api/v1/admin/chat/reports/${uuidv7()}`)
        .set('Authorization', `Bearer ${moderator.accessToken}`)
        .expect(404);
      expect(lapsed.body.error).toEqual(invented.body.error);
    });
  });

  // -------------------------------------------------------------------------
  // Leakage
  // -------------------------------------------------------------------------

  describe('no message body leaves chat.messages', () => {
    const MARKER = 'QZXV-CHAT-PRIVATE-MARKER-4417';

    it('keeps the text out of the outbox, analytics, notifications, and readiness', async () => {
      const pair = await seedPair('+98914007010');
      await send(pair.customer.accessToken, pair.conversationId, `پیام ${MARKER}`).expect(201);

      // It IS in the messages table -- without this the test could pass because
      // nothing was stored at all.
      const stored = await dataSource.query('SELECT body FROM chat.messages WHERE conversation_id = $1', [
        pair.conversationId,
      ]);
      expect(stored[0].body).toContain(MARKER);

      const outbox = await dataSource.query('SELECT payload FROM chat.outbox_events');
      expect(outbox.length).toBeGreaterThan(0);
      expect(JSON.stringify(outbox)).not.toContain(MARKER);

      await ctx.relay.drain();

      const facts = await dataSource.query('SELECT event_type, dimensions FROM analytics.events');
      expect(JSON.stringify(facts)).not.toContain(MARKER);

      const notifications = await dataSource.query('SELECT payload, deep_link, template_key FROM notification.notifications');
      expect(notifications.length).toBeGreaterThan(0);
      expect(JSON.stringify(notifications)).not.toContain(MARKER);

      const readiness = await api().get('/api/health/ready').expect(200);
      expect(JSON.stringify(readiness.body)).not.toContain(MARKER);
    });

    it('emits a MessageSent carrying a length and a recipient, never the text', async () => {
      const pair = await seedPair('+98914007020');
      const body = `سؤال ${MARKER}`;
      await send(pair.customer.accessToken, pair.conversationId, body).expect(201);

      const rows = await dataSource.query(
        `SELECT payload FROM chat.outbox_events WHERE event_type = 'MessageSent'`,
      );
      const payload = rows[0].payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        'bodyLength',
        'conversationId',
        'messageId',
        'occurredAt',
        'recipientUserId',
        'senderUserId',
        'sequence',
      ]);
      expect(payload.bodyLength).toBe([...body.normalize('NFC')].length);
      expect(payload.recipientUserId).toBe(pair.proOwner.id);
    });

    it('keeps a report note out of every channel', async () => {
      const pair = await seedPair('+98914007030');
      const sent = await send(pair.proOwner.accessToken, pair.conversationId, 'پیام').expect(201);
      const secretNote = `NOTE-${MARKER}`;
      await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/report`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .send({ messageId: sent.body.data.message.id, reason: 'harassment', note: secretNote })
        .expect(201);

      await ctx.relay.drain();
      const outbox = await dataSource.query('SELECT payload FROM chat.outbox_events');
      const facts = await dataSource.query('SELECT dimensions FROM analytics.events');
      expect(JSON.stringify(outbox)).not.toContain(secretNote);
      expect(JSON.stringify(facts)).not.toContain(secretNote);
    });

    /**
     * The notification rule is keyed on the MESSAGE, not the conversation.
     *
     * Keying on the conversation would give each recipient exactly ONE chat
     * notification for a conversation's entire life, with every later message
     * swallowed as a duplicate -- the tier-change bug this codebase already fixed
     * once.
     */
    it('notifies once per message, not once per conversation', async () => {
      const pair = await seedPair('+98914007040');
      await send(pair.customer.accessToken, pair.conversationId, 'یک').expect(201);
      await send(pair.customer.accessToken, pair.conversationId, 'دو').expect(201);
      await send(pair.customer.accessToken, pair.conversationId, 'سه').expect(201);
      await ctx.relay.drain();

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM notification.notifications WHERE user_id = $1 AND category = 'chat'`,
        [pair.proOwner.id],
      );
      expect(rows[0].n).toBe(3);
    });

    it('makes the chat notification category opt-outable', async () => {
      const pair = await seedPair('+98914007050');
      // A disabling preference row is writable -- unlike booking/payment/privacy,
      // which a CHECK constraint refuses to disable.
      await expect(
        dataSource.query(
          `INSERT INTO notification.preferences (id, user_id, category, enabled) VALUES ($1, $2, 'chat', false)`,
          [uuidv7(), pair.proOwner.id],
        ),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Subject data
  // -------------------------------------------------------------------------

  describe('subject-data coverage', () => {
    it('claims every chat table the database reports', async () => {
      const rows = await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'chat' ORDER BY tablename`);
      const inDatabase = rows.map((r: { tablename: string }) => `chat.${r.tablename}`).sort();
      expect(chatContract.tables.map((t) => t.table).sort()).toEqual(inDatabase);
    });

    it('has no message_attachments table — attachments are out of the milestone', async () => {
      const rows = await dataSource.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'chat' AND tablename LIKE '%attach%'`,
      );
      expect(rows).toEqual([]);
    });

    it('has no soft-delete column anywhere in the chat schema', async () => {
      const rows = await dataSource.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'chat' AND column_name IN ('deleted_at','is_deleted','archived_at','hidden_at')`,
      );
      expect(rows).toEqual([]);
    });

    /**
     * The boot assertion, proved to actually fail.
     *
     * A test asserting only the passing case would not distinguish a working
     * check from one that always returns "fine".
     */
    it('fails coverage when a chat table is unclaimed, which is what stops the boot', async () => {
      const rows = await dataSource.query(
        `SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      );
      const catalogue = rows.map((r: { schemaname: string; tablename: string }) => ({
        schema: r.schemaname,
        name: r.tablename,
        columns: [] as string[],
      }));

      const all = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const withoutChat = all.filter((c) => c.moduleKey !== 'chat');

      const report = evaluateCoverage(catalogue, withoutChat);
      const unclaimed = report.violations.filter((v) => v.kind === 'unclaimed' && v.table.startsWith('chat.'));
      expect(unclaimed).toHaveLength(7);

      expect(evaluateCoverage(catalogue, all).violations.filter((v) => v.table.startsWith('chat.'))).toEqual([]);
    });

    it('is registered in the platform contract list', () => {
      const all = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      expect(all.map((c) => c.moduleKey)).toContain('chat');
    });
  });

  describe('export and erasure', () => {
    it('exports only the subject`s own messages, never the counterparty`s', async () => {
      const pair = await seedPair('+98914008010');
      await send(pair.customer.accessToken, pair.conversationId, 'حرف مشتری').expect(201);
      await send(pair.proOwner.accessToken, pair.conversationId, 'حرف متخصص').expect(201);

      const sections = await chatContract.exportSubjectData(dataSource.manager, pair.customer.id);
      const serialized = JSON.stringify(sections);
      expect(serialized).toContain('حرف مشتری');
      expect(serialized).not.toContain('حرف متخصص');
    });

    /**
     * `V32-DEC-013`, the ADR-027-CONSISTENT option — and the single most
     * important case in this file.
     *
     * The erased subject's prose is DESTROYED. What remains is a structural
     * placeholder with no body, no sender, no excerpt, and nothing
     * reconstructable. The counterparty's own messages survive unchanged.
     */
    it('destroys the erased subject`s prose and leaves a neutral placeholder', async () => {
      const pair = await seedPair('+98914008020');
      const customerWords = 'راز شخصی مشتری';
      const proWords = 'پاسخ متخصص';
      await send(pair.customer.accessToken, pair.conversationId, customerWords).expect(201);
      await send(pair.proOwner.accessToken, pair.conversationId, proWords).expect(201);

      const outcome = await dataSource.transaction((m) =>
        chatContract.eraseSubjectData(m, pair.customer.id, tombstoneFor(pair.customer.id, new Date())),
      );
      expect(outcome.moduleKey).toBe('chat');
      expect(outcome.anonymized).toBeGreaterThan(0);

      const rows = await dataSource.query(
        'SELECT sender_user_id, body, erased_at, sequence FROM chat.messages WHERE conversation_id = $1 ORDER BY sequence',
        [pair.conversationId],
      );

      // The customer's message: gone, but the row and its sequence remain.
      expect(rows[0].body).toBeNull();
      expect(rows[0].sender_user_id).toBeNull();
      expect(rows[0].erased_at).not.toBeNull();
      expect(rows[0].sequence).toBe(1);

      // The professional's own words survive, unchanged.
      expect(rows[1].body).toBe(proWords);
      expect(rows[1].sender_user_id).toBe(pair.proOwner.id);

      // And the prose is nowhere in the schema -- not as an excerpt, not as a
      // hash, not anywhere.
      const everything = await dataSource.query(
        `SELECT string_agg(COALESCE(body,''), ' ') AS all_bodies FROM chat.messages`,
      );
      expect(everything[0].all_bodies ?? '').not.toContain(customerWords);
    });

    it('leaves the counterparty a readable conversation after the customer is erased', async () => {
      const pair = await seedPair('+98914008030');
      await send(pair.customer.accessToken, pair.conversationId, 'سؤال').expect(201);
      await send(pair.proOwner.accessToken, pair.conversationId, 'جواب من').expect(201);

      await dataSource.transaction((m) =>
        chatContract.eraseSubjectData(m, pair.customer.id, tombstoneFor(pair.customer.id, new Date())),
      );

      const res = await api()
        .get(`/api/v1/chat/conversations/${pair.conversationId}/messages`)
        .set('Authorization', `Bearer ${pair.proOwner.accessToken}`)
        .expect(200);

      const items = res.body.data.items;
      expect(items).toHaveLength(2);
      const erased = items.find((m: { sequence: number }) => m.sequence === 1);
      expect(erased.body).toBeNull();
      expect(erased.erased).toBe(true);
      expect(erased.senderUserId).toBeNull();
      // Their own words are intact.
      expect(items.find((m: { sequence: number }) => m.sequence === 2).body).toBe('جواب من');
    });

    it('destroys blocks and throttle counters, and tombstones a filed report', async () => {
      const pair = await seedPair('+98914008040');
      const sent = await send(pair.proOwner.accessToken, pair.conversationId, 'پیام').expect(201);
      await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/report`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .send({ messageId: sent.body.data.message.id, reason: 'harassment', note: 'یادداشت' })
        .expect(201);
      await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/block`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .expect(204);

      await dataSource.transaction((m) =>
        chatContract.eraseSubjectData(m, pair.customer.id, tombstoneFor(pair.customer.id, new Date())),
      );

      expect((await dataSource.query('SELECT count(*)::int AS n FROM chat.blocks'))[0].n).toBe(0);
      expect(
        (await dataSource.query('SELECT count(*)::int AS n FROM chat.send_counters WHERE user_id = $1', [pair.customer.id]))[0].n,
      ).toBe(0);

      // The report survives, attributable-but-anonymous, and its prose is gone.
      const report = await dataSource.query('SELECT reported_by, note, status FROM chat.reports');
      expect(report).toHaveLength(1);
      expect(report[0].reported_by).toBeNull();
      expect(report[0].note).toBeNull();
    });

    it('makes no anonymisation claim, because no subject prose is retained', () => {
      // The disposition list is the claim. `chat.messages` is `subject_data` --
      // exported and erased -- not `retained` with a legitimate-interest reason,
      // which is what an exception to ADR-027 would have required.
      const messages = chatContract.tables.find((t) => t.table === 'chat.messages');
      expect(messages?.disposition).toBe('subject_data');
      expect(messages?.reason).toBeUndefined();
    });

    it('rolls back cleanly, leaving the subject fully intact', async () => {
      const pair = await seedPair('+98914008050');
      await send(pair.customer.accessToken, pair.conversationId, 'باید بماند').expect(201);

      await expect(
        dataSource.transaction(async (m) => {
          await chatContract.eraseSubjectData(m, pair.customer.id, tombstoneFor(pair.customer.id, new Date()));
          throw new Error('another module failed');
        }),
      ).rejects.toThrow('another module failed');

      const rows = await dataSource.query('SELECT body FROM chat.messages WHERE conversation_id = $1', [
        pair.conversationId,
      ]);
      expect(rows[0].body).toBe('باید بماند');
    });
  });

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  describe('24-month retention', () => {
    it('keeps a conversation just inside the boundary', async () => {
      const pair = await seedPair('+98914009010');
      await send(pair.customer.accessToken, pair.conversationId, 'پیام').expect(201);
      await dataSource.query(
        `UPDATE chat.conversations SET last_message_at = now() - interval '23 months' WHERE id = $1`,
        [pair.conversationId],
      );
      expect(await retention.sweepOnce()).toBe(0);
    });

    it('destroys a conversation past it, with everything under it', async () => {
      const pair = await seedPair('+98914009020');
      const sent = await send(pair.proOwner.accessToken, pair.conversationId, 'پیام').expect(201);
      await api()
        .post(`/api/v1/chat/conversations/${pair.conversationId}/report`)
        .set('Authorization', `Bearer ${pair.customer.accessToken}`)
        .send({ messageId: sent.body.data.message.id, reason: 'spam' })
        .expect(201);

      await dataSource.query(
        `UPDATE chat.conversations SET last_message_at = now() - interval '25 months' WHERE id = $1`,
        [pair.conversationId],
      );
      expect(await retention.sweepOnce()).toBe(1);

      for (const table of ['chat.conversations', 'chat.messages', 'chat.conversation_participants', 'chat.reports']) {
        const rows = await dataSource.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0].n).toBe(0);
      }
    });

    it('ages an empty conversation out on its creation time', async () => {
      const pair = await seedPair('+98914009030');
      // Never written in, so `last_message_at` is null.
      await dataSource.query(`UPDATE chat.conversations SET created_at = now() - interval '25 months' WHERE id = $1`, [
        pair.conversationId,
      ]);
      expect(await retention.sweepOnce()).toBe(1);
    });

    it('is idempotent', async () => {
      const pair = await seedPair('+98914009040');
      await dataSource.query(`UPDATE chat.conversations SET created_at = now() - interval '30 months' WHERE id = $1`, [
        pair.conversationId,
      ]);
      expect(await retention.sweep()).toBe(1);
      expect(await retention.sweep()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // The AI boundary
  // -------------------------------------------------------------------------

  describe('human chat is not AI context', () => {
    /**
     * ADR-032 §5, asserted structurally rather than by policy.
     *
     * `ai`'s context is a closed three-key type whose key set is already asserted
     * against a literal in `ai-context.spec.ts`. This checks the other direction:
     * `chat` exposes no context port for `ai` to consume.
     */
    it('exposes no chat context port for the AI module to consume', async () => {
      const chatModule = await import('@beauclick/chat');
      const exported = Object.keys(chatModule).join(' ').toLowerCase();
      for (const forbidden of ['aicontext', 'chatcontextport', 'chat_context', 'summar']) {
        expect(exported).not.toContain(forbidden);
      }
    });

    it('keeps chat messages out of the ai schema entirely', async () => {
      const pair = await seedPair('+98914010010');
      const marker = 'CHAT-NEVER-IN-AI-9931';
      await send(pair.customer.accessToken, pair.conversationId, `پیام ${marker}`).expect(201);
      await ctx.relay.drain();

      const aiMessages = await dataSource.query('SELECT count(*)::int AS n FROM ai.messages');
      expect(aiMessages[0].n).toBe(0);
      const aiOutbox = await dataSource.query('SELECT payload FROM ai.outbox_events');
      expect(JSON.stringify(aiOutbox)).not.toContain(marker);
    });
  });
});
