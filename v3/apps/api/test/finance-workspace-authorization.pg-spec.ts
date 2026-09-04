import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  FinanceWorkspaceService,
  LedgerService,
  MyFinanceController,
  MyFinanceService,
  SettlementService,
} from '@beauclick/financial';
import { assertNoLeak } from '@beauclick/testing';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  financialOwnerUrl,
  requireFinancialOwnerUrl,
  requiredPgEnv,
  resetDatabase,
  resetFinancial,
  seedBusiness,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const OWNER_URL = financialOwnerUrl();
const describePg = requiredPgEnv() && OWNER_URL ? describe : describe.skip;

/**
 * Finance read authorization against real PostgreSQL — V3.3 #72,
 * `V33-DEC-020`.
 *
 * ## The two defects this suite exists to close
 *
 * `/api/v1/me/finance` decided who may READ a financial record by asking whose
 * money it is. That answer follows an active `business_staff` affiliation —
 * correct for attribution (ADR-023 §3), wrong for permission — and one boundary
 * produced two defects:
 *
 *  1. a dual owner was resolved business-first, so their professional
 *     receivables, settlements and ledger were reachable through no route;
 *  2. an affiliated staff professional read the EMPLOYING business's whole
 *     financial position.
 *
 * ## Why the evidence has to be here
 *
 * Every claim is about a REQUEST meeting real rows: that an affiliated
 * professional enumerates no employer workspace, that a dual owner reaches both
 * of theirs separately, that refusals are byte-identical over HTTP, that a
 * cursor cannot cross workspaces, that nothing is written. pg-mem honours no
 * ROLLBACK and has no real grants, so none of it is observable there.
 *
 * ## Distinguishable amounts, everywhere
 *
 * Each seeded party earns a distinct figure, so a leak is unmistakable in a
 * whole-body comparison rather than a matter of reading which number came back.
 */
