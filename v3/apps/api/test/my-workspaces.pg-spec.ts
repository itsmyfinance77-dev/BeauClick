import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { StaffService } from '@beauclick/business';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedMembership,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() ? describe : describe.skip;

/**
 * `GET /api/v1/me/workspaces` against real PostgreSQL — V3.3 #210.
 *
 * ## What this suite proves
 *
 * That the list is OWNERSHIP and nothing else, against the real rows that make
 * the other answers tempting: an active `business_staff` affiliation (staff and
 * manager), a live `finance_read` grant, a soft-deleted business. And that it
 * is the list the seller routes actually honour — every reference it returns
 * is accepted by the commercial seller routes for its owner, and the same
 * value from another session is refused exactly as a random one is.
 *
 * ## What it deliberately does not re-prove
 *
 * The reference primitive's cryptography (`@beauclick/workspace-reference`'s
 * golden vectors), and each seller route's own authority suite. This suite
 * only joins the list to them.
 */
describePg('ownership-scoped seller workspace list (real PostgreSQL, #210)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let staff: StaffService;

  let sequence = 0;
  const nextPhone = (): string => `+98917${String(100000 + (sequence += 1)).slice(-6)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    staff = app.get(StaffService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  // ------------------------------------------------------------------ HTTP

  const api = () => request(app.getHttpServer());
  const auth = (user: SeededUser) => ({ Authorization: `Bearer ${user.accessToken}` });
  const get = (path: string, user?: SeededUser) => {
    const req = api().get(`/api/v1${path}`);
    return user ? req.set(auth(user)) : req;
  };

  interface Entry {
    workspaceRef: string;
    workspaceType: 'professional' | 'business';
    displayLabel: string;
  }

  const myWorkspaces = async (user: SeededUser): Promise<Entry[]> => (await get('/me/workspaces', user).expect(200)).body.data.items;

  /** The seller read routes a listed reference is handed to. All three resolve through ownership. */
  const sellerReads = (ref: string) => [
    `/me/outcome-policy-assignments/${ref}`,
    `/me/collection-policy-assignments/${ref}`,
    `/me/subscriptions/${ref}/history`,
  ];

  // --------------------------------------------------------------- fixtures

  async function dualOwner() {
    const user = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
    const professional = await seedProfessional(dataSource, user.id, 'نگار');
    const business = await seedBusiness(dataSource, user.id, 'سالن نگار');
    return { user, professional, business };
  }

  /** A professional who is also an ACTIVE member of someone else's salon. */
  async function affiliatedPractitioner(businessId: string, ownerId: string, role: 'staff' | 'manager') {
    const user = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, user.id, 'آرایشگر');
    const membershipId = await seedMembership(dataSource, businessId, user.id, role, ownerId, professional.id);
    await staff.accept(membershipId, user.id);
    return { user, professional, membershipId };
  }

  // ===================================================================== list

  it('refuses an unauthenticated caller', async () => {
    await get('/me/workspaces').expect(401);
  });

  it('answers a customer who owns nothing with an empty collection, not a 404', async () => {
    const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const res = await get('/me/workspaces', customer).expect(200);
    expect(res.body.data).toEqual({ items: [] });
  });

  it('lists a dual owner both workspaces, in order, with exactly reference, type and public name', async () => {
    const { user, professional, business } = await dualOwner();
    const res = await get('/me/workspaces', user).expect(200);

    expect(res.headers['cache-control']).toBe('private, no-store');

    const items: Entry[] = res.body.data.items;
    expect(items.map((entry) => [entry.workspaceType, entry.displayLabel])).toEqual([
      ['business', 'سالن نگار'],
      ['professional', 'نگار'],
    ]);
    for (const entry of items) {
      expect(Object.keys(entry).sort()).toEqual(['displayLabel', 'workspaceRef', 'workspaceType']);
      expect(entry.workspaceRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }

    // No identifier of any kind leaves.
    const body = JSON.stringify(res.body);
    for (const id of [user.id, professional.id, business.id, professional.serviceId]) expect(body).not.toContain(id);
  });

  it('is stable across calls and byte-identical to the owner entries of the finance list', async () => {
    const { user } = await dualOwner();
    const first = await myWorkspaces(user);
    expect(await myWorkspaces(user)).toEqual(first);

    // One primitive, one secret: the owner's reference to a party is the same
    // value on every seller surface, so a client never holds two for one party.
    const finance = (await get('/me/finance/workspaces', user).expect(200)).body.data.items as Array<
      Entry & { accessMode: string }
    >;
    expect(finance.map(({ workspaceRef, workspaceType, displayLabel }) => ({ workspaceRef, workspaceType, displayLabel }))).toEqual(
      first,
    );
  });

  it('refuses any query parameter', async () => {
    const { user } = await dualOwner();
    await get('/me/workspaces?accessMode=finance_read', user).expect(400);
    await get('/me/workspaces?include=capabilities', user).expect(400);
  });

  // ============================================================ ownership only

  it('gives an affiliated staff member or manager their own professional workspace and never the employer', async () => {
    const owner = await dualOwner();
    for (const role of ['staff', 'manager'] as const) {
      const member = await affiliatedPractitioner(owner.business.id, owner.user.id, role);
      const items = await myWorkspaces(member.user);
      expect(items.map((entry) => [entry.workspaceType, entry.displayLabel])).toEqual([['professional', 'آرایشگر']]);
    }
  });

  it('gives a finance_read grantee nothing, although the finance list reaches the business', async () => {
    const owner = await dualOwner();
    const bookkeeper = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const membershipId = await seedMembership(dataSource, owner.business.id, bookkeeper.id, 'staff', owner.user.id, null);
    await staff.accept(membershipId, bookkeeper.id);
    await api()
      .post(`/api/v1/businesses/${owner.business.id}/staff/${membershipId}/grants`)
      .set(auth(owner.user))
      .send({ role: 'finance_read' })
      .expect(201);

    // Non-vacuity: the grant is live — the finance list does reach the business.
    const finance = (await get('/me/finance/workspaces', bookkeeper).expect(200)).body.data.items;
    expect(finance.map((entry: { accessMode: string }) => entry.accessMode)).toEqual(['finance_read']);

    expect(await myWorkspaces(bookkeeper)).toEqual([]);
  });

  it('drops a workspace on the next request once it is soft-deleted, under the same token', async () => {
    const { user, business } = await dualOwner();
    expect((await myWorkspaces(user)).map((entry) => entry.workspaceType)).toEqual(['business', 'professional']);

    await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [business.id]);
    expect((await myWorkspaces(user)).map((entry) => entry.workspaceType)).toEqual(['professional']);
  });

  // ======================================================= the routes honour it

  it('hands out only references the seller routes accept for their owner', async () => {
    const { user } = await dualOwner();
    for (const entry of await myWorkspaces(user)) {
      for (const path of sellerReads(entry.workspaceRef)) {
        await get(path, user).expect(200);
      }
    }
  });

  it('a listed reference is inert in another session: refused exactly as a random value is', async () => {
    const { user } = await dualOwner();
    const other = await dualOwner();
    const random = 'A'.repeat(43);

    for (const entry of await myWorkspaces(user)) {
      for (const [foreignPath, randomPath] of sellerReads(entry.workspaceRef).map(
        (path, index) => [path, sellerReads(random)[index]] as const,
      )) {
        const foreign = await get(foreignPath, other.user);
        const control = await get(randomPath, other.user);
        expect(foreign.status).toBeGreaterThanOrEqual(400);
        expect(foreign.status).toBe(control.status);
        expect(foreign.body).toEqual(control.body);
      }
    }
  });
});
