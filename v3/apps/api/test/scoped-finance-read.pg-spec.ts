import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  BusinessSubjectDataContract,
  SCOPED_STAFF_AUTHORIZER,
  ScopedStaffAuthorizerPort,
  StaffService,
} from '@beauclick/business';
import { AdminAuditService } from '@beauclick/audit';
import { BookingCollectionPolicyService, CommercialCatalogueService } from '@beauclick/commercial-policy';
import { FinanceWorkspaceService, LedgerService, SettlementService } from '@beauclick/financial';
import { SUBJECT_DATA_CONTRACTS, SubjectDataCoverageService } from '@beauclick/subject-data';
import { assertNoLeak } from '@beauclick/testing';
import { SellerPartyLookup } from '../src/composition/port-adapters';

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
  seedMembership,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const OWNER_URL = financialOwnerUrl();
const describePg = requiredPgEnv() && OWNER_URL ? describe : describe.skip;

/**
 * Scoped read-only business finance authority against real PostgreSQL —
 * V3.3 Story #111 (`#44e`), `V33-DEC-030` D4, ADR-049 §5.
 *
 * ## What this suite adds, and what it deliberately leaves alone
 *
 * `finance-workspace-authorization.pg-spec.ts` is #72's suite and this story's
 * primary regression gate: it runs UNCHANGED. Everything an OWNER could do
 * before is proved there. This suite proves what a `finance_read` GRANTEE can
 * do — read exactly one business's finance workspace through the existing
 * workspace-aware routes — and, at greater length, everything they cannot:
 * no other business, no singular route, no write anywhere the same
 * `workspaceRef` value is accepted, nothing after revocation, and no
 * distinguishable refusal.
 *
 * ## Why the evidence has to be here
 *
 * Every claim is about a REQUEST meeting real rows under a real CHECK, a real
 * partial unique index and a real composite foreign key: that a bookkeeper
 * with `professional_id IS NULL` can be granted, that the same membership
 * cannot be granted `practitioner_chat`, that a revoked grant is gone on the
 * next request under the same token, that a commercial-policy write route
 * refuses the grantee's reference byte-identically to a random one. pg-mem
 * honours none of it.
 *
 * ## Distinguishable amounts, everywhere
 *
 * Each seeded party earns a distinct figure, so a leak is unmistakable in a
 * whole-body comparison rather than a matter of reading which number came back.
 */
