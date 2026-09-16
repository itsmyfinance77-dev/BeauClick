import { INestApplication, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { StaffService } from '@beauclick/business';
import { assertNoLeak } from '@beauclick/testing';
import {
  WORKSPACE_REFERENCE_DOMAIN,
  WORKSPACE_REFERENCE_SECRET,
  deriveWorkspaceReference,
  workspaceReferenceInput,
} from '@beauclick/workspace-reference';

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
  seedLegacyPayment,
  seedMembership,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const OWNER_URL = financialOwnerUrl();
const describePg = requiredPgEnv() && OWNER_URL ? describe : describe.skip;

/**
 * Safe staff identification, finance workspace labels and cache safety of
 * finance reads -- V3.3 #154, `V33-DEC-038`.
 *
 * ## What is proved here, and what is deliberately proved elsewhere
 *
 * The unit specs pin the SHAPES: the seven-key management item, the four-key
 * workspace entry, the labelling rules against fakes. This suite proves what
 * only a real database and a real HTTP stack can: that the management read is
 * owner-only on the wire and that the roster it sits next to did not change;
 * that the labels come from the real public names and the hint from the real
 * verified phone; that the cost is constant as the roster and the collection
 * grow; that no read writes; that every finance response -- success, refusal,
 * guard rejection -- carries `Cache-Control: private, no-store`; and that
 * nothing sensitive reaches a log.
 *
 * ## Fixture discipline
 *
 * Every phone, name, id and reference in a fixture is distinct from every
 * other, so a value in the wrong place is a wrong string, not a plausible one.
 * The forbidden values (full phones, identity ids, professional ids) are the
 * SEEDED ones, asserted absent with `assertNoLeak` -- a control below plants a
 * value to prove the scanner sees it.
 */
describePg('safe staff identification, finance workspace labels and cache safety (real PostgreSQL, #154)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let staff: StaffService;
  let secret: string;

  let sequence = 0;
  const nextPhone = (): string => `+98917${String(100000 + (sequence += 1)).slice(-6)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    staff = app.get(StaffService);
    secret = app.get<string>(WORKSPACE_REFERENCE_SECRET);
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

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const get = (path: string, user?: SeededUser) => {
    const req = api().get(`/api/v1${path}`);
    return user ? req.set(auth(user.accessToken)) : req;
  };
  const grantVia = (businessId: string, token: string, membershipId: string, role: string) =>
    api().post(`/api/v1/businesses/${businessId}/staff/${membershipId}/grants`).set(auth(token)).send({ role });
  const revokeVia = (businessId: string, token: string, membershipId: string, role: string) =>
    api().post(`/api/v1/businesses/${businessId}/staff/${membershipId}/grants/revoke`).set(auth(token)).send({ role });

  const REFUSAL = { data: null, meta: null, error: { code: 'NOT_FOUND_OR_NOT_YOURS', message: expect.any(String) } };
  const NO_STORE = 'private, no-store';
  const MANAGEMENT_KEYS = ['displayLabel', 'id', 'identificationHint', 'labelSource', 'role', 'roles', 'status'];
  const ROSTER_KEYS = [
    'businessId',
    'createdAt',
    'id',
    'invitedBy',
    'professionalId',
    'respondedAt',
    'role',
    'status',
    'userId',
  ];
  const ENTRY_KEYS = ['accessMode', 'displayLabel', 'workspaceRef', 'workspaceType'];

  interface Salon {
    owner: SeededUser;
    businessId: string;
    name: string;
  }

  async function salon(name = 'سالن نور'): Promise<Salon> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
    const business = await seedBusiness(dataSource, owner.id, name);
    return { owner, businessId: business.id, name };
  }

  /** A consented member with NO professional profile -- the bookkeeper. */
  async function bookkeeper(s: Salon, role: 'manager' | 'staff' = 'staff') {
    const user = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const membershipId = await seedMembership(dataSource, s.businessId, user.id, role, s.owner.id, null);
    await staff.accept(membershipId, user.id);
    return { user, membershipId, hint: user.phone.slice(-4) };
  }

  /** A consented member WITH a public professional profile. */
  async function practitioner(s: Salon, name = 'سارا رضایی') {
    const user = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, user.id, name);
    const membershipId = await seedMembership(dataSource, s.businessId, user.id, 'staff', s.owner.id, professional.id);
    await staff.accept(membershipId, user.id);
    return { user, professional, membershipId, name, hint: user.phone.slice(-4) };
  }

  /** LEGACY fixture (ADR-052 §16) -- `LedgerService.recordPayment` is removed; this suite's finance-workspace reads are the legacy singular/plural surface either way. */
  async function earn(partyType: 'professional' | 'business', partyId: string, paid: number): Promise<string> {
    const orderId = uuidv7();
    await seedLegacyPayment(ctx.financialDataSource, {
      orderId,
      sellerPartyType: partyType,
      sellerPartyId: partyId,
      netAmountToman: paid,
      rateBp: 1500,
      paymentReferenceId: uuidv7(),
    });
    return orderId;
  }

  interface ManagementItem {
    id: string;
    role: string;
    status: string;
    displayLabel: string;
    labelSource: string;
    identificationHint: string;
    roles: string[];
  }
  const management = async (s: Salon, as: SeededUser = s.owner): Promise<ManagementItem[]> =>
    (await get(`/businesses/${s.businessId}/staff-management`, as).expect(200)).body.data.items;

  interface WorkspaceEntry {
    workspaceRef: string;
    workspaceType: string;
    accessMode: string;
    displayLabel: string;
  }
  const listWorkspaces = async (user: SeededUser): Promise<WorkspaceEntry[]> =>
    (await get('/me/finance/workspaces', user).expect(200)).body.data.items;

  const countQueries = async (run: () => Promise<unknown>): Promise<number> => {
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
      await run();
    } finally {
      dataSource.logger = appOriginal;
      ctx.financialDataSource.logger = finOriginal;
    }
    return queries;
  };

  const writeCounts = async (): Promise<Record<string, number>> => {
    const [row] = await dataSource.query(`
      SELECT (SELECT count(*) FROM admin.admin_audit_log)      AS audits,
             (SELECT count(*) FROM business.staff_role_grants) AS grants,
             (SELECT count(*) FROM business.business_staff)    AS memberships,
             (SELECT count(*) FROM business.businesses)        AS businesses,
             (SELECT count(*) FROM identity.users)             AS users,
             (SELECT count(*) FROM business.outbox_events)     AS business_outbox,
             (SELECT count(*) FROM notification.notifications) AS notifications
    `);
    const [fin] = await ctx.financialDataSource.query(
      `SELECT (SELECT count(*) FROM financial.ledger_entries) AS ledger, (SELECT count(*) FROM financial.outbox_events) AS outbox`,
    );
    return Object.fromEntries([...Object.entries(row), ...Object.entries(fin)].map(([k, v]) => [k, Number(v)]));
  };

  async function recordLogging<T>(run: () => Promise<T>): Promise<{ result: T; args: string; output: string }> {
    const args: unknown[] = [];
    let output = '';
    const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
    const loggerSpies = methods.map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(((...called: unknown[]) => {
        args.push(...called);
      }) as never),
    );
    const capture = (chunk: unknown): boolean => {
      output += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    };
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture as never);
    try {
      const result = await run();
      return { result, args: JSON.stringify(args), output };
    } finally {
      out.mockRestore();
      err.mockRestore();
      for (const spy of loggerSpies) spy.mockRestore();
    }
  }

  // =======================================================================
  // §1 the owner-only staff-management read
  // =======================================================================

  describe('§1 staff identification -- owner-only, human-readable, privacy-minimal', () => {
    it('names a linked member by the professional public name and a bookkeeper by the final four digits, and nothing else', async () => {
      const s = await salon();
      const p = await practitioner(s, 'سارا رضایی');
      const k = await bookkeeper(s, 'manager');

      const res = await get(`/businesses/${s.businessId}/staff-management`, s.owner).expect(200);
      const items: ManagementItem[] = res.body.data.items;

      expect(Object.keys(res.body.data)).toEqual(['items']);
      expect(items.map((item) => Object.keys(item).sort())).toEqual([MANAGEMENT_KEYS, MANAGEMENT_KEYS]);
      expect(items).toEqual([
        {
          id: p.membershipId,
          role: 'staff',
          status: 'active',
          displayLabel: 'سارا رضایی',
          labelSource: 'professional',
          identificationHint: p.hint,
          roles: [],
        },
        {
          id: k.membershipId,
          role: 'manager',
          status: 'active',
          displayLabel: k.hint,
          labelSource: 'phone',
          identificationHint: k.hint,
          roles: [],
        },
      ]);
      expect(k.hint).toMatch(/^\d{4}$/);

      // The non-vacuity control for the scanner: it DOES see a value it is
      // asked for, so the absences below mean absence.
      expect(() => assertNoLeak(res.body, p.membershipId)).toThrow(/leaked/);
      for (const forbidden of [
        p.user.phone,
        k.user.phone,
        s.owner.phone,
        p.user.id,
        k.user.id,
        s.owner.id,
        p.professional.id,
        'invitedBy',
        'userId',
        'professionalId',
        'email',
        '@',
      ]) {
        assertNoLeak(res.body, forbidden);
      }
      // The hint is the LAST four digits -- not the first four, not the country code.
      expect(k.user.phone.endsWith(k.hint)).toBe(true);
      expect(k.user.phone.startsWith(k.hint)).toBe(false);
    });

    it('lets the owner tell two members with the SAME public name apart by the hint alone', async () => {
      const s = await salon();
      const a = await practitioner(s, 'سارا رضایی');
      const b = await practitioner(s, 'سارا رضایی');

      const items = await management(s);
      expect(items.map((item) => item.displayLabel)).toEqual(['سارا رضایی', 'سارا رضایی']);
      expect(items.map((item) => item.identificationHint)).toEqual([a.hint, b.hint]);
      expect(a.hint).not.toBe(b.hint);
    });

    it('is owner-only: manager, staff, a foreign owner and a stranger get one byte-identical refusal; unauthenticated is refused first', async () => {
      const s = await salon();
      const manager = await bookkeeper(s, 'manager');
      const member = await bookkeeper(s, 'staff');
      const other = await salon('سالن دیگر');
      const stranger = await seedUser(app, dataSource, nextPhone(), ['customer']);

      const refusals = await Promise.all(
        [manager.user, member.user, other.owner, stranger].map((user) =>
          get(`/businesses/${s.businessId}/staff-management`, user).expect(404),
        ),
      );
      for (const res of refusals) {
        expect(res.body).toEqual(REFUSAL);
        for (const forbidden of [manager.hint, member.hint, manager.user.phone, member.user.phone]) {
          assertNoLeak(res.body, forbidden);
        }
      }
      const bodies = new Set(refusals.map((res) => JSON.stringify(res.body)));
      expect(bodies.size).toBe(1);

      await get(`/businesses/${s.businessId}/staff-management`).expect(401);
      expect((await get(`/businesses/${uuidv7()}/staff-management`, s.owner).expect(404)).body).toEqual(REFUSAL);
    });

    it('the roster GET …/staff is byte-for-byte what it was: still readable by a manager, same nine keys, and never a hint', async () => {
      const s = await salon();
      const manager = await bookkeeper(s, 'manager');
      const p = await practitioner(s);

      for (const reader of [s.owner, manager.user, p.user]) {
        const res = await get(`/businesses/${s.businessId}/staff`, reader).expect(200);
        const rows: Record<string, unknown>[] = res.body.data;
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => Object.keys(row).sort())).toEqual([ROSTER_KEYS, ROSTER_KEYS]);
        for (const forbidden of ['identificationHint', 'displayLabel', 'labelSource', manager.hint, p.hint, manager.user.phone]) {
          assertNoLeak(res.body, forbidden);
        }
      }
    });

    it('identifies a finance-only membership with professional_id NULL, and its roles follow the real grant lifecycle', async () => {
      const s = await salon();
      const k = await bookkeeper(s);

      expect((await management(s))[0]).toMatchObject({ labelSource: 'phone', roles: [] });

      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      expect((await management(s))[0].roles).toEqual(['finance_read']);

      await revokeVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      expect((await management(s))[0].roles).toEqual([]);

      // A grant on a DIFFERENT business never shows on this one.
      const other = await salon('سالن دیگر');
      const membershipElsewhere = await seedMembership(dataSource, other.businessId, k.user.id, 'staff', other.owner.id, null);
      await staff.accept(membershipElsewhere, k.user.id);
      await grantVia(other.businessId, other.owner.accessToken, membershipElsewhere, 'finance_read').expect(201);
      expect((await management(s))[0].roles).toEqual([]);
      expect((await management(other))[0]).toMatchObject({ id: membershipElsewhere, roles: ['finance_read'] });
    });

    it('lists exactly what the roster lists: invited and active, never declined, inactive or removed', async () => {
      const s = await salon();
      const active = await bookkeeper(s);
      const invitedUser = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const invited = await seedMembership(dataSource, s.businessId, invitedUser.id, 'staff', s.owner.id, null);
      const declinedUser = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const declined = await seedMembership(dataSource, s.businessId, declinedUser.id, 'staff', s.owner.id, null);
      await staff.decline(declined, declinedUser.id);
      const gone = await bookkeeper(s);
      await staff.deactivate(gone.membershipId);
      const erased = await bookkeeper(s);
      await dataSource.query(`UPDATE business.business_staff SET status = 'removed' WHERE id = $1`, [erased.membershipId]);

      const items = await management(s);
      expect(items.map((item) => [item.id, item.status])).toEqual([
        [active.membershipId, 'active'],
        [invited, 'invited'],
      ]);
      const roster: Array<{ id: string }> = (await get(`/businesses/${s.businessId}/staff`, s.owner).expect(200)).body.data;
      expect(roster.map((row) => row.id)).toEqual(items.map((item) => item.id));
    });

    it('falls back to the phone label when the linked profile is soft-deleted, and omits a member whose identity row is not live', async () => {
      const s = await salon();
      const p = await practitioner(s);
      const k = await bookkeeper(s);

      await dataSource.query(`UPDATE provider.professionals SET deleted_at = now() WHERE id = $1`, [p.professional.id]);
      expect((await management(s)).find((item) => item.id === p.membershipId)).toMatchObject({
        displayLabel: p.hint,
        labelSource: 'phone',
      });

      // Planted: erasure marks the membership `removed` in the same transaction,
      // so a live membership on a soft-deleted user is a race window, not a
      // state. If it ever occurs, the row is omitted -- never anonymous.
      await dataSource.query(`UPDATE identity.users SET deleted_at = now() WHERE id = $1`, [k.user.id]);
      const items = await management(s);
      expect(items.map((item) => item.id)).toEqual([p.membershipId]);
      assertNoLeak(items, k.hint);
    });

    it('costs the same number of statements for one member and for six', async () => {
      const small = await salon();
      await bookkeeper(small);
      const large = await salon('سالن بزرگ');
      await practitioner(large, 'الف');
      await practitioner(large, 'ب');
      await bookkeeper(large);
      await bookkeeper(large, 'manager');
      const inv = await seedUser(app, dataSource, nextPhone(), ['customer']);
      await seedMembership(dataSource, large.businessId, inv.id, 'staff', large.owner.id, null);
      const granted = await bookkeeper(large);
      await grantVia(large.businessId, large.owner.accessToken, granted.membershipId, 'finance_read').expect(201);
      expect(await management(large)).toHaveLength(6);

      const one = await countQueries(() => management(small));
      const six = await countQueries(() => management(large));
      expect(one).toBeGreaterThan(0);
      expect(six).toBe(one);
    });

    it('writes nothing and audits nothing, and inviting a phone with no account still produces no row anywhere', async () => {
      const s = await salon();
      await practitioner(s);
      await bookkeeper(s);
      await api()
        .post(`/api/v1/businesses/${s.businessId}/staff`)
        .set(auth(s.owner.accessToken))
        .send({ phone: '+989170000000', role: 'staff' })
        .expect(202);

      const before = await writeCounts();
      await management(s);
      await management(s);
      await get(`/businesses/${s.businessId}/staff-management`, (await salon('x')).owner).expect(404);
      const after = await writeCounts();

      // The foreign salon seeded above adds one business and one user; nothing else may move.
      expect(after).toEqual({ ...before, businesses: before.businesses + 1, users: before.users + 1 });
      expect((await management(s)).map((item) => item.identificationHint)).not.toContain('0000');
    });
  });

  // =======================================================================
  // §2 finance workspace labels
  // =======================================================================

  describe('§2 finance workspace display labels', () => {
    it('labels a business workspace with the public business name and a professional workspace with the public professional name', async () => {
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
      const professional = await seedProfessional(dataSource, owner.id, 'دکتر آرمان');
      const business = await seedBusiness(dataSource, owner.id, 'کلینیک آفتاب');

      const res = await get('/me/finance/workspaces', owner).expect(200);
      const entries: WorkspaceEntry[] = res.body.data.items;

      expect(entries.map((entry) => Object.keys(entry).sort())).toEqual([ENTRY_KEYS, ENTRY_KEYS]);
      expect(entries.map((entry) => [entry.workspaceType, entry.accessMode, entry.displayLabel])).toEqual([
        ['business', 'owner', 'کلینیک آفتاب'],
        ['professional', 'owner', 'دکتر آرمان'],
      ]);
      expect(new Set(entries.map((entry) => entry.displayLabel)).size).toBe(2);
      for (const forbidden of [owner.id, professional.id, business.id, owner.phone]) assertNoLeak(res.body, forbidden);
    });

    it('gives a finance_read grantee the granting business name, and owner still wins de-duplication', async () => {
      const s = await salon('سالن نور');
      const k = await bookkeeper(s);
      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);

      expect(await listWorkspaces(k.user)).toEqual([
        { workspaceRef: expect.any(String), workspaceType: 'business', accessMode: 'finance_read', displayLabel: 'سالن نور' },
      ]);

      // The owner, granted on their own business by a planted row, still sees
      // it once, as owner, under its real name.
      const selfMembership = await seedMembership(dataSource, s.businessId, s.owner.id, 'manager', s.owner.id, null);
      await staff.accept(selfMembership, s.owner.id);
      await dataSource.query(
        `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id)
         VALUES ($1, $2, $3, 'finance_read', $4)`,
        [uuidv7(), selfMembership, s.businessId, s.owner.id],
      );
      expect(await listWorkspaces(s.owner)).toEqual([
        { workspaceRef: expect.any(String), workspaceType: 'business', accessMode: 'owner', displayLabel: 'سالن نور' },
      ]);
    });

    it('a bookkeeper reaching two real businesses sees two DISTINCT real names, and a rename changes the label but never the reference', async () => {
      const a = await salon('سالن نور');
      const b = await salon('کلینیک آفتاب');
      const k = await bookkeeper(a);
      const membershipB = await seedMembership(dataSource, b.businessId, k.user.id, 'staff', b.owner.id, null);
      await staff.accept(membershipB, k.user.id);
      await grantVia(a.businessId, a.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      await grantVia(b.businessId, b.owner.accessToken, membershipB, 'finance_read').expect(201);

      const before = await listWorkspaces(k.user);
      expect(before.map((entry) => entry.displayLabel).sort()).toEqual(['سالن نور', 'کلینیک آفتاب']);
      expect(before.map((entry) => entry.workspaceRef)).toEqual(
        before.map((entry) =>
          deriveWorkspaceReference(secret, k.user.id, {
            partyType: 'business',
            partyId: entry.displayLabel === 'سالن نور' ? a.businessId : b.businessId,
          }),
        ),
      );

      await dataSource.query(`UPDATE business.businesses SET display_name = $1 WHERE id = $2`, ['سالن نور جدید', a.businessId]);
      const after = await listWorkspaces(k.user);
      expect(after.map((entry) => entry.workspaceRef)).toEqual(before.map((entry) => entry.workspaceRef));
      expect(after.map((entry) => entry.displayLabel).sort()).toEqual(['سالن نور جدید', 'کلینیک آفتاب']);
    });

    it('the reference construction is byte-identical: domain, input encoding and derivation are unchanged by the label', () => {
      expect(WORKSPACE_REFERENCE_DOMAIN).toBe('beauclick.workspace-reference.v1');
      const party = { partyType: 'business' as const, partyId: '018f4b1a-0000-7000-8000-0000000000bb' };
      const input = workspaceReferenceInput('018f4b1a-0000-7000-8000-000000000001', party);
      expect(input).not.toContain('displayLabel');
      expect(input).not.toContain('سالن');
      const ref = deriveWorkspaceReference('finance-unit-test-workspace-secret', '018f4b1a-0000-7000-8000-000000000001', party);
      expect(ref).toHaveLength(43);
      expect(ref).toBe(deriveWorkspaceReference('finance-unit-test-workspace-secret', '018f4b1a-0000-7000-8000-000000000001', party));
    });

    it('a label is not authorization: a foreign, revoked or malformed reference is refused identically and a refusal names no label', async () => {
      const a = await salon('سالن نور');
      const b = await salon('کلینیک آفتاب');
      const k = await bookkeeper(a);
      await grantVia(a.businessId, a.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      const [own] = await listWorkspaces(k.user);
      const foreign = deriveWorkspaceReference(secret, b.owner.id, { partyType: 'business', partyId: b.businessId });
      const forged = deriveWorkspaceReference(secret, k.user.id, { partyType: 'business', partyId: b.businessId });

      const refusals = await Promise.all(
        [foreign, forged, 'x'.repeat(43), own.workspaceRef.slice(1)].map((ref) => get(`/me/finance/${ref}/summary`, k.user).expect(404)),
      );
      for (const res of refusals) {
        expect(res.body).toEqual(REFUSAL);
        for (const forbidden of ['کلینیک', 'سالن', b.businessId, a.businessId, own.workspaceRef]) assertNoLeak(res.body, forbidden);
      }
      expect(new Set(refusals.map((res) => JSON.stringify(res.body))).size).toBe(1);

      await revokeVia(a.businessId, a.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      expect(await listWorkspaces(k.user)).toEqual([]);
      expect((await get(`/me/finance/${own.workspaceRef}/summary`, k.user).expect(404)).body).toEqual(REFUSAL);
    });

    it('costs the same number of statements for one workspace and for three, and writes nothing', async () => {
      const a = await salon('سالن نور');
      const k = await bookkeeper(a);
      await grantVia(a.businessId, a.owner.accessToken, k.membershipId, 'finance_read').expect(201);

      const dual = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
      await seedProfessional(dataSource, dual.id, 'دکتر آرمان');
      await seedBusiness(dataSource, dual.id, 'کلینیک آفتاب');
      const membership = await seedMembership(dataSource, a.businessId, dual.id, 'staff', a.owner.id, null);
      await staff.accept(membership, dual.id);
      await grantVia(a.businessId, a.owner.accessToken, membership, 'finance_read').expect(201);
      expect(await listWorkspaces(dual)).toHaveLength(3);

      const before = await writeCounts();
      const one = await countQueries(() => listWorkspaces(k.user));
      const three = await countQueries(() => listWorkspaces(dual));
      expect(one).toBeGreaterThan(0);
      expect(three).toBe(one);
      expect(await writeCounts()).toEqual(before);
    });
  });

  // =======================================================================
  // §3 cache safety
  // =======================================================================

  describe('§3 Cache-Control: private, no-store on every seller finance response', () => {
    it('is on all ten routes for a successful read, on the collection, and on the four singular routes', async () => {
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن نور');
      const orderId = await earn('business', business.id, 1_000_000);
      const [entry] = await listWorkspaces(owner);

      const paths = [
        '/me/finance/workspaces',
        `/me/finance/${entry.workspaceRef}/summary`,
        `/me/finance/${entry.workspaceRef}/outstanding-orders`,
        `/me/finance/${entry.workspaceRef}/settlements`,
        `/me/finance/${entry.workspaceRef}/orders/${orderId}/ledger`,
        // `#43a` (ADR-052 §16): the ADDITIVE tenth route -- workspace-aware
        // only, no singular sibling.
        `/me/finance/${entry.workspaceRef}/funds`,
        '/me/finance/summary',
        '/me/finance/outstanding-orders',
        '/me/finance/settlements',
        `/me/finance/orders/${orderId}/ledger`,
      ];
      expect(paths).toHaveLength(10);
      for (const path of paths) {
        const res = await get(path, owner).expect(200);
        expect(res.headers['cache-control']).toBe(NO_STORE);
      }
    });

    it('is on the refusals too: 401 before any guard, 404 for a foreign reference, 409 for a dual owner on a singular route', async () => {
      const dual = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional', 'business']);
      const professional = await seedProfessional(dataSource, dual.id, 'دکتر آرمان');
      const business = await seedBusiness(dataSource, dual.id, 'کلینیک آفتاب');

      const unauthenticated = await get('/me/finance/workspaces').expect(401);
      expect(unauthenticated.headers['cache-control']).toBe(NO_STORE);

      const notFound = await get(`/me/finance/${'x'.repeat(43)}/summary`, dual).expect(404);
      expect(notFound.headers['cache-control']).toBe(NO_STORE);
      expect(notFound.body).toEqual(REFUSAL);

      const selection = await get('/me/finance/summary', dual).expect(409);
      expect(selection.headers['cache-control']).toBe(NO_STORE);

      const [entry] = await listWorkspaces(dual);
      for (const res of [unauthenticated, notFound, selection]) {
        for (const forbidden of ['displayLabel', 'workspaceRef', 'کلینیک', 'دکتر', dual.id, professional.id, business.id, entry.workspaceRef]) {
          assertNoLeak(res.body, forbidden);
        }
      }
    });

    it('changes no unrelated cache policy: the public city catalogue, the session profile and the admin finance controller are untouched', async () => {
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
      await seedBusiness(dataSource, owner.id, 'سالن نور');

      const cities = await get('/cities').expect(200);
      expect(cities.headers['cache-control']).toBeUndefined();

      const me = await get('/me', owner).expect(200);
      expect(me.headers['cache-control']).toBeUndefined();

      const admin = await get('/admin/finance/totals', owner).expect(403);
      expect(admin.headers['cache-control']).toBeUndefined();
    });
  });

  // =======================================================================
  // §4 nothing sensitive reaches a log
  // =======================================================================

  describe('§4 leakage', () => {
    it('non-vacuity: the capture mechanism DOES see a planted value', async () => {
      const canary = 'CANARY-S154-LABEL-7X9Q';
      const { args, output } = await recordLogging(async () => {
        new Logger('Story154Probe').log(`planted ${canary}`);
        process.stdout.write(`planted ${canary}\n`);
      });
      expect(args).toContain(canary);
      expect(output).toContain(canary);
    });

    it('logs no display label, hint, phone, identity id or professional id across a full cycle including refusals', async () => {
      const s = await salon('سالن-کاناری-نور');
      const p = await practitioner(s, 'سارا-کاناری-رضایی');
      const k = await bookkeeper(s);
      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      const manager = await bookkeeper(s, 'manager');

      const { args, output } = await recordLogging(async () => {
        await management(s);
        await get(`/businesses/${s.businessId}/staff-management`, manager.user).expect(404);
        const [entry] = await listWorkspaces(k.user);
        await get(`/me/finance/${entry.workspaceRef}/summary`, k.user).expect(200);
        await get(`/me/finance/${'x'.repeat(43)}/summary`, k.user).expect(404);
        await get('/me/finance/workspaces').expect(401);
      });

      for (const secretValue of [
        'سالن-کاناری-نور',
        'سارا-کاناری-رضایی',
        p.hint,
        k.hint,
        manager.hint,
        p.user.phone,
        k.user.phone,
        manager.user.phone,
        s.owner.phone,
        p.user.id,
        k.user.id,
        manager.user.id,
        p.professional.id,
      ]) {
        expect(args).not.toContain(secretValue);
        expect(output).not.toContain(secretValue);
      }
    });
  });
});
