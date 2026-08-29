import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { AI_MAX_RETAINED_CONVERSATIONS } from '@beauclick/ai-contract';
import { AiConversationService, AiSubjectDataContract } from '@beauclick/ai';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage } from '@beauclick/subject-data';

import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * Bounded-session lifecycle, retention, deletion, export, and erasure —
 * `V32-DEC-002`, `V32-DEC-003`, `V32-DEC-007`, ADR-030 T9.
 *
 * **Why the clock is not mocked here.** The inactivity horizon and the retention
 * boundary are measured against `last_activity_at` and `created_at`, which are
 * ordinary columns. Ageing a conversation by writing an older timestamp is both
 * simpler and a stronger test than freezing a clock: it exercises the real
 * comparison against a real row, and it can put a row on either side of a
 * boundary to the millisecond.
 */
describePg('ai assistant — lifecycle, retention, and privacy (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let conversations: AiConversationService;
  let aiContract: AiSubjectDataContract;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    conversations = app.get(AiConversationService);
    aiContract = app.get(AiSubjectDataContract);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const api = () => request(app.getHttpServer());

  async function acceptConsent(token: string): Promise<void> {
    await api().post('/api/v1/me/ai/consent').set('Authorization', `Bearer ${token}`).expect(200);
  }

  async function startConversation(token: string): Promise<string> {
    const res = await api().post('/api/v1/me/ai/conversations').set('Authorization', `Bearer ${token}`).expect(201);
    return res.body.data.id as string;
  }

  async function sendMessage(token: string, conversationId: string, body = 'سلام'): Promise<void> {
    await api()
      .post(`/api/v1/me/ai/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body })
      .expect(201);
  }

  /** Ages a conversation by rewriting its activity timestamp. See this file's header. */
  async function ageConversation(conversationId: string, hours: number): Promise<void> {
    await dataSource.query(
      `UPDATE ai.conversations SET last_activity_at = now() - ($2 || ' hours')::interval WHERE id = $1`,
      [conversationId, String(hours)],
    );
  }

  /** Closes a conversation directly, as the sweep would, with a chosen closure age. */
  async function closeConversation(conversationId: string, closedHoursAgo: number): Promise<void> {
    await dataSource.query(
      `UPDATE ai.conversations
         SET status = 'closed', closure_reason = 'inactivity',
             closed_at = now() - ($2 || ' hours')::interval
       WHERE id = $1`,
      [conversationId, String(closedHoursAgo)],
    );
  }

  // -------------------------------------------------------------------------
  // Inactivity closure
  // -------------------------------------------------------------------------

  describe('24-hour inactivity closure', () => {
    it('leaves a conversation active just inside the horizon', async () => {
      const user = await seedUser(app, dataSource, '+989128000001');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await ageConversation(conversation, 23);

      const res = await api()
        .get(`/api/v1/me/ai/conversations/${conversation}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(res.body.data.conversation.status).toBe('active');
    });

    /**
     * Closure is applied ON READ, not only by the sweep.
     *
     * The harness runs with `DISABLE_BACKGROUND_SWEEPS=true`, so nothing has
     * swept -- and the conversation is still closed. That is the point: if the
     * rule lived only in the sweep, the 24-hour bound would be a claim about the
     * sweep's uptime rather than about the product, and it would be untested,
     * because the suites that prove it run with the timer off.
     */
    it('closes a conversation past the horizon on read, with no sweep having run', async () => {
      const user = await seedUser(app, dataSource, '+989128000002');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await ageConversation(conversation, 25);

      const res = await api()
        .get(`/api/v1/me/ai/conversations/${conversation}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(res.body.data.conversation.status).toBe('closed');
      expect(res.body.data.conversation.closureReason).toBe('inactivity');

      const rows = await dataSource.query('SELECT status, closed_at FROM ai.conversations WHERE id = $1', [
        conversation,
      ]);
      expect(rows[0].status).toBe('closed');
      expect(rows[0].closed_at).not.toBeNull();
    });

    it('refuses a message to a conversation past the horizon', async () => {
      const user = await seedUser(app, dataSource, '+989128000003');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await ageConversation(conversation, 25);

      const res = await api()
        .post(`/api/v1/me/ai/conversations/${conversation}/messages`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ body: 'سلام' })
        .expect(409);
      expect(res.body.error.details.reason).toBe('conversation_closed');
    });

    /**
     * `V32-DEC-002`: a closed session is never reopened. Continuing produces a
     * NEW session.
     */
    it('never reopens a closed conversation', async () => {
      const user = await seedUser(app, dataSource, '+989128000004');
      await acceptConsent(user.accessToken);
      const first = await startConversation(user.accessToken);
      await ageConversation(first, 25);
      await api()
        .post(`/api/v1/me/ai/conversations/${first}/messages`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ body: 'سلام' })
        .expect(409);

      const second = await startConversation(user.accessToken);
      expect(second).not.toBe(first);

      await sendMessage(user.accessToken, second);

      const rows = await dataSource.query('SELECT status FROM ai.conversations WHERE id = $1', [first]);
      expect(rows[0].status).toBe('closed');
    });

    /**
     * The horizon measures USE, not attention.
     *
     * Reading a conversation does not extend it -- otherwise a customer
     * scrolling their own history would keep a session alive forever, which is
     * the unbounded shape `V32-DEC-002` exists to prevent.
     */
    it('does not extend the horizon on a read', async () => {
      const user = await seedUser(app, dataSource, '+989128000005');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await ageConversation(conversation, 20);

      const before = await dataSource.query('SELECT last_activity_at FROM ai.conversations WHERE id = $1', [
        conversation,
      ]);
      await api()
        .get(`/api/v1/me/ai/conversations/${conversation}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      const after = await dataSource.query('SELECT last_activity_at FROM ai.conversations WHERE id = $1', [
        conversation,
      ]);
      expect(after[0].last_activity_at).toEqual(before[0].last_activity_at);
    });

    it('extends the horizon on an accepted message', async () => {
      const user = await seedUser(app, dataSource, '+989128000006');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await ageConversation(conversation, 20);

      await sendMessage(user.accessToken, conversation);

      const rows = await dataSource.query(
        `SELECT (now() - last_activity_at) < interval '1 minute' AS fresh FROM ai.conversations WHERE id = $1`,
        [conversation],
      );
      expect(rows[0].fresh).toBe(true);
    });

    it('closes stale conversations in bulk when the sweep is driven explicitly', async () => {
      const user = await seedUser(app, dataSource, '+989128000010');
      await acceptConsent(user.accessToken);
      const stale = [await startConversation(user.accessToken), await startConversation(user.accessToken)];
      const fresh = await startConversation(user.accessToken);
      for (const id of stale) await ageConversation(id, 30);

      expect(await conversations.sweepInactive()).toBe(2);

      const rows = await dataSource.query('SELECT id, status FROM ai.conversations WHERE user_id = $1', [user.id]);
      const byId = new Map(rows.map((r: { id: string; status: string }) => [r.id, r.status]));
      expect(byId.get(stale[0])).toBe('closed');
      expect(byId.get(stale[1])).toBe('closed');
      expect(byId.get(fresh)).toBe('active');
    });

    it('is idempotent — a second sweep closes nothing', async () => {
      const user = await seedUser(app, dataSource, '+989128000011');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await ageConversation(conversation, 30);

      expect(await conversations.sweepInactive()).toBe(1);
      expect(await conversations.sweepInactive()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // The retained-conversation cap
  // -------------------------------------------------------------------------

  describe('the 20-conversation cap', () => {
    it('allows exactly the cap before eviction is needed', async () => {
      const user = await seedUser(app, dataSource, '+989128001001');
      await acceptConsent(user.accessToken);
      for (let i = 0; i < AI_MAX_RETAINED_CONVERSATIONS; i += 1) await startConversation(user.accessToken);

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM ai.conversations WHERE user_id = $1', [
        user.id,
      ]);
      expect(rows[0].n).toBe(AI_MAX_RETAINED_CONVERSATIONS);
    });

    /**
     * `V32-DEC-002`: an ACTIVE session is never silently evicted. If the cap
     * cannot be satisfied without touching one, the platform REFUSES.
     *
     * A customer with twenty open threads gets a refusal telling them to delete
     * one. They do not get their oldest live conversation destroyed underneath
     * them to make room for a new one they can always start later.
     */
    it('refuses rather than evicting when every conversation is still active', async () => {
      const user = await seedUser(app, dataSource, '+989128001010');
      await acceptConsent(user.accessToken);
      for (let i = 0; i < AI_MAX_RETAINED_CONVERSATIONS; i += 1) await startConversation(user.accessToken);

      const res = await api()
        .post('/api/v1/me/ai/conversations')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(409);
      expect(res.body.error.details.reason).toBe('conversation_limit_reached');

      // Nothing was destroyed.
      const rows = await dataSource.query('SELECT count(*)::int AS n FROM ai.conversations WHERE user_id = $1', [
        user.id,
      ]);
      expect(rows[0].n).toBe(AI_MAX_RETAINED_CONVERSATIONS);
    });

    it('evicts the OLDEST CLOSED conversation, not the oldest one', async () => {
      const user = await seedUser(app, dataSource, '+989128001020');
      await acceptConsent(user.accessToken);

      const created: string[] = [];
      for (let i = 0; i < AI_MAX_RETAINED_CONVERSATIONS; i += 1) created.push(await startConversation(user.accessToken));

      // The oldest conversation overall stays ACTIVE. Two later ones are closed,
      // one of them longer ago than the other.
      const oldestButActive = created[0];
      const closedLongAgo = created[5];
      const closedRecently = created[9];
      await closeConversation(closedLongAgo, 100);
      await closeConversation(closedRecently, 2);

      const fresh = await startConversation(user.accessToken);
      expect(fresh).toBeTruthy();

      const remaining = await dataSource.query('SELECT id FROM ai.conversations WHERE user_id = $1', [user.id]);
      const ids = new Set(remaining.map((r: { id: string }) => r.id));

      // Only the oldest CLOSED one went.
      expect(ids.has(closedLongAgo)).toBe(false);
      expect(ids.has(closedRecently)).toBe(true);
      expect(ids.has(oldestButActive)).toBe(true);
      expect(ids.size).toBe(AI_MAX_RETAINED_CONVERSATIONS);
    });

    it('destroys the evicted conversation messages with it, in the same statement', async () => {
      const user = await seedUser(app, dataSource, '+989128001030');
      await acceptConsent(user.accessToken);

      const created: string[] = [];
      for (let i = 0; i < AI_MAX_RETAINED_CONVERSATIONS; i += 1) created.push(await startConversation(user.accessToken));

      const doomed = created[3];
      await sendMessage(user.accessToken, doomed, 'پیام محکوم به حذف');
      await closeConversation(doomed, 200);

      const before = await dataSource.query('SELECT count(*)::int AS n FROM ai.messages WHERE conversation_id = $1', [
        doomed,
      ]);
      expect(before[0].n).toBeGreaterThan(0);

      await startConversation(user.accessToken);

      const after = await dataSource.query('SELECT count(*)::int AS n FROM ai.messages WHERE conversation_id = $1', [
        doomed,
      ]);
      expect(after[0].n).toBe(0);
    });

    /**
     * A stale ACTIVE conversation becomes an evictable CLOSED one before the cap
     * is measured, rather than counting against the customer as though it were
     * live.
     */
    it('closes anything stale before measuring the cap, so an aged-out thread is evictable', async () => {
      const user = await seedUser(app, dataSource, '+989128001040');
      await acceptConsent(user.accessToken);

      const created: string[] = [];
      for (let i = 0; i < AI_MAX_RETAINED_CONVERSATIONS; i += 1) created.push(await startConversation(user.accessToken));

      // Still `active` in the table, but past the horizon.
      await ageConversation(created[0], 200);

      // Would have been a refusal if the cap had been measured first.
      const fresh = await startConversation(user.accessToken);
      expect(fresh).toBeTruthy();

      const remaining = await dataSource.query('SELECT id FROM ai.conversations WHERE user_id = $1', [user.id]);
      expect(remaining.map((r: { id: string }) => r.id)).not.toContain(created[0]);
    });

    it('caps each customer independently', async () => {
      const alice = await seedUser(app, dataSource, '+989128001050');
      const bob = await seedUser(app, dataSource, '+989128001051');
      await acceptConsent(alice.accessToken);
      await acceptConsent(bob.accessToken);

      for (let i = 0; i < AI_MAX_RETAINED_CONVERSATIONS; i += 1) await startConversation(alice.accessToken);
      await api().post('/api/v1/me/ai/conversations').set('Authorization', `Bearer ${alice.accessToken}`).expect(409);

      // Bob is unaffected.
      await api().post('/api/v1/me/ai/conversations').set('Authorization', `Bearer ${bob.accessToken}`).expect(201);
    });

    /**
     * `SELECT ... FOR UPDATE` on the customer's rows, so two concurrent creates
     * cannot both see nineteen and both insert.
     */
    it('never exceeds the cap under concurrent creation', async () => {
      const user = await seedUser(app, dataSource, '+989128001060');
      await acceptConsent(user.accessToken);
      for (let i = 0; i < AI_MAX_RETAINED_CONVERSATIONS - 1; i += 1) await startConversation(user.accessToken);

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          api().post('/api/v1/me/ai/conversations').set('Authorization', `Bearer ${user.accessToken}`),
        ),
      );

      const created = responses.filter((r) => r.status === 201).length;
      expect(created).toBe(1);

      const rows = await dataSource.query('SELECT count(*)::int AS n FROM ai.conversations WHERE user_id = $1', [
        user.id,
      ]);
      expect(rows[0].n).toBe(AI_MAX_RETAINED_CONVERSATIONS);
    });
  });

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  describe('30-day retention', () => {
    /** Ages a conversation past the retention boundary, in days. */
    async function ageDays(conversationId: string, days: number): Promise<void> {
      await dataSource.query(
        `UPDATE ai.conversations SET last_activity_at = now() - ($2 || ' days')::interval WHERE id = $1`,
        [conversationId, String(days)],
      );
    }

    it('keeps a conversation just inside the boundary', async () => {
      const user = await seedUser(app, dataSource, '+989128002001');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await ageDays(conversation, 29);

      expect(await conversations.sweepRetention()).toBe(0);
      const rows = await dataSource.query('SELECT count(*)::int AS n FROM ai.conversations WHERE id = $1', [
        conversation,
      ]);
      expect(rows[0].n).toBe(1);
    });

    it('destroys a conversation past the boundary, with its messages', async () => {
      const user = await seedUser(app, dataSource, '+989128002002');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await sendMessage(user.accessToken, conversation, 'یک پیام قدیمی');
      await ageDays(conversation, 31);

      expect(await conversations.sweepRetention()).toBe(1);

      const remaining = await dataSource.query('SELECT count(*)::int AS n FROM ai.conversations WHERE id = $1', [
        conversation,
      ]);
      expect(remaining[0].n).toBe(0);
      // Rows are DELETED, not flagged. `V32-DEC-003` and `V32-DEC-007` both
      // refuse a soft delete that leaves the prose in the table.
      const messages = await dataSource.query('SELECT count(*)::int AS n FROM ai.messages WHERE conversation_id = $1', [
        conversation,
      ]);
      expect(messages[0].n).toBe(0);
    });

    /**
     * Age is measured from `last_activity_at`, not `closed_at`.
     *
     * A conversation that closed on day 2 through inactivity and one that closed
     * on day 29 because the sweep was down should be destroyed at the same time,
     * because the customer's last interaction with both was at the same age.
     * Measuring from `closed_at` would make the retention period depend on when
     * a background job happened to run.
     */
    it('measures age from last activity, not from when the sweep closed it', async () => {
      const user = await seedUser(app, dataSource, '+989128002010');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);

      // Last used 31 days ago; only just closed.
      await dataSource.query(
        `UPDATE ai.conversations
           SET last_activity_at = now() - interval '31 days',
               status = 'closed', closure_reason = 'inactivity', closed_at = now()
         WHERE id = $1`,
        [conversation],
      );

      expect(await conversations.sweepRetention()).toBe(1);
    });

    it('destroys an active conversation past the boundary too', async () => {
      // An `active` row 31 days old is a row whose inactivity sweep never ran.
      // Retention is about how old the DATA is, not about the status column.
      const user = await seedUser(app, dataSource, '+989128002020');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await ageDays(conversation, 31);

      const status = await dataSource.query('SELECT status FROM ai.conversations WHERE id = $1', [conversation]);
      expect(status[0].status).toBe('active');
      expect(await conversations.sweepRetention()).toBe(1);
    });

    it('is idempotent', async () => {
      const user = await seedUser(app, dataSource, '+989128002030');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await ageDays(conversation, 40);

      expect(await conversations.sweepRetention()).toBe(1);
      expect(await conversations.sweepRetention()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Individual deletion
  // -------------------------------------------------------------------------

  describe('individual deletion', () => {
    it('destroys the conversation, its messages, and its recommendations immediately', async () => {
      const user = await seedUser(app, dataSource, '+989128003001');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await sendMessage(user.accessToken, conversation, 'یک پیام برای حذف');

      await api()
        .delete(`/api/v1/me/ai/conversations/${conversation}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(204);

      for (const table of ['ai.conversations', 'ai.messages', 'ai.recommendations']) {
        const rows = await dataSource.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'ai.conversations' ? 'id' : 'conversation_id'} = $1`,
          [conversation],
        );
        expect(rows[0].n).toBe(0);
      }
    });

    /**
     * `V32-DEC-003` is explicit: no soft delete pretending to be deletion.
     *
     * Asserted over the real catalogue rather than the code -- there is no
     * `deleted_at` column on any AI table, so a soft delete has nowhere to be
     * recorded even if somebody wanted one.
     */
    it('has no soft-delete column anywhere in the ai schema', async () => {
      const rows = await dataSource.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'ai' AND column_name IN ('deleted_at', 'is_deleted', 'archived_at', 'hidden_at')`,
      );
      expect(rows).toEqual([]);
    });

    it('is idempotent — deleting twice succeeds', async () => {
      const user = await seedUser(app, dataSource, '+989128003010');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);

      await api()
        .delete(`/api/v1/me/ai/conversations/${conversation}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(204);
      // A client retrying a delete it never saw the response to must not be told
      // the resource is missing -- that reads as "somebody else deleted it".
      await api()
        .delete(`/api/v1/me/ai/conversations/${conversation}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(204);
    });

    it('leaves the customer other conversations untouched', async () => {
      const user = await seedUser(app, dataSource, '+989128003020');
      await acceptConsent(user.accessToken);
      const kept = await startConversation(user.accessToken);
      const deleted = await startConversation(user.accessToken);

      await api()
        .delete(`/api/v1/me/ai/conversations/${deleted}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(204);

      await api()
        .get(`/api/v1/me/ai/conversations/${kept}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
    });

    it('does not spend a quota slot, so deleting is not a way to lose an allowance', async () => {
      const user = await seedUser(app, dataSource, '+989128003030');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await sendMessage(user.accessToken, conversation);

      const before = await dataSource.query('SELECT accepted_messages FROM ai.usage_daily WHERE user_id = $1', [
        user.id,
      ]);
      await api()
        .delete(`/api/v1/me/ai/conversations/${conversation}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(204);
      const after = await dataSource.query('SELECT accepted_messages FROM ai.usage_daily WHERE user_id = $1', [
        user.id,
      ]);

      // The counter is not rewound either: the message WAS accepted and answered,
      // and rewinding on delete would make the cap trivially bypassable.
      expect(after[0].accepted_messages).toBe(before[0].accepted_messages);
    });
  });

  // -------------------------------------------------------------------------
  // Subject data — boot coverage, export, erasure
  // -------------------------------------------------------------------------

  describe('subject-data coverage', () => {
    it('claims every ai table exactly once', () => {
      const claimed = aiContract.tables.map((t) => t.table).sort();
      expect(claimed).toEqual([
        'ai.assistant_consents',
        'ai.conversations',
        'ai.messages',
        'ai.recommendations',
        'ai.usage_daily',
        'ai.outbox_events',
      ].sort());
    });

    it('claims every ai table the database actually reports', async () => {
      const rows = await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'ai' ORDER BY tablename`);
      const inDatabase = rows.map((r: { tablename: string }) => `ai.${r.tablename}`).sort();
      const claimed = aiContract.tables.map((t) => t.table).sort();
      expect(claimed).toEqual(inDatabase);
    });

    /**
     * `V32-DEC-007`: AI conversations are `subject_data`, with no
     * counterpart-retention exception.
     *
     * Every table except the outbox is `subject_data`. Nothing is `retained`
     * except the transactional outbox, and nothing at all is `no_subject_data` --
     * which would be false anyway, because every one carries `user_id`.
     */
    it('classifies every content table as subject_data, retaining only the outbox', () => {
      const byTable = new Map(aiContract.tables.map((t) => [t.table, t]));
      for (const table of ['ai.conversations', 'ai.messages', 'ai.recommendations', 'ai.assistant_consents', 'ai.usage_daily']) {
        expect(byTable.get(table)?.disposition).toBe('subject_data');
      }
      expect(byTable.get('ai.outbox_events')?.disposition).toBe('retained');
      expect(aiContract.tables.filter((t) => t.disposition === 'no_subject_data')).toEqual([]);
    });

    /**
     * The boot assertion, proved to actually fail.
     *
     * `evaluateCoverage` is the pure function the boot check calls. Running it
     * with the AI contract REMOVED must report every AI table as unclaimed --
     * which is what stops the application starting. A test that only asserted
     * the passing case would not distinguish a working check from one that
     * always returns "fine".
     */
    it('fails coverage when an ai table is unclaimed, which is what stops the boot', async () => {
      const rows = await dataSource.query(
        `SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      );
      const catalogue = rows.map((r: { schemaname: string; tablename: string }) => ({
        schema: r.schemaname,
        name: r.tablename,
        columns: [] as string[],
      }));

      const all = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      // Everything except AI.
      const withoutAi = all.filter((contract) => contract.moduleKey !== 'ai');

      const report = evaluateCoverage(catalogue, withoutAi);
      const unclaimedAi = report.violations.filter((v) => v.kind === 'unclaimed' && v.table.startsWith('ai.'));
      expect(unclaimedAi.length).toBe(6);

      // And with AI present, the AI tables are clean.
      const complete = evaluateCoverage(catalogue, all);
      expect(complete.violations.filter((v) => v.table.startsWith('ai.'))).toEqual([]);
    });

    it('is registered in the platform contract list', () => {
      const all = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      expect(all.map((c) => c.moduleKey)).toContain('ai');
    });
  });

  describe('subject-data export', () => {
    /**
     * `V32-DEC-007` chose the COMPLETE readable conversation: customer messages
     * and assistant replies alike.
     *
     * The alternative -- exporting only what the subject typed -- produces a
     * document nobody can read: questions with no answers, out of context,
     * describing nothing.
     */
    it('exports the complete conversation, both sides, in readable order', async () => {
      const user = await seedUser(app, dataSource, '+989128004001');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await sendMessage(user.accessToken, conversation, 'پرسش اول من');
      await sendMessage(user.accessToken, conversation, 'پرسش دوم من');

      const sections = await aiContract.exportSubjectData(dataSource.manager, user.id);
      const conversationsSection = sections.find((s) => s.key === 'ai_conversations');
      expect(conversationsSection).toBeDefined();

      const exported = conversationsSection!.rows[0] as { messages: Array<{ role: string; body: string; sequence: number; providerState: string | null }> };
      expect(exported.messages).toHaveLength(4);
      // Deterministic order, so the document reads as a conversation.
      expect(exported.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
      expect(exported.messages.map((m) => m.role)).toEqual(['customer', 'assistant', 'customer', 'assistant']);
      expect(exported.messages[0].body).toBe('پرسش اول من');
      expect(exported.messages[2].body).toBe('پرسش دوم من');
      // The assistant's replies are present in full.
      expect(exported.messages[1].body.length).toBeGreaterThan(0);
      // And a reader of their own export can tell what produced each reply.
      expect(exported.messages[1].providerState).toBe('simulated');
      expect(exported.messages[0].providerState).toBeNull();
    });

    it('exports the consent record and the daily usage counts', async () => {
      const user = await seedUser(app, dataSource, '+989128004010');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await sendMessage(user.accessToken, conversation);

      const sections = await aiContract.exportSubjectData(dataSource.manager, user.id);
      expect(sections.map((s) => s.key).sort()).toEqual(['ai_consent', 'ai_conversations', 'ai_usage']);

      const consent = sections.find((s) => s.key === 'ai_consent')!;
      expect(consent.rows).toHaveLength(1);
      expect((consent.rows[0] as { contractKey: string }).contractKey).toBe('ai_assistant_sandbox_v1');

      const usage = sections.find((s) => s.key === 'ai_usage')!;
      expect((usage.rows[0] as { acceptedMessages: number }).acceptedMessages).toBe(1);
    });

    it('never includes another customer conversation', async () => {
      const alice = await seedUser(app, dataSource, '+989128004020');
      const bob = await seedUser(app, dataSource, '+989128004021');
      await acceptConsent(alice.accessToken);
      await acceptConsent(bob.accessToken);
      const alicesConversation = await startConversation(alice.accessToken);
      await sendMessage(alice.accessToken, alicesConversation, 'راز آلیس');

      const bobsExport = await aiContract.exportSubjectData(dataSource.manager, bob.id);
      expect(JSON.stringify(bobsExport)).not.toContain('راز آلیس');
      expect(JSON.stringify(bobsExport)).not.toContain(alicesConversation);
    });

    it('returns empty sections rather than nothing for a customer who never used the assistant', async () => {
      const user = await seedUser(app, dataSource, '+989128004030');
      const sections = await aiContract.exportSubjectData(dataSource.manager, user.id);
      // Three sections, all empty. A client never has to distinguish "no data"
      // from "the module was not reached".
      expect(sections).toHaveLength(3);
      for (const section of sections) expect(section.rows).toEqual([]);
    });
  });

  describe('account erasure', () => {
    it('destroys every ai row for the subject and retains nothing', async () => {
      const user = await seedUser(app, dataSource, '+989128005001');
      await acceptConsent(user.accessToken);
      const first = await startConversation(user.accessToken);
      const second = await startConversation(user.accessToken);
      await sendMessage(user.accessToken, first, 'پیام یک');
      await sendMessage(user.accessToken, second, 'پیام دو');

      const outcome = await dataSource.transaction((manager) =>
        aiContract.eraseSubjectData(manager, user.id),
      );

      expect(outcome.moduleKey).toBe('ai');
      expect(outcome.deleted).toBeGreaterThan(0);
      expect(outcome.anonymized).toBe(0);
      /**
       * `retained` is EMPTY, and that is the substantive claim.
       *
       * Every other module with a two-party fact reports something here. An AI
       * conversation has no counterpart with an interest, so nothing survives --
       * `V32-DEC-007` states there is no counterpart-retention exception.
       */
      expect(outcome.retained).toEqual([]);

      for (const table of [
        'ai.conversations',
        'ai.messages',
        'ai.recommendations',
        'ai.assistant_consents',
        'ai.usage_daily',
      ]) {
        const rows = await dataSource.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [user.id]);
        expect(rows[0].n).toBe(0);
      }
    });

    it('leaves other customers data entirely intact', async () => {
      const alice = await seedUser(app, dataSource, '+989128005010');
      const bob = await seedUser(app, dataSource, '+989128005011');
      await acceptConsent(alice.accessToken);
      await acceptConsent(bob.accessToken);
      const bobsConversation = await startConversation(bob.accessToken);
      await sendMessage(bob.accessToken, bobsConversation, 'پیام باب');
      const alicesConversation = await startConversation(alice.accessToken);
      await sendMessage(alice.accessToken, alicesConversation);

      await dataSource.transaction((manager) =>
        aiContract.eraseSubjectData(manager, alice.id),
      );

      const bobsRows = await dataSource.query('SELECT count(*)::int AS n FROM ai.messages WHERE user_id = $1', [bob.id]);
      expect(bobsRows[0].n).toBe(2);
      const bobsConsent = await dataSource.query(
        'SELECT count(*)::int AS n FROM ai.assistant_consents WHERE user_id = $1',
        [bob.id],
      );
      expect(bobsConsent[0].n).toBe(1);
    });

    it('is a no-op for a subject who never used the assistant', async () => {
      const user = await seedUser(app, dataSource, '+989128005020');
      const outcome = await dataSource.transaction((manager) =>
        aiContract.eraseSubjectData(manager, user.id),
      );
      // Zeroes are a real answer, not a stub -- and the claim list is what proves
      // this module was reached at all.
      expect(outcome.deleted).toBe(0);
      expect(outcome.retained).toEqual([]);
    });

    it('rolls back cleanly, leaving the subject fully intact rather than half erased', async () => {
      const user = await seedUser(app, dataSource, '+989128005030');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await sendMessage(user.accessToken, conversation, 'باید باقی بماند');

      await expect(
        dataSource.transaction(async (manager) => {
          await aiContract.eraseSubjectData(manager, user.id);
          // Something else in the same erasure transaction fails.
          throw new Error('another module failed');
        }),
      ).rejects.toThrow('another module failed');

      const rows = await dataSource.query('SELECT body FROM ai.messages WHERE user_id = $1 ORDER BY sequence', [
        user.id,
      ]);
      expect(rows[0].body).toBe('باید باقی بماند');
    });
  });

  // -------------------------------------------------------------------------
  // Schema-level guarantees
  // -------------------------------------------------------------------------

  describe('schema guarantees', () => {
    it('refuses a closed conversation with no closure time or reason', async () => {
      const user = await seedUser(app, dataSource, '+989128006001');
      await expect(
        dataSource.query(
          `INSERT INTO ai.conversations (id, user_id, status, last_activity_at) VALUES ($1, $2, 'closed', now())`,
          [uuidv7(), user.id],
        ),
      ).rejects.toThrow(/ck_ai_conversations_closed_consistently/);
    });

    it('refuses an assistant message with no provider recorded', async () => {
      const user = await seedUser(app, dataSource, '+989128006002');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);

      await expect(
        dataSource.query(
          `INSERT INTO ai.messages (id, conversation_id, user_id, role, body, sequence)
           VALUES ($1, $2, $3, 'assistant', 'پاسخ', 99)`,
          [uuidv7(), conversation, user.id],
        ),
      ).rejects.toThrow(/ck_ai_messages_provider_matches_role/);
    });

    it('refuses a customer message that claims a provider', async () => {
      const user = await seedUser(app, dataSource, '+989128006003');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);

      await expect(
        dataSource.query(
          `INSERT INTO ai.messages (id, conversation_id, user_id, role, body, sequence, provider_key, provider_state)
           VALUES ($1, $2, $3, 'customer', 'سلام', 98, 'deterministic', 'simulated')`,
          [uuidv7(), conversation, user.id],
        ),
      ).rejects.toThrow(/ck_ai_messages_provider_matches_role/);
    });

    it('refuses two messages claiming the same sequence in one conversation', async () => {
      const user = await seedUser(app, dataSource, '+989128006004');
      await acceptConsent(user.accessToken);
      const conversation = await startConversation(user.accessToken);
      await sendMessage(user.accessToken, conversation);

      await expect(
        dataSource.query(
          `INSERT INTO ai.messages (id, conversation_id, user_id, role, body, sequence)
           VALUES ($1, $2, $3, 'customer', 'تکراری', 1)`,
          [uuidv7(), conversation, user.id],
        ),
      ).rejects.toThrow(/uq_ai_messages_sequence/);
    });

    it('refuses a negative quota counter', async () => {
      const user = await seedUser(app, dataSource, '+989128006005');
      await expect(
        dataSource.query(
          `INSERT INTO ai.usage_daily (user_id, usage_day, accepted_messages) VALUES ($1, current_date, -1)`,
          [user.id],
        ),
      ).rejects.toThrow(/ck_ai_usage_counts_non_negative/);
    });
  });
});