describePg('scoped read-only business finance authority (real PostgreSQL, #111)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let ledger: LedgerService;
  let settlements: SettlementService;
  let staff: StaffService;
  let authorizer: ScopedStaffAuthorizerPort;
  let workspaces: FinanceWorkspaceService;

  let sequence = 0;
  const nextPhone = (): string => `+98916${String(100000 + (sequence += 1)).slice(-6)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    ledger = app.get(LedgerService);
    settlements = app.get(SettlementService);
    staff = app.get(StaffService);
    authorizer = app.get(SCOPED_STAFF_AUTHORIZER);
    workspaces = app.get(FinanceWorkspaceService);
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

  interface Salon {
    owner: SeededUser;
    businessId: string;
    orderId: string;
    receivable: number;
  }

  async function salon(paid = 2_200_000): Promise<Salon> {
    const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن');
    const orderId = await earn('business', business.id, paid);
    return { owner, businessId: business.id, orderId, receivable: receivableOf(paid) };
  }

  /**
   * A bookkeeper: a customer-only account with NO professional profile, invited
   * as plain `staff`, who accepted from their own session. Their membership's
   * `professional_id` is NULL — the case #109's grant path could not serve.
   */
  async function bookkeeper(salon: Salon, role: 'manager' | 'staff' = 'staff') {
    const user = await seedUser(app, dataSource, nextPhone(), ['customer']);
    const membershipId = await seedMembership(dataSource, salon.businessId, user.id, role, salon.owner.id, null);
    await staff.accept(membershipId, user.id);
    return { user, membershipId };
  }

  /**
   * A practitioner: owns a professional profile (so their token carries the
   * seller capabilities every commercial-policy write requires) and is an
   * active, professional-linked member of the salon. The adversary for the
   * write-route sweep: a grantee for whom the capability guard is NOT what
   * refuses the write.
   */
  async function practitioner(salon: Salon, ownPaid = 660_000) {
    const user = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, user.id, 'آرایشگر');
    const membershipId = await seedMembership(
      dataSource,
      salon.businessId,
      user.id,
      'staff',
      salon.owner.id,
      professional.id,
    );
    await staff.accept(membershipId, user.id);
    const ownOrder = await earn('professional', professional.id, ownPaid);
    return { user, professional, membershipId, ownOrder, ownReceivable: receivableOf(ownPaid) };
  }

  // ------------------------------------------------------------------ HTTP

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

  interface WorkspaceEntry {
    workspaceRef: string;
    workspaceType: string;
    accessMode: string;
  }

  const listWorkspaces = async (user: SeededUser): Promise<WorkspaceEntry[]> =>
    (await get('/me/finance/workspaces', user).expect(200)).body.data.items;

  const refFor = async (user: SeededUser, type: 'professional' | 'business', mode?: string): Promise<string> => {
    const found = (await listWorkspaces(user)).find(
      (entry) => entry.workspaceType === type && (mode === undefined || entry.accessMode === mode),
    );
    if (!found) throw new Error(`no ${type}/${mode ?? '*'} workspace for this caller — the fixture is wrong, not the assertion`);
    return found.workspaceRef;
  };

  /** A salon, a bookkeeper, and the grant — the story's outcome as one fixture. */
  async function grantedBookkeeper(paid = 2_200_000) {
    const s = await salon(paid);
    const k = await bookkeeper(s);
    await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
    const ref = await refFor(k.user, 'business', 'finance_read');
    return { salon: s, bookkeeper: k, ref };
  }

  const fourReads = (ref: string, orderId: string) => [
    `/me/finance/${ref}/summary`,
    `/me/finance/${ref}/outstanding-orders`,
    `/me/finance/${ref}/settlements`,
    `/me/finance/${ref}/orders/${orderId}/ledger`,
  ];

  const REFUSAL = { data: null, meta: null, error: { code: 'NOT_FOUND_OR_NOT_YOURS', message: expect.any(String) } };

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
             (SELECT count(*) FROM business.staff_role_grants)      AS grants,
             (SELECT count(*) FROM business.business_staff)         AS memberships,
             (SELECT count(*) FROM commercial.seller_subscriptions) AS subscriptions,
             (SELECT count(*) FROM commercial.booking_credit_grants) AS credits,
             (SELECT count(*) FROM payment.payment_intents)         AS intents,
             (SELECT count(*) FROM commerce.orders)                 AS orders,
             (SELECT count(*) FROM notification.notifications)      AS notifications
    `);
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  };

  const grantRows = (membershipId: string) =>
    dataSource.query(
      `SELECT id, role, business_id, granted_by_user_id, revoked_by_user_id, revoked_at, xmin::text AS x
         FROM business.staff_role_grants WHERE membership_id = $1 ORDER BY granted_at`,
      [membershipId],
    );

  // =======================================================================
  // §1. The vocabulary is closed BY THE DATABASE, and the migration rewrote nothing
  // =======================================================================

  describe('§1 the closed vocabulary, in PostgreSQL', () => {
    async function rawGrant(membershipId: string, businessId: string, role: string, actor: string) {
      return dataSource.query(
        `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), membershipId, businessId, role, actor],
      );
    }

    it('admits finance_read and practitioner_chat, and refuses every other literal by ck_staff_role_grants_role', async () => {
      const s = await salon();
      const k = await bookkeeper(s);
      const p = await practitioner(s);

      // Positive controls first, one per member, so the refusals below cannot
      // be failing for an unrelated reason.
      await expect(rawGrant(k.membershipId, s.businessId, 'finance_read', s.owner.id)).resolves.toBeDefined();
      await expect(rawGrant(p.membershipId, s.businessId, 'practitioner_chat', s.owner.id)).resolves.toBeDefined();

      for (const forbidden of ['finance', 'finance_write', 'finance_admin', 'FINANCE_READ', 'finance_read ', 'owner', 'manager', '']) {
        await expect(rawGrant(k.membershipId, s.businessId, forbidden, s.owner.id)).rejects.toThrow(
          /ck_staff_role_grants_role/,
        );
      }
    });

    it('the CHECK is VALIDATED and carries exactly the two members', async () => {
      const [row] = await dataSource.query(
        `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'business.staff_role_grants'::regclass AND conname = 'ck_staff_role_grants_role'`,
      );
      expect(row.convalidated).toBe(true);
      expect(row.def.replace(/\s+/g, ' ')).toContain("'practitioner_chat'");
      expect(row.def.replace(/\s+/g, ' ')).toContain("'finance_read'");
      expect(row.def.replace(/\s+/g, ' ')).not.toMatch(/'finance'/);
    });

    it('re-adding the CHECK validates without rewriting rows (xmin preserved), with a non-vacuity control', async () => {
      const s = await salon();
      const p = await practitioner(s);
      await grantVia(s.businessId, s.owner.accessToken, p.membershipId, 'practitioner_chat').expect(201);

      const xminOf = async (): Promise<string> => (await grantRows(p.membershipId))[0].x;
      const before = await xminOf();

      // The migration's own statements, replayed against an existing row.
      await dataSource.query(`ALTER TABLE business.staff_role_grants DROP CONSTRAINT ck_staff_role_grants_role`);
      await dataSource.query(
        `ALTER TABLE business.staff_role_grants ADD CONSTRAINT ck_staff_role_grants_role
         CHECK (role IN ('practitioner_chat', 'finance_read'))`,
      );
      expect(await xminOf()).toBe(before);

      // Non-vacuity: a genuine row change DOES move xmin. Revocation is the only
      // legal UPDATE the immutability trigger admits.
      await dataSource.query(`UPDATE business.staff_role_grants SET revoked_at = now() WHERE membership_id = $1`, [
        p.membershipId,
      ]);
      expect(await xminOf()).not.toBe(before);
    });

    it('every other grant-table constraint is intact: same-business FK, partial live uniqueness, immutability, one-way revocation', async () => {
      const s = await salon();
      const foreign = await salon();
      const k = await bookkeeper(s);

      // Cross-business: UNWRITABLE, not merely refused by a service.
      await expect(rawGrant(k.membershipId, foreign.businessId, 'finance_read', s.owner.id)).rejects.toThrow(
        /fk_staff_role_grants_membership_same_business/,
      );

      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      // A second LIVE finance_read on the same membership: the partial index.
      await expect(rawGrant(k.membershipId, s.businessId, 'finance_read', s.owner.id)).rejects.toThrow(
        /uq_staff_role_grants_live/,
      );
      // Facts are immutable; DELETE is refused; revocation is one-way.
      await expect(
        dataSource.query(`UPDATE business.staff_role_grants SET role = 'practitioner_chat' WHERE membership_id = $1`, [
          k.membershipId,
        ]),
      ).rejects.toThrow(/immutable|ck_staff_role_grants_role/);
      await expect(
        dataSource.query(`DELETE FROM business.staff_role_grants WHERE membership_id = $1`, [k.membershipId]),
      ).rejects.toThrow(/never deleted/);
      await revokeVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      await expect(
        dataSource.query(`UPDATE business.staff_role_grants SET revoked_at = NULL WHERE membership_id = $1`, [
          k.membershipId,
        ]),
      ).rejects.toThrow(/one-way/);
      // And after revocation a re-grant is an ordinary new row.
      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      expect(await grantRows(k.membershipId)).toHaveLength(2);
    });
  });

  // =======================================================================
  // §2. Role-aware grantability
  // =======================================================================

  describe('§2 grantability depends on the role, not on a professional profile', () => {
    it('a bookkeeper with professional_id NULL is grantable finance_read, and the response carries roles and nothing else', async () => {
      const s = await salon();
      const k = await bookkeeper(s);
      const [membership] = await dataSource.query(`SELECT professional_id FROM business.business_staff WHERE id = $1`, [
        k.membershipId,
      ]);
      expect(membership.professional_id).toBeNull();

      const res = await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      expect(res.body.data).toEqual({ roles: ['finance_read'] });
      assertNoLeak(res.body, k.user.id);
      assertNoLeak(res.body, s.owner.id);
      assertNoLeak(res.body, k.user.phone);

      const listed = await get(`/businesses/${s.businessId}/staff/${k.membershipId}/grants`, s.owner).expect(200);
      expect(listed.body.data).toEqual({ roles: ['finance_read'] });
    });

    it('the SAME unlinked membership is NOT grantable practitioner_chat -- #109 behaviour unchanged', async () => {
      const s = await salon();
      const k = await bookkeeper(s);

      const refused = await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'practitioner_chat').expect(404);
      expect(refused.body).toEqual(REFUSAL);
      expect(await grantRows(k.membershipId)).toHaveLength(0);

      // And a linked practitioner still gets both, one at a time.
      const p = await practitioner(s);
      await grantVia(s.businessId, s.owner.accessToken, p.membershipId, 'practitioner_chat').expect(201);
      const both = await grantVia(s.businessId, s.owner.accessToken, p.membershipId, 'finance_read').expect(201);
      expect(both.body.data).toEqual({ roles: ['finance_read', 'practitioner_chat'] });
    });

    it('a non-active membership is never grantable finance_read, for any status', async () => {
      const s = await salon();
      const invitee = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const invited = await seedMembership(dataSource, s.businessId, invitee.id, 'staff', s.owner.id, null);

      // invited
      await grantVia(s.businessId, s.owner.accessToken, invited, 'finance_read').expect(404);
      // declined
      await staff.decline(invited, invitee.id);
      await grantVia(s.businessId, s.owner.accessToken, invited, 'finance_read').expect(404);

      // inactive (accepted, then removed by the owner)
      const k = await bookkeeper(s);
      await staff.deactivate(k.membershipId);
      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(404);

      // removed (erasure) -- the terminal state
      const erased = await bookkeeper(s);
      await dataSource.query(`UPDATE business.business_staff SET status = 'removed' WHERE id = $1`, [erased.membershipId]);
      await grantVia(s.businessId, s.owner.accessToken, erased.membershipId, 'finance_read').expect(404);

      // foreign business: the owner of A cannot grant on B's membership even by naming A
      const b = await salon();
      const kb = await bookkeeper(b);
      await grantVia(s.businessId, s.owner.accessToken, kb.membershipId, 'finance_read').expect(404);
      await grantVia(b.businessId, s.owner.accessToken, kb.membershipId, 'finance_read').expect(404);

      expect(await dataSource.query(`SELECT count(*)::int AS c FROM business.staff_role_grants`)).toEqual([{ c: 0 }]);
    });

    it('only the live owner grants or revokes; every other actor gets one byte-identical refusal', async () => {
      const s = await salon();
      const foreign = await salon();
      const k = await bookkeeper(s);
      const m = await bookkeeper(s, 'manager');
      const stranger = await seedUser(app, dataSource, nextPhone(), ['customer', 'business']);

      const refusals = [
        ['a manager of the same salon', m.user.accessToken],
        ['the grantee themselves', k.user.accessToken],
        ['a stranger', stranger.accessToken],
        ['a foreign owner', foreign.owner.accessToken],
      ] as const;
      const bodies = new Set<string>();
      for (const [label, token] of refusals) {
        const res = await grantVia(s.businessId, token, k.membershipId, 'finance_read');
        expect([label, res.status]).toEqual([label, 404]);
        bodies.add(JSON.stringify(res.body));
        const rev = await revokeVia(s.businessId, token, k.membershipId, 'finance_read');
        expect([label, rev.status]).toEqual([label, 404]);
        bodies.add(JSON.stringify(rev.body));
      }
      expect([...bodies]).toHaveLength(1);
      expect(JSON.parse([...bodies][0])).toEqual(REFUSAL);
      expect(await grantRows(k.membershipId)).toHaveLength(0);

      // Positive control.
      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
    });

    it('grant and revoke are audited transactionally with #109\'s vocabulary, naming the owner and never the grantee', async () => {
      const s = await salon();
      const k = await bookkeeper(s);
      const before = await applicationCounts();

      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      const [grant] = await grantRows(k.membershipId);
      await revokeVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);

      const rows = await dataSource.query(
        `SELECT actor_user_id, action, target_type, target_id, before_state, after_state, reason, xmin::text AS x
           FROM admin.admin_audit_log WHERE target_id = $1 ORDER BY created_at`,
        [grant.id],
      );
      expect(rows.map((r: { action: string }) => r.action)).toEqual([
        'business.staff_grant_granted',
        'business.staff_grant_revoked',
      ]);
      expect(rows[0].actor_user_id).toBe(s.owner.id);
      expect(rows[0].after_state).toEqual({ role: 'finance_read', live: true });
      expect(rows[1].before_state).toEqual({ role: 'finance_read', live: true });
      expect(rows[1].after_state).toEqual({ role: 'finance_read', live: false });
      for (const row of rows) assertNoLeak(row, k.user.id);
      expect((await applicationCounts()).audits).toBe(before.audits + 2);

      // Same transaction: the grant row and its audit row share an xid.
      const [{ x: grantXid }] = await dataSource.query(
        `SELECT xmin::text AS x FROM business.staff_role_grants WHERE id = $1`,
        [grant.id],
      );
      // The grant row was later UPDATEd by the revoke, so compare the REVOKE
      // audit's xid to the row's current xmin instead.
      expect(rows[1].x).toBe(grantXid);
    });

    it('an audit failure rolls the finance_read grant back with it', async () => {
      const s = await salon();
      const k = await bookkeeper(s);
      const audit = app.get(AdminAuditService);
      const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit sink unavailable'));
      try {
        await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(await grantRows(k.membershipId)).toHaveLength(0);
      expect(await listWorkspaces(k.user)).toEqual([]);
    });
  });

  // =======================================================================
  // §3. Enumeration: owned ∪ live-scoped-read
  // =======================================================================

  describe('§3 enumeration', () => {
    it('an owner with no grant sees exactly what they saw before, now as `owner`', async () => {
      const s = await salon();
      const entries = await listWorkspaces(s.owner);
      expect(entries).toHaveLength(1);
      expect(Object.keys(entries[0]).sort()).toEqual(['accessMode', 'workspaceRef', 'workspaceType']);
      expect(entries[0]).toMatchObject({ workspaceType: 'business', accessMode: 'owner' });
      expect(entries[0].workspaceRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('a live grant adds exactly ONE business workspace, as `finance_read`, and no identity', async () => {
      const { salon: s, bookkeeper: k } = await grantedBookkeeper();
      const entries = await listWorkspaces(k.user);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ workspaceType: 'business', accessMode: 'finance_read' });
      for (const identifier of [k.user.id, s.owner.id, s.businessId, k.membershipId, k.user.phone]) {
        assertNoLeak(entries, identifier);
      }
    });

    it("the grantee's reference is viewer-specific: not the owner's, and inert in any other session", async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      const ownerRef = await refFor(s.owner, 'business', 'owner');
      const other = await salon();

      expect(ref).not.toBe(ownerRef);
      // The owner's reference in the grantee's session, and vice-versa, and the
      // grantee's in a stranger's -- all inert.
      await get(`/me/finance/${ownerRef}/summary`, k.user).expect(404);
      await get(`/me/finance/${ref}/summary`, s.owner).expect(404);
      await get(`/me/finance/${ref}/summary`, other.owner).expect(404);
      // And the primitive is the same one: the service derives the very value
      // the route returned, for the same (session, party).
      expect(workspaces.referenceFor(k.user.id, { partyType: 'business', partyId: s.businessId })).toBe(ref);
      expect(workspaces.referenceFor(s.owner.id, { partyType: 'business', partyId: s.businessId })).toBe(ownerRef);
    });

    it('a professional owner who is also a grantee sees both, separately, in the usual order', async () => {
      const s = await salon();
      const p = await practitioner(s);
      await grantVia(s.businessId, s.owner.accessToken, p.membershipId, 'finance_read').expect(201);

      const entries = await listWorkspaces(p.user);
      expect(entries.map((e) => [e.workspaceType, e.accessMode])).toEqual([
        ['business', 'finance_read'],
        ['professional', 'owner'],
      ]);

      const business = (await get(`/me/finance/${entries[0].workspaceRef}/summary`, p.user).expect(200)).body.data;
      const own = (await get(`/me/finance/${entries[1].workspaceRef}/summary`, p.user).expect(200)).body.data;
      expect(business.receivableNetToman).toBe(s.receivable);
      expect(own.receivableNetToman).toBe(p.ownReceivable);
      // Never merged.
      assertNoLeak(business, String(p.ownReceivable));
      assertNoLeak(own, String(s.receivable));
    });

    it('a workspace reachable through ownership AND a grant appears once, as `owner`', async () => {
      // Structurally near-impossible (an owner cannot invite themselves), so
      // seeded straight into the tables: the owner holds an active membership
      // of their own business with a live finance_read grant.
      const s = await salon();
      const membershipId = await seedMembership(dataSource, s.businessId, s.owner.id, 'staff', s.owner.id, null);
      await staff.accept(membershipId, s.owner.id);
      await dataSource.query(
        `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id)
         VALUES ($1, $2, $3, 'finance_read', $4)`,
        [uuidv7(), membershipId, s.businessId, s.owner.id],
      );
      // The grant IS live, so the de-duplication below is doing real work.
      expect(await authorizer.liveBusinessScopedGrants(dataSource.manager, s.owner.id, 'finance_read')).toEqual([
        { businessId: s.businessId },
      ]);

      const entries = await listWorkspaces(s.owner);
      expect(entries).toHaveLength(1);
      expect(entries[0].accessMode).toBe('owner');
    });

    it('a grant on business A never reaches business B, and B\'s owner never reaches A through it', async () => {
      const { salon: a, bookkeeper: k, ref } = await grantedBookkeeper(2_200_000);
      const b = await salon(3_300_000);
      const bRef = await refFor(b.owner, 'business', 'owner');

      // k reaches A only.
      const summary = (await get(`/me/finance/${ref}/summary`, k.user).expect(200)).body.data;
      expect(summary.receivableNetToman).toBe(a.receivable);
      assertNoLeak(summary, String(b.receivable));
      for (const path of fourReads(bRef, b.orderId)) await get(path, k.user).expect(404);
      // Nothing about B is in k's list.
      expect(await listWorkspaces(k.user)).toHaveLength(1);
      // And B's owner learns nothing from k's reference.
      for (const path of fourReads(ref, a.orderId)) await get(path, b.owner).expect(404);
    });

    it('bare affiliation grants nothing: staff, manager and a practitioner_chat holder are refused like a stranger', async () => {
      const s = await salon();
      const ownerRef = await refFor(s.owner, 'business', 'owner');
      const plainStaff = await bookkeeper(s, 'staff');
      const manager = await bookkeeper(s, 'manager');
      const chat = await practitioner(s);
      await grantVia(s.businessId, s.owner.accessToken, chat.membershipId, 'practitioner_chat').expect(201);
      const stranger = await seedUser(app, dataSource, nextPhone(), ['customer']);

      for (const [label, user] of [
        ['staff', plainStaff.user],
        ['manager', manager.user],
        ['practitioner_chat holder', chat.user],
        ['stranger', stranger],
      ] as const) {
        const entries = await listWorkspaces(user);
        expect([label, entries.filter((e) => e.workspaceType === 'business')]).toEqual([label, []]);
        // Their own derivation of the business reference -- what they would get
        // if affiliation counted -- is inert.
        const theirRef = workspaces.referenceFor(user.id, { partyType: 'business', partyId: s.businessId });
        const bodies = new Set<string>();
        for (const path of [...fourReads(theirRef, s.orderId), ...fourReads(ownerRef, s.orderId)]) {
          const res = await get(path, user);
          expect([label, path, res.status]).toEqual([label, path, 404]);
          bodies.add(JSON.stringify(res.body));
        }
        expect([label, [...bodies].length]).toEqual([label, 1]);
      }
      // Positive control: the owner still reads it.
      await get(`/me/finance/${ownerRef}/summary`, s.owner).expect(200);
    });
  });

  // =======================================================================
  // §4. The four scoped reads, as a grantee
  // =======================================================================

  describe('§4 reads', () => {
    it('a grantee reads all four workspace-aware routes with the OWNER projection, byte-for-byte', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      await settlements.createSettlement({
        partyType: 'business',
        partyId: s.businessId,
        orderIds: [s.orderId],
        method: 'bank',
        reference: 'SET-1',
        note: 'operator note',
        actorId: s.owner.id,
      });
      const secondOrder = await earn('business', s.businessId, 800_000);
      const ownerRef = await refFor(s.owner, 'business', 'owner');

      const ownerBodies = [];
      const granteeBodies = [];
      for (const [ownerPath, granteePath] of fourReads(ownerRef, secondOrder).map((p, i) => [p, fourReads(ref, secondOrder)[i]])) {
        ownerBodies.push((await get(ownerPath, s.owner).expect(200)).body);
        granteeBodies.push((await get(granteePath, k.user).expect(200)).body);
      }
      // Same projection: the grantee's body is the owner's body, key for key and
      // value for value. No field added, none removed, none masked.
      expect(JSON.stringify(granteeBodies)).toBe(JSON.stringify(ownerBodies));

      const [summary, outstanding, page, entries] = granteeBodies.map((b) => b.data);
      expect(summary).toEqual({
        partyType: 'business',
        receivableNetToman: s.receivable + receivableOf(800_000),
        settledToman: s.receivable,
        outstandingToman: receivableOf(800_000),
        currency: 'IRT',
      });
      expect(outstanding).toEqual([{ orderId: secondOrder, outstandingToman: receivableOf(800_000) }]);
      expect(page.items.map((i: Record<string, unknown>) => Object.keys(i).sort())).toEqual([
        ['amountToman', 'createdAt', 'currency', 'id', 'kind', 'method', 'reference'],
      ]);
      expect(entries.map((e: Record<string, unknown>) => Object.keys(e).sort())).toEqual([
        ['amountToman', 'commissionRateBp', 'createdAt', 'currency', 'entryType', 'id', 'referenceType'],
      ]);
      // No identity, no note, no actor, no payment reference id anywhere.
      for (const body of granteeBodies) {
        for (const identifier of [k.user.id, s.owner.id, s.businessId, k.membershipId, 'operator note']) {
          assertNoLeak(body, identifier);
        }
      }
    });

    it('scopes every financial statement by party type and party id, for a grantee', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
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
        for (const path of fourReads(ref, s.orderId)) await get(path, k.user).expect(200);
      } finally {
        ctx.financialDataSource.logger = original;
      }
      const financial = statements.filter((sql) => /(ledger_entries|settlement_batches|settlement_items)/i.test(sql));
      expect(financial.length).toBeGreaterThanOrEqual(5);
      expect(financial.filter((sql) => !/party_type/i.test(sql) || !/party_id/i.test(sql))).toEqual([]);
    });

    it('costs the same number of queries for one accessible workspace and for several', async () => {
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

      // One grant.
      const one = await grantedBookkeeper();
      // Three: a professional owner granted on two businesses.
      const a = await salon();
      const b = await salon();
      const p = await practitioner(a);
      await grantVia(a.businessId, a.owner.accessToken, p.membershipId, 'finance_read').expect(201);
      const membershipB = await seedMembership(dataSource, b.businessId, p.user.id, 'staff', b.owner.id, null);
      await staff.accept(membershipB, p.user.id);
      await grantVia(b.businessId, b.owner.accessToken, membershipB, 'finance_read').expect(201);
      expect(await listWorkspaces(p.user)).toHaveLength(3);

      const collectionWithOne = await count('/me/finance/workspaces', one.bookkeeper.user);
      const collectionWithThree = await count('/me/finance/workspaces', p.user);
      expect(collectionWithOne).toBeGreaterThan(0);
      expect(collectionWithThree).toBe(collectionWithOne);

      const summaryWithOne = await count(`/me/finance/${one.ref}/summary`, one.bookkeeper.user);
      const summaryWithThree = await count(`/me/finance/${await refFor(p.user, 'professional', 'owner')}/summary`, p.user);
      expect(summaryWithThree).toBe(summaryWithOne);

      // And the same as an OWNER pays: the scoped branch is a constant, not a tax.
      const ownerSummary = await count(`/me/finance/${await refFor(one.salon.owner, 'business', 'owner')}/summary`, one.salon.owner);
      expect(summaryWithOne).toBe(ownerSummary);
    });

    it('pages settlements deterministically for a grantee, and the cursor is bound to the grantee\'s own reference', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      const ownerRef = await refFor(s.owner, 'business', 'owner');
      const orders = [s.orderId, await earn('business', s.businessId, 500_000), await earn('business', s.businessId, 600_000)];
      for (const orderId of orders) {
        await settlements.createSettlement({
          partyType: 'business',
          partyId: s.businessId,
          orderIds: [orderId],
          method: null,
          reference: null,
          note: null,
          actorId: s.owner.id,
        });
      }

      const first = (await get(`/me/finance/${ref}/settlements?limit=2`, k.user).expect(200)).body.data;
      expect(first.items).toHaveLength(2);
      const second = (
        await get(`/me/finance/${ref}/settlements?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, k.user).expect(200)
      ).body.data;
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const ids = [...first.items, ...second.items].map((b: { id: string }) => b.id);
      expect(ids).toEqual([...ids].sort().reverse());

      // The owner's page of the SAME rows, in the same order -- and the owner's
      // cursor does not work for the grantee, nor the grantee's for the owner.
      const ownerFirst = (await get(`/me/finance/${ownerRef}/settlements?limit=2`, s.owner).expect(200)).body.data;
      expect(ownerFirst.items).toEqual(first.items);
      await get(`/me/finance/${ref}/settlements?cursor=${encodeURIComponent(ownerFirst.nextCursor)}`, k.user).expect(404);
      await get(`/me/finance/${ownerRef}/settlements?cursor=${encodeURIComponent(first.nextCursor)}`, s.owner).expect(404);
    });

    it("a foreign order id through the grantee's workspace is indistinguishable from a missing one", async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      const other = await salon();
      const foreign = (await get(`/me/finance/${ref}/orders/${other.orderId}/ledger`, k.user).expect(200)).body;
      const missing = (await get(`/me/finance/${ref}/orders/${uuidv7()}/ledger`, k.user).expect(200)).body;
      expect(foreign.data).toEqual([]);
      expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
      const own = (await get(`/me/finance/${ref}/orders/${s.orderId}/ledger`, k.user).expect(200)).body.data;
      expect(own.length).toBeGreaterThan(0);
    });
  });

  // =======================================================================
  // §5. The singular routes stay ownership-only
  // =======================================================================

  describe('§5 singular routes', () => {
    it('a grantee who owns nothing gets the unchanged non-seller refusal on all four', async () => {
      const { salon: s, bookkeeper: k } = await grantedBookkeeper();
      const bodies = new Set<string>();
      for (const path of ['/me/finance/summary', '/me/finance/outstanding-orders', '/me/finance/settlements', `/me/finance/orders/${s.orderId}/ledger`]) {
        const res = await get(path, k.user).expect(404);
        bodies.add(JSON.stringify(res.body));
      }
      expect([...bodies]).toHaveLength(1);
      expect(JSON.parse([...bodies][0])).toEqual(REFUSAL);
      // The owner's singular routes are untouched.
      expect((await get('/me/finance/summary', s.owner).expect(200)).body.data.receivableNetToman).toBe(s.receivable);
    });

    it('an owner of one workspace who also holds a grant is NOT turned into a dual owner -- no new 409', async () => {
      const s = await salon();
      const p = await practitioner(s);
      const before = (await get('/me/finance/summary', p.user).expect(200)).body;

      await grantVia(s.businessId, s.owner.accessToken, p.membershipId, 'finance_read').expect(201);
      expect(await listWorkspaces(p.user)).toHaveLength(2);

      const after = (await get('/me/finance/summary', p.user).expect(200)).body;
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(after.data.receivableNetToman).toBe(p.ownReceivable);
      await get('/me/finance/outstanding-orders', p.user).expect(200);
      await get('/me/finance/settlements', p.user).expect(200);
      await get(`/me/finance/orders/${p.ownOrder}/ledger`, p.user).expect(200);
    });
  });

  // =======================================================================
  // §6. Write isolation: the same workspaceRef value buys no write anywhere
  // =======================================================================

  describe('§6 write isolation', () => {
    type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };
    const routeTable = (): Array<{ method: string; path: string }> => {
      const router = (app.getHttpServer() as { _events: { request: { _router: { stack: RouteLayer[] } } } })._events.request
        ._router;
      return router.stack
        .filter((layer) => layer.route)
        .flatMap((layer) => Object.keys(layer.route!.methods).map((method) => ({ method: method.toUpperCase(), path: layer.route!.path })));
    };

    const NON_FINANCE_WORKSPACE_ROUTES = [
      'GET /api/v1/me/subscriptions/:workspaceRef/history',
      'POST /api/v1/me/subscriptions/:workspaceRef/selection',
      'POST /api/v1/me/subscriptions/:workspaceRef/cancellation',
      'POST /api/v1/me/subscriptions/:workspaceRef/credit-purchases/quote',
      'POST /api/v1/me/subscriptions/:workspaceRef/credit-purchases',
      'GET /api/v1/me/subscriptions/:workspaceRef/credit-purchases',
      'GET /api/v1/me/collection-policy-assignments/:workspaceRef',
      'PUT /api/v1/me/collection-policy-assignments/:workspaceRef',
    ];

    /**
     * A published, auto-assignable, zero-price base plan, through the real
     * administrator catalogue service. `resetDatabase` truncates the migration's
     * own base-plan seed, and subscription INITIALIZATION -- which the
     * non-vacuity control below needs so the owner has something to cancel --
     * refuses without one. Mirrors `seller-subscription-surface.pg-spec.ts`.
     */
    async function publishBasePlan(): Promise<void> {
      const catalogue = app.get(CommercialCatalogueService);
      const admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
      const activeFrom = new Date('2020-01-01T00:00:00.000Z');
      const scheduleKey = `sched-${sequence}-${Date.now() % 100000}`;
      await catalogue.createPriceSchedule(admin.id, scheduleKey, 'seller_plan', 'suite setup');
      const scheduleDraft = await catalogue.createScheduleVersionDraft(
        admin.id,
        {
          scheduleKey,
          displayName: `${scheduleKey} v1`,
          activationStartsAt: activeFrom,
          activationEndsAt: null,
          terms: {
            currency: 'IRT',
            minPurchaseQuantity: 1,
            maxPurchaseQuantity: 1,
            uiPresetQuantities: [],
            tiers: [{ minQuantity: 1, maxQuantity: 1, unitPriceToman: 0 }],
          },
        },
        'suite setup',
      );
      const schedule = await catalogue.publishScheduleVersion(admin.id, scheduleKey, scheduleDraft.version, 'suite setup');
      const planKey = `plan-${sequence}-${Date.now() % 100000}`;
      await catalogue.createPlan(admin.id, planKey, 'suite setup');
      const draft = await catalogue.createPlanVersionDraft(
        admin.id,
        {
          planKey,
          priceScheduleVersionId: schedule.id,
          bookingCreditScheduleKey: null,
          autoAssignable: true,
          activationStartsAt: activeFrom,
          activationEndsAt: null,
          terms: {
            displayName: planKey,
            billingTermDays: null,
            includedBookingCredits: 0,
            staffSeats: 0,
            includedLocations: 0,
            capabilityKeys: [],
          },
        },
        'suite setup',
      );
      await catalogue.publishPlanVersion(admin.id, planKey, draft.version, 'suite setup');

      // And one published collection policy, for the same reason: assigning an
      // unknown policy is refused with the same non-enumerating shape as a
      // foreign workspace, so the owner control on that PUT needs a real key.
      const policies = app.get(BookingCollectionPolicyService);
      const policyKey = `cp-${sequence}-${Date.now() % 100000}`;
      await policies.createPolicy(admin.id, policyKey, `${policyKey} display`, 'suite setup');
      const policyDraft = await policies.createVersionDraft(
        admin.id,
        {
          policyKey,
          terms: { contractVersion: 1, collectionMode: 'full_payment_online', deposit: { kind: 'none' } },
          activationEndsAt: null,
        },
        'suite setup',
      );
      await policies.publishVersion(admin.id, policyKey, policyDraft.version, 'suite setup');
      publishedPolicyKey = policyKey;
    }
    let publishedPolicyKey = 'unpublished';

    /** A body every route above accepts syntactically, so the REFERENCE is what decides. */
    const bodyFor = (path: string): Record<string, unknown> => {
      if (path.endsWith('/selection')) return { planKey: 'starter', version: 1 };
      if (path.endsWith('/credit-purchases/quote') || path.endsWith('/credit-purchases')) return { quantity: 1 };
      if (path.includes('collection-policy-assignments')) return { policyKey: publishedPolicyKey, reason: 'bookkeeper reconciliation' };
      return {};
    };

    const send = (method: string, path: string, token: string, body: Record<string, unknown>) => {
      const req = api()[method.toLowerCase() as 'get' | 'post' | 'put'](path).set(auth(token)).set('idempotency-key', uuidv7());
      return method === 'GET' ? req : req.send(body);
    };

    it('every workspaceRef route outside /me/finance is known, so a new one cannot appear unproved', () => {
      const actual = routeTable()
        .filter((r) => r.path.includes(':workspaceRef') && !r.path.startsWith('/api/v1/me/finance'))
        .map((r) => `${r.method} ${r.path}`)
        .sort();
      expect(actual).toEqual([...NON_FINANCE_WORKSPACE_ROUTES].sort());
    });

    it("a grantee's finance reference is refused on every commercial-policy workspace route, byte-identically to a random reference, even when the grantee holds the seller capabilities", async () => {
      const s = await salon();
      // The adversary: a professional owner (token carries bc_manage_own_subscription
      // and bc_manage_own_collection_policy) granted finance_read on the salon.
      const p = await practitioner(s);
      await grantVia(s.businessId, s.owner.accessToken, p.membershipId, 'finance_read').expect(201);
      const granteeRef = await refFor(p.user, 'business', 'finance_read');
      const ownerRef = await refFor(s.owner, 'business', 'owner');
      const random = 'A'.repeat(43);

      // The owner initializes their subscription workspace first, so that the
      // non-vacuity control below (the owner's own reference on the same route
      // with the same body) has a subscription to act on and is answered
      // differently from the reference refusal -- a cancellation on a party
      // with no subscription at all is refused with the same non-enumerating
      // shape, which would make the control vacuous.
      await publishBasePlan();
      await api().post('/api/v1/me/subscriptions/initialization').set(auth(s.owner.accessToken)).send({}).expect(201);

      const before = { app: await applicationCounts(), fin: await financialCounts() };
      const granteeBodies = new Map<string, { status: number; body: string }>();
      for (const route of NON_FINANCE_WORKSPACE_ROUTES) {
        const [method, template] = route.split(' ');
        const withRef = (ref: string) => template.replace(':workspaceRef', ref);

        const grantee = await send(method, withRef(granteeRef), p.user.accessToken, bodyFor(template));
        const rubbish = await send(method, withRef(random), p.user.accessToken, bodyFor(template));
        // Refused, and indistinguishable from a random reference.
        expect([route, grantee.status >= 400]).toEqual([route, true]);
        expect([route, grantee.status]).toEqual([route, rubbish.status]);
        expect([route, JSON.stringify(grantee.body)]).toEqual([route, JSON.stringify(rubbish.body)]);
        granteeBodies.set(route, { status: grantee.status, body: JSON.stringify(grantee.body) });
      }
      // Nothing was written by any of the grantee's attempts.
      expect(await applicationCounts()).toEqual(before.app);
      expect(await financialCounts()).toEqual(before.fin);

      // Non-vacuity, run AFTER the write-nothing check because these controls
      // legitimately write: every route DOES discriminate on the reference --
      // the owner's own reference, same body, is answered differently.
      for (const route of NON_FINANCE_WORKSPACE_ROUTES) {
        const [method, template] = route.split(' ');
        const owner = await send(method, template.replace(':workspaceRef', ownerRef), s.owner.accessToken, bodyFor(template));
        const refused = granteeBodies.get(route)!;
        expect([route, owner.status === refused.status && JSON.stringify(owner.body) === refused.body]).toEqual([route, false]);
      }
    });

    it('the granted business is absent from the commercial-policy LIST surfaces too', async () => {
      const s = await salon();
      const p = await practitioner(s);
      await grantVia(s.businessId, s.owner.accessToken, p.membershipId, 'finance_read').expect(201);

      const listed = (await get('/me/subscriptions', p.user).expect(200)).body.data.items;
      // Only their own professional workspace, if the surface lists it at all.
      expect(listed.filter((w: { workspaceType?: string }) => w.workspaceType === 'business')).toEqual([]);
      const financeRefs = (await listWorkspaces(p.user)).map((e) => e.workspaceRef);
      for (const w of listed) expect(financeRefs.includes(w.workspaceRef) ? w.workspaceType : 'professional').toBe('professional');
    });

    it('a customer-only bookkeeper is refused every seller write by the capability guard, before any reference is read', async () => {
      const { bookkeeper: k, ref } = await grantedBookkeeper();
      for (const route of NON_FINANCE_WORKSPACE_ROUTES.filter((r) => r.startsWith('POST') || r.startsWith('PUT'))) {
        const [method, template] = route.split(' ');
        if (template.endsWith('/credit-purchases/quote')) continue; // a read that happens to be a POST; covered above
        const res = await send(method, template.replace(':workspaceRef', ref), k.user.accessToken, bodyFor(template));
        expect([route, res.status]).toEqual([route, 403]);
      }
    });

    it('admin finance and admin commercial routes refuse the grantee with the capability 403, and no settlement or ledger row can be written', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      const before = await financialCounts();
      const adminRoutes = routeTable().filter(
        (r) => r.path.startsWith('/api/v1/admin/finance') || r.path.startsWith('/api/v1/admin/commercial'),
      );
      expect(adminRoutes.length).toBeGreaterThanOrEqual(2 + 5);
      expect(adminRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(
        expect.arrayContaining(['POST /api/v1/admin/finance/settlements', 'POST /api/v1/admin/finance/settlements/:id/reverse']),
      );
      for (const r of adminRoutes) {
        const path = r.path
          .replace(':id', uuidv7())
          .replace(':scheduleKey', 'x')
          .replace(':planKey', 'x')
          .replace(':policyKey', 'x')
          .replace(':version', '1');
        const client = api();
        const res = await client[r.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'](path)
          .set(auth(k.user.accessToken))
          .send({ partyType: 'business', partyId: s.businessId, orderIds: [s.orderId], workspaceRef: ref });
        expect([r.method, r.path, res.status]).toEqual([r.method, r.path, 403]);
      }
      expect(await financialCounts()).toEqual(before);
    });

    it('there is no payment, refund, settlement or ledger HTTP write a workspaceRef reaches, and the financial role contract is untouched', async () => {
      // No route anywhere takes a workspaceRef and writes financial.*: the only
      // financial writes are the two admin settlement routes proved above, and
      // the writer role cannot UPDATE or DELETE a ledger row at all.
      const financialWrites = routeTable().filter(
        (r) => r.method !== 'GET' && r.path.includes(':workspaceRef') && /finance|ledger|settlement|payment|refund/i.test(r.path),
      );
      expect(financialWrites).toEqual([]);
      await expect(
        ctx.financialDataSource.query(`UPDATE financial.ledger_entries SET amount_toman = 0 WHERE false`),
      ).rejects.toThrow(/permission denied/);
    });
  });

  // =======================================================================
  // §7. Live re-check: revocation and lifecycle, under an unchanged token
  // =======================================================================

  describe('§7 lifecycle', () => {
    const proveNextRequestLoses = async (
      s: Salon,
      user: SeededUser,
      ref: string,
      withdraw: () => Promise<void>,
    ) => {
      const token = user.accessToken; // captured once, reused verbatim
      for (const path of fourReads(ref, s.orderId)) await api().get(`/api/v1${path}`).set(auth(token)).expect(200);
      const financialBefore = await financialCounts();

      await withdraw();

      const bodies = new Set<string>();
      for (const path of fourReads(ref, s.orderId)) {
        const res = await api().get(`/api/v1${path}`).set(auth(token)).expect(404);
        bodies.add(JSON.stringify(res.body));
      }
      expect([...bodies]).toHaveLength(1);
      expect(JSON.parse([...bodies][0])).toEqual(REFUSAL);
      expect((await api().get('/api/v1/me/finance/workspaces').set(auth(token)).expect(200)).body.data.items).toEqual([]);
      // Historical finance is untouched.
      expect(await financialCounts()).toEqual(financialBefore);
    };

    it('revocation: gone on the next request', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      await proveNextRequestLoses(s, k.user, ref, async () => {
        await revokeVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      });
      // The grant row is the record, not deleted.
      const [row] = await grantRows(k.membershipId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_by_user_id).toBe(s.owner.id);
    });

    it('membership becoming inactive: gone on the next request, without the grant row changing', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      const [before] = await grantRows(k.membershipId);
      await proveNextRequestLoses(s, k.user, ref, async () => {
        await api().post(`/api/v1/businesses/${s.businessId}/staff/${k.membershipId}/remove`).set(auth(s.owner.accessToken)).expect(201);
      });
      const [after] = await grantRows(k.membershipId);
      expect(after).toEqual(before);
    });

    it('membership removed by erasure: gone on the next request, grant revoked in the same transaction, export never names the grantor', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      const contract = app.get(BusinessSubjectDataContract);
      await proveNextRequestLoses(s, k.user, ref, async () => {
        await dataSource.transaction(async (manager) => {
          await contract.eraseSubjectData(manager, k.user.id);
        });
      });
      const [{ status }] = await dataSource.query(`SELECT status FROM business.business_staff WHERE id = $1`, [k.membershipId]);
      expect(status).toBe('removed');
      const [row] = await grantRows(k.membershipId);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_by_user_id).toBeNull();

      // Export: the subject's own grant, and never the granting actor.
      const fresh = await grantedBookkeeper();
      const sections = await dataSource.transaction((manager) => contract.exportSubjectData(manager, fresh.bookkeeper.user.id));
      const grantsSection = sections.find((section) => section.key === 'staff_role_grants');
      expect(grantsSection).toBeDefined();
      expect(JSON.stringify(grantsSection)).toContain('finance_read');
      assertNoLeak(grantsSection, fresh.salon.owner.id);
    });

    it('erasure is atomic: a failure leaves the grant live AND the membership active', async () => {
      const { bookkeeper: k, ref } = await grantedBookkeeper();
      const contract = app.get(BusinessSubjectDataContract);
      await expect(
        dataSource.transaction(async (manager) => {
          await contract.eraseSubjectData(manager, k.user.id);
          throw new Error('a later module failed');
        }),
      ).rejects.toThrow('a later module failed');
      const [{ status }] = await dataSource.query(`SELECT status FROM business.business_staff WHERE id = $1`, [k.membershipId]);
      expect(status).toBe('active');
      expect((await grantRows(k.membershipId))[0].revoked_at).toBeNull();
      await get(`/me/finance/${ref}/summary`, k.user).expect(200);
    });

    it('business soft deletion: gone on the next request, for the grantee and the owner alike', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      const ownerRef = await refFor(s.owner, 'business', 'owner');
      await proveNextRequestLoses(s, k.user, ref, async () => {
        await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [s.businessId]);
      });
      const ownerRefused = await get(`/me/finance/${ownerRef}/summary`, s.owner).expect(404);
      const granteeRefused = await get(`/me/finance/${ref}/summary`, k.user).expect(404);
      expect(JSON.stringify(ownerRefused.body)).toBe(JSON.stringify(granteeRefused.body));
    });

    it('a token minted BEFORE the grant reads after it; nothing is cached in a claim', async () => {
      const s = await salon();
      const k = await bookkeeper(s);
      const token = k.user.accessToken;
      const ref = workspaces.referenceFor(k.user.id, { partyType: 'business', partyId: s.businessId });
      await api().get(`/api/v1/me/finance/${ref}/summary`).set(auth(token)).expect(404);
      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      await api().get(`/api/v1/me/finance/${ref}/summary`).set(auth(token)).expect(200);
      await revokeVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      await api().get(`/api/v1/me/finance/${ref}/summary`).set(auth(token)).expect(404);
      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      await api().get(`/api/v1/me/finance/${ref}/summary`).set(auth(token)).expect(200);
    });

    it('location reassignment and professional-affiliation changes neither create nor disturb finance access', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      // A location, and the bookkeeper bound to it, then unbound. Access unchanged.
      const [{ id: cityId }] = await dataSource.query(
        `INSERT INTO provider.locations_cities (id, name, is_launched) VALUES ($1, 'شهر', true) RETURNING id`,
        [uuidv7()],
      );
      const [{ id: locationId }] = await dataSource.query(
        `INSERT INTO business.locations (id, business_id, city_id, name, lifecycle) VALUES ($1, $2, $3, 'شعبه', 'active') RETURNING id`,
        [uuidv7(), s.businessId, cityId],
      );
      await dataSource.query(`UPDATE business.business_staff SET location_id = $1 WHERE id = $2`, [locationId, k.membershipId]);
      await get(`/me/finance/${ref}/summary`, k.user).expect(200);
      await dataSource.query(`UPDATE business.business_staff SET location_id = NULL WHERE id = $1`, [k.membershipId]);
      await get(`/me/finance/${ref}/summary`, k.user).expect(200);

      // A practitioner whose affiliation moves salons: the OLD salon's finance
      // was never theirs by affiliation, and is not theirs after either.
      const p = await practitioner(s);
      const other = await salon();
      const theirRefToS = workspaces.referenceFor(p.user.id, { partyType: 'business', partyId: s.businessId });
      await get(`/me/finance/${theirRefToS}/summary`, p.user).expect(404);
      await staff.deactivate(p.membershipId);
      const moved = await seedMembership(dataSource, other.businessId, p.user.id, 'staff', other.owner.id, p.professional.id);
      await staff.accept(moved, p.user.id);
      await get(`/me/finance/${theirRefToS}/summary`, p.user).expect(404);
      const theirRefToOther = workspaces.referenceFor(p.user.id, { partyType: 'business', partyId: other.businessId });
      await get(`/me/finance/${theirRefToOther}/summary`, p.user).expect(404);
    });

    it('SellerPartyLookup is untouched: affiliation still decides whose money it is, grant or no grant', async () => {
      const s = await salon();
      const p = await practitioner(s);
      const lookup = app.get(SellerPartyLookup);
      const before = await lookup.forProfessional(dataSource.manager, p.professional.id);
      expect(before).toEqual({ partyType: 'business', partyId: s.businessId });

      await grantVia(s.businessId, s.owner.accessToken, p.membershipId, 'finance_read').expect(201);
      expect(await lookup.forProfessional(dataSource.manager, p.professional.id)).toEqual(before);
      await revokeVia(s.businessId, s.owner.accessToken, p.membershipId, 'finance_read').expect(201);
      expect(await lookup.forProfessional(dataSource.manager, p.professional.id)).toEqual(before);

      // And a bookkeeper's grant creates no beneficiary at all: the professional
      // they do not have cannot be looked up.
      const k = await bookkeeper(s);
      await grantVia(s.businessId, s.owner.accessToken, k.membershipId, 'finance_read').expect(201);
      expect(await lookup.forProfessional(dataSource.manager, uuidv7())).toEqual({
        partyType: 'professional',
        partyId: expect.any(String),
      });
    });
  });

  // =======================================================================
  // §8. One refusal, byte for byte, across every cause
  // =======================================================================

  describe('§8 refusal contract', () => {
    it('answers malformed, unknown, foreign-user, foreign-business, revoked, removed, deleted and missing-role references identically', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      const other = await salon();
      const otherOwnerRef = await refFor(other.owner, 'business', 'owner');
      const noRole = await bookkeeper(s);
      const noRoleRef = workspaces.referenceFor(noRole.user.id, { partyType: 'business', partyId: s.businessId });

      const responses: Array<[string, request.Response]> = [];
      const probe = async (label: string, path: string, user: SeededUser) => {
        responses.push([label, await get(path, user)]);
      };

      await probe('malformed', `/me/finance/${encodeURIComponent('not-a-reference')}/summary`, k.user);
      await probe('wrong length', `/me/finance/${'A'.repeat(42)}/summary`, k.user);
      await probe('unknown', `/me/finance/${'A'.repeat(43)}/summary`, k.user);
      await probe('raw business id', `/me/finance/${s.businessId}/summary`, k.user);
      await probe('another user\'s reference', `/me/finance/${otherOwnerRef}/summary`, k.user);
      await probe('another business, own derivation', `/me/finance/${workspaces.referenceFor(k.user.id, { partyType: 'business', partyId: other.businessId })}/summary`, k.user);
      await probe('missing role', `/me/finance/${noRoleRef}/summary`, noRole.user);

      // Revoked.
      const revokedK = await bookkeeper(s);
      await grantVia(s.businessId, s.owner.accessToken, revokedK.membershipId, 'finance_read').expect(201);
      const revokedRef = await refFor(revokedK.user, 'business', 'finance_read');
      await revokeVia(s.businessId, s.owner.accessToken, revokedK.membershipId, 'finance_read').expect(201);
      await probe('revoked grant', `/me/finance/${revokedRef}/summary`, revokedK.user);

      // Removed membership.
      const removedK = await bookkeeper(s);
      await grantVia(s.businessId, s.owner.accessToken, removedK.membershipId, 'finance_read').expect(201);
      const removedRef = await refFor(removedK.user, 'business', 'finance_read');
      await staff.deactivate(removedK.membershipId);
      await probe('removed membership', `/me/finance/${removedRef}/summary`, removedK.user);

      // Deleted business -- last, because it withdraws everyone's access.
      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [s.businessId]);
      await probe('deleted business', `/me/finance/${ref}/summary`, k.user);

      const [first, ...rest] = responses;
      expect(first[1].status).toBe(404);
      for (const [label, res] of rest) {
        expect([label, res.status]).toEqual([label, 404]);
        expect([label, JSON.stringify(res.body)]).toEqual([label, JSON.stringify(first[1].body)]);
      }
      expect(first[1].body).toEqual(REFUSAL);
    });

    it('an unauthenticated request is refused before any reference or grant is consulted, on all five routes', async () => {
      const { salon: s, ref } = await grantedBookkeeper();
      let scopedQueries = 0;
      const original = dataSource.logger;
      try {
        dataSource.logger = {
          logQuery: (query: string) => {
            if (/staff_role_grants/i.test(query)) scopedQueries += 1;
          },
          logQueryError: () => undefined,
          logQuerySlow: () => undefined,
          logSchemaBuild: () => undefined,
          logMigration: () => undefined,
          log: () => undefined,
        } as never;
        for (const path of ['/me/finance/workspaces', ...fourReads(ref, s.orderId)]) await get(path).expect(401);
      } finally {
        dataSource.logger = original;
      }
      expect(scopedQueries).toBe(0);
    });

    it('no read writes anything, anywhere: no audit row, no grant row, no financial row', async () => {
      const { salon: s, bookkeeper: k, ref } = await grantedBookkeeper();
      const financialBefore = await financialCounts();
      const applicationBefore = await applicationCounts();

      await get('/me/finance/workspaces', k.user).expect(200);
      for (const path of fourReads(ref, s.orderId)) await get(path, k.user).expect(200);
      await get(`/me/finance/${'A'.repeat(43)}/summary`, k.user).expect(404);
      await get('/me/finance/summary', k.user).expect(404);

      expect(await financialCounts()).toEqual(financialBefore);
      expect(await applicationCounts()).toEqual(applicationBefore);
    });
  });

  // =======================================================================
  // §9. Route table, ADR-027 and the unchanged #72 gate
  // =======================================================================

  describe('§9 the surface is unchanged', () => {
    it('the finance route table is still exactly nine routes', () => {
      const server = app.getHttpServer();
      const router = server._events.request._router as { stack: Array<{ route?: { path: string } }> };
      const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route!.path);
      expect(paths.filter((path) => path.startsWith('/api/v1/me/finance')).sort()).toEqual(
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
    });

    it('no ADR-027 disposition changed: the exact-set coverage still holds with no new table', async () => {
      const coverage = app.get(SubjectDataCoverageService);
      const report = await coverage.assertComplete(app.get(SUBJECT_DATA_CONTRACTS));
      expect(report?.violations).toEqual([]);
      const [{ c }] = await dataSource.query(
        `SELECT count(*)::int AS c FROM pg_tables WHERE schemaname = 'business' AND tablename = 'staff_role_grants'`,
      );
      expect(c).toBe(1);
      const cols = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'business' AND table_name = 'staff_role_grants' ORDER BY ordinal_position`,
        )
      ).map((row: { column_name: string }) => row.column_name);
      expect(cols).toEqual([
        'id',
        'membership_id',
        'business_id',
        'role',
        'granted_by_user_id',
        'granted_at',
        'revoked_by_user_id',
        'revoked_at',
      ]);
    });
  });
});
