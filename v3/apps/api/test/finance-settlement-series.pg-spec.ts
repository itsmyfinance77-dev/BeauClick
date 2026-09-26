import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { FinanceWorkspaceService, settlementMonthWindows } from '@beauclick/financial';
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
 * `GET /me/finance/:workspaceRef/settlement-series` against real PostgreSQL (#255).
 *
 * The finance page draws a four-month trend. Built in the browser from the
 * paged settlement history it would be a partial series presented as a whole,
 * so the server computes it: settled and reversed Toman per SOLAR HIJRI month,
 * beginning 00:00 Tehran (`V32-DEC-035`'s reading of "calendar month").
 *
 * What only real rows can show, and so is proved here:
 *  * a batch at the last millisecond before Tehran midnight and one AT it land
 *    in different months, through the real SQL window predicate;
 *  * a reversal counts in the month it happened, not its batch's month;
 *  * another party's batches, and batches before the window, are not counted;
 *  * the route's authority and refusal are the workspace family's own, and it
 *    writes nothing.
 * Owner/grantee parity and the grant/revocation battery come from
 * `scoped-finance-read.pg-spec.ts`, where this route is one of `legacyReads`.
 */
describePg('the monthly settlement series (#255, real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let workspaces: FinanceWorkspaceService;

  let sequence = 0;
  const nextPhone = (): string => `+98916${String(100000 + (sequence += 1)).slice(-6)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    workspaces = app.get(FinanceWorkspaceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    await resetFinancial(requireFinancialOwnerUrl());
  });

  const get = (path: string, user?: SeededUser) => {
    const req = request(app.getHttpServer()).get(`/api/v1${path}`);
    return user ? req.set('Authorization', `Bearer ${user.accessToken}`) : req;
  };

  const refFor = async (user: SeededUser, type: 'professional' | 'business'): Promise<string> => {
    const items: Array<{ workspaceRef: string; workspaceType: string }> = (await get('/me/finance/workspaces', user).expect(200)).body
      .data.items;
    const found = items.find((entry) => entry.workspaceType === type);
    if (!found) throw new Error(`no ${type} workspace for this caller — the fixture is wrong, not the assertion`);
    return found.workspaceRef;
  };

  const series = (ref: string) => `/me/finance/${ref}/settlement-series`;

  const REFUSAL = { data: null, meta: null, error: { code: 'NOT_FOUND_OR_NOT_YOURS', message: expect.any(String) } };

  /** A settlement batch at an exact instant -- `seedSettlementBatch`'s insert shape, with `created_at` set. */
  async function batchAt(
    party: { partyType: 'professional' | 'business'; partyId: string },
    amountToman: number,
    at: Date,
    createdBy: string,
  ): Promise<string> {
    const id = uuidv7();
    await ctx.financialDataSource.query(
      `INSERT INTO financial.settlement_batches
         (id, kind, reverses_settlement_id, party_type, party_id, amount_toman, currency, created_by, created_at)
       VALUES ($1, 'settlement', NULL, $2, $3, $4, 'IRT', $5, $6)`,
      [id, party.partyType, party.partyId, String(amountToman), createdBy, at.toISOString()],
    );
    return id;
  }

  /** A reversal of `batchId`, at an exact instant: a new row with the amount negated. */
  async function reversalAt(
    party: { partyType: 'professional' | 'business'; partyId: string },
    batchId: string,
    amountToman: number,
    at: Date,
    createdBy: string,
  ): Promise<void> {
    await ctx.financialDataSource.query(
      `INSERT INTO financial.settlement_batches
         (id, kind, reverses_settlement_id, party_type, party_id, amount_toman, currency, created_by, created_at)
       VALUES ($1, 'reversal', $2, $3, $4, $5, 'IRT', $6, $7)`,
      [uuidv7(), batchId, party.partyType, party.partyId, String(-amountToman), createdBy, at.toISOString()],
    );
  }

  const financialCounts = async () => {
    const [row] = await ctx.financialDataSource.query(`
      SELECT (SELECT count(*) FROM financial.ledger_entries)     AS ledger,
             (SELECT count(*) FROM financial.settlement_batches) AS batches,
             (SELECT count(*) FROM financial.outbox_events)      AS outbox
    `);
    return { ledger: Number(row.ledger), batches: Number(row.batches), outbox: Number(row.outbox) };
  };

  const ms = (date: Date, delta: number) => new Date(date.getTime() + delta);

  it('counts each batch in the Jalali month it falls in, to the millisecond at Tehran midnight, and nothing else', async () => {
    const owner = await seedUser(app, dataSource, nextPhone(), ['business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن تسویه');
    const party = { partyType: 'business' as const, partyId: business.id };
    const other = await seedUser(app, dataSource, nextPhone(), ['business']);
    const otherBusiness = await seedBusiness(dataSource, other.id, 'سالن دیگر');

    const w = settlementMonthWindows(new Date(), 4);

    // Before the series: not counted anywhere.
    await batchAt(party, 999_001, ms(w[0].startsAt, -1), owner.id);
    // The first millisecond of the oldest month.
    const oldest = await batchAt(party, 100_000, w[0].startsAt, owner.id);
    // The last millisecond of the second month, and the first of the third.
    await batchAt(party, 200_000, ms(w[2].startsAt, -1), owner.id);
    await batchAt(party, 300_000, w[2].startsAt, owner.id);
    await batchAt(party, 50_000, ms(w[2].startsAt, 60_000), owner.id);
    // The oldest batch reversed in the third month: counted where it happened.
    await reversalAt(party, oldest, 100_000, ms(w[2].startsAt, 120_000), owner.id);
    // Somebody else's batch in the same month: never this workspace's.
    await batchAt({ partyType: 'business', partyId: otherBusiness.id }, 777_000, ms(w[3].startsAt, 1), other.id);

    const ref = await refFor(owner, 'business');
    const before = await financialCounts();
    const res = await get(series(ref), owner).expect(200);

    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.data.currency).toBe('IRT');
    expect(res.body.data.items).toEqual([
      { month: w[0].month, startsAt: w[0].startsAt.toISOString(), endsAt: w[0].endsAt.toISOString(), settledToman: 100_000, reversedToman: 0, settlementCount: 1, complete: true },
      { month: w[1].month, startsAt: w[1].startsAt.toISOString(), endsAt: w[1].endsAt.toISOString(), settledToman: 200_000, reversedToman: 0, settlementCount: 1, complete: true },
      { month: w[2].month, startsAt: w[2].startsAt.toISOString(), endsAt: w[2].endsAt.toISOString(), settledToman: 350_000, reversedToman: 100_000, settlementCount: 2, complete: true },
      { month: w[3].month, startsAt: w[3].startsAt.toISOString(), endsAt: w[3].endsAt.toISOString(), settledToman: 0, reversedToman: 0, settlementCount: 0, complete: false },
    ]);
    // Jalali month keys, consecutive.
    expect(res.body.data.items.map((m: { month: string }) => m.month)).toEqual(w.map((x) => x.month));

    // No identity of either party, and nothing written by reading.
    for (const forbidden of [business.id, otherBusiness.id, owner.id, 'سالن', '777000', '999001']) assertNoLeak(res.body, forbidden);
    expect(await financialCounts()).toEqual(before);
  });

  it('draws month edges from the zone’s real offset: a 2021 summer month began at 19:30 UTC', async () => {
    const owner = await seedUser(app, dataSource, nextPhone(), ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'متخصص تابستان');
    const party = { partyType: 'professional' as const, partyId: professional.id };

    // 1 Mordad 1400 began at 2021-07-22T19:30Z (Tehran was +04:30).
    const mordadStart = new Date('2021-07-22T19:30:00.000Z');
    await batchAt(party, 11_000, ms(mordadStart, -1), owner.id); // 31 Tir, 23:59:59.999
    await batchAt(party, 22_000, mordadStart, owner.id); // 1 Mordad, 00:00

    const ref = await refFor(owner, 'professional');
    // Mid-Mordad 1400, so the series is Ordibehesht .. Mordad.
    const months = await workspaces.settlementSeriesFor(owner.id, ref, new Date('2021-08-05T08:00:00.000Z'));

    expect(months.map((m) => [m.month, m.settledToman, m.complete])).toEqual([
      ['1400-02', 0, true],
      ['1400-03', 0, true],
      ['1400-04', 11_000, true],
      ['1400-05', 22_000, false],
    ]);
    expect(months[3].startsAt.toISOString()).toBe('2021-07-22T19:30:00.000Z');
  });

  it('gives an owner with no settlements four zero months — a correct answer, not an empty one', async () => {
    const owner = await seedUser(app, dataSource, nextPhone(), ['professional']);
    await seedProfessional(dataSource, owner.id, 'تازه‌کار');
    const ref = await refFor(owner, 'professional');

    const items = (await get(series(ref), owner).expect(200)).body.data.items;
    expect(items).toHaveLength(4);
    for (const m of items) expect([m.settledToman, m.reversedToman, m.settlementCount]).toEqual([0, 0, 0]);
  });

  it('refuses every caller who cannot address the workspace with the one shared body, and takes no query', async () => {
    const owner = await seedUser(app, dataSource, nextPhone(), ['business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن مقصد');
    await batchAt({ partyType: 'business', partyId: business.id }, 450_000, new Date(), owner.id);
    const ref = await refFor(owner, 'business');

    const stranger = await seedUser(app, dataSource, nextPhone(), ['business']);
    await seedBusiness(dataSource, stranger.id, 'سالن غریبه');
    const strangersOwnRef = await refFor(stranger, 'business');

    // Staff of the business, without a grant.
    const staff = await seedUser(app, dataSource, nextPhone(), ['professional']);
    const staffProfessional = await seedProfessional(dataSource, staff.id, 'کارمند سالن');
    await dataSource.query(
      `INSERT INTO business.business_staff (id, business_id, user_id, professional_id, role, status, invited_by)
       VALUES ($1, $2, $3, $4, 'manager', 'active', $5)`,
      [uuidv7(), business.id, staff.id, staffProfessional.id, owner.id],
    );

    const refusals = [
      await get(series(ref), stranger).expect(404), // a real reference, not theirs
      await get(series(ref), staff).expect(404), // employed there, not granted
      await get(series('x'.repeat(43)), owner).expect(404), // malformed
    ];
    for (const res of refusals) {
      expect(res.body).toEqual(REFUSAL);
      expect(res.headers['cache-control']).toBe('private, no-store');
      for (const forbidden of [business.id, '450000', 'سالن']) assertNoLeak(res.body, forbidden);
    }
    // The stranger's own reference still works for the stranger -- the refusal above was about the workspace.
    await get(series(strangersOwnRef), stranger).expect(200);

    await get(series(ref)).expect(401);
    await get(`${series(ref)}?months=12`, owner).expect(400);
  });
});
