import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { LOYALTY_REASONS, LoyaltyLedgerService, MembershipService } from '@beauclick/loyalty';
import {
  PgTestApp,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedUser,
} from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * Loyalty against real PostgreSQL.
 *
 * Everything here rests on a real unique index doing real work under real
 * concurrency, which is exactly the class of guarantee the fast pg-mem layer
 * cannot vouch for -- it does not honour ROLLBACK, so a "duplicate award was
 * rejected" assertion there would prove nothing.
 */
describePg('loyalty — idempotency, tiers, membership (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let ledger: LoyaltyLedgerService;
  let memberships: MembershipService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    ledger = app.get(LoyaltyLedgerService);
    memberships = app.get(MembershipService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const seedTier = async (slug: string, threshold: number): Promise<string> => {
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO loyalty.tiers (id, slug, name, threshold_points, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $4, true)`,
      [id, slug, slug, threshold],
    );
    return id;
  };

  const seedPlan = async (slug: string, tierId: string | null, isPaid = false): Promise<string> => {
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO loyalty.membership_plans (id, slug, name, tier_id, is_paid, price_toman, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, true, 0)`,
      [id, slug, slug, tierId, isPaid, isPaid ? 500_000 : null],
    );
    return id;
  };

  describe('award idempotency', () => {
    it('awards once and only once for the same (reference, reason)', async () => {
      const user = await seedUser(app, dataSource, '+989120000101');
      const bookingId = uuidv7();

      const first = await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: bookingId,
      });
      const second = await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: bookingId,
      });

      expect(first.awarded).toBe(true);
      expect(first.points).toBe(10);
      // Not an error -- a redelivered event is the expected steady state of an
      // at-least-once outbox.
      expect(second.awarded).toBe(false);

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM loyalty.points_entries WHERE user_id = $1`,
        [user.id],
      );
      expect(rows[0].n).toBe(1);
      expect(await ledger.lifetimeEarned(user.id)).toBe(10);
    });

    it('holds under genuinely CONCURRENT duplicate awards', async () => {
      const user = await seedUser(app, dataSource, '+989120000102');
      const bookingId = uuidv7();

      // Fired simultaneously through separate pooled connections. A sequential
      // pair proves nothing about the index -- it would pass against an
      // implementation whose only guard was a preceding SELECT.
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          ledger.award({
            userId: user.id,
            reason: LOYALTY_REASONS.bookingCompleted,
            referenceType: 'booking',
            referenceId: bookingId,
          }),
        ),
      );

      expect(results.filter((r) => r.awarded)).toHaveLength(1);

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM loyalty.points_entries WHERE reference_id = $1`,
        [bookingId],
      );
      expect(rows[0].n).toBe(1);
    });

    it('treats a different REASON on the same reference as a separate award', async () => {
      const user = await seedUser(app, dataSource, '+989120000103');
      const reference = uuidv7();

      const a = await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: reference,
      });
      const b = await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.reviewSubmitted,
        referenceType: 'booking',
        referenceId: reference,
      });

      // The reason is part of the key: completing a booking and reviewing it
      // are two distinct earning events about the same booking.
      expect(a.awarded).toBe(true);
      expect(b.awarded).toBe(true);
      expect(await ledger.lifetimeEarned(user.id)).toBe(15);
    });

    it('never blocks reference-less manual adjustments', async () => {
      const user = await seedUser(app, dataSource, '+989120000104');
      // The partial index only covers rows WITH a reference, so two manual
      // adjustments are both legal. In V2 this worked only because MySQL
      // treats each NULL as distinct -- here it is stated explicitly.
      await dataSource.query(
        `INSERT INTO loyalty.points_entries (id, user_id, points, base_points, reason) VALUES ($1, $2, 50, 50, 'manual_adjustment')`,
        [uuidv7(), user.id],
      );
      await dataSource.query(
        `INSERT INTO loyalty.points_entries (id, user_id, points, base_points, reason) VALUES ($1, $2, 25, 25, 'manual_adjustment')`,
        [uuidv7(), user.id],
      );
      expect(await ledger.lifetimeEarned(user.id)).toBe(75);
    });
  });

  describe('balance vs lifetime earned', () => {
    it('lets a redemption reduce the balance WITHOUT reducing lifetime earned', async () => {
      const user = await seedUser(app, dataSource, '+989120000105');
      await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: uuidv7(),
      });
      await dataSource.query(
        `INSERT INTO loyalty.points_entries (id, user_id, points, base_points, reason) VALUES ($1, $2, -4, -4, 'manual_adjustment')`,
        [uuidv7(), user.id],
      );

      // The rule that makes the tier model coherent: spending points must
      // never demote a customer. "How much have you earned" and "how much can
      // you still spend" are different questions.
      expect(await ledger.balance(user.id)).toBe(6);
      expect(await ledger.lifetimeEarned(user.id)).toBe(10);
    });
  });

  describe('tier crossings', () => {
    it('records each real crossing once, and records nothing for an award that crosses nothing', async () => {
      // Bronze at 5, not 0. A tier whose threshold is 0 is one every customer
      // already holds from signup, so there is no transition into it and
      // nothing to record -- correct, but it would make this case prove
      // nothing about crossings.
      await seedTier('bronze', 5);
      await seedTier('silver', 20);
      const user = await seedUser(app, dataSource, '+989120000106');

      for (let i = 0; i < 3; i += 1) {
        await ledger.award({
          userId: user.id,
          reason: LOYALTY_REASONS.bookingCompleted,
          referenceType: 'booking',
          referenceId: uuidv7(),
        });
      }
      const rows = await dataSource.query(
        `SELECT from_tier_slug, to_tier_slug, lifetime_earned FROM loyalty.tier_crossings WHERE user_id = $1 ORDER BY lifetime_earned`,
        [user.id],
      );

      // Two crossings from three awards: none->bronze at 10, bronze->silver at
      // 20. The third award lands at 30 and crosses nothing, so it records
      // nothing -- the tier itself is still never stored, only its changes.
      expect(rows.map((r: { to_tier_slug: string }) => r.to_tier_slug)).toEqual(['bronze', 'silver']);
      expect(rows.map((r: { from_tier_slug: string | null }) => r.from_tier_slug)).toEqual([null, 'bronze']);
      expect(rows.map((r: { lifetime_earned: number }) => r.lifetime_earned)).toEqual([10, 20]);

      // One LoyaltyTierChanged per real crossing, not per award.
      const events = await dataSource.query(
        `SELECT count(*)::int AS n FROM loyalty.outbox_events WHERE event_type = 'LoyaltyTierChanged'`,
      );
      expect(events[0].n).toBe(2);
    });

    it('does not re-record a crossing when the same total is reached again', async () => {
      await seedTier('silver', 10);
      const user = await seedUser(app, dataSource, '+989120000107');
      const reference = uuidv7();

      await ledger.award({ userId: user.id, reason: LOYALTY_REASONS.bookingCompleted, referenceType: 'booking', referenceId: reference });
      await ledger.award({ userId: user.id, reason: LOYALTY_REASONS.bookingCompleted, referenceType: 'booking', referenceId: reference });

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM loyalty.tier_crossings WHERE user_id = $1`,
        [user.id],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('membership', () => {
    it('auto-activates the plan linked to a newly-qualified tier', async () => {
      const silverId = await seedTier('silver', 10);
      const planId = await seedPlan('silver-plan', silverId);
      const user = await seedUser(app, dataSource, '+989120000108');

      const result = await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: uuidv7(),
      });
      await memberships.syncFromTier(user.id, result.lifetimeEarned);

      const membership = await memberships.forUser(user.id);
      expect(membership?.membership.planId).toBe(planId);
      expect(membership?.membership.activationSource).toBe('tier_qualification');
    });

    it('NEVER overwrites a membership granted from a different source', async () => {
      const silverId = await seedTier('silver', 10);
      await seedPlan('silver-plan', silverId);
      const paidPlanId = await seedPlan('vip', null, true);
      const user = await seedUser(app, dataSource, '+989120000109');

      // The customer is paying for VIP. Crossing a points threshold must not
      // silently replace a commercial commitment this system did not make.
      await memberships.activate(user.id, paidPlanId, 'manual');

      const result = await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: uuidv7(),
      });
      const sync = await memberships.syncFromTier(user.id, result.lifetimeEarned);

      expect(sync.activated).toBe(false);
      const membership = await memberships.forUser(user.id);
      expect(membership?.membership.planId).toBe(paidPlanId);
      expect(membership?.membership.activationSource).toBe('manual');
    });

    it('is a no-op when the customer already holds exactly that plan', async () => {
      const silverId = await seedTier('silver', 10);
      const planId = await seedPlan('silver-plan', silverId);
      const user = await seedUser(app, dataSource, '+989120000110');

      await memberships.activate(user.id, planId, 'tier_qualification');
      const again = await memberships.activate(user.id, planId, 'tier_qualification');

      // No second MembershipActivated, so no second welcome notification.
      expect(again.changed).toBe(false);
      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM loyalty.outbox_events WHERE event_type = 'MembershipActivated'`,
      );
      expect(rows[0].n).toBe(1);
    });

    it('keeps one membership row per user under concurrent activation', async () => {
      const planId = await seedPlan('solo', null);
      const user = await seedUser(app, dataSource, '+989120000111');

      await Promise.all(
        Array.from({ length: 4 }, () => memberships.activate(user.id, planId, 'manual').catch(() => null)),
      );

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM loyalty.memberships WHERE user_id = $1`,
        [user.id],
      );
      expect(rows[0].n).toBe(1);
    });

    it('expires a due membership exactly once', async () => {
      const planId = await seedPlan('timed', null);
      const user = await seedUser(app, dataSource, '+989120000112');
      await memberships.activate(user.id, planId, 'manual');
      await dataSource.query(`UPDATE loyalty.memberships SET expires_at = now() - interval '1 day' WHERE user_id = $1`, [
        user.id,
      ]);

      expect(await memberships.expireDue()).toBe(1);
      // A second sweep finds no active row and emits nothing.
      expect(await memberships.expireDue()).toBe(0);

      const rows = await dataSource.query(
        `SELECT count(*)::int AS n FROM loyalty.outbox_events WHERE event_type = 'MembershipEnded'`,
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('benefit multiplier is captured at award time', () => {
    it('records the multiplier used, so a later benefit change cannot rewrite history', async () => {
      const tierId = await seedTier('gold', 0);
      await dataSource.query(
        `INSERT INTO loyalty.benefits (id, source_type, source_id, benefit_type, label, config, is_active, sort_order)
         VALUES ($1, 'tier', $2, 'bonus_points_multiplier', 'x2', '{"multiplierBp": 20000}'::jsonb, true, 0)`,
        [uuidv7(), tierId],
      );
      const user = await seedUser(app, dataSource, '+989120000113');

      const result = await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: uuidv7(),
      });
      expect(result.points).toBe(20);

      // Change the benefit AFTER the award.
      await dataSource.query(`UPDATE loyalty.benefits SET config = '{"multiplierBp": 30000}'::jsonb`);

      const row = await dataSource.query(
        `SELECT points, base_points, multiplier_bp FROM loyalty.points_entries WHERE user_id = $1`,
        [user.id],
      );
      // Same discipline as financial capturing the commission rate per ledger
      // row: what a past award was worth must not move.
      expect(row[0].points).toBe(20);
      expect(row[0].base_points).toBe(10);
      expect(row[0].multiplier_bp).toBe(20000);
    });
  });

  describe('API surface', () => {
    it('serves the caller their OWN summary with no user parameter anywhere', async () => {
      await seedTier('bronze', 0);
      const user = await seedUser(app, dataSource, '+989120000114');
      await ledger.award({
        userId: user.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: uuidv7(),
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/loyalty/summary')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expect(res.body.data.lifetimeEarned).toBe(10);
      expect(res.body.data.tier.slug).toBe('bronze');
    });

    it('refuses self-activation of a PAID plan', async () => {
      const paidPlanId = await seedPlan('vip', null, true);
      const user = await seedUser(app, dataSource, '+989120000115');

      const res = await request(app.getHttpServer())
        .post('/api/v1/me/loyalty/membership')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ planId: paidPlanId })
        .expect(200);

      // Self-granting a paid entitlement with no order, no payment, and no
      // ledger entry would be a real money hole.
      expect(res.body.data.activated).toBe(false);
      const rows = await dataSource.query(`SELECT count(*)::int AS n FROM loyalty.memberships`);
      expect(rows[0].n).toBe(0);
    });

    it('rejects an unauthenticated loyalty read', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/loyalty/summary').expect(401);
    });

    it('gives one customer no way to read another customer balance', async () => {
      const a = await seedUser(app, dataSource, '+989120000116');
      const b = await seedUser(app, dataSource, '+989120000117');
      await ledger.award({
        userId: b.id,
        reason: LOYALTY_REASONS.bookingCompleted,
        referenceType: 'booking',
        referenceId: uuidv7(),
      });

      // There is no parameter to tamper with -- the route takes none. A is
      // asserted to see their OWN (empty) state, which is the only thing the
      // route can express.
      const res = await request(app.getHttpServer())
        .get('/api/v1/me/loyalty/summary')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(200);
      expect(res.body.data.lifetimeEarned).toBe(0);
    });
  });

  describe('policy transparency', () => {
    it('reports which loyalty values are still V2 placeholders', async () => {
      const admin = await seedUser(app, dataSource, '+989120000118', ['administrator']);
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/loyalty/policy')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);

      // GAP-10's real risk is a placeholder quietly becoming policy because
      // nobody was reminded it was one. Here the running system says so.
      expect(Array.isArray(res.body.data.unresolvedBusinessDecisions)).toBe(true);
      expect(res.body.data.tierQualificationBasis).toBe('lifetime');
    });

    it('denies the policy route to a non-admin', async () => {
      const customer = await seedUser(app, dataSource, '+989120000119');
      await request(app.getHttpServer())
        .get('/api/v1/admin/loyalty/policy')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .expect(403);
    });
  });
});
