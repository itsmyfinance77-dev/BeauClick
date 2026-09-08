import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  BusinessSubjectDataContract,
  SCOPED_STAFF_AUTHORIZER,
  STAFF_INVITE_MIN_RESPONSE_MS,
  ScopedStaffAuthorizerPort,
  StaffGrantService,
  StaffService,
} from '@beauclick/business';
import { AdminAuditService } from '@beauclick/audit';
import {
  CatalogueTable,
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  evaluateCoverage,
} from '@beauclick/subject-data';

import {
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedMembership,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

/**
 * REAL PostgreSQL: V3.3 Story #109 (`#44c`) -- scoped staff roles and
 * permissions.
 *
 * ## Why every case here needs a real server
 *
 * ADR-049 section 2.4. The in-memory layer honours neither `ROLLBACK`, nor row
 * locks, nor partial unique indexes, nor CHECK constraints, nor row triggers,
 * nor `xmin`. This story's load-bearing guarantees are made of exactly those
 * things:
 *
 *  * the closed role and status vocabularies are **database** CHECKs, not
 *    TypeScript unions somebody could widen in one line;
 *  * "a cross-business grant is unwritable" is a composite foreign key, and the
 *    word that matters is *unwritable* -- refused by the server, not by a
 *    service that could be called a second way;
 *  * "exactly one live grant" is a partial unique index under real concurrency;
 *  * "immutable plus one-way revocation" is a row trigger;
 *  * "existing rows are byte-identical" is `xmin`;
 *  * "erasure is one transaction" is a `ROLLBACK`.
 *
 * The closed vocabularies as TypeScript, the DTO refusals, the boundary scans
 * and the deterministic timing-floor proof live in the fast layer
 * (`scoped-staff.contract.spec.ts`, `scoped-staff-boundary.spec.ts`,
 * `staff-invite-timing.spec.ts`), because they need no database.
 *
 * ## What "byte-identical refusal" means here
 *
 * Every adversarial case asserts the **whole response body**, compared against
 * the other refusals rather than against a literal. A refusal that started
 * carrying a reason code would break the comparison even if its status stayed
 * `404`, which is the leak this story is actually guarding against.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

/** The three actions this story may ever write, and the only ones it counts. */
const STORY_AUDIT_ACTIONS = [
  'business.staff_grant_granted',
  'business.staff_grant_revoked',
  'business.staff_invited',
];

describeIfPg('Scoped staff authority on real PostgreSQL (#109)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let staff: StaffService;
  let grants: StaffGrantService;
  let authorizer: ScopedStaffAuthorizerPort;
  let coverage: SubjectDataCoverageService;
  let contracts: SubjectDataContract[];

  let phoneCounter = 0;
  /**
   * A phone unique across the whole run.
   *
   * `identity.users.phone` is unique and this suite seeds a lot of people. A
   * monotonic counter folded into the number is deterministic, unlike the
   * `Date.now()` slices elsewhere in this directory, which collide when two
   * cases run inside the same millisecond.
   */
  const uniquePhone = () => `+9891${String(10_000_000 + phoneCounter++).slice(-8)}`;

  beforeAll(async () => {
    const ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    staff = app.get(StaffService);
    grants = app.get(StaffGrantService);
    authorizer = app.get(SCOPED_STAFF_AUTHORIZER);
    coverage = app.get(SubjectDataCoverageService);
    contracts = app.get(SUBJECT_DATA_CONTRACTS);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // `admin.admin_audit_log` is deliberately NOT reset: the application role
    // holds INSERT and SELECT only, which is the guarantee that makes it worth
    // auditing to. Every assertion below scopes to its own target id or takes a
    // before/after delta.
  });

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const auditCount = async (): Promise<number> => {
    const [{ c }] = await dataSource.query(
      `SELECT count(*)::int AS c FROM admin.admin_audit_log WHERE action = ANY($1)`,
      [STORY_AUDIT_ACTIONS],
    );
    return c;
  };

  const auditRowsFor = (targetId: string) =>
    dataSource.query(
      `SELECT actor_user_id, action, target_type, target_id, before_state, after_state, reason
         FROM admin.admin_audit_log WHERE target_id = $1 ORDER BY created_at`,
      [targetId],
    );

  const countOf = async (sql: string, params: unknown[] = []): Promise<number> => {
    const [{ c }] = await dataSource.query(sql, params);
    return Number(c);
  };

  const liveGrantRows = (membershipId: string) =>
    dataSource.query(
      `SELECT id, role, business_id, granted_by_user_id, revoked_by_user_id, revoked_at
         FROM business.staff_role_grants WHERE membership_id = $1 ORDER BY granted_at`,
      [membershipId],
    );

  // -------------------------------------------------------------------------
  // Scenario builders — real rows through the real schema
  // -------------------------------------------------------------------------

  interface Salon {
    owner: Awaited<ReturnType<typeof seedUser>>;
    business: { id: string };
  }

  async function seedSalon(): Promise<Salon> {
    const owner = await seedUser(app, dataSource, uniquePhone(), ['customer', 'business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن آزمون');
    return { owner, business };
  }

  /**
   * A consented, professional-linked, `active` membership.
   *
   * The row is seeded at `invited` and moved to `active` through
   * `StaffService.accept` **from the invitee's own id** — never by an UPDATE.
   * ADR-023's structural consent is the thing a grant hangs off, so a helper
   * that shortcut it would make every grant case below prove less than it says.
   */
  async function seedPractitioner(salon: Salon, opts: { activate?: boolean } = {}) {
    const user = await seedUser(app, dataSource, uniquePhone(), ['customer', 'professional']);
    const professional = await seedProfessional(dataSource, user.id, 'آرایشگر');
    const membershipId = await seedMembership(
      dataSource,
      salon.business.id,
      user.id,
      'staff',
      salon.owner.id,
      professional.id,
    );
    if (opts.activate !== false) await staff.accept(membershipId, user.id);
    return { user, professional, membershipId };
  }

  let slotOffsetHours = 0;
  /**
   * A qualifying booking plus its commerce order, exactly as `CheckoutService`
   * writes them: the order carries the seller-party **snapshot**, which is what
   * makes a practitioner who later changes salon unable to reach the
   * conversation they used to serve.
   */
  async function seedQualifyingBooking(input: {
    customerId: string;
    professionalId: string;
    serviceId: string;
    sellerBusinessId: string;
    status?: string;
  }): Promise<string> {
    const bookingId = uuidv7();
    // `ex_availability_slots_no_overlap` forbids two overlapping slots for one
    // professional, so each seeded slot walks a further hour back.
    slotOffsetHours += 1;
    const start = new Date(Date.now() - 7 * 86_400_000 - slotOffsetHours * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    const slotId = await seedSlot(dataSource, input.professionalId, input.serviceId, start);

    await dataSource.query(
      `INSERT INTO booking.bookings
         (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [bookingId, input.customerId, input.professionalId, input.serviceId, slotId, start, end, input.status ?? 'completed'],
    );
    await dataSource.query(
      `INSERT INTO commerce.orders
         (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
          status, currency, subtotal_toman, total_toman, paid_at)
       VALUES ($1, 'booking', $2, $3, 'business', $4, 'paid', 'IRT', 100000, 100000, now())`,
      [uuidv7(), bookingId, input.customerId, input.sellerBusinessId],
    );
    return bookingId;
  }

  /** The customer opens the conversation, which is the only direction chat permits. */
  async function startConversation(customerToken: string, businessId: string): Promise<string> {
    const res = await api()
      .post('/api/v1/chat/conversations')
      .set(auth(customerToken))
      .send({ counterpartyType: 'business', counterpartyId: businessId })
      .expect(201);
    return res.body.data.id;
  }

  const grantVia = (businessId: string, token: string, membershipId: string) =>
    api()
      .post(`/api/v1/businesses/${businessId}/staff/${membershipId}/grants`)
      .set(auth(token))
      .send({ role: 'practitioner_chat' });

  const revokeVia = (businessId: string, token: string, membershipId: string) =>
    api()
      .post(`/api/v1/businesses/${businessId}/staff/${membershipId}/grants/revoke`)
      .set(auth(token))
      .send({ role: 'practitioner_chat' });

  // =========================================================================
  // 1. The vocabularies are closed BY THE DATABASE
  // =========================================================================

  describe('closed vocabularies, enforced by PostgreSQL rather than by TypeScript', () => {
    /** A grant row inserted straight past every service, to prove the server itself refuses. */
    async function rawGrant(membershipId: string, businessId: string, role: string, actor: string) {
      return dataSource.query(
        `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), membershipId, businessId, role, actor],
      );
    }

    it('admits `practitioner_chat` and refuses every other role, including `owner`', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);

      // The positive control. Without it the refusals below could all be
      // failing for an unrelated reason -- a bad membership id, say.
      await expect(
        rawGrant(practitioner.membershipId, salon.business.id, 'practitioner_chat', salon.owner.id),
      ).resolves.toBeDefined();

      for (const forbidden of ['owner', 'manager', 'staff', 'location_manager', 'location_viewer', 'finance', '']) {
        await expect(
          rawGrant(practitioner.membershipId, salon.business.id, forbidden, salon.owner.id),
        ).rejects.toThrow(/ck_staff_role_grants_role/);
      }
    });

    it('closes business_staff.status over exactly the five ratified members', async () => {
      const salon = await seedSalon();
      const user = await seedUser(app, dataSource, uniquePhone());
      const membershipId = await seedMembership(dataSource, salon.business.id, user.id, 'staff', salon.owner.id);

      for (const admitted of ['invited', 'active', 'inactive', 'declined', 'removed']) {
        await expect(
          dataSource.query(`UPDATE business.business_staff SET status = $1 WHERE id = $2`, [admitted, membershipId]),
        ).resolves.toBeDefined();
      }
      for (const refused of ['pending', 'deleted', 'owner', 'REMOVED', '']) {
        await expect(
          dataSource.query(`UPDATE business.business_staff SET status = $1 WHERE id = $2`, [refused, membershipId]),
        ).rejects.toThrow(/ck_business_staff_status/);
      }
    });

    it('leaves business_staff.role untouched — no CHECK, no widening, same type', async () => {
      // `V33-DEC-033` R5: new authority is a scoped GRANT, never a wider role
      // string. This story added a CHECK to `status` and deliberately none to
      // `role`, and it changed neither the column's type nor its length.
      const [column] = await dataSource.query(
        `SELECT data_type, character_maximum_length AS len
           FROM information_schema.columns
          WHERE table_schema = 'business' AND table_name = 'business_staff' AND column_name = 'role'`,
      );
      expect(column).toEqual({ data_type: 'character varying', len: 20 });

      const roleChecks = await dataSource.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'business.business_staff'::regclass
            AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'`,
      );
      expect(roleChecks).toEqual([]);
    });

    it('the grant table carries exactly the ratified columns and no speculative scope', async () => {
      const columns = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'business' AND table_name = 'staff_role_grants'
          ORDER BY column_name`,
      );
      expect(columns.map((c: { column_name: string }) => c.column_name)).toEqual([
        'business_id',
        'granted_at',
        'granted_by_user_id',
        'id',
        'membership_id',
        'revoked_at',
        'revoked_by_user_id',
        'role',
      ]);
    });
  });

  // =========================================================================
  // 2. The migration did not rewrite a single existing row
  // =========================================================================

  describe('migration stability', () => {
    it('adding ck_business_staff_status validates without rewriting rows (xmin preserved)', async () => {
      const salon = await seedSalon();
      const user = await seedUser(app, dataSource, uniquePhone());
      const membershipId = await seedMembership(dataSource, salon.business.id, user.id, 'staff', salon.owner.id);

      const xminOf = async (): Promise<string> => {
        const [row] = await dataSource.query(`SELECT xmin::text AS x FROM business.business_staff WHERE id = $1`, [
          membershipId,
        ]);
        return row.x;
      };

      const before = await xminOf();

      // The migration's own statement, replayed. Dropping and re-adding the
      // CHECK is the migration's effect on an existing row, isolated: if adding
      // it rewrote rows, `xmin` would move here exactly as it would have moved
      // in production.
      await dataSource.query(`ALTER TABLE business.business_staff DROP CONSTRAINT ck_business_staff_status`);
      await dataSource.query(
        `ALTER TABLE business.business_staff ADD CONSTRAINT ck_business_staff_status
         CHECK (status IN ('invited', 'active', 'inactive', 'declined', 'removed'))`,
      );

      expect(await xminOf()).toBe(before);

      // Non-vacuity: `xmin` is a real observation, and a genuine row rewrite
      // does move it. Without this the assertion above would pass against a
      // constant.
      await dataSource.query(`UPDATE business.business_staff SET role = 'manager' WHERE id = $1`, [membershipId]);
      expect(await xminOf()).not.toBe(before);
    });

    it('the constraint is VALIDATED, not left NOT VALID over existing rows', async () => {
      // A `NOT VALID` CHECK constrains future writes only and silently tolerates
      // whatever is already there -- which would make the vocabulary closure a
      // claim about new rows rather than about the column.
      const [row] = await dataSource.query(
        `SELECT convalidated FROM pg_constraint
          WHERE conrelid = 'business.business_staff'::regclass AND conname = 'ck_business_staff_status'`,
      );
      expect(row.convalidated).toBe(true);
    });
  });

  // =========================================================================
  // 3. Database-enforced integrity: FK, partial uniqueness, immutability, races
  // =========================================================================

  describe('integrity the database enforces, not the application', () => {
    it('a cross-business grant is UNWRITABLE, not merely refused by a service', async () => {
      const salonA = await seedSalon();
      const salonB = await seedSalon();
      const practitioner = await seedPractitioner(salonA);

      // Membership belongs to A; the grant names B. The composite FK has no
      // matching `(id, business_id)` pair, so PostgreSQL refuses it outright.
      await expect(
        dataSource.query(
          `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id)
           VALUES ($1, $2, $3, 'practitioner_chat', $4)`,
          [uuidv7(), practitioner.membershipId, salonB.business.id, salonB.owner.id],
        ),
      ).rejects.toThrow(/fk_staff_role_grants_membership_same_business/);
    });

    it('admits exactly one LIVE grant per (membership, role, business), and re-grant after revoke', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);

      const insert = () =>
        dataSource.query(
          `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id)
           VALUES ($1, $2, $3, 'practitioner_chat', $4)`,
          [uuidv7(), practitioner.membershipId, salon.business.id, salon.owner.id],
        );

      await insert();
      await expect(insert()).rejects.toThrow(/uq_staff_role_grants_live/);

      // A revoked row vacates the slot, so revoke-then-re-grant is ordinary and
      // the history is kept rather than rewritten.
      await dataSource.query(
        `UPDATE business.staff_role_grants SET revoked_at = now() WHERE membership_id = $1 AND revoked_at IS NULL`,
        [practitioner.membershipId],
      );
      await expect(insert()).resolves.toBeDefined();
      expect(await liveGrantRows(practitioner.membershipId)).toHaveLength(2);
    });

    it('grant facts are immutable, revocation is one-way, and DELETE is refused', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      const other = await seedPractitioner(salon);

      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      const [grant] = await liveGrantRows(practitioner.membershipId);

      // Every immutable fact, one at a time, each set to a DIFFERENT value —
      // the trigger compares NEW to OLD, so re-writing a column with the value
      // it already holds is not a change and is correctly permitted.
      for (const [column, value] of [
        ['membership_id', other.membershipId],
        ['business_id', uuidv7()],
        ['granted_by_user_id', uuidv7()],
        ['granted_at', new Date(0).toISOString()],
        ['id', uuidv7()],
      ] as const) {
        await expect(
          dataSource.query(`UPDATE business.staff_role_grants SET ${column} = $1 WHERE id = $2`, [value, grant.id]),
        ).rejects.toThrow(/immutable|restrict/i);
      }

      // `role` is doubly closed, and the order is worth stating: a BEFORE ROW
      // trigger runs ahead of constraint evaluation, so a re-pointing update is
      // refused as an immutability violation and never reaches
      // `ck_staff_role_grants_role`. Either refusal is correct; what must not
      // happen is the update succeeding. Setting it to the one admitted value is
      // a no-op and is correctly allowed, which is why the loop above cannot
      // express this column and this case states it instead.
      await expect(
        dataSource.query(`UPDATE business.staff_role_grants SET role = 'location_manager' WHERE id = $1`, [grant.id]),
      ).rejects.toThrow(/immutable|ck_staff_role_grants_role/);

      await expect(
        dataSource.query(`DELETE FROM business.staff_role_grants WHERE id = $1`, [grant.id]),
      ).rejects.toThrow(/never deleted|restrict/i);

      // Revocation itself is permitted...
      await dataSource.query(`UPDATE business.staff_role_grants SET revoked_at = now() WHERE id = $1`, [grant.id]);
      // ...and is one-way. Reviving a revoked grant is the second way past
      // `uq_staff_role_grants_live`, and the trigger closes it.
      await expect(
        dataSource.query(`UPDATE business.staff_role_grants SET revoked_at = NULL WHERE id = $1`, [grant.id]),
      ).rejects.toThrow(/one-way|restrict/i);
    });

    it('CONCURRENT identical grants yield exactly one live row and exactly one audit row', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      const before = await auditCount();

      // Twelve genuinely concurrent calls through the real service, each in its
      // own transaction against the real server. `ON CONFLICT … DO NOTHING`
      // against the partial index is what makes a race and a replay the same
      // thing; pg-mem honours neither, which is why this case lives here.
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          grants.grant(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat'),
        ),
      );
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      const rows = await liveGrantRows(practitioner.membershipId);
      expect(rows.filter((r: { revoked_at: Date | null }) => r.revoked_at === null)).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(await auditCount()).toBe(before + 1);
    });

    it('CONCURRENT revokes produce one revocation instant and one audit row', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      await grants.grant(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat');
      const before = await auditCount();

      await Promise.all(
        Array.from({ length: 8 }, () =>
          grants.revoke(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat'),
        ),
      );

      const rows = await liveGrantRows(practitioner.membershipId);
      expect(rows).toHaveLength(1);
      expect(rows[0].revoked_at).not.toBeNull();
      expect(await auditCount()).toBe(before + 1);
    });
  });

  // =========================================================================
  // 4. Owner-only grant and revoke, proved adversarially
  // =========================================================================

  describe('grant and revoke are owner-only', () => {
    it('the owner grants and revokes; the response carries roles and nothing else', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);

      const granted = await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      expect(granted.body.data).toEqual({ roles: ['practitioner_chat'] });

      const listed = await api()
        .get(`/api/v1/businesses/${salon.business.id}/staff/${practitioner.membershipId}/grants`)
        .set(auth(salon.owner.accessToken))
        .expect(200);
      expect(listed.body.data).toEqual({ roles: ['practitioner_chat'] });

      const revoked = await revokeVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      expect(revoked.body.data).toEqual({ roles: [] });
    });

    it('every non-owner and every invalid target is refused with a BYTE-IDENTICAL body', async () => {
      const salon = await seedSalon();
      const foreign = await seedSalon();
      const practitioner = await seedPractitioner(salon);

      // A manager of the same salon. `V33-DEC-033`: a manager cannot grant a role.
      const managerUser = await seedUser(app, dataSource, uniquePhone(), ['customer', 'business']);
      const managerMembership = await seedMembership(
        dataSource,
        salon.business.id,
        managerUser.id,
        'manager',
        salon.owner.id,
      );
      await staff.accept(managerMembership, managerUser.id);

      // A plain staff member, and the grantee themselves.
      const stranger = await seedUser(app, dataSource, uniquePhone(), ['customer', 'business']);

      // A membership that is not `active`.
      const invitedOnly = await seedPractitioner(salon, { activate: false });
      // A membership with no professional link — it could authorize nothing, so
      // it may not be granted.
      const linkless = await seedUser(app, dataSource, uniquePhone());
      const linklessMembership = await seedMembership(
        dataSource,
        salon.business.id,
        linkless.id,
        'staff',
        salon.owner.id,
      );
      await staff.accept(linklessMembership, linkless.id);

      const refusals = [
        ['a manager of the same salon', salon.business.id, managerUser.accessToken, practitioner.membershipId],
        ['the grantee themselves', salon.business.id, practitioner.user.accessToken, practitioner.membershipId],
        ['a stranger', salon.business.id, stranger.accessToken, practitioner.membershipId],
        ['a foreign owner', salon.business.id, foreign.owner.accessToken, practitioner.membershipId],
        ['the owner, on a foreign business', foreign.business.id, salon.owner.accessToken, practitioner.membershipId],
        ['the owner, on a nonexistent membership', salon.business.id, salon.owner.accessToken, uuidv7()],
        ['the owner, on a non-active membership', salon.business.id, salon.owner.accessToken, invitedOnly.membershipId],
        ['the owner, on a professional-less membership', salon.business.id, salon.owner.accessToken, linklessMembership],
      ] as const;

      const bodies: Record<string, unknown> = {};
      for (const [label, businessId, token, membershipId] of refusals) {
        const res = await grantVia(businessId, token, membershipId);
        expect([label, res.status]).toEqual([label, 404]);
        bodies[label] = res.body;
      }

      // Not merely "all 404" — the whole body is one shape. A refusal that grew
      // a reason code would fail here even though its status stayed 404.
      const distinct = new Set(Object.values(bodies).map((b) => JSON.stringify(b)));
      expect([...distinct]).toHaveLength(1);

      // The positive control, so the uniformity above is not the uniformity of
      // a route that refuses everybody.
      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);

      // And nothing was written by any of the refusals.
      expect(await liveGrantRows(practitioner.membershipId)).toHaveLength(1);
    });

    it('a soft-deleted business cannot be granted on, even by its owner', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [salon.business.id]);

      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(404);
      expect(await liveGrantRows(practitioner.membershipId)).toHaveLength(0);
    });

    it('a replayed grant and a no-op revoke write no second row and no second audit', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);

      const start = await auditCount();
      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      expect(await auditCount()).toBe(start + 1);
      expect(await liveGrantRows(practitioner.membershipId)).toHaveLength(1);

      await revokeVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      await revokeVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      expect(await auditCount()).toBe(start + 2);

      // A read writes nothing at all.
      await api()
        .get(`/api/v1/businesses/${salon.business.id}/staff/${practitioner.membershipId}/grants`)
        .set(auth(salon.owner.accessToken))
        .expect(200);
      expect(await auditCount()).toBe(start + 2);
    });

    it('the audit row names the acting owner and the grant, and no invitee identity', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      const [grant] = await liveGrantRows(practitioner.membershipId);

      const [row] = await auditRowsFor(grant.id);
      expect(row).toMatchObject({
        actor_user_id: salon.owner.id,
        action: 'business.staff_grant_granted',
        target_type: 'business.staff_grant',
        target_id: grant.id,
        after_state: { role: 'practitioner_chat', live: true },
        reason: 'scoped staff role granted by the business owner',
      });
      // The grantee's identity is not in the snapshot: the row it names is a
      // business row, and the actor column is where actor identity belongs.
      expect(JSON.stringify(row)).not.toContain(practitioner.user.id);
      expect(JSON.stringify(row)).not.toContain(practitioner.professional.id);
    });

    it('the audit row is written in the SAME transaction as the grant (equal xmin)', async () => {
      /*
       * Added because a mutation escaped: moving the audit write to
       * `AdminAuditService.recordDetached` — which opens its own transaction —
       * broke the "audited in the same transaction" guarantee and **no test
       * noticed**. The rollback case below could not see it, because it stubs
       * `record`, and a detached implementation never calls `record`.
       *
       * `xmin` is the id of the transaction that inserted a row, so two rows
       * carry the same `xmin` if and only if one transaction wrote both. That is
       * a direct observation of the property rather than a proxy for it: it holds
       * no matter which audit method is called, or how many are added later.
       */
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      const [grant] = await liveGrantRows(practitioner.membershipId);

      const [grantRow] = await dataSource.query(
        `SELECT xmin::text AS x FROM business.staff_role_grants WHERE id = $1`,
        [grant.id],
      );
      const [auditRow] = await dataSource.query(
        `SELECT xmin::text AS x FROM admin.admin_audit_log WHERE target_id = $1`,
        [grant.id],
      );
      expect(auditRow).toBeDefined();
      expect(auditRow.x).toBe(grantRow.x);

      // Non-vacuity: `xmin` really does differ across transactions, so the
      // equality above is an observation and not a constant.
      await revokeVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      const [revokeAudit] = await dataSource.query(
        `SELECT xmin::text AS x FROM admin.admin_audit_log
          WHERE target_id = $1 AND action = 'business.staff_grant_revoked'`,
        [grant.id],
      );
      expect(revokeAudit.x).not.toBe(grantRow.x);
    });

    it('an audit failure rolls the grant back with it — one transaction, not two', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);

      // The audit insert is made to fail on the SAME connection the grant is
      // written on. If the two were separate transactions the grant would
      // survive; the point of the guarantee is that it does not.
      const audit = app.get(AdminAuditService);
      const original = audit.record;
      audit.record = async () => {
        throw new Error('audit refused (deliberate)');
      };
      try {
        await expect(
          grants.grant(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat'),
        ).rejects.toThrow('audit refused (deliberate)');
      } finally {
        audit.record = original;
      }

      expect(await liveGrantRows(practitioner.membershipId)).toHaveLength(0);
    });
  });

  // =========================================================================
  // 5. Authority is re-read live, on every request
  // =========================================================================

  describe('live authority', () => {
    it('a revoked grant fails on the NEXT request, under the same unchanged token', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      const customer = await seedUser(app, dataSource, uniquePhone());
      await seedQualifyingBooking({
        customerId: customer.id,
        professionalId: practitioner.professional.id,
        serviceId: practitioner.professional.serviceId,
        sellerBusinessId: salon.business.id,
      });
      const conversationId = await startConversation(customer.accessToken, salon.business.id);

      // The token is captured ONCE and reused verbatim across the revocation.
      const token = practitioner.user.accessToken;

      await api().get(`/api/v1/chat/conversations/${conversationId}`).set(auth(token)).expect(404);
      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      await api().get(`/api/v1/chat/conversations/${conversationId}`).set(auth(token)).expect(200);

      await revokeVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      // Same token, next request, refused. Not at the next token issuance.
      await api().get(`/api/v1/chat/conversations/${conversationId}`).set(auth(token)).expect(404);
    });

    it('grants and revokes write no identity role and mint no capability', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);

      const rolesBefore = await dataSource.query(
        `SELECT role_slug FROM identity.user_roles WHERE user_id = $1 ORDER BY role_slug`,
        [practitioner.user.id],
      );
      const columnBefore = await dataSource.query(`SELECT roles FROM identity.users WHERE id = $1`, [
        practitioner.user.id,
      ]);

      await grantVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);
      await revokeVia(salon.business.id, salon.owner.accessToken, practitioner.membershipId).expect(201);

      expect(
        await dataSource.query(`SELECT role_slug FROM identity.user_roles WHERE user_id = $1 ORDER BY role_slug`, [
          practitioner.user.id,
        ]),
      ).toEqual(rolesBefore);
      expect(await dataSource.query(`SELECT roles FROM identity.users WHERE id = $1`, [practitioner.user.id])).toEqual(
        columnBefore,
      );
    });

    it('a membership that leaves `active` loses its authority without the grant changing', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      await grants.grant(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat');

      const ask = () =>
        authorizer.hasLiveScopedAuthority(dataSource.manager, {
          userId: practitioner.user.id,
          role: 'practitioner_chat',
          businessId: salon.business.id,
          professionalId: practitioner.professional.id,
        });

      expect(await ask()).toBe(true);

      await staff.deactivate(practitioner.membershipId);
      expect(await ask()).toBe(false);
      // The grant itself is untouched — the authority is the CONJUNCTION, and a
      // membership status is not a fact a foreign key can express.
      const [row] = await liveGrantRows(practitioner.membershipId);
      expect(row.revoked_at).toBeNull();
    });

    it('a soft-deleted business withdraws authority immediately', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      await grants.grant(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat');

      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [salon.business.id]);
      expect(
        await authorizer.hasLiveScopedAuthority(dataSource.manager, {
          userId: practitioner.user.id,
          role: 'practitioner_chat',
          businessId: salon.business.id,
          professionalId: practitioner.professional.id,
        }),
      ).toBe(false);
    });
  });

  // =========================================================================
  // 6. Invitation by phone: one answer for every well-formed case
  // =========================================================================

  describe('invitation by phone', () => {
    const invite = (businessId: string, token: string, body: object) =>
      api().post(`/api/v1/businesses/${businessId}/staff`).set(auth(token)).send(body);

    it('answers 202 {} byte-identically for known, unknown, self, duplicate, foreign and ineligible', async () => {
      const salon = await seedSalon();

      const known = await seedUser(app, dataSource, uniquePhone());
      const duplicate = await seedUser(app, dataSource, uniquePhone());
      await seedMembership(dataSource, salon.business.id, duplicate.id, 'staff', salon.owner.id);
      const elsewhere = await seedSalon();
      const foreign = await seedUser(app, dataSource, uniquePhone());
      const foreignMembership = await seedMembership(
        dataSource,
        elsewhere.business.id,
        foreign.id,
        'staff',
        elsewhere.owner.id,
      );
      await staff.accept(foreignMembership, foreign.id);
      const erased = await seedUser(app, dataSource, uniquePhone());
      await dataSource.query(`UPDATE identity.users SET deleted_at = now() WHERE id = $1`, [erased.id]);

      const cases: Array<[string, string]> = [
        ['known eligible', known.phone],
        ['unknown phone', uniquePhone()],
        ['self-invite', salon.owner.phone],
        ['duplicate membership', duplicate.phone],
        ['affiliated elsewhere', foreign.phone],
        ['deleted account', erased.phone],
      ];

      const observed: Array<[string, number, string]> = [];
      for (const [label, phone] of cases) {
        const res = await invite(salon.business.id, salon.owner.accessToken, { phone, role: 'staff' });
        observed.push([label, res.status, JSON.stringify(res.body)]);
      }

      // Every status and every byte of every body, identical.
      const statuses = new Set(observed.map(([, status]) => status));
      const payloads = new Set(observed.map(([, , body]) => body));
      expect([...statuses]).toEqual([202]);
      expect([...payloads]).toHaveLength(1);
      expect(JSON.parse([...payloads][0]).data).toEqual({});
    });

    it('writes NOTHING on every negative path — no row, no outbox, no audit', async () => {
      const salon = await seedSalon();
      const elsewhere = await seedSalon();
      const foreign = await seedUser(app, dataSource, uniquePhone());
      const foreignMembership = await seedMembership(
        dataSource,
        elsewhere.business.id,
        foreign.id,
        'staff',
        elsewhere.owner.id,
      );
      await staff.accept(foreignMembership, foreign.id);
      const erased = await seedUser(app, dataSource, uniquePhone());
      await dataSource.query(`UPDATE identity.users SET deleted_at = now() WHERE id = $1`, [erased.id]);

      const memberships = () =>
        countOf(`SELECT count(*)::int AS c FROM business.business_staff WHERE business_id = $1`, [salon.business.id]);
      const outbox = () => countOf(`SELECT count(*)::int AS c FROM business.outbox_events`);

      const before = { memberships: await memberships(), outbox: await outbox(), audit: await auditCount() };

      for (const phone of [uniquePhone(), salon.owner.phone, foreign.phone, erased.phone, uniquePhone()]) {
        await invite(salon.business.id, salon.owner.accessToken, { phone, role: 'staff' }).expect(202);
      }

      expect({ memberships: await memberships(), outbox: await outbox(), audit: await auditCount() }).toEqual(before);
    });

    it('an account ACTIVE elsewhere is refused; a spent membership elsewhere is not', async () => {
      /*
       * ADR-049 section 4.6 lists "foreign" among the refused resolutions, and
       * the story's acceptance criterion says nothing is persisted for it. What
       * neither pins is what "affiliated" means, so this case pins the reading:
       * ACTIVE elsewhere blocks; `inactive`, `declined` and `removed` do not.
       *
       * The alternative — any membership row anywhere ever — would make a person
       * who once declined an invitation permanently unhireable, which no source
       * asks for.
       */
      const salon = await seedSalon();
      const elsewhere = await seedSalon();

      const active = await seedUser(app, dataSource, uniquePhone());
      const activeMembership = await seedMembership(
        dataSource,
        elsewhere.business.id,
        active.id,
        'staff',
        elsewhere.owner.id,
      );
      await staff.accept(activeMembership, active.id);

      const spent = await seedUser(app, dataSource, uniquePhone());
      const spentMembership = await seedMembership(
        dataSource,
        elsewhere.business.id,
        spent.id,
        'staff',
        elsewhere.owner.id,
      );
      await staff.accept(spentMembership, spent.id);
      await staff.deactivate(spentMembership);

      for (const person of [active, spent]) {
        await invite(salon.business.id, salon.owner.accessToken, { phone: person.phone, role: 'staff' }).expect(202);
      }

      const rows = await dataSource.query(
        `SELECT user_id FROM business.business_staff WHERE business_id = $1`,
        [salon.business.id],
      );
      expect(rows.map((r: { user_id: string }) => r.user_id)).toEqual([spent.id]);
    });

    it('a duplicate in ANY membership state writes nothing and changes nothing', async () => {
      const salon = await seedSalon();
      const invitee = await seedUser(app, dataSource, uniquePhone());

      for (const status of ['invited', 'active', 'inactive', 'declined', 'removed']) {
        await dataSource.query(`DELETE FROM business.business_staff WHERE business_id = $1`, [salon.business.id]);
        const membershipId = await seedMembership(dataSource, salon.business.id, invitee.id, 'staff', salon.owner.id);
        await dataSource.query(`UPDATE business.business_staff SET status = $1 WHERE id = $2`, [status, membershipId]);

        const before = await dataSource.query(`SELECT * FROM business.business_staff WHERE id = $1`, [membershipId]);
        const auditBefore = await auditCount();

        await invite(salon.business.id, salon.owner.accessToken, { phone: invitee.phone, role: 'manager' }).expect(202);

        // Byte-identical row: the invitation did not quietly re-role, revive or
        // re-time an existing membership.
        expect(await dataSource.query(`SELECT * FROM business.business_staff WHERE id = $1`, [membershipId])).toEqual(
          before,
        );
        expect(await auditCount()).toBe(auditBefore);
      }
    });

    it('the known-eligible path creates a consented membership, visible only to the invitee', async () => {
      const salon = await seedSalon();
      const inviteeUser = await seedUser(app, dataSource, uniquePhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, inviteeUser.id, 'دعوت‌شده');

      const auditBefore = await auditCount();
      await invite(salon.business.id, salon.owner.accessToken, { phone: inviteeUser.phone, role: 'staff' }).expect(202);

      const [membership] = await dataSource.query(
        `SELECT id, user_id, professional_id, role, status, invited_by FROM business.business_staff WHERE business_id = $1`,
        [salon.business.id],
      );
      expect(membership).toMatchObject({
        user_id: inviteeUser.id,
        // Resolved SERVER-SIDE from the invited account's own profile. The
        // inviter neither supplied nor learned it.
        professional_id: professional.id,
        role: 'staff',
        status: 'invited',
        invited_by: salon.owner.id,
      });
      expect(await auditCount()).toBe(auditBefore + 1);

      // Exactly one outbox event, and it carries no phone.
      const events = await dataSource.query(
        `SELECT event_type, payload FROM business.outbox_events WHERE aggregate_id = $1`,
        [membership.id],
      );
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('StaffInvited');
      expect(JSON.stringify(events[0].payload)).not.toContain(inviteeUser.phone.replace('+', ''));

      // The membership id is disclosed to the invitee and to nobody else.
      const mine = await api().get('/api/v1/me/business-staff').set(auth(inviteeUser.accessToken)).expect(200);
      expect(mine.body.data.map((m: { id: string }) => m.id)).toEqual([membership.id]);

      const ownersView = await api().get('/api/v1/me/business-staff').set(auth(salon.owner.accessToken)).expect(200);
      expect(ownersView.body.data).toEqual([]);
    });

    it('only the invitee may accept or decline', async () => {
      const salon = await seedSalon();
      const invitee = await seedUser(app, dataSource, uniquePhone());
      const bystander = await seedUser(app, dataSource, uniquePhone());
      await invite(salon.business.id, salon.owner.accessToken, { phone: invitee.phone, role: 'staff' }).expect(202);
      const [{ id: membershipId }] = await dataSource.query(
        `SELECT id FROM business.business_staff WHERE business_id = $1`,
        [salon.business.id],
      );

      for (const impostor of [salon.owner, bystander]) {
        await api()
          .post(`/api/v1/me/business-staff/${membershipId}/accept`)
          .set(auth(impostor.accessToken))
          .expect(404);
      }
      await api()
        .post(`/api/v1/me/business-staff/${membershipId}/accept`)
        .set(auth(invitee.accessToken))
        .expect(201);
    });

    it('refuses a malformed body — the UUID contract is gone, not shadowed', async () => {
      const salon = await seedSalon();
      const target = await seedUser(app, dataSource, uniquePhone());

      // The old contract, rejected rather than quietly ignored.
      await invite(salon.business.id, salon.owner.accessToken, { userId: target.id, role: 'staff' }).expect(400);
      // And rejected even alongside an OTHERWISE VALID body — the case that
      // actually catches a re-introduced `userId` selector, because a body
      // missing `phone` would 400 on `phone` regardless of what else it carries.
      await invite(salon.business.id, salon.owner.accessToken, {
        phone: target.phone,
        role: 'staff',
        userId: target.id,
      }).expect(400);
      // A caller-supplied professional link, likewise.
      await invite(salon.business.id, salon.owner.accessToken, {
        phone: target.phone,
        professionalId: uuidv7(),
        role: 'staff',
      }).expect(400);
      // An unknown field is refused, not ignored — the whitelist pipe is on.
      await invite(salon.business.id, salon.owner.accessToken, {
        phone: target.phone,
        role: 'staff',
        workspaceRef: 'anything',
      }).expect(400);
      // A scoped role in the MEMBERSHIP field.
      await invite(salon.business.id, salon.owner.accessToken, {
        phone: target.phone,
        role: 'practitioner_chat',
      }).expect(400);
      // An absent phone.
      await invite(salon.business.id, salon.owner.accessToken, { role: 'staff' }).expect(400);

      expect(await countOf(`SELECT count(*)::int AS c FROM business.business_staff WHERE business_id = $1`, [
        salon.business.id,
      ])).toBe(0);
    });

    it('no route accepts a caller-supplied identity for a scoped grant either', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      for (const body of [
        { role: 'practitioner_chat', userId: uuidv7() },
        { role: 'practitioner_chat', professionalId: uuidv7() },
        { role: 'owner' },
        {},
      ]) {
        await api()
          .post(`/api/v1/businesses/${salon.business.id}/staff/${practitioner.membershipId}/grants`)
          .set(auth(salon.owner.accessToken))
          .send(body)
          .expect(400);
      }
    });
  });

  // =========================================================================
  // 7. The response-time floor, measured
  // =========================================================================

  describe('the invitation response-time floor, measured', () => {
    /** Robust to a single slow sample in a way a mean is not. */
    const median = (samples: number[]): number => {
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };

    /**
     * The statistic under test, isolated so it can be run against a PLANTED
     * dataset as well as against the real one.
     *
     * A method that is only ever run on passing data proves nothing about its
     * own sensitivity, so the case below runs it twice: once on the measured
     * samples, and once on the same samples with an outcome-specific delay added
     * to one path.
     */
    const spreadOf = (byOutcome: Record<string, number[]>): number => {
      const medians = Object.values(byOutcome).map(median);
      return Math.max(...medians) - Math.min(...medians);
    };

    it('every semantic outcome takes comparable time, and the method would catch one that did not', async () => {
      const salon = await seedSalon();
      const known = await seedUser(app, dataSource, uniquePhone());
      const duplicate = await seedUser(app, dataSource, uniquePhone());
      await seedMembership(dataSource, salon.business.id, duplicate.id, 'staff', salon.owner.id);

      const paths: Record<string, () => string> = {
        unknown: () => uniquePhone(),
        self: () => salon.owner.phone,
        duplicate: () => duplicate.phone,
        // The known-eligible path is measured LAST per round and only once
        // creates a row; after that it is a duplicate, which is the same
        // codepath cost the story claims comparability for.
        known: () => known.phone,
      };

      const samples: Record<string, number[]> = { unknown: [], self: [], duplicate: [], known: [] };
      const ROUNDS = 9;
      for (let round = 0; round < ROUNDS; round++) {
        for (const [label, phoneOf] of Object.entries(paths)) {
          const started = process.hrtime.bigint();
          await api()
            .post(`/api/v1/businesses/${salon.business.id}/staff`)
            .set(auth(salon.owner.accessToken))
            .send({ phone: phoneOf(), role: 'staff' })
            .expect(202);
          samples[label].push(Number(process.hrtime.bigint() - started) / 1e6);
        }
      }

      // 1. Every path actually waits out the floor. A path that returned early
      //    would sit well under it.
      for (const [label, values] of Object.entries(samples)) {
        expect([label, median(values) >= STAFF_INVITE_MIN_RESPONSE_MS * 0.9]).toEqual([label, true]);
      }

      // 2. The paths are comparable. The bound is deliberately generous —
      //    `V33-DEC-033` R3 requires *measured comparable timing under a
      //    documented method*, and explicitly NOT a constant-time claim — but it
      //    is far tighter than the difference an unmitigated database lookup
      //    would produce.
      const TOLERANCE_MS = STAFF_INVITE_MIN_RESPONSE_MS / 2;
      const observedSpread = spreadOf(samples);
      // Reported as data rather than as a bare boolean, so a failure says how
      // far apart the paths actually were instead of only that they were.
      expect({ spread: observedSpread < TOLERANCE_MS, ms: Math.round(observedSpread) }).toEqual({
        spread: true,
        ms: Math.round(observedSpread),
      });

      // 3. The method is NOT vacuous: the same statistic, run over the same
      //    samples with an outcome-specific delay planted on one path, exceeds
      //    the bound. Without this, a spread test that had quietly stopped
      //    discriminating would still pass.
      const planted = { ...samples, known: samples.known.map((ms) => ms + TOLERANCE_MS + 20) };
      expect(spreadOf(planted) < TOLERANCE_MS).toBe(false);
    }, 120_000);
  });

  // =========================================================================
  // 8. Practitioner-specific chat authority
  // =========================================================================

  describe('practitioner_chat reaches the grantee’s OWN conversation and no other', () => {
    /**
     * One salon, two practitioners, two customers, one conversation each.
     *
     * This is the shape `V33-DEC-033` R2 exists for: the interesting failure is
     * not "a stranger got in", it is "a colleague in the same salon got in".
     */
    async function twoPractitionerSalon() {
      const salon = await seedSalon();
      const alice = await seedPractitioner(salon);
      const bob = await seedPractitioner(salon);

      const aliceCustomer = await seedUser(app, dataSource, uniquePhone());
      const bobCustomer = await seedUser(app, dataSource, uniquePhone());

      await seedQualifyingBooking({
        customerId: aliceCustomer.id,
        professionalId: alice.professional.id,
        serviceId: alice.professional.serviceId,
        sellerBusinessId: salon.business.id,
      });
      await seedQualifyingBooking({
        customerId: bobCustomer.id,
        professionalId: bob.professional.id,
        serviceId: bob.professional.serviceId,
        sellerBusinessId: salon.business.id,
      });

      const aliceConversation = await startConversation(aliceCustomer.accessToken, salon.business.id);
      const bobConversation = await startConversation(bobCustomer.accessToken, salon.business.id);
      return { salon, alice, bob, aliceCustomer, bobCustomer, aliceConversation, bobConversation };
    }

    it('a granted practitioner reads and sends in their own conversation', async () => {
      const s = await twoPractitionerSalon();
      await grantVia(s.salon.business.id, s.salon.owner.accessToken, s.alice.membershipId).expect(201);

      await api()
        .get(`/api/v1/chat/conversations/${s.aliceConversation}`)
        .set(auth(s.alice.user.accessToken))
        .expect(200);

      await api()
        .post(`/api/v1/chat/conversations/${s.aliceConversation}/messages`)
        .set(auth(s.alice.user.accessToken))
        .send({ body: 'سلام، وقت شما تأیید شد.' })
        .expect(201);
    });

    it('never reaches a COLLEAGUE’s conversation in the same salon', async () => {
      const s = await twoPractitionerSalon();
      await grantVia(s.salon.business.id, s.salon.owner.accessToken, s.alice.membershipId).expect(201);

      // Alice holds a live grant on this very business — and still cannot open
      // Bob's conversation, because the qualifying booking's professional is not
      // hers. This is the case a business-wide grant would have passed.
      await api()
        .get(`/api/v1/chat/conversations/${s.bobConversation}`)
        .set(auth(s.alice.user.accessToken))
        .expect(404);

      await api()
        .post(`/api/v1/chat/conversations/${s.bobConversation}/messages`)
        .set(auth(s.alice.user.accessToken))
        .send({ body: 'نباید برسد' })
        .expect(404);
    });

    it('every denial shape is byte-identical, against a positive control', async () => {
      const s = await twoPractitionerSalon();
      const foreignSalon = await seedSalon();
      const unrelatedStaffUser = await seedUser(app, dataSource, uniquePhone());
      const unrelatedMembership = await seedMembership(
        dataSource,
        s.salon.business.id,
        unrelatedStaffUser.id,
        'staff',
        s.salon.owner.id,
      );
      await staff.accept(unrelatedMembership, unrelatedStaffUser.id);

      // A practitioner whose grant was revoked.
      await grantVia(s.salon.business.id, s.salon.owner.accessToken, s.bob.membershipId).expect(201);
      await revokeVia(s.salon.business.id, s.salon.owner.accessToken, s.bob.membershipId).expect(201);

      // A practitioner whose membership went inactive while the grant stayed live.
      const inactive = await seedPractitioner(s.salon);
      await grantVia(s.salon.business.id, s.salon.owner.accessToken, inactive.membershipId).expect(201);
      await staff.deactivate(inactive.membershipId);

      const denials: Array<[string, string]> = [
        ['ungranted practitioner', s.alice.user.accessToken],
        ['revoked grant', s.bob.user.accessToken],
        ['inactive membership with a live grant', inactive.user.accessToken],
        ['unrelated same-business staff', unrelatedStaffUser.accessToken],
        ['a foreign business owner', foreignSalon.owner.accessToken],
        ['the other customer', s.bobCustomer.accessToken],
      ];

      const bodies = new Set<string>();
      for (const [label, token] of denials) {
        const res = await api().get(`/api/v1/chat/conversations/${s.aliceConversation}`).set(auth(token));
        expect([label, res.status]).toEqual([label, 404]);
        bodies.add(JSON.stringify(res.body));
      }
      expect([...bodies]).toHaveLength(1);

      // The positive control: the same route, the same conversation, 200.
      await grantVia(s.salon.business.id, s.salon.owner.accessToken, s.alice.membershipId).expect(201);
      await api()
        .get(`/api/v1/chat/conversations/${s.aliceConversation}`)
        .set(auth(s.alice.user.accessToken))
        .expect(200);
    });

    it('a practitioner who changed salon cannot reach the conversation they used to serve', async () => {
      const oldSalon = await seedSalon();
      const newSalon = await seedSalon();
      const practitionerUser = await seedUser(app, dataSource, uniquePhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, practitionerUser.id, 'مهاجر');

      const oldMembership = await seedMembership(
        dataSource,
        oldSalon.business.id,
        practitionerUser.id,
        'staff',
        oldSalon.owner.id,
        professional.id,
      );
      await staff.accept(oldMembership, practitionerUser.id);

      const customer = await seedUser(app, dataSource, uniquePhone());
      await seedQualifyingBooking({
        customerId: customer.id,
        professionalId: professional.id,
        serviceId: professional.serviceId,
        sellerBusinessId: oldSalon.business.id,
      });
      const conversation = await startConversation(customer.accessToken, oldSalon.business.id);

      // They move. `uq_business_staff_active_professional` admits one active
      // affiliation at a time, so the old one ends first — which is exactly what
      // production does.
      await staff.deactivate(oldMembership);
      const newMembership = await seedMembership(
        dataSource,
        newSalon.business.id,
        practitionerUser.id,
        'staff',
        newSalon.owner.id,
        professional.id,
      );
      await staff.accept(newMembership, practitionerUser.id);
      await grantVia(newSalon.business.id, newSalon.owner.accessToken, newMembership).expect(201);

      // A live grant, the same professional, the same person — and the order's
      // SNAPSHOTTED seller is the old salon, so the conversation stays closed.
      await api()
        .get(`/api/v1/chat/conversations/${conversation}`)
        .set(auth(practitionerUser.accessToken))
        .expect(404);
    });

    it('listing and unread counts carry the grantee’s own conversation only', async () => {
      const s = await twoPractitionerSalon();
      await api()
        .post(`/api/v1/chat/conversations/${s.aliceConversation}/messages`)
        .set(auth(s.aliceCustomer.accessToken))
        .send({ body: 'سلام' })
        .expect(201);
      await api()
        .post(`/api/v1/chat/conversations/${s.bobConversation}/messages`)
        .set(auth(s.bobCustomer.accessToken))
        .send({ body: 'سلام' })
        .expect(201);

      const listBefore = await api().get('/api/v1/chat/conversations').set(auth(s.alice.user.accessToken)).expect(200);
      expect(listBefore.body.data.items).toEqual([]);

      await grantVia(s.salon.business.id, s.salon.owner.accessToken, s.alice.membershipId).expect(201);

      const listAfter = await api().get('/api/v1/chat/conversations').set(auth(s.alice.user.accessToken)).expect(200);
      expect(listAfter.body.data.items.map((c: { id: string }) => c.id)).toEqual([s.aliceConversation]);

      const unread = await api().get('/api/v1/chat/unread-count').set(auth(s.alice.user.accessToken)).expect(200);
      expect(unread.body.data.conversations).toBe(1);
    });

    it('existing customer and independent-professional behaviour is unchanged', async () => {
      // The regression guard. #109 changed three seller-access call sites; the
      // two paths that were already correct must answer exactly as before.
      const proUser = await seedUser(app, dataSource, uniquePhone(), ['customer', 'professional']);
      const independent = await seedProfessional(dataSource, proUser.id, 'مستقل');
      const customer = await seedUser(app, dataSource, uniquePhone());

      const bookingId = uuidv7();
      slotOffsetHours += 1;
      const start = new Date(Date.now() - 7 * 86_400_000 - slotOffsetHours * 3_600_000);
      const slotId = await seedSlot(dataSource, independent.id, independent.serviceId, start);
      await dataSource.query(
        `INSERT INTO booking.bookings (id, customer_id, professional_id, service_id, slot_id, slot_start, slot_end, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`,
        [bookingId, customer.id, independent.id, independent.serviceId, slotId, start, new Date(start.getTime() + 3_600_000)],
      );
      await dataSource.query(
        `INSERT INTO commerce.orders (id, source_type, source_id, customer_id, seller_party_type, seller_party_id,
           status, currency, subtotal_toman, total_toman, paid_at)
         VALUES ($1, 'booking', $2, $3, 'professional', $4, 'paid', 'IRT', 100000, 100000, now())`,
        [uuidv7(), bookingId, customer.id, independent.id],
      );

      const res = await api()
        .post('/api/v1/chat/conversations')
        .set(auth(customer.accessToken))
        .send({ counterpartyType: 'professional', counterpartyId: independent.id })
        .expect(201);

      // The independent professional still reaches their own inbox, and the
      // customer still reaches their own conversation.
      await api().get(`/api/v1/chat/conversations/${res.body.data.id}`).set(auth(proUser.accessToken)).expect(200);
      await api().get(`/api/v1/chat/conversations/${res.body.data.id}`).set(auth(customer.accessToken)).expect(200);
    });

    it('a salon MANAGER still reaches the salon’s conversations, with no grant at all', async () => {
      // The pre-existing rule, unweakened. #109 added the practitioner branch
      // BELOW the manager branch; a refactor that lost the manager check would
      // pass every practitioner case above and fail here.
      const s = await twoPractitionerSalon();
      const managerUser = await seedUser(app, dataSource, uniquePhone(), ['customer', 'business']);
      const managerMembership = await seedMembership(
        dataSource,
        s.salon.business.id,
        managerUser.id,
        'manager',
        s.salon.owner.id,
      );
      await staff.accept(managerMembership, managerUser.id);

      await api()
        .get(`/api/v1/chat/conversations/${s.aliceConversation}`)
        .set(auth(managerUser.accessToken))
        .expect(200);
      await api()
        .get(`/api/v1/chat/conversations/${s.bobConversation}`)
        .set(auth(managerUser.accessToken))
        .expect(200);
      expect(await countOf(`SELECT count(*)::int AS c FROM business.staff_role_grants`)).toBe(0);
    });
  });

  // =========================================================================
  // 9. Privacy: erasure, export, ADR-027
  // =========================================================================

  describe('privacy', () => {
    it('erasure revokes every live grant and marks the membership removed, in ONE transaction', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      await grants.grant(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat');

      const contract = app.get(BusinessSubjectDataContract);
      const outcome = await dataSource.transaction((manager) =>
        contract.eraseSubjectData(manager, practitioner.user.id),
      );

      const [membership] = await dataSource.query(`SELECT status FROM business.business_staff WHERE id = $1`, [
        practitioner.membershipId,
      ]);
      expect(membership.status).toBe('removed');

      const [grant] = await liveGrantRows(practitioner.membershipId);
      expect(grant.revoked_at).not.toBeNull();
      // No human actor is fabricated for something nobody did.
      expect(grant.revoked_by_user_id).toBeNull();

      // Truthful counts: one membership anonymised plus one grant revoked.
      expect(outcome.anonymized).toBe(2);
    });

    it('erasure is atomic — a failure leaves the grant live AND the membership active', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      await grants.grant(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat');
      const contract = app.get(BusinessSubjectDataContract);

      await expect(
        dataSource.transaction(async (manager) => {
          await contract.eraseSubjectData(manager, practitioner.user.id);
          throw new Error('privacy transaction failed downstream (deliberate)');
        }),
      ).rejects.toThrow('deliberate');

      // Neither half survived. There is no state where the authority is gone but
      // the membership still says `active`, or the reverse.
      const [membership] = await dataSource.query(`SELECT status FROM business.business_staff WHERE id = $1`, [
        practitioner.membershipId,
      ]);
      expect(membership.status).toBe('active');
      const [grant] = await liveGrantRows(practitioner.membershipId);
      expect(grant.revoked_at).toBeNull();
    });

    it('export returns the subject’s own grants and never the granting actor', async () => {
      const salon = await seedSalon();
      const practitioner = await seedPractitioner(salon);
      await grants.grant(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat');
      await grants.revoke(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat');
      await grants.grant(salon.business.id, salon.owner.id, practitioner.membershipId, 'practitioner_chat');

      const contract = app.get(BusinessSubjectDataContract);
      const sections = await contract.exportSubjectData(dataSource.manager, practitioner.user.id);
      const section = sections.find((s) => s.key === 'staff_role_grants');
      expect(section).toBeDefined();

      // "You held this and it ended" is as much the subject's own history as
      // "you hold this", so a revoked grant is included.
      expect(section!.rows).toHaveLength(2);
      const serialised = JSON.stringify(section!.rows);
      expect(serialised).not.toContain(salon.owner.id);
      for (const row of section!.rows as Array<Record<string, unknown>>) {
        expect(Object.keys(row).sort()).toEqual(['businessId', 'grantedAt', 'revokedAt', 'role']);
      }

      // The OWNER's own export does not carry the grants they issued either —
      // those are the grantee's data, not theirs.
      const ownerSections = await contract.exportSubjectData(dataSource.manager, salon.owner.id);
      const ownerGrants = ownerSections.find((s) => s.key === 'staff_role_grants');
      expect(ownerGrants!.rows).toEqual([]);
    });

    it('the new table is claimed under ADR-027 and the exact-set boot assertion holds', async () => {
      const catalogue = await coverage.readCatalogue();
      expect(catalogue.map((table) => `${table.schema}.${table.name}`)).toContain('business.staff_role_grants');

      // The REAL catalogue against the REAL contract list. This is the same
      // assertion that refuses to boot the application, run here so a #109
      // regression fails a test rather than a deployment.
      const report = evaluateCoverage(catalogue, contracts);
      expect(report.violations).toEqual([]);

      const contract = app.get(BusinessSubjectDataContract);
      const claims = contract.tables.filter((claim) => claim.table === 'business.staff_role_grants');
      expect(claims).toEqual([{ table: 'business.staff_role_grants', disposition: 'subject_data' }]);
    });

    describe('the ADR-027 assertion is non-vacuous — each planted defect is caught', () => {
      it.each([
        [
          'unclaimed',
          'unclaimed',
          (catalogue: CatalogueTable[], list: SubjectDataContract[]) => ({
            catalogue: [
              ...catalogue,
              { schema: 'business', name: 'zz_never_a_real_grant_table', columns: ['id', 'membership_id'] },
            ],
            contracts: list,
          }),
        ],
        [
          'a stale claim on a table that no longer exists',
          'claimed_but_absent',
          (catalogue: CatalogueTable[], list: SubjectDataContract[]) => ({
            catalogue: catalogue.filter((t) => `${t.schema}.${t.name}` !== 'business.staff_role_grants'),
            contracts: list,
          }),
        ],
        [
          'two modules claiming the grant table',
          'claimed_twice',
          (catalogue: CatalogueTable[], list: SubjectDataContract[]) => ({
            catalogue,
            contracts: [
              ...list,
              {
                moduleKey: 'zz_impostor',
                tables: [{ table: 'business.staff_role_grants', disposition: 'subject_data' as const }],
                exportSubjectData: async () => [],
                eraseSubjectData: async () => ({ moduleKey: 'zz_impostor', anonymized: 0, deleted: 0, retained: [] }),
              } as unknown as SubjectDataContract,
            ],
          }),
        ],
        [
          'a wrong `no_subject_data` claim on the grant table',
          'wrongly_declared_empty',
          (catalogue: CatalogueTable[], list: SubjectDataContract[]) => ({
            catalogue,
            // `coverage.ts` recognises the `*_user_id` suffix, so both actor
            // columns make this table undeniably subject-bearing: an exemption
            // claim has to fail rather than be taken at its word.
            contracts: list.map((contract) => ({
              ...contract,
              tables: contract.tables.map((t) =>
                t.table === 'business.staff_role_grants'
                  ? { ...t, disposition: 'no_subject_data' as const, reason: 'it is only organisational, honestly' }
                  : t,
              ),
            })) as unknown as SubjectDataContract[],
          }),
        ],
      ])('catches %s', async (_label, kind, mutate) => {
        const catalogue = await coverage.readCatalogue();
        const mutated = (mutate as (c: CatalogueTable[], k: SubjectDataContract[]) => {
          catalogue: CatalogueTable[];
          contracts: SubjectDataContract[];
        })([...catalogue], [...contracts]);

        const report = evaluateCoverage(mutated.catalogue, mutated.contracts);
        expect(report.violations.map((violation) => violation.kind)).toContain(kind);
      });
    });
  });
});