describePg('finance workspace authorization (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let ledger: LedgerService;
  let settlements: SettlementService;
  let workspaces: FinanceWorkspaceService;
  let myFinance: MyFinanceService;

  let sequence = 0;
  const nextPhone = (): string => `+98915${String(100000 + (sequence += 1)).slice(-6)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    ledger = app.get(LedgerService);
    settlements = app.get(SettlementService);
    workspaces = app.get(FinanceWorkspaceService);
    myFinance = app.get(MyFinanceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    await resetFinancial(requireFinancialOwnerUrl());
  });

  // =======================================================================
  // Builders
  // =======================================================================

  /** 15% commission, so a payment of N leaves a receivable of N * 0.85. */
  const receivableOf = (paid: number) => paid - Math.round(paid * 0.15);

  async function earn(partyType: 'professional' | 'business', partyId: string, paid: number): Promise<string> {
    const orderId = uuidv7();
    await ledger.recordPayment({
      orderId,
      sourceId: null,
      sellerPartyType: partyType,
      sellerPartyId: partyId,
      netAmountToman: paid,
      paymentReferenceId: uuidv7(),
    });
    return orderId;
  }

  async function soloProfessional(paid = 1_100_000) {
    const user = await seedUser(app, dataSource, nextPhone(), ['professional']);
    const professional = await seedProfessional(dataSource, user.id, 'متخصص مستقل');
    const orderId = await earn('professional', professional.id, paid);
    return { user, partyId: professional.id, orderId, receivable: receivableOf(paid) };
  }

  async function businessOwner(paid = 2_200_000) {
    const user = await seedUser(app, dataSource, nextPhone(), ['business']);
    const business = await seedBusiness(dataSource, user.id, 'کسب‌وکار');
    const orderId = await earn('business', business.id, paid);
    return { user, partyId: business.id, orderId, receivable: receivableOf(paid) };
  }

  /** One user owning BOTH a professional and a business — the case that has no singular answer. */
  async function dualOwner(professionalPaid = 3_300_000, businessPaid = 4_400_000) {
    const user = await seedUser(app, dataSource, nextPhone(), ['professional', 'business']);
    const professional = await seedProfessional(dataSource, user.id, 'متخصص دوگانه');
    const business = await seedBusiness(dataSource, user.id, 'کسب‌وکار دوگانه');
    const professionalOrder = await earn('professional', professional.id, professionalPaid);
    const businessOrder = await earn('business', business.id, businessPaid);
    return {
      user,
      professionalId: professional.id,
      businessId: business.id,
      professionalOrder,
      businessOrder,
      professionalReceivable: receivableOf(professionalPaid),
      businessReceivable: receivableOf(businessPaid),
    };
  }

  /**
   * A professional who OWNS their own profile and is an ACTIVE staff member of
   * somebody else's business.
   *
   * The employer earns a distinguishable amount so any disclosure is visible,
   * and the staff professional earns a smaller one of their own so "shows their
   * own workspace" can be told apart from "shows nothing at all".
   */
  async function affiliatedStaff(employerPaid = 5_500_000, ownPaid = 660_000) {
    const employer = await businessOwner(employerPaid);
    const staff = await seedUser(app, dataSource, nextPhone(), ['professional']);
    const professional = await seedProfessional(dataSource, staff.id, 'کارمند');
    await dataSource.query(
      `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
       VALUES ($1, $2, $3, $4, 'manager', 'active', $5)`,
      [uuidv7(), employer.partyId, staff.id, professional.id, employer.user.id],
    );
    const ownOrder = await earn('professional', professional.id, ownPaid);
    return {
      employer,
      staff,
      professionalId: professional.id,
      ownOrder,
      ownReceivable: receivableOf(ownPaid),
    };
  }

  // ------------------------------------------------------------------ HTTP

  const get = (path: string, user?: SeededUser) => {
    const req = request(app.getHttpServer()).get(`/api/v1${path}`);
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  };

  interface WorkspaceEntry {
    workspaceRef: string;
    workspaceType: string;
  }

  const listWorkspaces = async (user: SeededUser): Promise<WorkspaceEntry[]> =>
    (await get('/me/finance/workspaces', user).expect(200)).body.data.items;

  const refFor = async (user: SeededUser, type: 'professional' | 'business'): Promise<string> => {
    const found = (await listWorkspaces(user)).find((entry) => entry.workspaceType === type);
    if (!found) throw new Error(`no ${type} workspace for this caller — the fixture is wrong, not the assertion`);
    return found.workspaceRef;
  };

  // ------------------------------------------------------------------ rows

  const financialCounts = async (): Promise<Record<string, number>> => {
    const [row] = await ctx.financialDataSource.query(`
      SELECT (SELECT count(*) FROM financial.ledger_entries)     AS ledger,
             (SELECT count(*) FROM financial.settlement_batches) AS batches,
             (SELECT count(*) FROM financial.settlement_items)   AS items,
             (SELECT count(*) FROM financial.outbox_events)      AS outbox
    `);
    return { ledger: Number(row.ledger), batches: Number(row.batches), items: Number(row.items), outbox: Number(row.outbox) };
  };

  const applicationCounts = async (): Promise<Record<string, number>> => {
    const [row] = await dataSource.query(`
      SELECT (SELECT count(*) FROM admin.admin_audit_log)           AS audits,
             (SELECT count(*) FROM commercial.seller_subscriptions) AS subscriptions,
             (SELECT count(*) FROM commercial.booking_credit_grants) AS grants,
             (SELECT count(*) FROM payment.payment_intents)         AS intents,
             (SELECT count(*) FROM commerce.orders)                 AS orders,
             (SELECT count(*) FROM notification.notifications)      AS notifications
    `);
    return {
      audits: Number(row.audits),
      subscriptions: Number(row.subscriptions),
      grants: Number(row.grants),
      intents: Number(row.intents),
      orders: Number(row.orders),
      notifications: Number(row.notifications),
    };
  };

  // =======================================================================
  // §1. The two defects
  // =======================================================================

  describe('§1 the defects, closed', () => {
    it('gives a dual owner BOTH workspaces, where the old resolver gave one', async () => {
      const owner = await dualOwner();

      const entries = await listWorkspaces(owner.user);

      expect(entries.map((e) => e.workspaceType)).toEqual(['business', 'professional']);
      expect(new Set(entries.map((e) => e.workspaceRef)).size).toBe(2);
    });

    it('lets a dual owner read each workspace separately, with no merging', async () => {
      const owner = await dualOwner();

      const professional = (await get(`/me/finance/${await refFor(owner.user, 'professional')}/summary`, owner.user).expect(200))
        .body.data;
      const business = (await get(`/me/finance/${await refFor(owner.user, 'business')}/summary`, owner.user).expect(200))
        .body.data;

      expect(professional.receivableNetToman).toBe(owner.professionalReceivable);
      expect(business.receivableNetToman).toBe(owner.businessReceivable);

      // Neither figure appears in the other's whole response body, and neither
      // equals the sum — a merge would show up as either.
      assertNoLeak(professional, String(owner.businessReceivable));
      assertNoLeak(business, String(owner.professionalReceivable));
      for (const summary of [professional, business]) {
        expect(summary.receivableNetToman).not.toBe(owner.professionalReceivable + owner.businessReceivable);
      }
    });

    it('gives an affiliated staff professional their OWN workspace and not the employer', async () => {
      const { employer, staff, ownReceivable } = await affiliatedStaff();

      const entries = await listWorkspaces(staff);
      const employerRef = await refFor(employer.user, 'business');

      // Their own professional workspace, and nothing else.
      expect(entries).toHaveLength(1);
      expect(entries[0].workspaceType).toBe('professional');
      expect(entries[0].workspaceRef).not.toBe(employerRef);

      // Which shows their own earnings — so "restricted to their own" is
      // distinguishable from "shows nothing at all".
      const own = (await get(`/me/finance/${entries[0].workspaceRef}/summary`, staff).expect(200)).body.data;
      expect(own.partyType).toBe('professional');
      expect(own.receivableNetToman).toBe(ownReceivable);
      assertNoLeak(own, String(employer.receivable));
    });

    it("refuses a staff professional the employer's workspace on every route", async () => {
      const { employer, staff } = await affiliatedStaff();
      const employerRef = await refFor(employer.user, 'business');

      // The reference is real and correctly signed. It is inert for this
      // session, because it does not belong to a party they own.
      for (const path of [
        `/me/finance/${employerRef}/summary`,
        `/me/finance/${employerRef}/outstanding-orders`,
        `/me/finance/${employerRef}/settlements`,
        `/me/finance/${employerRef}/orders/${employer.orderId}/ledger`,
      ]) {
        await get(path, staff).expect(404);
      }

      // The positive control: the employer themselves still reads it.
      const owner = (await get(`/me/finance/${employerRef}/summary`, employer.user).expect(200)).body.data;
      expect(owner.receivableNetToman).toBe(employer.receivable);
    });

    it('leaves the beneficiary answer alone — affiliation still decides whose money it is', async () => {
      /*
       * The half of ADR-023 that must NOT change. An affiliated professional's
       * earnings genuinely belong to the business, and #72 corrects who may
       * READ, never who is paid.
       */
      const { employer, professionalId } = await affiliatedStaff();

      const resolver = app.get<{ resolveForUser(id: string): Promise<{ partyType: string; partyId: string } | null> }>(
        (await import('@beauclick/financial')).FINANCIAL_PARTY_RESOLVER,
      );
      const staffUser = await dataSource.query(`SELECT user_id FROM business.business_staff WHERE professional_id = $1`, [
        professionalId,
      ]);
      const beneficiary = await resolver.resolveForUser(staffUser[0].user_id);

      expect(beneficiary).toEqual({ partyType: 'business', partyId: employer.partyId });
    });

    it('does not rewrite a historical ledger row when an affiliation changes', async () => {
      const { staff, professionalId, ownOrder, employer } = await affiliatedStaff();

      const before = await ctx.financialDataSource.query(
        `SELECT id, party_type, party_id, amount_toman FROM financial.ledger_entries ORDER BY id`,
      );

      await dataSource.query(`UPDATE business.business_staff SET status = 'inactive' WHERE professional_id = $1`, [
        professionalId,
      ]);

      // Byte-identical rows: `party_id` is written onto the row at payment time
      // and the ledger is append-only, so leaving a business cannot retroactively
      // move earnings.
      expect(
        await ctx.financialDataSource.query(
          `SELECT id, party_type, party_id, amount_toman FROM financial.ledger_entries ORDER BY id`,
        ),
      ).toEqual(before);

      // And the read surface still shows the staff member only their own party.
      const entries = await listWorkspaces(staff);
      expect(entries).toHaveLength(1);
      expect(entries[0].workspaceRef).not.toBe(await refFor(employer.user, 'business'));
      expect(ownOrder).toBeTruthy();
    });
  });

  // =======================================================================
  // §2. Everyone who was already correct, still is
  // =======================================================================

  describe('§2 unchanged callers', () => {
    it('an independent professional reads their own finance on both surfaces', async () => {
      const solo = await soloProfessional();

      const legacy = (await get('/me/finance/summary', solo.user).expect(200)).body.data;
      const scoped = (await get(`/me/finance/${await refFor(solo.user, 'professional')}/summary`, solo.user).expect(200))
        .body.data;

      expect(legacy.receivableNetToman).toBe(solo.receivable);
      // The workspace-aware route answers identically for a single-workspace
      // owner: same shape, same figures, same currency.
      expect(scoped).toEqual(legacy);
    });

    it('a business owner reads the business finance on both surfaces', async () => {
      const owner = await businessOwner();

      const legacy = (await get('/me/finance/summary', owner.user).expect(200)).body.data;
      expect(legacy.partyType).toBe('business');
      expect(legacy.receivableNetToman).toBe(owner.receivable);
      expect((await get(`/me/finance/${await refFor(owner.user, 'business')}/summary`, owner.user).expect(200)).body.data).toEqual(
        legacy,
      );
    });

    it('a caller who owns nothing gets the unchanged refusal, and an empty collection', async () => {
      const customer = await seedUser(app, dataSource, nextPhone(), ['professional']);

      // The legacy refusal is preserved exactly.
      await get('/me/finance/summary', customer).expect(404);
      await get('/me/finance/outstanding-orders', customer).expect(404);
      await get('/me/finance/settlements', customer).expect(404);
      await get(`/me/finance/orders/${uuidv7()}/ledger`, customer).expect(404);
      expect(await myFinance.mySummary(customer.id)).toBeNull();

      // The collection is `[]`, never a 404: owning no workspace is a
      // legitimate state, not a missing resource.
      expect(await listWorkspaces(customer)).toEqual([]);
    });
  });

  // =======================================================================
  // §3. Singular-route compatibility
  // =======================================================================

  describe('§3 the singular routes', () => {
    it('refuses a dual owner with the ratified code rather than choosing', async () => {
      const owner = await dualOwner();

      for (const path of ['/me/finance/summary', '/me/finance/outstanding-orders', '/me/finance/settlements']) {
        const res = await get(path, owner.user).expect(409);
        expect(res.body.error.code).toBe('finance_workspace_selection_required');
      }
      const ledgerRes = await get(`/me/finance/orders/${owner.professionalOrder}/ledger`, owner.user).expect(409);
      expect(ledgerRes.body.error.code).toBe('finance_workspace_selection_required');
    });

    it('discloses no figure, count or party in that refusal', async () => {
      const owner = await dualOwner();

      const res = await get('/me/finance/summary', owner.user).expect(409);

      // The caller learns they own more than one workspace — which they already
      // knew — and nothing else.
      expect(res.body.error.details).toBeUndefined();
      for (const secretish of [
        owner.professionalId,
        owner.businessId,
        owner.user.id,
        String(owner.professionalReceivable),
        String(owner.businessReceivable),
      ]) {
        assertNoLeak(res.body, secretish);
      }
    });

    it('never silently selects a party for a dual owner', async () => {
      // The property stated as an absence: no legacy route returns 200 for a
      // caller who owns two, by any resolution order.
      const owner = await dualOwner();

      const statuses = await Promise.all(
        ['/me/finance/summary', '/me/finance/outstanding-orders', '/me/finance/settlements'].map(async (path) =>
          (await get(path, owner.user)).status,
        ),
      );
      expect(statuses).toEqual([409, 409, 409]);
    });

    it('serves an affiliated staff professional their OWN figures on the legacy route', async () => {
      const { staff, ownReceivable, employer } = await affiliatedStaff();

      const summary = (await get('/me/finance/summary', staff).expect(200)).body.data;

      expect(summary.partyType).toBe('professional');
      expect(summary.receivableNetToman).toBe(ownReceivable);
      assertNoLeak(summary, String(employer.receivable));
    });

    it('shows a truthful zero rather than falling back to the employer', async () => {
      /*
       * `V33-DEC-020` accepts this outcome explicitly: an affiliated
       * professional with no personal earnings sees zero, and the server must
       * not substitute the employer's figures to avoid an empty screen.
       */
      const employer = await businessOwner(7_700_000);
      const staff = await seedUser(app, dataSource, nextPhone(), ['professional']);
      const professional = await seedProfessional(dataSource, staff.id, 'کارمند بدون درآمد');
      await dataSource.query(
        `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
         VALUES ($1, $2, $3, $4, 'staff', 'active', $5)`,
        [uuidv7(), employer.partyId, staff.id, professional.id, employer.user.id],
      );

      const summary = (await get('/me/finance/summary', staff).expect(200)).body.data;

      expect(summary).toEqual({
        partyType: 'professional',
        receivableNetToman: 0,
        settledToman: 0,
        outstandingToman: 0,
        currency: 'IRT',
      });
      assertNoLeak(summary, String(employer.receivable));
    });
  });

  // =======================================================================
  // §4. Refusals
  // =======================================================================

  describe('§4 one refusal, byte for byte', () => {
    it('answers malformed, random, foreign, stale and unmatched references identically', async () => {
      const owner = await dualOwner();
      const stranger = await soloProfessional();

      const foreign = await refFor(stranger.user, 'professional');
      const businessRef = await refFor(owner.user, 'business');

      const candidates = [
        'not-a-reference',
        'A'.repeat(42),
        'A'.repeat(44),
        'A'.repeat(43),
        `${'A'.repeat(42)}+`,
        owner.professionalId,
        owner.user.id,
        foreign,
      ];

      const responses = [];
      for (const candidate of candidates) {
        responses.push(await get(`/me/finance/${encodeURIComponent(candidate)}/summary`, owner.user));
      }

      // Stale: a reference for a workspace the caller owned a moment ago.
      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [owner.businessId]);
      responses.push(await get(`/me/finance/${businessRef}/summary`, owner.user));

      const [first, ...rest] = responses;
      expect(first.status).toBe(404);
      for (const res of rest) {
        expect(res.status).toBe(first.status);
        // BYTE-identical, not merely the same code: a different message,
        // `details` or key order is a distinguishable response, and
        // distinguishable is all an enumeration oracle needs.
        expect(JSON.stringify(res.body)).toBe(JSON.stringify(first.body));
      }
      expect(first.body).toEqual({
        data: null,
        meta: null,
        error: { code: 'NOT_FOUND_OR_NOT_YOURS', message: expect.any(String) },
      });

      // The positive control. Without it every assertion above would pass
      // against a route that refused everything, including a valid reference.
      await get(`/me/finance/${await refFor(owner.user, 'professional')}/summary`, owner.user).expect(200);
    });

    it('makes a stolen reference useless to another caller', async () => {
      const victim = await soloProfessional();
      const thief = await soloProfessional();

      const stolen = await refFor(victim.user, 'professional');

      const refused = await get(`/me/finance/${stolen}/summary`, thief.user).expect(404);
      const rubbish = await get(`/me/finance/${'B'.repeat(43)}/summary`, thief.user).expect(404);

      // A correctly-signed reference for a real party is indistinguishable from
      // a random string, so the thief cannot even confirm it was genuine.
      expect(JSON.stringify(refused.body)).toBe(JSON.stringify(rubbish.body));
      // And the victim is unaffected.
      expect((await get(`/me/finance/${stolen}/summary`, victim.user).expect(200)).body.data.receivableNetToman).toBe(
        victim.receivable,
      );
    });

    it('exposes no raw identity in any successful response', async () => {
      const owner = await dualOwner();
      const professionalRef = await refFor(owner.user, 'professional');

      const bodies = [
        (await get('/me/finance/workspaces', owner.user).expect(200)).body,
        (await get(`/me/finance/${professionalRef}/summary`, owner.user).expect(200)).body,
        (await get(`/me/finance/${professionalRef}/outstanding-orders`, owner.user).expect(200)).body,
        (await get(`/me/finance/${professionalRef}/settlements`, owner.user).expect(200)).body,
      ];

      for (const body of bodies) {
        for (const identifier of [owner.user.id, owner.professionalId, owner.businessId, owner.user.phone]) {
          assertNoLeak(body, identifier);
        }
      }
    });
  });

  // =======================================================================
  // §5. Authentication
  // =======================================================================

  describe('§5 authentication', () => {
    it('refuses all nine finance routes without a token', async () => {
      const ref = 'A'.repeat(43);
      const orderId = uuidv7();

      for (const path of [
        '/me/finance/workspaces',
        `/me/finance/${ref}/summary`,
        `/me/finance/${ref}/outstanding-orders`,
        `/me/finance/${ref}/settlements`,
        `/me/finance/${ref}/orders/${orderId}/ledger`,
        '/me/finance/summary',
        '/me/finance/outstanding-orders',
        '/me/finance/settlements',
        `/me/finance/orders/${orderId}/ledger`,
      ]) {
        await get(path).expect(401);
      }

      // The control that proves the nine above are real routes rather than
      // 401s produced by a catch-all.
      await get('/me/finance/no-such-route/at/all').expect(404);
    });
  });

  // =======================================================================
  // §6. Order and cursor isolation
  // =======================================================================

  describe('§6 cross-workspace isolation', () => {
    it("makes another workspace's order id indistinguishable from a missing one", async () => {
      const owner = await dualOwner();
      const professionalRef = await refFor(owner.user, 'professional');

      const foreignOrder = (
        await get(`/me/finance/${professionalRef}/orders/${owner.businessOrder}/ledger`, owner.user).expect(200)
      ).body;
      const missingOrder = (
        await get(`/me/finance/${professionalRef}/orders/${uuidv7()}/ledger`, owner.user).expect(200)
      ).body;

      // Both empty, and byte-identical: knowing a real order id from the other
      // workspace buys nothing.
      expect(foreignOrder.data).toEqual([]);
      expect(JSON.stringify(foreignOrder)).toBe(JSON.stringify(missingOrder));

      // The positive control: the workspace's OWN order does return rows.
      const own = (
        await get(`/me/finance/${professionalRef}/orders/${owner.professionalOrder}/ledger`, owner.user).expect(200)
      ).body.data;
      expect(own.length).toBeGreaterThan(0);
      // And the platform's commission row is not among them.
      expect(own.every((entry: { entryType: string }) => entry.entryType === 'receivable')).toBe(true);
    });

    it('rejects a cursor issued by the other workspace', async () => {
      const owner = await dualOwner();
      const professionalRef = await refFor(owner.user, 'professional');
      const businessRef = await refFor(owner.user, 'business');

      // Two settlements per workspace, so a page of one leaves a cursor.
      for (const [type, partyId, orderId] of [
        ['professional', owner.professionalId, owner.professionalOrder],
        ['business', owner.businessId, owner.businessOrder],
      ] as const) {
        await settlements.createSettlement({
          partyType: type,
          partyId,
          orderIds: [orderId],
          method: null,
          reference: null,
          note: null,
          actorId: owner.user.id,
        });
      }

      const businessPage = (
        await get(`/me/finance/${businessRef}/settlements?limit=1`, owner.user).expect(200)
      ).body.data;
      const professionalPage = (
        await get(`/me/finance/${professionalRef}/settlements?limit=1`, owner.user).expect(200)
      ).body.data;

      expect(businessPage.items).toHaveLength(1);
      expect(professionalPage.items).toHaveLength(1);

      // A cursor is only valid for the workspace that issued it. Both
      // directions, so neither is a special case.
      const businessCursor = encodeURIComponent(
        Buffer.from(`${businessRef}.${businessPage.items[0].id}`, 'utf8').toString('base64url'),
      );
      const professionalCursor = encodeURIComponent(
        Buffer.from(`${professionalRef}.${professionalPage.items[0].id}`, 'utf8').toString('base64url'),
      );

      await get(`/me/finance/${professionalRef}/settlements?cursor=${businessCursor}`, owner.user).expect(404);
      await get(`/me/finance/${businessRef}/settlements?cursor=${professionalCursor}`, owner.user).expect(404);

      // The positive control: each workspace accepts its OWN cursor.
      await get(`/me/finance/${professionalRef}/settlements?cursor=${professionalCursor}`, owner.user).expect(200);
      await get(`/me/finance/${businessRef}/settlements?cursor=${businessCursor}`, owner.user).expect(200);
    });

    it('pages settlements stably and bounded', async () => {
      const solo = await soloProfessional();
      const ref = await refFor(solo.user, 'professional');

      // Three settled orders, so two pages of two.
      const orderIds = [solo.orderId, await earn('professional', solo.partyId, 500_000), await earn('professional', solo.partyId, 600_000)];
      for (const orderId of orderIds) {
        await settlements.createSettlement({
          partyType: 'professional',
          partyId: solo.partyId,
          orderIds: [orderId],
          method: null,
          reference: null,
          note: null,
          actorId: solo.user.id,
        });
      }

      const first = (await get(`/me/finance/${ref}/settlements?limit=2`, solo.user).expect(200)).body.data;
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = (
        await get(`/me/finance/${ref}/settlements?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, solo.user).expect(
          200,
        )
      ).body.data;

      expect(second.items).toHaveLength(1);
      // Last page: `nextCursor` is null rather than a cursor onto nothing.
      expect(second.nextCursor).toBeNull();

      // Newest first, no overlap, no gap.
      const ids = [...first.items, ...second.items].map((b: { id: string }) => b.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids).toEqual([...ids].sort().reverse());
    });
  });

  // =======================================================================
  // §7. Query scoping, counts and writes
  // =======================================================================

  describe('§7 scoping, cost and side effects', () => {
    it('scopes every financial statement by party type and party id', async () => {
      /*
       * Read from the DATABASE's own view of what ran, not from the source.
       * `pg_stat_statements` is not installed here, so the logger is the seam —
       * and the assertion is that no statement touching a financial table
       * reaches it without both predicates.
       */
      const owner = await dualOwner();
      const ref = await refFor(owner.user, 'professional');

      const statements: string[] = [];
      const original = ctx.financialDataSource.logger;
      try {
        ctx.financialDataSource.logger = {
          logQuery: (query: string) => statements.push(query),
          logQueryError: () => undefined,
          logQuerySlow: () => undefined,
          logSchemaBuild: () => undefined,
          logMigration: () => undefined,
          log: () => undefined,
        } as never;

        await get(`/me/finance/${ref}/summary`, owner.user).expect(200);
        await get(`/me/finance/${ref}/outstanding-orders`, owner.user).expect(200);
        await get(`/me/finance/${ref}/settlements`, owner.user).expect(200);
        await get(`/me/finance/${ref}/orders/${owner.professionalOrder}/ledger`, owner.user).expect(200);
      } finally {
        ctx.financialDataSource.logger = original;
      }

      // Matched on the TABLE name alone, not on `financial.<table>`: TypeORM
      // quotes schema-qualified identifiers as `"financial"."ledger_entries"`,
      // so a pattern anchored on the unquoted form silently sees only the
      // hand-written SQL and misses every query-builder statement — which is
      // most of them, and exactly the half worth checking.
      const financial = statements.filter((sql) => /(ledger_entries|settlement_batches|settlement_items)/i.test(sql));
      // The discovery half: statements really were captured, from BOTH the raw
      // queries and the repository ones.
      expect(financial.length).toBeGreaterThanOrEqual(5);

      const unscoped = financial.filter((sql) => !/party_type/i.test(sql) || !/party_id/i.test(sql));
      // `settlement_items` is reached only through a correlated subquery on an
      // already party-scoped outer query, so every statement carries both.
      expect(unscoped).toEqual([]);
    });

    it('costs the same number of queries for one workspace and for two', async () => {
      /*
       * Not "assert the count is N". A magic number fails when an unrelated
       * query is added and passes when the fixture is small — it tests the
       * constant rather than the growth. One workspace against two tests the
       * growth directly.
       */
      const solo = await soloProfessional();
      const dual = await dualOwner();

      const count = async (path: string, user: SeededUser): Promise<number> => {
        let queries = 0;
        const counting = {
          logQuery: () => {
            queries += 1;
          },
          logQueryError: () => undefined,
          logQuerySlow: () => undefined,
          logSchemaBuild: () => undefined,
          logMigration: () => undefined,
          log: () => undefined,
        } as never;
        const appOriginal = dataSource.logger;
        const finOriginal = ctx.financialDataSource.logger;
        try {
          dataSource.logger = counting;
          ctx.financialDataSource.logger = counting;
          await get(path, user).expect(200);
        } finally {
          dataSource.logger = appOriginal;
          ctx.financialDataSource.logger = finOriginal;
        }
        return queries;
      };

      // The COLLECTION is where an N+1 would actually grow: it is the one route
      // that touches every owned workspace, so a per-workspace lookup added to
      // it costs one extra query per workspace and nothing here would otherwise
      // notice.
      const collectionWithOne = await count('/me/finance/workspaces', solo.user);
      const collectionWithTwo = await count('/me/finance/workspaces', dual.user);

      expect(collectionWithOne).toBeGreaterThan(0);
      expect(collectionWithTwo).toBe(collectionWithOne);

      // And a scoped read costs the same whether the caller owns one workspace
      // or two, because it names exactly one either way.
      const summaryWithOne = await count(`/me/finance/${await refFor(solo.user, 'professional')}/summary`, solo.user);
      const summaryWithTwo = await count(`/me/finance/${await refFor(dual.user, 'professional')}/summary`, dual.user);

      expect(summaryWithOne).toBeGreaterThan(0);
      expect(summaryWithTwo).toBe(summaryWithOne);
    });

    it('writes nothing, anywhere, on any of the nine routes', async () => {
      const owner = await dualOwner();
      const ref = await refFor(owner.user, 'professional');
      const orderId = owner.professionalOrder;

      const financialBefore = await financialCounts();
      const applicationBefore = await applicationCounts();

      await get('/me/finance/workspaces', owner.user).expect(200);
      await get(`/me/finance/${ref}/summary`, owner.user).expect(200);
      await get(`/me/finance/${ref}/outstanding-orders`, owner.user).expect(200);
      await get(`/me/finance/${ref}/settlements`, owner.user).expect(200);
      await get(`/me/finance/${ref}/orders/${orderId}/ledger`, owner.user).expect(200);
      await get('/me/finance/summary', owner.user).expect(409);
      await get(`/me/finance/${'A'.repeat(43)}/summary`, owner.user).expect(404);

      expect(await financialCounts()).toEqual(financialBefore);
      expect(await applicationCounts()).toEqual(applicationBefore);
    });
  });

  // =======================================================================
  // §8. The route table
  // =======================================================================

  describe('§8 route registration', () => {
    it('maps all nine finance routes, and the static one is not captured by the dynamic', async () => {
      const server = app.getHttpServer();
      const router = server._events.request._router as { stack: Array<{ route?: { path: string } }> };
      const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route!.path);

      const finance = paths.filter((path) => path.startsWith('/api/v1/me/finance'));
      expect(finance.sort()).toEqual(
        [
          '/api/v1/me/finance/workspaces',
          '/api/v1/me/finance/:workspaceRef/summary',
          '/api/v1/me/finance/:workspaceRef/outstanding-orders',
          '/api/v1/me/finance/:workspaceRef/settlements',
          '/api/v1/me/finance/:workspaceRef/orders/:orderId/ledger',
          '/api/v1/me/finance/summary',
          '/api/v1/me/finance/outstanding-orders',
          '/api/v1/me/finance/settlements',
          '/api/v1/me/finance/orders/:orderId/ledger',
        ].sort(),
      );

      // `workspaces` is registered BEFORE any dynamic path, so Express cannot
      // route it into `:workspaceRef/...` even if a single-segment dynamic route
      // were added later.
      const order = finance.map((path) => paths.indexOf(path));
      expect(paths.indexOf('/api/v1/me/finance/workspaces')).toBe(Math.min(...order));

      // And it genuinely resolves as the collection rather than as a reference.
      const solo = await soloProfessional();
      const res = await get('/me/finance/workspaces', solo.user).expect(200);
      expect(res.body.data.items).toHaveLength(1);

      expect(MyFinanceController.name).toBe('MyFinanceController');
      expect(workspaces).toBeInstanceOf(FinanceWorkspaceService);
    });
  });
});
