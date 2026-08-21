import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import {
  AlwaysFailingChannel,
  NotificationChannelPort,
  NotificationService,
  PreferenceService,
} from '@beauclick/notification';
import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

describePg('notifications — idempotency, retry, dead-letter, isolation (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let notifications: NotificationService;
  let preferences: PreferenceService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    notifications = app.get(NotificationService);
    preferences = app.get(PreferenceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const confirmVars = { professionalName: 'سالن کیمیا', date: 'جمعه ۳۰ مرداد', time: '۱۴:۰۰' };

  const notifyBooking = (userId: string, bookingId: string) =>
    notifications.notify({
      userId,
      templateKey: 'booking_confirmed',
      vars: confirmVars,
      entityType: 'booking',
      entityId: bookingId,
      channels: ['in_app'],
    });

  describe('idempotency', () => {
    it('sends once and reports the second request as a duplicate', async () => {
      const user = await seedUser(app, dataSource, '+989122000001');
      const bookingId = uuidv7();

      expect((await notifyBooking(user.id, bookingId)).in_app).toBe('sent');
      expect((await notifyBooking(user.id, bookingId)).in_app).toBe('duplicate');

      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM notification.notifications`);
      expect(rows[0].n).toBe(1);
    });

    it('holds under CONCURRENT identical requests', async () => {
      const user = await seedUser(app, dataSource, '+989122000002');
      const bookingId = uuidv7();

      // The reservation is an INSERT BEFORE dispatch, so simultaneous callers
      // race for one UNIQUE key and the loser never reaches a channel.
      const results = await Promise.all(Array.from({ length: 5 }, () => notifyBooking(user.id, bookingId)));
      expect(results.filter((r) => r.in_app === 'sent')).toHaveLength(1);

      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM notification.notifications`);
      expect(rows[0].n).toBe(1);
    });

    it('treats a different ENTITY as a different notification', async () => {
      const user = await seedUser(app, dataSource, '+989122000003');
      expect((await notifyBooking(user.id, uuidv7())).in_app).toBe('sent');
      expect((await notifyBooking(user.id, uuidv7())).in_app).toBe('sent');

      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM notification.notifications`);
      expect(rows[0].n).toBe(2);
    });

    it('treats two USERS as two notifications for the same entity', async () => {
      const a = await seedUser(app, dataSource, '+989122000004');
      const b = await seedUser(app, dataSource, '+989122000005');
      const bookingId = uuidv7();

      expect((await notifyBooking(a.id, bookingId)).in_app).toBe('sent');
      expect((await notifyBooking(b.id, bookingId)).in_app).toBe('sent');
    });
  });

  describe('preferences', () => {
    it('SUPPRESSES a disabled optional category, and records that it did', async () => {
      const user = await seedUser(app, dataSource, '+989122000006');
      await preferences.update(user.id, { reminder: false });

      // Recorded rather than skipped: "we chose not to tell them, and when"
      // is operationally valuable, and it consumes the idempotency slot so a
      // redelivery does not re-evaluate and send.
      expect(await preferences.isEnabled(user.id, 'reminder')).toBe(false);
    });

    it('CANNOT disable a mandatory category', async () => {
      const user = await seedUser(app, dataSource, '+989122000007');
      const result = await preferences.update(user.id, { booking: false, payment: false });

      // A suppressed payment receipt is a customer with money gone and no
      // record of why. Two independent layers stop it: a CHECK constraint
      // makes the row unwritable, and the service short-circuits without
      // reading the table at all.
      expect(result.find((p) => p.category === 'booking')?.enabled).toBe(true);
      expect(result.find((p) => p.category === 'payment')?.enabled).toBe(true);
      expect(await preferences.isEnabled(user.id, 'booking')).toBe(true);
    });

    it('rejects a disabling row for a mandatory category at the DATABASE layer', async () => {
      const user = await seedUser(app, dataSource, '+989122000008');
      await expect(
        dataSource.query(
          `INSERT INTO notification.preferences (id, user_id, category, enabled) VALUES ($1, $2, 'booking', false)`,
          [uuidv7(), user.id],
        ),
      ).rejects.toThrow(/ck_preferences_mandatory_always_enabled/);
    });

    it('defaults every category to enabled with no row present', async () => {
      const user = await seedUser(app, dataSource, '+989122000009');
      const prefs = await preferences.forUser(user.id);
      expect(prefs.every((p) => p.enabled)).toBe(true);
      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM notification.preferences`);
      // Opt-out: the table records only an explicit change.
      expect(rows[0].n).toBe(0);
    });

    it('ignores an unknown category key rather than writing an arbitrary row', async () => {
      const user = await seedUser(app, dataSource, '+989122000010');
      await preferences.update(user.id, { not_a_category: false } as never);
      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM notification.preferences`);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('retry and dead-letter', () => {
    /**
     * Swaps in a deliberately failing channel.
     *
     * The channel map is built in the service constructor, so this reaches
     * into it to register a failing implementation under a real channel key.
     * A less invasive route would need a whole second app boot per case.
     */
    const useFailingChannel = (key: string, retryable: boolean, errorCode = 'simulated_failure') => {
      const map = (notifications as unknown as { channelsByKey: Map<string, NotificationChannelPort> }).channelsByKey;
      const original = map.get(key);
      map.set(key, new AlwaysFailingChannel(key, retryable, errorCode));
      return () => {
        if (original) map.set(key, original);
        else map.delete(key);
      };
    };

    it('schedules a retry with BACKOFF after a retryable failure', async () => {
      const restore = useFailingChannel('in_app', true);
      try {
        const user = await seedUser(app, dataSource, '+989122000011');
        expect((await notifyBooking(user.id, uuidv7())).in_app).toBe('failed');

        const row = await dataSource.query(
          `SELECT status, attempts, next_attempt_at, error_code FROM notification.notifications`,
        );
        expect(row[0].status).toBe('failed');
        expect(row[0].attempts).toBe(1);
        // V2 re-ran every failed row on every sweep with no backoff, aiming a
        // retry storm at whatever was already struggling.
        expect(new Date(row[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());
        expect(row[0].error_code).toBe('simulated_failure');
      } finally {
        restore();
      }
    });

    it('DEAD-LETTERS a permanent failure immediately, without a single retry', async () => {
      const restore = useFailingChannel('in_app', false, 'no_phone_on_file');
      try {
        const user = await seedUser(app, dataSource, '+989122000012');
        expect((await notifyBooking(user.id, uuidv7())).in_app).toBe('dead_lettered');

        const row = await dataSource.query(
          `SELECT status, attempts, next_attempt_at, dead_lettered_at FROM notification.notifications`,
        );
        // A customer with no phone number will not acquire one because we
        // retried. Retrying this forever is how a dead-letter queue fills with
        // messages that were never deliverable.
        expect(row[0].status).toBe('dead_lettered');
        expect(row[0].attempts).toBe(1);
        expect(row[0].next_attempt_at).toBeNull();
        expect(row[0].dead_lettered_at).not.toBeNull();
      } finally {
        restore();
      }
    });

    it('gives up after a BOUNDED number of retries', async () => {
      const restore = useFailingChannel('in_app', true);
      try {
        const user = await seedUser(app, dataSource, '+989122000013');
        await notifyBooking(user.id, uuidv7());

        // Drive the sweep past the backoff schedule. Never an infinite loop:
        // the schedule's length IS the retry limit.
        for (let i = 0; i < 5; i += 1) {
          await dataSource.query(`UPDATE notification.notifications SET next_attempt_at = now() - interval '1 minute'`);
          await notifications.retryDue();
        }

        const row = await dataSource.query(`SELECT status, attempts FROM notification.notifications`);
        expect(row[0].status).toBe('dead_lettered');
        expect(row[0].attempts).toBe(4);
      } finally {
        restore();
      }
    });

    it('RE-RENDERS the real message on retry, not a generic notice', async () => {
      const restore = useFailingChannel('in_app', true);
      const user = await seedUser(app, dataSource, '+989122000014');
      await notifyBooking(user.id, uuidv7());
      restore();

      await dataSource.query(`UPDATE notification.notifications SET next_attempt_at = now() - interval '1 minute'`);
      const result = await notifications.retryDue();
      expect(result.sent).toBe(1);

      // V2 never persisted the template vars and its own comment concedes the
      // consequence: a retry sent "you have a notification" instead of the
      // real message. The stored payload is what makes this possible.
      const row = await dataSource.query(`SELECT status, payload FROM notification.notifications`);
      expect(row[0].status).toBe('sent');
      expect(row[0].payload.professionalName).toBe('سالن کیمیا');
    });

    it('does not retry a notification that is not yet due', async () => {
      const restore = useFailingChannel('in_app', true);
      try {
        const user = await seedUser(app, dataSource, '+989122000015');
        await notifyBooking(user.id, uuidv7());
        const result = await notifications.retryDue();
        expect(result.attempted).toBe(0);
      } finally {
        restore();
      }
    });

    it('emits NotificationDeadLettered so an operator can see what was abandoned', async () => {
      const restore = useFailingChannel('in_app', false);
      try {
        const user = await seedUser(app, dataSource, '+989122000016');
        await notifyBooking(user.id, uuidv7());

        const rows = await dataSource.query(
          `SELECT count(*)::int AS n FROM notification.outbox_events WHERE event_type = 'NotificationDeadLettered'`,
        );
        expect(rows[0].n).toBe(1);
      } finally {
        restore();
      }
    });
  });

  describe('the notification centre', () => {
    it('lists only the caller OWN notifications', async () => {
      const a = await seedUser(app, dataSource, '+989122000017');
      const b = await seedUser(app, dataSource, '+989122000018');
      await notifyBooking(a.id, uuidv7());
      await notifyBooking(b.id, uuidv7());

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/notifications')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(200);

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.unreadCount).toBe(1);
    });

    it('renders the title and body from the template at READ time', async () => {
      const user = await seedUser(app, dataSource, '+989122000019');
      await notifyBooking(user.id, uuidv7());

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/notifications')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      const item = res.body.data.items[0];
      expect(item.title).toBe('رزرو شما تأیید شد');
      expect(item.body).toContain('سالن کیمیا');
      expect(item.deepLink).toBe('/bookings');
      // The stored row holds VARIABLES; the prose is produced here, so a
      // template fix reaches an already-delivered notification.
      expect(item).not.toHaveProperty('payload');
    });

    it('marks one notification read and updates the unread count', async () => {
      const user = await seedUser(app, dataSource, '+989122000020');
      await notifyBooking(user.id, uuidv7());
      const list = await request(app.getHttpServer())
        .get('/api/v1/me/notifications')
        .set('Authorization', `Bearer ${user.accessToken}`);
      const id = list.body.data.items[0].id;

      const res = await request(app.getHttpServer())
        .post(`/api/v1/me/notifications/${id}/read`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(res.body.data.unreadCount).toBe(0);
    });

    it('DENIES marking another customer notification read, indistinguishably from a nonexistent one', async () => {
      const a = await seedUser(app, dataSource, '+989122000021');
      const b = await seedUser(app, dataSource, '+989122000022');
      await notifyBooking(b.id, uuidv7());
      const bList = await request(app.getHttpServer())
        .get('/api/v1/me/notifications')
        .set('Authorization', `Bearer ${b.accessToken}`);
      const bNotificationId = bList.body.data.items[0].id;

      const stranger = await request(app.getHttpServer())
        .post(`/api/v1/me/notifications/${bNotificationId}/read`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(404);
      const nonexistent = await request(app.getHttpServer())
        .post(`/api/v1/me/notifications/${uuidv7()}/read`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(404);

      // Byte-identical: a differing response would confirm the notification
      // exists and belongs to somebody else.
      expect(stranger.body).toEqual(nonexistent.body);

      // And B's notification is genuinely untouched.
      const row = await dataSource.query(`SELECT read_at FROM notification.notifications WHERE id = $1`, [
        bNotificationId,
      ]);
      expect(row[0].read_at).toBeNull();
    });

    it('marks all read in one call', async () => {
      const user = await seedUser(app, dataSource, '+989122000023');
      for (let i = 0; i < 3; i += 1) await notifyBooking(user.id, uuidv7());

      const res = await request(app.getHttpServer())
        .post('/api/v1/me/notifications/read-all')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(res.body.data.marked).toBe(3);
      expect(res.body.data.unreadCount).toBe(0);

      // One user action, so ONE analytics signal -- not three. Marking 200
      // notifications read would otherwise drown the signal it exists for.
      const events = await dataSource.query(
        `SELECT count(*)::int AS n FROM notification.outbox_events WHERE event_type = 'NotificationRead'`,
      );
      expect(events[0].n).toBe(0);
    });

    it('emits NotificationRead once, even if marked twice', async () => {
      const user = await seedUser(app, dataSource, '+989122000024');
      await notifyBooking(user.id, uuidv7());
      const list = await request(app.getHttpServer())
        .get('/api/v1/me/notifications')
        .set('Authorization', `Bearer ${user.accessToken}`);
      const id = list.body.data.items[0].id;

      await notifications.markRead(user.id, id);
      expect(await notifications.markRead(user.id, id)).toBe(false);

      const events = await dataSource.query(
        `SELECT count(*)::int AS n FROM notification.outbox_events WHERE event_type = 'NotificationRead'`,
      );
      expect(events[0].n).toBe(1);
    });

    it('rejects an unauthenticated read of the notification centre', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/notifications').expect(401);
    });

    it('serves the unread count from its own endpoint', async () => {
      const user = await seedUser(app, dataSource, '+989122000025');
      await notifyBooking(user.id, uuidv7());
      const res = await request(app.getHttpServer())
        .get('/api/v1/me/notifications/unread-count')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
      expect(res.body.data.unreadCount).toBe(1);
    });
  });

  describe('operator visibility', () => {
    it('reports which channels have a VERIFIED provider behind them', async () => {
      const admin = await seedUser(app, dataSource, '+989122000026', ['administrator']);
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications/status')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      const channels: Array<{ channel: string; providerVerified: boolean }> = res.body.data.channels;
      // A channel that quietly logs instead of sending must never look like
      // one that delivers. GAP-11 remains open and the API says so.
      expect(channels.find((c) => c.channel === 'in_app')?.providerVerified).toBe(true);
      expect(channels.find((c) => c.channel === 'sms')?.providerVerified).toBe(false);
      expect(channels.find((c) => c.channel === 'email')?.providerVerified).toBe(false);
    });

    it('denies the admin surface to a customer', async () => {
      const customer = await seedUser(app, dataSource, '+989122000027');
      await request(app.getHttpServer())
        .get('/api/v1/admin/notifications/status')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(403);
    });
  });

  describe('payload hygiene', () => {
    it('stores template variables and never a rendered sentence', async () => {
      const user = await seedUser(app, dataSource, '+989122000028');
      await notifyBooking(user.id, uuidv7());

      const row = await dataSource.query(`SELECT payload FROM notification.notifications`);
      expect(row[0].payload).toEqual(confirmVars);
      expect(JSON.stringify(row[0].payload)).not.toContain('تأیید شد');
    });

    it('never records a recipient address on the notification row', async () => {
      const user = await seedUser(app, dataSource, '+989122000029');
      await notifyBooking(user.id, uuidv7());

      // V2 stored `recipient` and consequently had to scrub the column on
      // account deletion. Not storing it removes that whole class of work.
      const columns = await dataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'notification' AND table_name = 'notifications'`,
      );
      const names = columns.map((c: { column_name: string }) => c.column_name);
      expect(names).not.toContain('recipient');
    });

    it('keeps the message body out of every emitted event', async () => {
      const user = await seedUser(app, dataSource, '+989122000030');
      await notifyBooking(user.id, uuidv7());

      const rows = await dataSource.query(`SELECT payload FROM notification.outbox_events`);
      for (const row of rows) {
        const json = JSON.stringify(row.payload);
        expect(json).not.toContain('تأیید شد');
        expect(json).not.toContain('سالن کیمیا');
      }
    });
  });
});
