import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  evaluateCoverage,
} from '@beauclick/subject-data';
import { WISHLIST_MAX_SAVED_ITEMS, WISHLIST_TARGET_TYPES } from '@beauclick/wishlist-contract';
import { WishlistService, WishlistSubjectDataContract } from '@beauclick/wishlist';

import {
  PgTestApp,
  SeededProfessional,
  SeededUser,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * The wishlist, proved against real PostgreSQL (V3.2-C Story #8, ADR-033).
 *
 * Everything that matters about this module is a database guarantee — the
 * unique constraint that makes duplicate saving unrepresentable, the advisory
 * lock that makes the cap hold under concurrency, the transaction the erasure
 * runs in, and the boot-time coverage assertion. pg-mem honours none of them
 * (it does not even honour ROLLBACK), so they are proved here or nowhere.
 */
describePg('wishlist — persistence, ownership, cap, tombstones, privacy (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let wishlist: WishlistService;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    wishlist = app.get(WishlistService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const http = () => request(app.getHttpServer());

  const save = (user: SeededUser, targetType: string, targetId: string) =>
    http()
      .post('/api/v1/me/wishlist/items')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ targetType, targetId });

  const list = (user: SeededUser, query = '') =>
    http()
      .get(`/api/v1/me/wishlist/items${query}`)
      .set('Authorization', `Bearer ${user.accessToken}`);

  const remove = (user: SeededUser, targetType: string, targetId: string) =>
    http()
      .delete(`/api/v1/me/wishlist/items/${targetType}/${targetId}`)
      .set('Authorization', `Bearer ${user.accessToken}`);

  /** A professional owned by a throwaway account, so the customer under test is never the owner. */
  async function seedTarget(seq: number): Promise<SeededProfessional> {
    const owner = await seedUser(app, dataSource, `+9891280${String(seq).padStart(5, '0')}`, ['professional']);
    return seedProfessional(dataSource, owner.id, `متخصص ${seq}`);
  }

  // -------------------------------------------------------------------------
  // Add: idempotent by constraint, not by branch
  // -------------------------------------------------------------------------

  describe('saving', () => {
    it('saves a professional and returns the item', async () => {
      const user = await seedUser(app, dataSource, '+989128100001');
      const pro = await seedTarget(1);

      const res = await save(user, 'professional', pro.id).expect(200);

      expect(res.body.data.targetType).toBe('professional');
      expect(res.body.data.targetId).toBe(pro.id);
      expect(typeof res.body.data.savedAt).toBe('string');
    });

    it('saves a service offering', async () => {
      const user = await seedUser(app, dataSource, '+989128100002');
      const pro = await seedTarget(2);

      const res = await save(user, 'service', pro.serviceId).expect(200);
      expect(res.body.data.targetId).toBe(pro.serviceId);
    });

    it('is idempotent: saving twice writes ONE row and answers identically', async () => {
      const user = await seedUser(app, dataSource, '+989128100003');
      const pro = await seedTarget(3);

      const first = await save(user, 'professional', pro.id).expect(200);
      const second = await save(user, 'professional', pro.id).expect(200);

      // Same status, same body -- a caller cannot tell a first save from a
      // repeat, which is correct because it is their own list either way.
      expect(second.body.data).toEqual(first.body.data);

      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int AS count FROM wishlist.saved_items WHERE user_id = $1',
        [user.id],
      );
      expect(count).toBe(1);
    });

    it('makes a duplicate UNWRITABLE at the database, independently of the service', async () => {
      // The service's early-return is a convenience. The guarantee is the index,
      // and this proves it by going around the service entirely -- the same
      // reasoning `loyalty`'s idempotency suite records.
      const user = await seedUser(app, dataSource, '+989128100004');
      const pro = await seedTarget(4);
      await save(user, 'professional', pro.id).expect(200);

      await expect(
        dataSource.query(
          `INSERT INTO wishlist.saved_items (id, user_id, target_type, target_id) VALUES ($1, $2, 'professional', $3)`,
          [uuidv7(), user.id, pro.id],
        ),
      ).rejects.toThrow(/uq_wishlist_saved_items_user_target|duplicate key/i);
    });

    it('lets two different customers save the same target', async () => {
      const a = await seedUser(app, dataSource, '+989128100005');
      const b = await seedUser(app, dataSource, '+989128100006');
      const pro = await seedTarget(5);

      await save(a, 'professional', pro.id).expect(200);
      await save(b, 'professional', pro.id).expect(200);

      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int AS count FROM wishlist.saved_items WHERE target_id = $1',
        [pro.id],
      );
      expect(count).toBe(2);
    });

    it('two concurrent first-saves of the same target produce exactly one row', async () => {
      // The race the early-return read cannot close: both requests pass it. The
      // unique index is what makes the outcome one row, and `insertOnce` is what
      // stops the loser reporting a fresh write.
      const user = await seedUser(app, dataSource, '+989128100007');
      const pro = await seedTarget(6);

      const results = await Promise.all([
        save(user, 'professional', pro.id),
        save(user, 'professional', pro.id),
        save(user, 'professional', pro.id),
      ]);

      for (const res of results) expect(res.status).toBe(200);
      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int AS count FROM wishlist.saved_items WHERE user_id = $1',
        [user.id],
      );
      expect(count).toBe(1);
    });

    it('refuses a target type outside the closed vocabulary', async () => {
      const user = await seedUser(app, dataSource, '+989128100008');
      // `business` and `portfolio` are refused by `V32-DEC-020`. The validation
      // pipe rejects them before any query runs.
      for (const bad of ['business', 'portfolio', 'PROFESSIONAL', '']) {
        await save(user, bad, uuidv7()).expect(400);
      }
      expect([...WISHLIST_TARGET_TYPES]).toEqual(['professional', 'service']);
    });

    it('refuses a target id that is not a UUID', async () => {
      const user = await seedUser(app, dataSource, '+989128100009');
      await save(user, 'professional', 'not-a-uuid').expect(400);
    });

    it('rejects an unauthenticated caller', async () => {
      await http()
        .post('/api/v1/me/wishlist/items')
        .send({ targetType: 'professional', targetId: uuidv7() })
        .expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // Indistinguishability — the security property
  // -------------------------------------------------------------------------

  describe('missing, foreign and inaccessible targets are indistinguishable', () => {
    /** Every refusal below must be byte-identical to this one. */
    async function refusalFor(user: SeededUser, targetType: string, targetId: string) {
      const res = await save(user, targetType, targetId).expect(404);
      return res.body;
    }

    it('answers identically for nonexistent, deleted, suspended and revoked targets', async () => {
      const user = await seedUser(app, dataSource, '+989128110001');

      const nonexistent = await refusalFor(user, 'professional', uuidv7());

      const deleted = await seedTarget(11);
      await dataSource.query('UPDATE provider.professionals SET deleted_at = now() WHERE id = $1', [deleted.id]);

      const suspended = await seedTarget(12);
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [
        suspended.id,
      ]);

      const revoked = await seedTarget(13);
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'revoked' WHERE id = $1", [
        revoked.id,
      ]);

      const bodies = [
        await refusalFor(user, 'professional', deleted.id),
        await refusalFor(user, 'professional', suspended.id),
        await refusalFor(user, 'professional', revoked.id),
      ];

      // One code, one message, no `reason`, no status, no discriminator of any
      // kind. Anything else is a moderation-and-verification feed for named
      // third parties, dressed as an error code.
      for (const body of bodies) expect(body).toEqual(nonexistent);
      expect(nonexistent.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
      expect(JSON.stringify(nonexistent)).not.toMatch(/deleted|suspended|revoked|verification/i);
    });

    it('refuses a live service whose professional has been suspended', async () => {
      // The second-order case, and the single easiest thing to leave out of an
      // implementation: a service row SURVIVES its professional's suspension, so
      // checking only `services.deleted_at` would let this through.
      const user = await seedUser(app, dataSource, '+989128110002');
      const pro = await seedTarget(14);
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [
        pro.id,
      ]);

      // The service itself is untouched and live.
      const [service] = await dataSource.query('SELECT deleted_at FROM provider.services WHERE id = $1', [
        pro.serviceId,
      ]);
      expect(service.deleted_at).toBeNull();

      await save(user, 'service', pro.serviceId).expect(404);
    });

    it('refuses a live service whose professional has been soft-deleted', async () => {
      const user = await seedUser(app, dataSource, '+989128110003');
      const pro = await seedTarget(15);
      await dataSource.query('UPDATE provider.professionals SET deleted_at = now() WHERE id = $1', [pro.id]);
      await save(user, 'service', pro.serviceId).expect(404);
    });

    it('ALLOWS saving an unverified, pending or rejected professional', async () => {
      // `V32-DEC-021`, and the point of the whole predicate.
      // `SearchService.searchProviders` filters only `is_deleted`, so ordinary
      // discovery still returns these professionals -- refusing the save would
      // make the wishlist contradict the page the customer is saving from, and
      // would be a stricter rule than the platform applies anywhere else.
      const user = await seedUser(app, dataSource, '+989128110004');

      for (const [i, status] of ['unverified', 'pending', 'rejected'].entries()) {
        const pro = await seedTarget(20 + i);
        await dataSource.query('UPDATE provider.professionals SET verification_status = $2 WHERE id = $1', [
          pro.id,
          status,
        ]);
        await save(user, 'professional', pro.id).expect(200);
      }
    });

    it('removal answers identically whether or not anything was there', async () => {
      const user = await seedUser(app, dataSource, '+989128110005');
      const pro = await seedTarget(25);
      await save(user, 'professional', pro.id).expect(200);

      const real = await remove(user, 'professional', pro.id).expect(204);
      const noop = await remove(user, 'professional', pro.id).expect(204);
      const never = await remove(user, 'professional', uuidv7()).expect(204);

      expect(real.body).toEqual(noop.body);
      expect(noop.body).toEqual(never.body);
    });

    it('one customer cannot remove another customer\'s saved item', async () => {
      const owner = await seedUser(app, dataSource, '+989128110006');
      const stranger = await seedUser(app, dataSource, '+989128110007');
      const pro = await seedTarget(26);
      await save(owner, 'professional', pro.id).expect(200);

      // Succeeds with 204 and removes NOTHING -- the `user_id` predicate is in
      // the WHERE clause, so a stranger's delete is a no-op that reveals nothing.
      await remove(stranger, 'professional', pro.id).expect(204);

      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int AS count FROM wishlist.saved_items WHERE user_id = $1',
        [owner.id],
      );
      expect(count).toBe(1);
    });

    it('one customer never sees another customer\'s list', async () => {
      const a = await seedUser(app, dataSource, '+989128110008');
      const b = await seedUser(app, dataSource, '+989128110009');
      const pro = await seedTarget(27);
      await save(a, 'professional', pro.id).expect(200);

      const res = await list(b).expect(200);
      expect(res.body.data.items).toEqual([]);
    });

    it('accepts no caller-supplied identity anywhere', async () => {
      const a = await seedUser(app, dataSource, '+989128110010');
      const b = await seedUser(app, dataSource, '+989128110011');
      const pro = await seedTarget(28);

      // `forbidNonWhitelisted` rejects the attempt outright rather than silently
      // ignoring it, which is the stronger outcome: a silently-ignored field is
      // one somebody later wires up by accident.
      await http()
        .post('/api/v1/me/wishlist/items')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ targetType: 'professional', targetId: pro.id, userId: b.id })
        .expect(400);

      await http()
        .get(`/api/v1/me/wishlist/items?userId=${b.id}`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // The tombstone
  // -------------------------------------------------------------------------

  describe('unavailable targets survive as neutral tombstones', () => {
    it('keeps a saved item after its professional is soft-deleted', async () => {
      const user = await seedUser(app, dataSource, '+989128120001');
      const pro = await seedTarget(30);
      await save(user, 'professional', pro.id).expect(200);

      await dataSource.query('UPDATE provider.professionals SET deleted_at = now() WHERE id = $1', [pro.id]);

      // The row survives and still lists. `V32-DEC-021` chose this over silent
      // removal, and at this layer the property is a matter of what does NOT
      // happen: no cascade, no trigger, no sweep, no filter on target state.
      const res = await list(user).expect(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].targetId).toBe(pro.id);
    });

    it('keeps a saved item after its professional is suspended, and after it is restored', async () => {
      const user = await seedUser(app, dataSource, '+989128120002');
      const pro = await seedTarget(31);
      await save(user, 'professional', pro.id).expect(200);

      await dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [
        pro.id,
      ]);
      expect((await list(user).expect(200)).body.data.items).toHaveLength(1);

      // Restored with NO write to the wishlist: availability is computed per
      // read and is never cached on the row, so there is nothing to repair.
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'verified' WHERE id = $1", [
        pro.id,
      ]);
      expect((await list(user).expect(200)).body.data.items).toHaveLength(1);
    });

    it('keeps a saved service after the service itself is soft-deleted', async () => {
      const user = await seedUser(app, dataSource, '+989128120003');
      const pro = await seedTarget(32);
      await save(user, 'service', pro.serviceId).expect(200);

      await dataSource.query('UPDATE provider.services SET deleted_at = now() WHERE id = $1', [pro.serviceId]);

      expect((await list(user).expect(200)).body.data.items).toHaveLength(1);
    });

    it('exposes no target detail at all, so no cause can leak', async () => {
      const user = await seedUser(app, dataSource, '+989128120004');
      const pro = await seedTarget(33);
      await save(user, 'professional', pro.id).expect(200);
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'revoked' WHERE id = $1", [
        pro.id,
      ]);

      const item = (await list(user).expect(200)).body.data.items[0];

      // The key set, asserted against a literal. A new key fails this test until
      // somebody edits it, which is the reviewable act the assertion exists to
      // force -- the same discipline `ai-context.spec.ts` applies to its context.
      //
      // `state` was added by V3.2-C Story #9 and editing this line is exactly the
      // review the assertion is for. Story #8's version listed three keys and
      // additionally asserted `state` was ABSENT, because declaring a
      // vocabulary nothing could produce would have been a promise a client
      // codes against before anything can keep it.
      expect(Object.keys(item).sort()).toEqual(['savedAt', 'state', 'targetId', 'targetType']);
      // The state is a bare value from the closed vocabulary and nothing more.
      expect(item.state).toBe('unavailable');
      expect(item).not.toHaveProperty('available');
      expect(item).not.toHaveProperty('unavailableReason');
      expect(item).not.toHaveProperty('displayName');
      expect(JSON.stringify(item)).not.toMatch(/revoked|suspended|deleted|verification/i);
    });

    it('has no foreign key from wishlist into provider', async () => {
      // Structural, not behavioural: an `ON DELETE CASCADE` here would silently
      // implement the option the owner rejected, and it would do so without any
      // code to review.
      const rows = await dataSource.query(
        `SELECT conname FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'wishlist' AND c.contype = 'f'`,
      );
      expect(rows).toEqual([]);
    });

    it('has no deleted_at, no state, and no snapshot column', async () => {
      const rows = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'wishlist' AND table_name = 'saved_items'
          ORDER BY column_name`,
      );
      const columns = rows.map((r: { column_name: string }) => r.column_name);
      // Asserted against a literal so a later migration that adds a column has
      // to come here and say why.
      expect(columns).toEqual(['created_at', 'id', 'target_id', 'target_type', 'user_id']);
    });

    it('has no outbox table in the wishlist schema', async () => {
      // `V32-DEC-021`: no event, no outbox, and `wishlist` is not in
      // `ServiceName`. A table nothing writes would still need a subject-data
      // claim nobody could verify.
      const rows = await dataSource.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'wishlist' ORDER BY tablename`,
      );
      expect(rows.map((r: { tablename: string }) => r.tablename)).toEqual(['saved_items']);
    });
  });

  // -------------------------------------------------------------------------
  // The cap
  // -------------------------------------------------------------------------

  describe('the 500-item cap', () => {
    /**
     * Fills a customer's list directly, bypassing the API.
     *
     * Deliberate: 500 HTTP round trips plus 500 seeded professionals would make
     * this suite minutes long and would prove nothing extra. What is under test
     * is the cap, and the cap reads `count(*)`.
     */
    async function fill(userId: string, rows: number): Promise<void> {
      await dataSource.query(
        `INSERT INTO wishlist.saved_items (id, user_id, target_type, target_id)
         SELECT gen_random_uuid(), $1, 'professional', gen_random_uuid() FROM generate_series(1, $2)`,
        [userId, rows],
      );
    }

    it('refuses the 501st item with a cap refusal, not a not-found', async () => {
      const user = await seedUser(app, dataSource, '+989128130001');
      const pro = await seedTarget(40);
      await fill(user.id, WISHLIST_MAX_SAVED_ITEMS);

      const res = await save(user, 'professional', pro.id).expect(409);

      // The ONE refusal in this module that is not the shared not-found, because
      // it is a fact about the caller's own list rather than about a third party.
      expect(res.body.error.code).toBe('WISHLIST_LIMIT_REACHED');
      expect(res.body.error.details.reason).toBe('limit_reached');
    });

    it('accepts the 500th item', async () => {
      const user = await seedUser(app, dataSource, '+989128130002');
      const pro = await seedTarget(41);
      await fill(user.id, WISHLIST_MAX_SAVED_ITEMS - 1);

      await save(user, 'professional', pro.id).expect(200);

      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int AS count FROM wishlist.saved_items WHERE user_id = $1',
        [user.id],
      );
      expect(count).toBe(WISHLIST_MAX_SAVED_ITEMS);
    });

    it('does NOT overshoot when many adds race at the boundary', async () => {
      /**
       * The `GAP-04` case, and the reason this module takes an advisory lock.
       *
       * Without it, every one of these requests reads 499 and every one inserts.
       * A single-statement `INSERT ... SELECT ... WHERE (SELECT count(*)) < 500`
       * fails this too, because under READ COMMITTED each subquery sees a
       * snapshot taken before any sibling's insert is visible.
       */
      const user = await seedUser(app, dataSource, '+989128130003');
      await fill(user.id, WISHLIST_MAX_SAVED_ITEMS - 1);

      const targets = await Promise.all([44, 45, 46, 47, 48].map((n) => seedTarget(n)));
      const results = await Promise.all(targets.map((t) => save(user, 'professional', t.id)));

      const accepted = results.filter((r) => r.status === 200).length;
      const refused = results.filter((r) => r.status === 409).length;

      expect(accepted).toBe(1);
      expect(refused).toBe(4);

      const [{ count }] = await dataSource.query(
        'SELECT count(*)::int AS count FROM wishlist.saved_items WHERE user_id = $1',
        [user.id],
      );
      expect(count).toBe(WISHLIST_MAX_SAVED_ITEMS);
    });

    it('lets a customer save again after removing something', async () => {
      const user = await seedUser(app, dataSource, '+989128130004');
      const pro = await seedTarget(49);
      await fill(user.id, WISHLIST_MAX_SAVED_ITEMS);
      await save(user, 'professional', pro.id).expect(409);

      const [victim] = await dataSource.query(
        'SELECT target_id FROM wishlist.saved_items WHERE user_id = $1 LIMIT 1',
        [user.id],
      );
      await remove(user, 'professional', victim.target_id).expect(204);

      await save(user, 'professional', pro.id).expect(200);
    });

    it('caps each customer independently', async () => {
      const full = await seedUser(app, dataSource, '+989128130005');
      const empty = await seedUser(app, dataSource, '+989128130006');
      const pro = await seedTarget(50);
      await fill(full.id, WISHLIST_MAX_SAVED_ITEMS);

      await save(full, 'professional', pro.id).expect(409);
      await save(empty, 'professional', pro.id).expect(200);
    });

    it('reports the cap BEFORE it reports a missing target', async () => {
      // Order matters. A caller at the cap gets the cap refusal for a target
      // that does not exist, which tells them nothing about the target -- the
      // reverse order would let somebody at 500 items probe target existence by
      // comparing two different refusals.
      const user = await seedUser(app, dataSource, '+989128130007');
      await fill(user.id, WISHLIST_MAX_SAVED_ITEMS);

      await save(user, 'professional', uuidv7()).expect(409);
    });

    it('lets a repeat save of an already-saved item through at the cap', async () => {
      // The early-return path. A customer at exactly 500 who re-sends a save for
      // something they already hold must not be refused: nothing is being added.
      const user = await seedUser(app, dataSource, '+989128130008');
      const pro = await seedTarget(51);
      await fill(user.id, WISHLIST_MAX_SAVED_ITEMS - 1);
      await save(user, 'professional', pro.id).expect(200);

      await save(user, 'professional', pro.id).expect(200);
    });

    it('lets a repeat save through even after the target becomes unavailable', async () => {
      // Also the early-return path, and a privacy property rather than a
      // convenience: re-sending a save for something already held must not
      // become a way to discover that the platform has acted against somebody.
      const user = await seedUser(app, dataSource, '+989128130009');
      const pro = await seedTarget(52);
      await save(user, 'professional', pro.id).expect(200);

      await dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [
        pro.id,
      ]);

      await save(user, 'professional', pro.id).expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  describe('keyset pagination', () => {
    async function seedItems(userId: string, n: number): Promise<void> {
      // One statement, distinct `created_at` per row so the ordering is
      // unambiguous for the ordering assertions below. The same-instant case is
      // covered separately.
      await dataSource.query(
        `INSERT INTO wishlist.saved_items (id, user_id, target_type, target_id, created_at)
         SELECT gen_random_uuid(), $1, 'professional', gen_random_uuid(),
                now() - (g || ' seconds')::interval
           FROM generate_series(1, $2) AS g`,
        [userId, n],
      );
    }

    it('defaults to 20 per page', async () => {
      const user = await seedUser(app, dataSource, '+989128140001');
      await seedItems(user.id, 25);

      const res = await list(user).expect(200);
      expect(res.body.data.items).toHaveLength(20);
      expect(res.body.data.nextCursor).toBeTruthy();
    });

    it('honours an explicit limit up to 50', async () => {
      const user = await seedUser(app, dataSource, '+989128140002');
      await seedItems(user.id, 60);

      expect((await list(user, '?limit=50').expect(200)).body.data.items).toHaveLength(50);
      expect((await list(user, '?limit=1').expect(200)).body.data.items).toHaveLength(1);
    });

    it('refuses a limit above the maximum rather than silently serving it', async () => {
      const user = await seedUser(app, dataSource, '+989128140003');
      // The DTO's `@Max` fires first. The service clamps too, so a caller
      // reaching it another way still cannot get an unbounded page.
      await list(user, '?limit=51').expect(400);
      await list(user, '?limit=100000').expect(400);
    });

    it('walks every item exactly once with no repeat and no gap', async () => {
      const user = await seedUser(app, dataSource, '+989128140004');
      await seedItems(user.id, 47);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor ? `?limit=10&cursor=${encodeURIComponent(cursor)}` : '?limit=10';
        const res: request.Response = await list(user, query).expect(200);
        seen.push(...res.body.data.items.map((i: { targetId: string }) => i.targetId));
        cursor = res.body.data.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(20); // a cursor that never terminates is an infinite loop, not a failure
      } while (cursor);

      expect(seen).toHaveLength(47);
      expect(new Set(seen).size).toBe(47);
      expect(pages).toBe(5);
    });

    it('returns newest first', async () => {
      const user = await seedUser(app, dataSource, '+989128140005');
      const older = await seedTarget(60);
      const newer = await seedTarget(61);
      await save(user, 'professional', older.id).expect(200);
      await save(user, 'professional', newer.id).expect(200);

      const items = (await list(user).expect(200)).body.data.items;
      expect(items[0].targetId).toBe(newer.id);
      expect(items[1].targetId).toBe(older.id);
    });

    it('stays stable when every row shares one instant', async () => {
      // The reason `id` is in the ORDER BY and in the cursor. `created_at` alone
      // is not a total order, and a non-total order makes a page boundary skip
      // or repeat a row -- which the walk above would not catch, because it
      // seeds distinct timestamps.
      const user = await seedUser(app, dataSource, '+989128140006');
      await dataSource.query(
        `INSERT INTO wishlist.saved_items (id, user_id, target_type, target_id, created_at)
         SELECT gen_random_uuid(), $1, 'professional', gen_random_uuid(), '2026-08-30T10:00:00Z'
           FROM generate_series(1, 30)`,
        [user.id],
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `?limit=7&cursor=${encodeURIComponent(cursor)}` : '?limit=7';
        const res: request.Response = await list(user, query).expect(200);
        seen.push(...res.body.data.items.map((i: { targetId: string }) => i.targetId));
        cursor = res.body.data.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(30);
      expect(new Set(seen).size).toBe(30);
    });

    it('returns null nextCursor on the last page', async () => {
      const user = await seedUser(app, dataSource, '+989128140007');
      await seedItems(user.id, 5);
      const res = await list(user, '?limit=10').expect(200);
      expect(res.body.data.items).toHaveLength(5);
      expect(res.body.data.nextCursor).toBeNull();
    });

    it('treats a malformed cursor as page one rather than as an error', async () => {
      const user = await seedUser(app, dataSource, '+989128140008');
      await seedItems(user.id, 3);

      for (const bad of ['garbage', 'YWJj', Buffer.from('x|y').toString('base64url')]) {
        const res = await list(user, `?limit=10&cursor=${encodeURIComponent(bad)}`).expect(200);
        expect(res.body.data.items).toHaveLength(3);
      }
    });

    it('refuses an over-long cursor at the DTO boundary', async () => {
      const user = await seedUser(app, dataSource, '+989128140009');
      await list(user, `?cursor=${'A'.repeat(500)}`).expect(400);
    });

    it('another customer\'s cursor pages through the CALLER\'s rows, never theirs', async () => {
      // A cursor is a position, not a capability. Even a genuine cursor from
      // somebody else's list can only walk the caller's own rows, because
      // `user_id` is in the WHERE clause and the cursor only narrows it further.
      const a = await seedUser(app, dataSource, '+989128140010');
      const b = await seedUser(app, dataSource, '+989128140011');
      await seedItems(a.id, 30);
      await seedItems(b.id, 5);

      const aPage = await list(a, '?limit=10').expect(200);
      const stolen = aPage.body.data.nextCursor as string;

      const res = await list(b, `?limit=10&cursor=${encodeURIComponent(stolen)}`).expect(200);
      const bIds = await dataSource.query('SELECT target_id FROM wishlist.saved_items WHERE user_id = $1', [b.id]);
      const bSet = new Set(bIds.map((r: { target_id: string }) => r.target_id));
      for (const item of res.body.data.items) expect(bSet.has(item.targetId)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Privacy
  // -------------------------------------------------------------------------

  describe('subject data', () => {
    it('claims exactly one table, as subject_data', () => {
      const contract = app.get(WishlistSubjectDataContract);
      expect(contract.moduleKey).toBe('wishlist');
      expect(contract.tables).toEqual([{ table: 'wishlist.saved_items', disposition: 'subject_data' }]);
    });

    it('exports the subject\'s own saved items, and only ids and an instant', async () => {
      const user = await seedUser(app, dataSource, '+989128150001');
      const other = await seedUser(app, dataSource, '+989128150002');
      const pro = await seedTarget(70);
      await save(user, 'professional', pro.id).expect(200);
      await save(other, 'professional', pro.id).expect(200);

      const contract = app.get(WishlistSubjectDataContract);
      const sections = await contract.exportSubjectData(dataSource.manager, user.id);

      expect(sections).toHaveLength(1);
      expect(sections[0].key).toBe('wishlist_items');
      expect(sections[0].rows).toHaveLength(1);
      // No display name, no price, no image. This module stores none of it, so
      // an export cannot leak a third party's catalogue data even by accident.
      expect(Object.keys(sections[0].rows[0]).sort()).toEqual(['savedAt', 'targetId', 'targetType']);
    });

    it('exports nothing for a subject who has saved nothing', async () => {
      const user = await seedUser(app, dataSource, '+989128150003');
      const contract = app.get(WishlistSubjectDataContract);
      const sections = await contract.exportSubjectData(dataSource.manager, user.id);
      // A section with zero rows rather than no section: the export document
      // says "we hold none of this", which is a different claim from silence.
      expect(sections[0].rows).toEqual([]);
    });

    it('erasure DELETES every row and retains nothing', async () => {
      const user = await seedUser(app, dataSource, '+989128150004');
      const survivor = await seedUser(app, dataSource, '+989128150005');
      const pro = await seedTarget(71);
      await save(user, 'professional', pro.id).expect(200);
      await save(user, 'service', pro.serviceId).expect(200);
      await save(survivor, 'professional', pro.id).expect(200);

      const contract = app.get(WishlistSubjectDataContract);
      const outcome = await contract.eraseSubjectData(dataSource.manager, user.id);

      // Deleted, not anonymized. A saved id is single-party and referenced by
      // nobody, so keeping it would be keeping personal data for no reason --
      // `journey`'s reasoning, applied unchanged.
      expect(outcome).toEqual({ moduleKey: 'wishlist', anonymized: 0, deleted: 2, retained: [] });

      const rows = await dataSource.query('SELECT user_id FROM wishlist.saved_items');
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(survivor.id);
    });

    it('reports a truthful count rather than a fabricated one', async () => {
      // V3.2-B bug #3: TypeORM's postgres driver returns `[rows, rowCount]` for
      // DELETE, so `result.length` is 2 for every statement -- an erasure that
      // always claims two rows. This asserts the real number in both directions.
      const empty = await seedUser(app, dataSource, '+989128150006');
      const contract = app.get(WishlistSubjectDataContract);
      const outcome = await contract.eraseSubjectData(dataSource.manager, empty.id);
      expect(outcome.deleted).toBe(0);
    });

    it('is reached by the platform\'s real erasure route, not only in isolation', async () => {
      const user = await seedUser(app, dataSource, '+989128150007');
      const pro = await seedTarget(72);
      await save(user, 'professional', pro.id).expect(200);

      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS, { strict: false });
      const keys = contracts.map((c) => c.moduleKey);
      // Registered in the composition root's list. Without this the module could
      // pass every test above and still never be called during a real erasure.
      expect(keys).toContain('wishlist');
    });

    it('an unclaimed wishlist table fails the boot-time coverage assertion', async () => {
      // Proved by test rather than by inspection, exactly as V3.2-B proved it:
      // the coverage check is what stops the boot, so a test that only reads the
      // contract proves nothing about whether the check would fire.
      const coverage = app.get(SubjectDataCoverageService);
      expect(coverage).toBeDefined();

      const withoutWishlist: SubjectDataContract[] = [
        {
          moduleKey: 'pretend',
          tables: [],
          exportSubjectData: async () => [],
          eraseSubjectData: async () => ({ moduleKey: 'pretend', anonymized: 0, deleted: 0, retained: [] }),
        },
      ];
      const report = evaluateCoverage(
        [{ schema: 'wishlist', name: 'saved_items', columns: ['id', 'user_id', 'target_type', 'target_id'] }],
        withoutWishlist,
      );
      expect(report.violations.some((v) => v.kind === 'unclaimed' && v.table === 'wishlist.saved_items')).toBe(true);
    });

    it('rejects a no_subject_data claim on the table by column name alone', async () => {
      // The naming convention doing its job. Even if somebody declared the wrong
      // disposition, `user_id` makes the check reject it.
      const wrong: SubjectDataContract[] = [
        {
          moduleKey: 'wishlist',
          tables: [{ table: 'wishlist.saved_items', disposition: 'no_subject_data', reason: 'just ids' }],
          exportSubjectData: async () => [],
          eraseSubjectData: async () => ({ moduleKey: 'wishlist', anonymized: 0, deleted: 0, retained: [] }),
        },
      ];
      const report = evaluateCoverage(
        [{ schema: 'wishlist', name: 'saved_items', columns: ['id', 'user_id', 'target_type', 'target_id'] }],
        wrong,
      );
      expect(report.violations.some((v) => v.kind === 'wrongly_declared_empty')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Service-level surface used by other stories
  // -------------------------------------------------------------------------

  describe('service surface', () => {
    it('allForSubject returns oldest first and only the subject\'s rows', async () => {
      const user = await seedUser(app, dataSource, '+989128160001');
      const other = await seedUser(app, dataSource, '+989128160002');
      const a = await seedTarget(80);
      const b = await seedTarget(81);
      await save(user, 'professional', a.id).expect(200);
      await save(user, 'professional', b.id).expect(200);
      await save(other, 'professional', a.id).expect(200);

      const rows = await wishlist.allForSubject(dataSource.manager, user.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].targetId).toBe(a.id);
      expect(rows.every((r) => r.userId === user.id)).toBe(true);
    });
  });
});
