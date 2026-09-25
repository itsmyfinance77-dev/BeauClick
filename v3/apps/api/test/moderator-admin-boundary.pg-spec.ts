import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CAPABILITY_KEY } from '@beauclick/auth';

import { PgTestApp, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const describePg = requiredPgEnv() ? describe : describe.skip;

/**
 * #264 — the server half of "a moderator reaches only the moderation queues".
 *
 * The web change (`52_MODERATOR_LANDING.md`) lets a moderation-only caller into
 * the `/admin` shell. Everything that shell refuses to OFFER them is only a
 * courtesy; this file proves the CONTROL: the `moderator` role is refused on
 * EVERY route gated on `bc_manage_platform` or `bc_manage_commercial_plans`,
 * and admitted to the moderation queues it holds.
 *
 * ## Why the routes are discovered and not listed
 *
 * A hand-written list of "platform routes" is the bug one level up: the route
 * someone adds next month is exactly the one it would miss. The inventory is
 * read from the SAME metadata `CapabilityGuard` reads (handler first, then the
 * class — the guard's `getAllAndOverride` precedence, and the one
 * `AuditEnforcementService` was corrected to in #141), so a new
 * `@RequireCapability('bc_manage_platform')` route is covered the day it lands.
 *
 * ## Why an exact 403, and the controls that make it mean something
 *
 *  - A mis-built path answers 404, not 403, so `=== 403` cannot pass on a
 *    route this file failed to address.
 *  - The same moderator token is ADMITTED (200) to its own queues, so the
 *    refusals are not a broken token or a failed live re-check.
 *  - The discovery must find named routes of both capabilities, so an empty
 *    inventory cannot pass as "nothing refused".
 */
describePg('#264 — moderator admin boundary (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;

  const GUARDED = ['bc_manage_platform', 'bc_manage_commercial_plans'] as const;

  interface GuardedRoute {
    handler: string;
    capability: string;
    method: RequestMethod;
    path: string;
  }

  /** Joins Nest path segments the way the router does, filling `:params` with a fresh id. */
  function routePath(controllerPath: string, handlerPath: string): string {
    const joined = ['api', controllerPath, handlerPath]
      .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
      .filter((segment) => segment.length > 0)
      .join('/');
    return `/${joined}`.replace(/:[A-Za-z0-9_]+/g, () => uuidv7());
  }

  function firstPath(value: unknown): string {
    if (Array.isArray(value)) return String(value[0] ?? '');
    return typeof value === 'string' ? value : '';
  }

  function guardedRoutes(): GuardedRoute[] {
    const discovery = app.get(DiscoveryService, { strict: false });
    const scanner = app.get(MetadataScanner, { strict: false });
    const found: GuardedRoute[] = [];

    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance);
      const controllerPath = firstPath(Reflect.getMetadata(PATH_METADATA, metatype));

      for (const methodName of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== 'function') continue;
        const method: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;
        const capability: string | undefined =
          Reflect.getMetadata(CAPABILITY_KEY, handler) ?? Reflect.getMetadata(CAPABILITY_KEY, metatype);
        if (!capability || !(GUARDED as readonly string[]).includes(capability)) continue;
        found.push({
          handler: `${metatype.name}.${methodName}`,
          capability,
          method,
          path: routePath(controllerPath, firstPath(Reflect.getMetadata(PATH_METADATA, handler))),
        });
      }
    }
    return found;
  }

  function send(route: { method: RequestMethod; path: string }, token: string) {
    const server = request(app.getHttpServer());
    const auth = `Bearer ${token}`;
    switch (route.method) {
      case RequestMethod.GET:
        return server.get(route.path).set('Authorization', auth);
      case RequestMethod.POST:
        return server.post(route.path).set('Authorization', auth).send({});
      case RequestMethod.PUT:
        return server.put(route.path).set('Authorization', auth).send({});
      case RequestMethod.PATCH:
        return server.patch(route.path).set('Authorization', auth).send({});
      case RequestMethod.DELETE:
        return server.delete(route.path).set('Authorization', auth).send({});
      default:
        throw new Error(`unhandled method ${RequestMethod[route.method]} on ${route.path}`);
    }
  }

  /** Every route whose answer to `token` is not exactly 403, as `handler METHOD path → status`. */
  async function notRefused(routes: GuardedRoute[], token: string): Promise<string[]> {
    const offenders: string[] = [];
    for (const route of routes) {
      const res = await send(route, token);
      if (res.status !== 403) offenders.push(`${route.handler} ${RequestMethod[route.method]} ${route.path} → ${res.status}`);
    }
    return offenders;
  }

  const QUEUES = {
    bc_moderate_verification: '/api/v1/admin/verification/queue?page=1&limit=1',
    bc_moderate_media: '/api/v1/admin/media/reports?page=1&limit=1',
    bc_moderate_reviews: '/api/v1/admin/reviews/queue?page=1&limit=1',
    bc_moderate_chat: '/api/v1/admin/chat/reports?limit=50',
  } as const;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  it('SEES the guarded routes of both capabilities — an empty inventory cannot pass as "nothing refused"', () => {
    const routes = guardedRoutes();
    const handlers = routes.map((r) => r.handler);
    expect(routes.filter((r) => r.capability === 'bc_manage_platform').length).toBeGreaterThan(10);
    expect(routes.filter((r) => r.capability === 'bc_manage_commercial_plans').length).toBeGreaterThan(5);
    // Named, so a rename makes somebody look rather than silently shrinking a count.
    expect(handlers).toEqual(
      expect.arrayContaining([
        'AdminAuditController.list',
        'AdminRolesController.mutate',
        'FinancialAdminController.totals',
        'FinancialAdminController.createSettlement',
        'CommercialCatalogueController.listPlans',
      ]),
    );
    // Both verbs: reads (the pages) and writes (what the pages would do).
    expect(routes.some((r) => r.method === RequestMethod.GET)).toBe(true);
    expect(routes.some((r) => r.method !== RequestMethod.GET)).toBe(true);
  });

  it('admits a moderator to the four moderation queues — the refusals below are not a broken token', async () => {
    const moderator = await seedUser(app, dataSource, '+989152640001', ['moderator']);
    for (const path of Object.values(QUEUES)) {
      await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${moderator.accessToken}`).expect(200);
    }
  });

  it('refuses a moderator with 403 on EVERY bc_manage_platform and bc_manage_commercial_plans route', async () => {
    const moderator = await seedUser(app, dataSource, '+989152640002', ['moderator']);
    expect(await notRefused(guardedRoutes(), moderator.accessToken)).toEqual([]);
  });

  it('refuses it even when the token CLAIMS the capability — the privileged re-check reads the database', async () => {
    // A token minted with `bc_manage_platform` the account does not hold: the
    // shape a stale or forged claim would have. `CapabilityGuard` must answer
    // from `identity.user_roles`, not from the claim.
    const moderator = await seedUser(app, dataSource, '+989152640003', ['moderator']);
    const jwt = app.get(JwtService);
    const inflated = jwt.sign({
      sub: moderator.id,
      roles: ['moderator'],
      capabilities: ['bc_moderate_verification', 'bc_moderate_reviews', 'bc_moderate_media', 'bc_moderate_chat', ...GUARDED],
    });
    expect(await notRefused(guardedRoutes(), inflated)).toEqual([]);
  });

  it('holds for a PARTIAL moderator: its own queue only, every other queue and guarded route refused', async () => {
    // The persona matrix: "a subset of bc_moderate_* (for example through a
    // future role); the design must hold for any subset". Roles are data, so a
    // subset role is two rows.
    await dataSource.query(
      `INSERT INTO identity.roles (slug, name, description, is_privileged, is_default)
       VALUES ('test_media_moderator', 'Media moderator (test)', '#264 partial-moderator fixture', true, false)`,
    );
    await dataSource.query(
      `INSERT INTO identity.role_capabilities (role_slug, capability_slug) VALUES ('test_media_moderator', 'bc_moderate_media')`,
    );
    const user = await seedUser(app, dataSource, '+989152640004', ['customer']);
    await dataSource.query(
      `INSERT INTO identity.user_roles (user_id, role_slug, granted_by, reason) VALUES ($1, 'test_media_moderator', NULL, 'test')`,
      [user.id],
    );
    const token = app.get(JwtService).sign({ sub: user.id, roles: ['customer', 'test_media_moderator'], capabilities: ['bc_moderate_media'] });

    const me = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(me.body.data.capabilities).toContain('bc_moderate_media');
    expect(me.body.data.capabilities).not.toContain('bc_moderate_verification');

    await request(app.getHttpServer()).get(QUEUES.bc_moderate_media).set('Authorization', `Bearer ${token}`).expect(200);
    for (const path of [QUEUES.bc_moderate_verification, QUEUES.bc_moderate_reviews, QUEUES.bc_moderate_chat]) {
      await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`).expect(403);
    }
    expect(await notRefused(guardedRoutes(), token)).toEqual([]);
  });

  it('revokes on the next request: /v1/me drops the capability and the queue refuses the SAME token', async () => {
    const moderator = await seedUser(app, dataSource, '+989152640005', ['moderator']);
    const auth = `Bearer ${moderator.accessToken}`;
    await request(app.getHttpServer()).get(QUEUES.bc_moderate_media).set('Authorization', auth).expect(200);

    await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1 AND role_slug = 'moderator'`, [moderator.id]);

    // What the landing re-reads — live, not the token's snapshot.
    const me = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', auth).expect(200);
    for (const capability of Object.keys(QUEUES)) expect(me.body.data.capabilities).not.toContain(capability);
    // And what it would then be refused.
    for (const path of Object.values(QUEUES)) {
      await request(app.getHttpServer()).get(path).set('Authorization', auth).expect(403);
    }
  });
});
