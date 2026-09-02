import { INestApplication } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { ALL_EVENT_CONTRACTS } from '@beauclick/event-contracts';
import { InMemorySearchEngine, SEARCH_ENGINE, SearchIndexerService } from '@beauclick/search';
import { WISHLIST_TARGET_STATES, wishlistTargetKey } from '@beauclick/wishlist-contract';

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
 * Wishlist discovery integration and the target-state projection (V3.2-C Story
 * #9, ADR-034), proved against real PostgreSQL.
 *
 * This file exists separately from `wishlist.pg-spec.ts` because it proves a
 * different KIND of thing. That one proves the module's own guarantees — the
 * unique index, the advisory lock, the erasure transaction. This one proves
 * properties that only exist where two domains meet: that authoritative
 * PostgreSQL state beats a stale search index, that four internal situations
 * render as one indistinguishable value, that a page of saved items costs a
 * bounded number of queries, and that none of it leaks another customer's list.
 *
 * Nothing here is provable on the fast layer. pg-mem does not honour ROLLBACK,
 * has no query planner worth counting against, and — most importantly — cannot
 * hold a search projection that disagrees with the provider tables, which is the
 * exact disagreement half of this file is about.
 */
describePg('wishlist discovery integration and target-state projection (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let indexer: SearchIndexerService;
  let engine: InMemorySearchEngine;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    indexer = app.get(SearchIndexerService);
    engine = app.get(SEARCH_ENGINE) as InMemorySearchEngine;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // The engine is a DI singleton, so truncating PostgreSQL does not clear it.
    engine.reset();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const http = () => request(app.getHttpServer());

  const auth = (req: request.Test, user?: SeededUser) =>
    user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;

  const save = (user: SeededUser, targetType: string, targetId: string) =>
    auth(http().post('/api/v1/me/wishlist/items'), user).send({ targetType, targetId });

  const listSaved = (user: SeededUser, query = '') =>
    auth(http().get(`/api/v1/me/wishlist/items${query}`), user);

  const searchProviders = (user?: SeededUser, query = '') =>
    auth(http().get(`/api/v1/search/providers${query}`), user);

  const profile = (id: string, user?: SeededUser, query = '') =>
    auth(http().get(`/api/v1/providers/${id}${query}`), user);

  const providerList = (user?: SeededUser, query = '') => auth(http().get(`/api/v1/providers${query}`), user);

  const servicesOf = (id: string, user?: SeededUser) => auth(http().get(`/api/v1/providers/${id}/services`), user);

  let seq = 0;
  /** A professional owned by a throwaway account, so the customer under test is never the owner. */
  async function seedTarget(displayName = 'متخصص'): Promise<SeededProfessional> {
    seq += 1;
    const owner = await seedUser(app, dataSource, `+9891285${String(seq).padStart(5, '0')}`, ['professional']);
    return seedProfessional(dataSource, owner.id, `${displayName} ${seq}`);
  }

  async function customer(): Promise<SeededUser> {
    seq += 1;
    return seedUser(app, dataSource, `+9891286${String(seq).padStart(5, '0')}`);
  }

  /**
   * Puts a document in the search index for a professional, at the state given.
   *
   * `applyProfessional` writes the PROJECTION and marks the row dirty;
   * `flushDirty` is what pushes it to the engine. Both are needed, and forgetting
   * the second is not a harmless omission — it leaves the engine empty, so every
   * search below returns nothing and the assertions about search results pass
   * vacuously. (It did, on the first run of this file.)
   */
  async function index(professionalId: string, over: Record<string, unknown> = {}): Promise<void> {
    await indexer.applyProfessional({
      professionalId,
      revision: 1,
      displayName: 'سالن نمونه',
      bio: null,
      cityId: null,
      cityName: 'تهران',
      specialtyIds: [],
      specialtyNames: [],
      verificationStatus: 'verified',
      isDeleted: false,
      updatedAt: new Date(),
      services: [],
      ...over,
    });
    await indexer.flushDirty();
  }

  /**
   * Records every SQL statement the application issues while `run` executes.
   *
   * TypeORM creates a query runner per operation, so wrapping `createQueryRunner`
   * catches repository calls, query-builder calls, and raw `manager.query` alike
   * — which is what makes this a real count rather than a count of the one path
   * somebody remembered to instrument.
   *
   * The alternative, `pg_stat_statements`, is not installed on the CI service
   * container and would count this suite's own setup statements as well.
   */
  async function recordSql<T>(run: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
    const sql: string[] = [];
    const original = dataSource.createQueryRunner.bind(dataSource);
    const spy = jest
      .spyOn(dataSource, 'createQueryRunner')
      .mockImplementation(((mode?: 'master' | 'slave') => {
        const runner: QueryRunner = original(mode);
        const query = runner.query.bind(runner);
        runner.query = ((statement: string, parameters?: unknown[], useStructuredResult?: boolean) => {
          sql.push(statement);
          return query(statement, parameters as never, useStructuredResult as never);
        }) as QueryRunner['query'];
        return runner;
      }) as typeof dataSource.createQueryRunner);
    try {
      return { result: await run(), sql };
    } finally {
      spy.mockRestore();
    }
  }

  const matching = (sql: readonly string[], pattern: RegExp) => sql.filter((s) => pattern.test(s));

  // -------------------------------------------------------------------------
  // 1. Saved state on the discovery surfaces
  // -------------------------------------------------------------------------

  describe('the caller\'s own saved state, on the surfaces they discover from', () => {
    it('marks a saved professional on the profile and leaves an unsaved one unmarked', async () => {
      const user = await customer();
      const saved = await seedTarget();
      const unsaved = await seedTarget();
      await save(user, 'professional', saved.id).expect(200);

      expect((await profile(saved.id, user).expect(200)).body.data.saved).toBe(true);
      expect((await profile(unsaved.id, user).expect(200)).body.data.saved).toBe(false);
    });

    it('marks a saved professional in search results', async () => {
      const user = await customer();
      const saved = await seedTarget();
      const unsaved = await seedTarget();
      await index(saved.id);
      await index(unsaved.id);
      await save(user, 'professional', saved.id).expect(200);

      const items = (await searchProviders(user).expect(200)).body.data.items as Array<{
        id: string;
        saved: boolean | null;
      }>;
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(items.find((i) => i.id === saved.id)?.saved).toBe(true);
      expect(items.find((i) => i.id === unsaved.id)?.saved).toBe(false);
    });

    it('marks a saved professional in the provider listing', async () => {
      const user = await customer();
      const target = await seedTarget();
      await save(user, 'professional', target.id).expect(200);

      const items = (await providerList(user).expect(200)).body.data as Array<{ id: string; saved: boolean | null }>;
      expect(items.find((i) => i.id === target.id)?.saved).toBe(true);
    });

    it('marks a saved SERVICE on the service consumer surface', async () => {
      const user = await customer();
      const target = await seedTarget();
      await save(user, 'service', target.serviceId).expect(200);

      const offerings = (await servicesOf(target.id, user).expect(200)).body.data as Array<{
        id: string;
        saved: boolean | null;
      }>;
      expect(offerings).toHaveLength(1);
      expect(offerings[0].id).toBe(target.serviceId);
      expect(offerings[0].saved).toBe(true);
    });

    it('marks EVERY saved target in a large mixed batch, losing none', async () => {
      // The de-duplication trap: `getMany` hydrates entities and dedupes them by
      // primary key, so a partial select that omitted `id` could collapse
      // distinct rows into one and silently report saved targets as unsaved.
      // Twenty-five in one page is enough for that to show.
      const user = await customer();
      const targets: SeededProfessional[] = [];
      for (let i = 0; i < 25; i += 1) {
        const target = await seedTarget();
        await save(user, 'professional', target.id).expect(200);
        await save(user, 'service', target.serviceId).expect(200);
        targets.push(target);
      }

      const items = (await providerList(user, '?limit=50').expect(200)).body.data as Array<{
        id: string;
        saved: boolean | null;
      }>;
      const marked = items.filter((i) => i.saved === true).map((i) => i.id);
      expect(new Set(marked)).toEqual(new Set(targets.map((t) => t.id)));

      // And the same for services, through the other consumer.
      for (const target of targets.slice(0, 3)) {
        const offerings = (await servicesOf(target.id, user).expect(200)).body.data as Array<{ saved: boolean }>;
        expect(offerings.every((o) => o.saved === true)).toBe(true);
      }
    });

    it('reports null, not false, for a caller the server cannot identify', async () => {
      // `false` would be a claim about somebody who has not identified themselves.
      // The distinction is the whole reason `saved` is `boolean | null`.
      const target = await seedTarget();
      await index(target.id);

      expect((await profile(target.id).expect(200)).body.data.saved).toBeNull();
      expect((await servicesOf(target.id).expect(200)).body.data[0].saved).toBeNull();
      const items = (await searchProviders().expect(200)).body.data.items as Array<{ saved: boolean | null }>;
      expect(items.every((i) => i.saved === null)).toBe(true);
    });

    it('leaves the professional\'s own management surface unmarked', async () => {
      // `/v1/me/provider` and every mutation response are the provider's own
      // surface, not a page anybody discovers from. `null` there is the honest
      // answer, and it costs no query.
      const ownerUser = await seedUser(app, dataSource, '+989128700001', ['professional']);
      await seedProfessional(dataSource, ownerUser.id, 'سالن خودم');

      const res = await http()
        .get('/api/v1/me/provider')
        .set('Authorization', `Bearer ${ownerUser.accessToken}`)
        .expect(200);
      expect(res.body.data.saved).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Cross-customer isolation — the adversarial half
  // -------------------------------------------------------------------------

  describe('saved state is scoped to the authenticated customer', () => {
    it('never reports another customer\'s save', async () => {
      const mine = await customer();
      const theirs = await customer();
      const target = await seedTarget();
      await index(target.id);
      await save(theirs, 'professional', target.id).expect(200);
      await save(theirs, 'service', target.serviceId).expect(200);

      // Everything the other customer saved; nothing the caller did.
      expect((await profile(target.id, mine).expect(200)).body.data.saved).toBe(false);
      expect((await servicesOf(target.id, mine).expect(200)).body.data[0].saved).toBe(false);
      const items = (await searchProviders(mine).expect(200)).body.data.items as Array<{ saved: boolean | null }>;
      expect(items.every((i) => i.saved === false)).toBe(true);
    });

    it('exposes no count, total, or aggregate anywhere in the browser contract', async () => {
      // Three customers save the same professional. Nothing in any response may
      // reveal that more than the caller did — `V32-DEC-021` refuses a public
      // popularity signal outright.
      const savers = [await customer(), await customer(), await customer()];
      const watcher = await customer();
      const target = await seedTarget();
      await index(target.id);
      for (const saver of savers) await save(saver, 'professional', target.id).expect(200);

      const profileBody = (await profile(target.id, watcher).expect(200)).body.data;
      const searchItem = ((await searchProviders(watcher).expect(200)).body.data.items as Array<{ id: string }>).find(
        (i) => i.id === target.id,
      );
      const serviceBody = (await servicesOf(target.id, watcher).expect(200)).body.data[0];

      for (const body of [profileBody, searchItem, serviceBody]) {
        const serialised = JSON.stringify(body);
        // The number three must not appear as a save count under any name.
        expect(serialised).not.toMatch(/saveCount|savesCount|savedBy|popularity|wishlistCount|favouriteCount/i);
        for (const key of Object.keys(body as Record<string, unknown>)) {
          expect(key).not.toMatch(/saves|popular|wishlist/i);
        }
      }
      // The only save-shaped field is the caller's own boolean.
      expect(profileBody.saved).toBe(false);
      expect(searchItem).toBeDefined();
      expect(serviceBody.saved).toBe(false);
    });

    it('rejects or ignores a forged identity, and never honours one', async () => {
      const mine = await customer();
      const theirs = await customer();
      const target = await seedTarget();
      await index(target.id);
      await save(theirs, 'professional', target.id).expect(200);

      // Where a query DTO exists, `forbidNonWhitelisted` REFUSES the attempt
      // outright rather than ignoring it — the stronger outcome, because a
      // silently-ignored field is one somebody later wires up by accident.
      await searchProviders(mine, `?userId=${theirs.id}`).expect(400);
      await providerList(mine, `?userId=${theirs.id}`).expect(400);
      await providerList(mine, `?customerId=${theirs.id}`).expect(400);

      // Where no query DTO exists the parameter is structurally unreachable:
      // the handler has no binding that could read it. Proved by the response
      // being byte-identical with and without it, and reporting the SESSION's
      // saved state rather than the named party's.
      const clean = await profile(target.id, mine).expect(200);
      const forged = await profile(target.id, mine, `?userId=${theirs.id}`).expect(200);
      expect(forged.body).toEqual(clean.body);
      expect(forged.body.data.saved).toBe(false);

      const forgedServices = await auth(
        http().get(`/api/v1/providers/${target.id}/services?userId=${theirs.id}`),
        mine,
      ).expect(200);
      expect(forgedServices.body.data[0].saved).toBe(false);
    });

    it('a bearer token is the ONLY thing that changes the answer', async () => {
      const owner = await customer();
      const target = await seedTarget();
      await save(owner, 'professional', target.id).expect(200);

      // Same URL, three callers, three answers — and the only difference is the
      // Authorization header.
      expect((await profile(target.id, owner).expect(200)).body.data.saved).toBe(true);
      expect((await profile(target.id, await customer()).expect(200)).body.data.saved).toBe(false);
      expect((await profile(target.id).expect(200)).body.data.saved).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Authoritative PostgreSQL beats the eventually-consistent projection
  // -------------------------------------------------------------------------

  describe('the authoritative provider tables win over a stale search index', () => {
    it('reads unavailable while the search projection still shows the professional', async () => {
      const user = await customer();
      const target = await seedTarget();
      await index(target.id);
      await save(user, 'professional', target.id).expect(200);

      // Suspended in the authoritative table, with NO reindex. This is exactly
      // the window the projection is eventually consistent across: the event has
      // not drained, so the document is still there and still says `verified`.
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [
        target.id,
      ]);

      // The projection is genuinely stale — asserted, not assumed. Without this
      // the test would pass just as well if the index had been updated, and
      // would prove nothing about which source the projection reads.
      const [doc] = await dataSource.query(
        'SELECT verification_status, is_deleted FROM search.provider_documents WHERE professional_id = $1',
        [target.id],
      );
      expect(doc.verification_status).toBe('verified');
      expect(doc.is_deleted).toBe(false);
      const stillIndexed = (await searchProviders().expect(200)).body.data.items as Array<{ id: string }>;
      expect(stillIndexed.some((i) => i.id === target.id)).toBe(true);

      // And the saved item reads `unavailable` anyway.
      const item = (await listSaved(user).expect(200)).body.data.items[0];
      expect(item.state).toBe('unavailable');
    });

    it('reads available while the search projection has already dropped the professional', async () => {
      // The mirror case, and the one a projection-reading implementation would
      // also get wrong: the index says gone, the authoritative row says fine.
      const user = await customer();
      const target = await seedTarget();
      await index(target.id);
      await save(user, 'professional', target.id).expect(200);

      // A spurious deletion in the projection only. `provider.professionals` is
      // untouched.
      await index(target.id, { revision: 2, isDeleted: true });
      const [{ deleted_at: deletedAt }] = await dataSource.query(
        'SELECT deleted_at FROM provider.professionals WHERE id = $1',
        [target.id],
      );
      expect(deletedAt).toBeNull();

      const item = (await listSaved(user).expect(200)).body.data.items[0];
      expect(item.state).toBe('available');
    });

    it('never queries the search projection to answer a target-state question', async () => {
      // Structural rather than behavioural. The two cases above prove the ANSWER
      // is authoritative; this proves the projection is not consulted at all, so
      // a later change cannot start reading it and still pass them by luck.
      const user = await customer();
      const target = await seedTarget();
      await index(target.id);
      await save(user, 'professional', target.id).expect(200);

      const { sql } = await recordSql(() => listSaved(user).expect(200));
      expect(matching(sql, /search\.provider_documents|search\.ranking_signals/i)).toEqual([]);
      expect(matching(sql, /provider_documents/i)).toEqual([]);
      // It reads the authoritative tables instead.
      expect(matching(sql, /provider\.professionals|"professionals"/i).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. One neutral unavailable state, with no cause
  // -------------------------------------------------------------------------

  describe('deleted, suspended and revoked are indistinguishable', () => {
    /** Saves a target, applies `mutate`, and returns the rendered saved item. */
    async function itemAfter(mutate: (target: SeededProfessional) => Promise<void>) {
      const user = await customer();
      const target = await seedTarget();
      await save(user, 'professional', target.id).expect(200);
      await mutate(target);
      const item = (await listSaved(user).expect(200)).body.data.items[0];
      // Normalised so the comparison is about STATE, not about which throwaway
      // ids and instants this particular case happened to generate.
      return { ...item, targetId: '<id>', savedAt: '<at>' };
    }

    it('produces one identical shape for all three causes', async () => {
      const deleted = await itemAfter((t) =>
        dataSource.query('UPDATE provider.professionals SET deleted_at = now() WHERE id = $1', [t.id]),
      );
      const suspended = await itemAfter((t) =>
        dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [t.id]),
      );
      const revoked = await itemAfter((t) =>
        dataSource.query("UPDATE provider.professionals SET verification_status = 'revoked' WHERE id = $1", [t.id]),
      );

      // WHOLE-RESPONSE comparison, not a field-by-field one. A discriminator
      // added anywhere in the item fails here even if nobody thought to assert
      // on it by name.
      expect(suspended).toEqual(deleted);
      expect(revoked).toEqual(deleted);

      // KEY-SET comparison against an independently written literal, so a new
      // key has to come here and say why.
      expect(Object.keys(deleted).sort()).toEqual(['savedAt', 'state', 'targetId', 'targetType']);

      // And the value itself is the bare vocabulary member.
      expect(deleted.state).toBe('unavailable');
      expect([...WISHLIST_TARGET_STATES]).toEqual(['available', 'unavailable']);
      expect(JSON.stringify(deleted)).not.toMatch(/deleted|suspended|revoked|verification|reason|because/i);
    });

    it('makes a soft-deleted SERVICE indistinguishable from a suspended owner', async () => {
      async function serviceItemAfter(mutate: (t: SeededProfessional) => Promise<void>) {
        const user = await customer();
        const target = await seedTarget();
        await save(user, 'service', target.serviceId).expect(200);
        await mutate(target);
        const item = (await listSaved(user).expect(200)).body.data.items[0];
        return { ...item, targetId: '<id>', savedAt: '<at>' };
      }

      const serviceDeleted = await serviceItemAfter((t) =>
        dataSource.query('UPDATE provider.services SET deleted_at = now() WHERE id = $1', [t.serviceId]),
      );
      const ownerSuspended = await serviceItemAfter((t) =>
        dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [t.id]),
      );
      const ownerDeleted = await serviceItemAfter((t) =>
        dataSource.query('UPDATE provider.professionals SET deleted_at = now() WHERE id = $1', [t.id]),
      );

      expect(ownerSuspended).toEqual(serviceDeleted);
      expect(ownerDeleted).toEqual(serviceDeleted);
      expect(serviceDeleted.state).toBe('unavailable');
    });

    it('follows the OWNING professional for a service that is itself untouched', async () => {
      // The second-order case, and the single easiest thing to leave out: a
      // service row SURVIVES its professional's suspension, so an implementation
      // checking only `services.deleted_at` would call this `available`.
      const user = await customer();
      const target = await seedTarget();
      await save(user, 'service', target.serviceId).expect(200);
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'revoked' WHERE id = $1", [
        target.id,
      ]);

      const [service] = await dataSource.query('SELECT deleted_at FROM provider.services WHERE id = $1', [
        target.serviceId,
      ]);
      expect(service.deleted_at).toBeNull();

      expect((await listSaved(user).expect(200)).body.data.items[0].state).toBe('unavailable');
    });

    it('keeps unverified, pending and rejected AVAILABLE', async () => {
      // `V32-DEC-021`, and the point of the whole predicate.
      // `SearchService.searchProviders` filters only `is_deleted`, so ordinary
      // discovery still returns these professionals — a stricter rule here would
      // make the saved list contradict the page the customer saved it from.
      const user = await customer();
      for (const status of ['unverified', 'pending', 'rejected']) {
        const target = await seedTarget();
        await dataSource.query('UPDATE provider.professionals SET verification_status = $2 WHERE id = $1', [
          target.id,
          status,
        ]);
        await save(user, 'professional', target.id).expect(200);
        await save(user, 'service', target.serviceId).expect(200);
      }

      const items = (await listSaved(user, '?limit=50').expect(200)).body.data.items as Array<{ state: string }>;
      expect(items).toHaveLength(6);
      expect(items.every((i) => i.state === 'available')).toBe(true);
    });

    it('reports a target that never existed the same way as one that went away', async () => {
      // Written directly, because the API refuses to save a nonexistent target —
      // this is the row a customer would hold if a target were hard-deleted
      // underneath them, and it must render like every other absence.
      const user = await customer();
      const gone = await seedTarget();
      await save(user, 'professional', gone.id).expect(200);
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [
        gone.id,
      ]);
      await dataSource.query(
        `INSERT INTO wishlist.saved_items (id, user_id, target_type, target_id) VALUES ($1, $2, 'professional', $3)`,
        [uuidv7(), user.id, uuidv7()],
      );

      const items = (await listSaved(user).expect(200)).body.data.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      const normalised = items.map((i) => ({ ...i, targetId: '<id>', savedAt: '<at>' }));
      expect(normalised[0]).toEqual(normalised[1]);
      expect(items.every((i) => i.state === 'unavailable')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Computed per read, cached nowhere
  // -------------------------------------------------------------------------

  describe('availability is computed on every read and never stored', () => {
    it('restores a lifted suspension with NO write to the wishlist', async () => {
      const user = await customer();
      const target = await seedTarget();
      await save(user, 'professional', target.id).expect(200);

      const before = await dataSource.query(
        'SELECT id, ctid::text AS ctid, xmin::text AS xmin FROM wishlist.saved_items WHERE user_id = $1',
        [user.id],
      );

      await dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [
        target.id,
      ]);
      expect((await listSaved(user).expect(200)).body.data.items[0].state).toBe('unavailable');

      await dataSource.query("UPDATE provider.professionals SET verification_status = 'verified' WHERE id = $1", [
        target.id,
      ]);
      const { result, sql } = await recordSql(() => listSaved(user).expect(200));
      expect((result as request.Response).body.data.items[0].state).toBe('available');

      // No repair write of any kind. Proved twice, because either alone is weak:
      // the SQL the request issued contained no wishlist mutation, AND the row's
      // physical location and inserting transaction id are unchanged — a row
      // that had been UPDATEd would have a new ctid and a new xmin.
      expect(matching(sql, /(INSERT|UPDATE|DELETE)[\s\S]*wishlist/i)).toEqual([]);
      const after = await dataSource.query(
        'SELECT id, ctid::text AS ctid, xmin::text AS xmin FROM wishlist.saved_items WHERE user_id = $1',
        [user.id],
      );
      expect(after).toEqual(before);
    });

    it('has no column that could hold a cached state', async () => {
      // Structural. Availability cannot go stale because there is nowhere to
      // store it — asserted against `information_schema` and a literal, so a
      // migration adding one has to come here and say why.
      const rows = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'wishlist' AND table_name = 'saved_items'
          ORDER BY column_name`,
      );
      expect(rows.map((r: { column_name: string }) => r.column_name)).toEqual([
        'created_at',
        'id',
        'target_id',
        'target_type',
        'user_id',
      ]);
    });

    it('re-reads the target on every request rather than memoising it', async () => {
      const user = await customer();
      const target = await seedTarget();
      await save(user, 'professional', target.id).expect(200);

      // Four alternating reads. A cache anywhere — per process, per connection,
      // per request-scoped provider — makes at least one of them wrong.
      const states: string[] = [];
      for (const status of ['suspended', 'verified', 'revoked', 'pending']) {
        await dataSource.query('UPDATE provider.professionals SET verification_status = $2 WHERE id = $1', [
          target.id,
          status,
        ]);
        states.push((await listSaved(user).expect(200)).body.data.items[0].state);
      }
      expect(states).toEqual(['unavailable', 'available', 'unavailable', 'available']);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Batching — bounded query counts, no N+1
  // -------------------------------------------------------------------------

  describe('reads are batched and do not grow with the page', () => {
    async function fillSaved(user: SeededUser, professionals: number, services: number): Promise<void> {
      for (let i = 0; i < Math.max(professionals, services); i += 1) {
        const target = await seedTarget();
        if (i < professionals) await save(user, 'professional', target.id).expect(200);
        if (i < services) await save(user, 'service', target.serviceId).expect(200);
      }
    }

    it('costs the same number of target queries for 1 saved item as for 40', async () => {
      const small = await customer();
      const large = await customer();
      await fillSaved(small, 1, 0);
      await fillSaved(large, 20, 20);

      const one = await recordSql(() => listSaved(small, '?limit=50').expect(200));
      const many = await recordSql(() => listSaved(large, '?limit=50').expect(200));

      expect((many.result as request.Response).body.data.items).toHaveLength(40);

      const targetReads = (sql: string[]) => matching(sql, /FROM\s+"?provider"?\./i).length;
      // EXACT counts, not upper bounds. One saved professional costs ONE query
      // (no services in the batch, so that half is skipped entirely); twenty
      // professionals and twenty services cost TWO -- the services, then every
      // professional the answer depends on, named and owning alike, in one `IN`.
      //
      // Verified non-vacuous: with `availableTargets` rewritten as a loop over
      // its argument, this case reports 60 target reads instead of 2 and fails
      // on the line below.
      expect(targetReads(one.sql)).toBe(1);
      expect(targetReads(many.sql)).toBe(2);
      // And exactly ONE read of the saved rows themselves.
      expect(matching(many.sql, /FROM\s+"?wishlist"?\./i)).toHaveLength(1);
    });

    it('costs exactly one saved-state query for a whole page of search results', async () => {
      const user = await customer();
      const targets: SeededProfessional[] = [];
      for (let i = 0; i < 8; i += 1) {
        const target = await seedTarget();
        await index(target.id);
        targets.push(target);
      }
      for (const target of targets) await save(user, 'professional', target.id).expect(200);

      const { result, sql } = await recordSql(() => searchProviders(user, '?pageSize=50').expect(200));
      const items = (result as request.Response).body.data.items as Array<{ saved: boolean | null }>;
      expect(items).toHaveLength(8);
      expect(items.every((i) => i.saved === true)).toBe(true);

      expect(matching(sql, /FROM\s+"?wishlist"?\.\s*"?saved_items"?/i)).toHaveLength(1);
    });

    it('issues NO saved-state query at all for an anonymous caller', async () => {
      // No subject, no query. Asking "which of these has nobody saved" would
      // require inventing a caller.
      const target = await seedTarget();
      await index(target.id);

      const search = await recordSql(() => searchProviders().expect(200));
      expect(matching(search.sql, /wishlist/i)).toEqual([]);

      const view = await recordSql(() => profile(target.id).expect(200));
      expect(matching(view.sql, /wishlist/i)).toEqual([]);

      const services = await recordSql(() => servicesOf(target.id).expect(200));
      expect(matching(services.sql, /wishlist/i)).toEqual([]);
    });

    it('costs one saved-state query for a professional\'s whole service catalogue', async () => {
      const user = await customer();
      const target = await seedTarget();
      for (let i = 0; i < 6; i += 1) {
        await dataSource.query(
          `INSERT INTO provider.services (id, professional_id, name, duration_minutes, price_toman)
           VALUES ($1, $2, $3, 30, 100000)`,
          [uuidv7(), target.id, `خدمت ${i}`],
        );
      }

      const { result, sql } = await recordSql(() => servicesOf(target.id, user).expect(200));
      expect((result as request.Response).body.data).toHaveLength(7);
      expect(matching(sql, /FROM\s+"?wishlist"?\.\s*"?saved_items"?/i)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Pagination stays correct while targets change underneath
  // -------------------------------------------------------------------------

  describe('pagination is stable while target states change', () => {
    it('walks every item exactly once while targets are suspended between pages', async () => {
      const user = await customer();
      const targets: SeededProfessional[] = [];
      for (let i = 0; i < 23; i += 1) {
        const target = await seedTarget();
        await save(user, 'professional', target.id).expect(200);
        targets.push(target);
      }

      const seen: string[] = [];
      const states: string[] = [];
      let cursor: string | null = null;
      let page = 0;
      do {
        const query: string = cursor ? `?limit=5&cursor=${encodeURIComponent(cursor)}` : '?limit=5';
        const res: request.Response = await listSaved(user, query).expect(200);
        for (const item of res.body.data.items as Array<{ targetId: string; state: string }>) {
          seen.push(item.targetId);
          states.push(item.state);
        }
        cursor = res.body.data.nextCursor;
        page += 1;

        // Between every page, change the state of targets on BOTH sides of the
        // cursor. Nothing about target state is in the WHERE clause or the ORDER
        // BY, so this must not move, skip, or duplicate a row.
        await dataSource.query(
          `UPDATE provider.professionals SET verification_status = 'suspended'
            WHERE id = ANY($1::uuid[])`,
          [[targets[page]?.id, targets[targets.length - page]?.id].filter(Boolean)],
        );
        expect(page).toBeLessThan(15); // a cursor that never terminates is a loop, not a failure
      } while (cursor);

      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
      // Every id saved is an id seen — no row was filtered out by going
      // unavailable, which is the tombstone (`V32-DEC-021`).
      expect(new Set(seen)).toEqual(new Set(targets.map((t) => t.id)));
      // And the states are real values, not a constant.
      expect(states.every((s) => (WISHLIST_TARGET_STATES as readonly string[]).includes(s))).toBe(true);
      expect(states).toHaveLength(23);
    });

    it('keeps an unavailable target in its ORIGINAL position rather than filtering it', async () => {
      const user = await customer();
      const older = await seedTarget();
      const middle = await seedTarget();
      const newer = await seedTarget();
      await save(user, 'professional', older.id).expect(200);
      await save(user, 'professional', middle.id).expect(200);
      await save(user, 'professional', newer.id).expect(200);

      await dataSource.query('UPDATE provider.professionals SET deleted_at = now() WHERE id = $1', [middle.id]);

      const items = (await listSaved(user).expect(200)).body.data.items as Array<{ targetId: string; state: string }>;
      expect(items.map((i) => i.targetId)).toEqual([newer.id, middle.id, older.id]);
      expect(items.map((i) => i.state)).toEqual(['available', 'unavailable', 'available']);
    });
  });

  // -------------------------------------------------------------------------
  // 8. The refusal boundary is unchanged
  // -------------------------------------------------------------------------

  describe('missing and inaccessible resources preserve the established refusal', () => {
    it('answers identically for a nonexistent and a soft-deleted professional', async () => {
      const user = await customer();
      const deleted = await seedTarget();
      await dataSource.query('UPDATE provider.professionals SET deleted_at = now() WHERE id = $1', [deleted.id]);

      const nonexistent = await profile(uuidv7(), user).expect(404);
      const gone = await profile(deleted.id, user).expect(404);
      const services = await servicesOf(deleted.id, user).expect(404);

      expect(gone.body).toEqual(nonexistent.body);
      expect(services.body).toEqual(nonexistent.body);
      expect(nonexistent.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
      expect(JSON.stringify(nonexistent.body)).not.toMatch(/deleted|suspended|saved|wishlist/i);
    });

    it('refuses BEFORE consulting the wishlist, so a 404 reveals nothing', async () => {
      const user = await customer();
      const { sql } = await recordSql(() => profile(uuidv7(), user).expect(404));
      expect(matching(sql, /wishlist/i)).toEqual([]);
    });

    it('still refuses to SAVE an unavailable target, with the same one refusal', async () => {
      // Story #8's boundary, re-proved through the absorbed port: `save` now
      // calls the same batch method `list` does, so a regression there would
      // change this answer.
      const user = await customer();
      const suspended = await seedTarget();
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [
        suspended.id,
      ]);

      const missing = await save(user, 'professional', uuidv7()).expect(404);
      const refused = await save(user, 'professional', suspended.id).expect(404);
      const service = await save(user, 'service', suspended.serviceId).expect(404);

      expect(refused.body).toEqual(missing.body);
      expect(service.body).toEqual(missing.body);
    });

    it('reports a saved item as available the moment it is saved', async () => {
      const user = await customer();
      const target = await seedTarget();
      const res = await save(user, 'professional', target.id).expect(200);
      expect(res.body.data.state).toBe('available');
      expect(Object.keys(res.body.data).sort()).toEqual(['savedAt', 'state', 'targetId', 'targetType']);
    });

    it('tells the truth on a repeat save of a target that has since gone away', async () => {
      // The early-return path. It still succeeds — re-sending a save for
      // something already held must not become a way to discover the platform
      // has acted — and it reports the state the caller's own list already
      // shows, rather than a comfortable `available` the next read contradicts.
      const user = await customer();
      const target = await seedTarget();
      await save(user, 'professional', target.id).expect(200);
      await dataSource.query("UPDATE provider.professionals SET verification_status = 'revoked' WHERE id = $1", [
        target.id,
      ]);

      const again = await save(user, 'professional', target.id).expect(200);
      expect(again.body.data.state).toBe('unavailable');
      expect(again.body.data.state).toBe((await listSaved(user).expect(200)).body.data.items[0].state);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Nothing new is emitted, counted, notified, or ranked
  // -------------------------------------------------------------------------

  describe('no event, notification, analytics fact, or ranking signal', () => {
    it('emits nothing when a saved target becomes unavailable', async () => {
      const user = await customer();
      const target = await seedTarget();
      await index(target.id);
      await save(user, 'professional', target.id).expect(200);

      // Clear everything the SETUP legitimately produced, then do the thing.
      await dataSource.query('TRUNCATE notification.notifications, analytics.events');
      const outboxBefore = await outboxCounts();

      await dataSource.query("UPDATE provider.professionals SET verification_status = 'suspended' WHERE id = $1", [
        target.id,
      ]);
      await listSaved(user).expect(200);
      await searchProviders(user).expect(200);
      await profile(target.id, user).expect(200);
      await servicesOf(target.id, user).expect(200);

      // A notification to the customer would disclose a third party's status
      // change; a notification to the professional would publish a private list.
      expect(await countOf('notification.notifications')).toBe(0);
      expect(await countOf('analytics.events')).toBe(0);
      // Search still records its own SearchPerformed fact, which is pre-existing
      // and unrelated — every OTHER outbox must be untouched.
      const outboxAfter = await outboxCounts();
      for (const [table, before] of Object.entries(outboxBefore)) {
        if (table === 'search.outbox_events') continue;
        expect({ table, count: outboxAfter[table] }).toEqual({ table, count: before });
      }
    });

    it('has no wishlist outbox table and no wishlist event contract', async () => {
      const tables = await dataSource.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'wishlist' ORDER BY tablename`,
      );
      expect(tables.map((r: { tablename: string }) => r.tablename)).toEqual(['saved_items']);

      // `ServiceName` is a closed compile-time union that does not contain
      // 'wishlist', so an event whose producer is this module cannot be
      // DECLARED. This checks the catalogue agrees at runtime.
      for (const contract of ALL_EVENT_CONTRACTS) {
        expect(contract.producer).not.toBe('wishlist');
        expect(contract.name.toLowerCase()).not.toMatch(/wishlist|saved|favourite|favorite/);
      }
    });

    it('contributes no ranking signal, so a save cannot move a professional up', async () => {
      const target = await seedTarget();
      await index(target.id);
      const savers = [await customer(), await customer(), await customer(), await customer()];
      for (const saver of savers) await save(saver, 'professional', target.id).expect(200);

      // Four saves, and the ranking tables have not heard of any of them.
      expect(await countOf('search.ranking_signals')).toBe(0);
      expect(await countOf('search.signal_applications')).toBe(0);
      const [doc] = await dataSource.query(
        'SELECT ranking_score, ranking_signal_keys FROM search.provider_documents WHERE professional_id = $1',
        [target.id],
      );
      expect(JSON.stringify(doc.ranking_signal_keys ?? [])).not.toMatch(/save|wishlist|popular/i);

      // And the ordering a saver sees is the ordering everybody sees.
      const anonymous = ((await searchProviders().expect(200)).body.data.items as Array<{ id: string }>).map(
        (i) => i.id,
      );
      const signedIn = ((await searchProviders(savers[0]).expect(200)).body.data.items as Array<{ id: string }>).map(
        (i) => i.id,
      );
      // Non-vacuity first: two empty arrays are equal and prove nothing.
      expect(anonymous).toContain(target.id);
      expect(signedIn).toEqual(anonymous);
    });

    it('hydrates saved state beside the results rather than inside the query', async () => {
      const user = await customer();
      const a = await seedTarget();
      const b = await seedTarget();
      await index(a.id);
      await index(b.id);
      await save(user, 'professional', b.id).expect(200);

      const { sql } = await recordSql(() => searchProviders(user).expect(200));
      const wishlistReads = matching(sql, /wishlist/i);

      // It really did read the wishlist -- otherwise everything below is vacuous.
      expect(wishlistReads).toHaveLength(1);
      // And it read it on its OWN, joined to nothing the engine chose results
      // with. A statement mentioning both would be a saved-state filter, which
      // is how a save starts changing which results a customer sees.
      for (const statement of wishlistReads) {
        expect(statement).not.toMatch(/provider_documents|ranking_signals/i);
      }

      // The observable half: the results and their order are identical for a
      // signed-in caller and an anonymous one.
      const signedIn = ((await searchProviders(user).expect(200)).body.data.items as Array<{ id: string }>).map(
        (i) => i.id,
      );
      const anonymous = ((await searchProviders().expect(200)).body.data.items as Array<{ id: string }>).map(
        (i) => i.id,
      );
      expect(signedIn).toHaveLength(2);
      expect(signedIn).toEqual(anonymous);
    });
  });

  // -------------------------------------------------------------------------
  // Small query helpers, kept at the bottom so the cases above read as prose
  // -------------------------------------------------------------------------

  async function countOf(table: string): Promise<number> {
    const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM ${table}`);
    return count;
  }

  async function outboxCounts(): Promise<Record<string, number>> {
    // `financial` is excluded because the application role cannot even SELECT
    // from that schema (ADR-017) -- reading it here would fail with "permission
    // denied", which is itself the proof that this suite is running as the real
    // application role rather than as a superuser.
    const rows = await dataSource.query(
      `SELECT schemaname || '.' || tablename AS table FROM pg_tables
        WHERE tablename = 'outbox_events' AND schemaname <> 'financial'`,
    );
    const counts: Record<string, number> = {};
    for (const row of rows as Array<{ table: string }>) counts[row.table] = await countOf(row.table);
    return counts;
  }

  // A tiny sanity check that the key helper the whole file rests on is the one
  // the contract exports, rather than a string this suite happens to build.
  it('keys targets exactly as the contract does', () => {
    const id = uuidv7();
    expect(wishlistTargetKey({ targetType: 'service', targetId: id })).toBe(`service:${id}`);
  });
});
