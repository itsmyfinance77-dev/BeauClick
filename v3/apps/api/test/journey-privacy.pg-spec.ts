import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { JourneyContextProvider, JourneyService } from '@beauclick/journey';
import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

describePg('beauty journey — ownership, privacy, AI boundary (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let journey: JourneyService;
  let context: JourneyContextProvider;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    journey = app.get(JourneyService);
    context = app.get(JourneyContextProvider);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  describe('profile', () => {
    it('returns an empty profile rather than nothing for a customer who has never set one', async () => {
      const user = await seedUser(app, dataSource, '+989123000001');
      const res = await request(app.getHttpServer())
        .get('/api/v1/me/journey/profile')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      // The client never has to distinguish "no profile" from "empty profile".
      expect(res.body.data.preferredSpecialtyIds).toEqual([]);
      expect(res.body.data.notes).toBeNull();
    });

    it('upserts on repeated PATCH rather than failing on a duplicate key', async () => {
      const user = await seedUser(app, dataSource, '+989123000002');
      await request(app.getHttpServer())
        .patch('/api/v1/me/journey/profile')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ budgetMaxToman: 500000 })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/me/journey/profile')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ notes: 'پوست حساس دارم' })
        .expect(200);

      // A partial PATCH preserves the fields it did not mention.
      expect(res.body.data.budgetMaxToman).toBe(500000);
      expect(res.body.data.notes).toBe('پوست حساس دارم');
    });

    it('rejects a budget range whose max is below its min', async () => {
      const user = await seedUser(app, dataSource, '+989123000003');
      // Enforced by a CHECK constraint: an inverted range makes every
      // downstream price filter nonsense.
      await expect(
        journey.updateProfile(user.id, { budgetMinToman: 900_000, budgetMaxToman: 100_000 }),
      ).rejects.toThrow(/ck_beauty_profiles_budget_ordered/);
    });

    it('rejects notes longer than the 500-character product boundary', async () => {
      const user = await seedUser(app, dataSource, '+989123000004');
      await request(app.getHttpServer())
        .patch('/api/v1/me/journey/profile')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ notes: 'ا'.repeat(501) })
        .expect(400);
    });

    it('gives one customer no route to another customer profile', async () => {
      const a = await seedUser(app, dataSource, '+989123000005');
      const b = await seedUser(app, dataSource, '+989123000006');
      await journey.updateProfile(b.id, { notes: 'یادداشت خصوصی ب' });

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/journey/profile')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(200);

      // There is no parameter to tamper with: the profile's primary key IS
      // the user id, so "my profile" is the only addressable thing.
      expect(res.body.data.notes).toBeNull();
    });

    it('rejects an unauthenticated profile read', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/journey/profile').expect(401);
    });
  });

  describe('goals', () => {
    it('creates a goal and its timeline entry in ONE transaction', async () => {
      const user = await seedUser(app, dataSource, '+989123000007');
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/journey/goals')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ title: 'آماده شدن برای عروسی', budgetToman: 3_000_000 })
        .expect(201);

      const timeline = await dataSource.query(
        `SELECT entry_type, source_id FROM journey.timeline_entries WHERE user_id = $1`,
        [user.id],
      );
      // A goal that exists without its timeline entry would make the journey
      // view silently incomplete.
      expect(timeline).toHaveLength(1);
      expect(timeline[0].entry_type).toBe('goal_created');
      expect(timeline[0].source_id).toBe(res.body.data.id);
    });

    it('rejects a blank title at the database layer', async () => {
      const user = await seedUser(app, dataSource, '+989123000008');
      await expect(journey.createGoal(user.id, { title: '   ' })).rejects.toThrow(
        /ck_beauty_goals_title_not_blank/,
      );
    });

    it('DENIES updating another customer goal, indistinguishably from a nonexistent one', async () => {
      const a = await seedUser(app, dataSource, '+989123000009');
      const b = await seedUser(app, dataSource, '+989123000010');
      const bGoal = await journey.createGoal(b.id, { title: 'هدف ب' });

      const stranger = await request(app.getHttpServer())
        .patch(`/api/v1/me/journey/goals/${bGoal.id}`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ status: 'abandoned' })
        .expect(404);
      const nonexistent = await request(app.getHttpServer())
        .patch(`/api/v1/me/journey/goals/${uuidv7()}`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ status: 'abandoned' })
        .expect(404);

      expect(stranger.body).toEqual(nonexistent.body);

      // And B's goal is verifiably untouched -- the denial is real, not just a
      // 404 over a completed write.
      const row = await dataSource.query(`SELECT status FROM journey.beauty_goals WHERE id = $1`, [bGoal.id]);
      expect(row[0].status).toBe('active');
    });

    it('lists only the caller own goals', async () => {
      const a = await seedUser(app, dataSource, '+989123000011');
      const b = await seedUser(app, dataSource, '+989123000012');
      await journey.createGoal(a.id, { title: 'هدف الف' });
      await journey.createGoal(b.id, { title: 'هدف ب' });

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/journey/goals')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('هدف الف');
    });

    it('emits BeautyGoalCreated WITHOUT the customer-authored title', async () => {
      const user = await seedUser(app, dataSource, '+989123000013');
      await journey.createGoal(user.id, { title: 'آماده شدن برای عروسی خواهرم' });

      const rows = await dataSource.query(
        `SELECT payload FROM journey.outbox_events WHERE event_type = 'BeautyGoalCreated'`,
      );
      expect(rows).toHaveLength(1);
      // The goal's STRUCTURED intent travels; the customer's own words do not.
      expect(rows[0].payload).not.toHaveProperty('title');
      expect(JSON.stringify(rows[0].payload)).not.toContain('عروسی');
    });

    it('transitions a goal status with a compare-and-swap', async () => {
      const user = await seedUser(app, dataSource, '+989123000014');
      const goal = await journey.createGoal(user.id, { title: 'هدف' });

      await journey.updateGoalStatus(user.id, goal.id, 'achieved');
      const row = await dataSource.query(`SELECT status FROM journey.beauty_goals WHERE id = $1`, [goal.id]);
      expect(row[0].status).toBe('achieved');

      const events = await dataSource.query(
        `SELECT count(*)::int AS n FROM journey.outbox_events WHERE event_type = 'BeautyGoalStatusChanged'`,
      );
      expect(events[0].n).toBe(1);
    });

    it('emits nothing when the status is already what was asked for', async () => {
      const user = await seedUser(app, dataSource, '+989123000015');
      const goal = await journey.createGoal(user.id, { title: 'هدف' });
      await journey.updateGoalStatus(user.id, goal.id, 'active');

      const events = await dataSource.query(
        `SELECT count(*)::int AS n FROM journey.outbox_events WHERE event_type = 'BeautyGoalStatusChanged'`,
      );
      expect(events[0].n).toBe(0);
    });
  });

  describe('timeline', () => {
    it('is idempotent per (user, entryType, source) under redelivery', async () => {
      const user = await seedUser(app, dataSource, '+989123000016');
      const bookingId = uuidv7();
      const entry = {
        userId: user.id,
        entryType: 'booking_completed',
        sourceType: 'booking',
        sourceId: bookingId,
        occurredAt: new Date(),
      };

      expect(await journey.appendTimelineStandalone(entry)).toBe(true);
      // The outbox is at-least-once, so a redelivered BookingCompleted must
      // add nothing.
      expect(await journey.appendTimelineStandalone(entry)).toBe(false);

      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM journey.timeline_entries`);
      expect(rows[0].n).toBe(1);
    });

    it('allows SEVERAL entry types for one booking', async () => {
      const user = await seedUser(app, dataSource, '+989123000017');
      const bookingId = uuidv7();
      for (const entryType of ['booking_confirmed', 'booking_completed']) {
        await journey.appendTimelineStandalone({
          userId: user.id,
          entryType,
          sourceType: 'booking',
          sourceId: bookingId,
          occurredAt: new Date(),
        });
      }
      // One booking legitimately produces several entries over its life --
      // which is why entry_type is part of the uniqueness key.
      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM journey.timeline_entries`);
      expect(rows[0].n).toBe(2);
    });

    it('holds under CONCURRENT redelivery', async () => {
      const user = await seedUser(app, dataSource, '+989123000018');
      const bookingId = uuidv7();
      const entry = {
        userId: user.id,
        entryType: 'booking_completed',
        sourceType: 'booking',
        sourceId: bookingId,
        occurredAt: new Date(),
      };

      const results = await Promise.all(Array.from({ length: 5 }, () => journey.appendTimelineStandalone(entry)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('renders a Persian label from the stored machine key', async () => {
      const user = await seedUser(app, dataSource, '+989123000019');
      await journey.appendTimelineStandalone({
        userId: user.id,
        entryType: 'booking_completed',
        sourceType: 'booking',
        sourceId: uuidv7(),
        occurredAt: new Date(),
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/journey/timeline')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      // Storing the label would freeze today's copy into every historical row.
      expect(res.body.data.items[0].type).toBe('booking_completed');
      expect(res.body.data.items[0].label).toBe('خدمت انجام شد');
    });

    it('shows a customer only their OWN timeline', async () => {
      const a = await seedUser(app, dataSource, '+989123000020');
      const b = await seedUser(app, dataSource, '+989123000021');
      await journey.appendTimelineStandalone({
        userId: b.id,
        entryType: 'booking_completed',
        sourceType: 'booking',
        sourceId: uuidv7(),
        occurredAt: new Date(),
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/journey/timeline')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(200);
      expect(res.body.data.items).toHaveLength(0);
    });
  });

  describe('the AI context boundary', () => {
    it('NEVER includes the profile free-text notes', async () => {
      const user = await seedUser(app, dataSource, '+989123000022');
      await journey.updateProfile(user.id, {
        preferredCityId: uuidv7(),
        budgetMaxToman: 800_000,
        notes: 'من به مواد شیمیایی حساسیت دارم و سابقه بیماری پوستی دارم',
      });

      const aiContext = await context.inferAiDefaults(user.id);

      // The rule V2 got right and V3 makes structural: the return TYPE has no
      // free-text field, so including notes would require editing the
      // interface -- a visible, reviewable act rather than an accident.
      expect(JSON.stringify(aiContext)).not.toContain('حساسیت');
      expect(JSON.stringify(aiContext)).not.toContain('بیماری');
      expect(aiContext).not.toHaveProperty('notes');
      expect(Object.keys(aiContext).sort()).toEqual(['budgetToman', 'cityId']);
    });

    it('NEVER includes a goal title', async () => {
      const user = await seedUser(app, dataSource, '+989123000023');
      const specialtyId = uuidv7();
      await journey.createGoal(user.id, { title: 'عروسی خواهرم در شیراز', specialtyId, budgetToman: 2_000_000 });

      const aiContext = await context.inferAiDefaults(user.id);

      expect(aiContext.specialtyIds).toEqual([specialtyId]);
      expect(aiContext.budgetToman).toBe(2_000_000);
      expect(JSON.stringify(aiContext)).not.toContain('عروسی');
      expect(JSON.stringify(aiContext)).not.toContain('شیراز');
    });

    it('lets an ACTIVE goal override the standing profile', async () => {
      const user = await seedUser(app, dataSource, '+989123000024');
      const profileCity = uuidv7();
      const goalCity = uuidv7();
      await journey.updateProfile(user.id, { preferredCityId: profileCity, budgetMaxToman: 100_000 });
      await journey.createGoal(user.id, { title: 'هدف', cityId: goalCity, budgetToman: 900_000 });

      const aiContext = await context.inferAiDefaults(user.id);
      // A specific, current goal is a stronger statement of intent than a
      // standing preference.
      expect(aiContext.cityId).toBe(goalCity);
      expect(aiContext.budgetToman).toBe(900_000);
    });

    it('ignores an ACHIEVED goal', async () => {
      const user = await seedUser(app, dataSource, '+989123000025');
      const profileCity = uuidv7();
      await journey.updateProfile(user.id, { preferredCityId: profileCity });
      const goal = await journey.createGoal(user.id, { title: 'هدف', cityId: uuidv7() });
      await journey.updateGoalStatus(user.id, goal.id, 'achieved');

      const aiContext = await context.inferAiDefaults(user.id);
      expect(aiContext.cityId).toBe(profileCity);
    });

    it('is deterministic with several active goals', async () => {
      const user = await seedUser(app, dataSource, '+989123000026');
      const first = uuidv7();
      const second = uuidv7();
      await journey.createGoal(user.id, { title: 'اول', cityId: first });
      await journey.createGoal(user.id, { title: 'دوم', cityId: second });

      // Two identical requests must not produce different AI suggestions.
      const a = await context.inferAiDefaults(user.id);
      const b = await context.inferAiDefaults(user.id);
      expect(a).toEqual(b);
      expect(a.cityId).toBe(second);
    });

    it('returns an empty context for a customer with no journey at all', async () => {
      const user = await seedUser(app, dataSource, '+989123000027');
      expect(await context.inferAiDefaults(user.id)).toEqual({});
    });

    it('reads ONLY the given user data', async () => {
      const a = await seedUser(app, dataSource, '+989123000028');
      const b = await seedUser(app, dataSource, '+989123000029');
      await journey.updateProfile(b.id, { preferredCityId: uuidv7(), budgetMaxToman: 5_000_000 });

      // The provider takes an already-authenticated user id and has no
      // parameter that could widen the scope.
      expect(await context.inferAiDefaults(a.id)).toEqual({});
    });
  });

  describe('notes never leave the table', () => {
    it('keeps notes out of every journey event payload', async () => {
      const user = await seedUser(app, dataSource, '+989123000030');
      await journey.updateProfile(user.id, { notes: 'یادداشت کاملا خصوصی' });
      await journey.createGoal(user.id, { title: 'هدف' });

      const rows = await dataSource.query(`SELECT payload FROM journey.outbox_events`);
      for (const row of rows) {
        expect(JSON.stringify(row.payload)).not.toContain('خصوصی');
      }
    });

    it('keeps notes out of the timeline', async () => {
      const user = await seedUser(app, dataSource, '+989123000031');
      await journey.updateProfile(user.id, { notes: 'یادداشت کاملا خصوصی' });
      await journey.createGoal(user.id, { title: 'هدف' });

      const rows = await dataSource.query(`SELECT metadata FROM journey.timeline_entries`);
      for (const row of rows) {
        expect(JSON.stringify(row.metadata)).not.toContain('خصوصی');
      }
    });
  });
});
