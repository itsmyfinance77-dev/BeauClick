import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { AdminAuditService } from '@beauclick/audit';
import { AvailabilityService, BookingService } from '@beauclick/booking';
import { BusinessSubjectDataContract } from '@beauclick/business';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, SubjectDataCoverageService, CatalogueTable, evaluateCoverage } from '@beauclick/subject-data';
import { WORKSPACE_REFERENCE_SECRET, deriveLocationReference } from '@beauclick/workspace-reference';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedCity,
  seedMembership,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

/**
 * REAL PostgreSQL: V3.3 Story #127 (`#127a`) -- the delivery-location context.
 *
 * ## Why every case here needs a real server
 *
 * ADR-049 §2.4. The in-memory layer honours neither composite foreign keys, nor
 * row triggers, nor `xmin`, nor `FOR UPDATE`, nor `ROLLBACK` -- which is to say it
 * can prove nothing about same-business integrity, the snapshot freeze, the
 * byte-identity of existing rows, the linearisation of a rebinding against a slot
 * creation, or the atomicity of a binding with its audit row. Those are exactly
 * the guarantees this story ships.
 *
 * The closed DTO, the handler metadata, the non-exposure scans and the migration
 * guards live in the fast layer
 * (`services/business/src/staff-location.contract.spec.ts` and
 * `services/booking/src/availability/delivery-location-boundary.spec.ts`).
 *
 * ## What this story is NOT
 *
 * No resource, no requirement mapping, no assignment table and no selection
 * appear anywhere in this file. Those are `#127b` (#131) and `#128`.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

describeIfPg('Delivery-location context on real PostgreSQL (#127a)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let availability: AvailabilityService;
  let referenceSecret: string;

  const uniquePhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    availability = app.get(AvailabilityService);
    referenceSecret = app.get<string>(WORKSPACE_REFERENCE_SECRET);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const api = () => request(app.getHttpServer());
  const auth = (user: SeededUser) => ({ Authorization: `Bearer ${user.accessToken}` });
  const bindingPath = (businessId: string, membershipId: string) =>
    `/api/v1/businesses/${businessId}/staff/${membershipId}/location`;

  /** A live business with one active location, and its owner. */
  async function seedOwnerWithLocation(prefix: string, lifecycle: 'active' | 'suspended' | 'closed' = 'active') {
    const owner = await seedUser(app, dataSource, uniquePhone(prefix), ['business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن');
    const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
    const locationId = uuidv7();
    await dataSource.query(
      `INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه', $3, $4)`,
      [locationId, business.id, cityId, lifecycle],
    );
    return {
      owner,
      businessId: business.id,
      locationId,
      locationRef: deriveLocationReference(referenceSecret, owner.id, business.id, locationId),
    };
  }

  /** An ACTIVE membership for a professional, optionally already bound to a branch. */
  async function seedActiveProfessionalMembership(
    businessId: string,
    ownerId: string,
    prefix: string,
    locationId: string | null = null,
  ) {
    const proUser = await seedUser(app, dataSource, uniquePhone(prefix), ['professional']);
    const professional = await seedProfessional(dataSource, proUser.id, 'آرایشگر');
    const membershipId = await seedMembership(dataSource, businessId, proUser.id, 'staff', ownerId, professional.id);
    await dataSource.query(`UPDATE business.business_staff SET status='active', responded_at=now() WHERE id = $1`, [membershipId]);
    if (locationId) {
      await dataSource.query(`UPDATE business.business_staff SET location_id = $1 WHERE id = $2`, [locationId, membershipId]);
    }
    return { proUser, professional, membershipId };
  }

  const futureSlot = (offsetHours: number) => {
    const start = new Date(Date.now() + offsetHours * 3_600_000);
    return { startAt: start, endAt: new Date(start.getTime() + 3_600_000) };
  };

  async function snapshotOf(slotId: string): Promise<string | null> {
    const [row] = await dataSource.query(`SELECT delivery_location_id FROM booking.availability_slots WHERE id = $1`, [slotId]);
    return row.delivery_location_id;
  }

  // =========================================================================
  // §1 Schema
  // =========================================================================

  describe('§1 the migrations produced exactly the ratified shape', () => {
    it('business_staff gains a nullable location_id with the composite same-business FK', async () => {
      const [col] = await dataSource.query(
        `SELECT is_nullable, data_type, column_default FROM information_schema.columns
          WHERE table_schema='business' AND table_name='business_staff' AND column_name='location_id'`,
      );
      expect(col.is_nullable).toBe('YES');
      expect(col.data_type).toBe('uuid');
      expect(col.column_default).toBeNull();

      const defs: string[] = (
        await dataSource.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid='business.business_staff'::regclass AND conname='fk_business_staff_location_same_business'`,
        )
      ).map((r: { conname: string; def: string }) => `${r.conname}: ${r.def}`);
      expect(defs.join()).toMatch(
        /fk_business_staff_location_same_business: FOREIGN KEY \(location_id, business_id\) REFERENCES business\.locations\(id, business_id\)/,
      );
      expect(defs.join()).not.toMatch(/ON DELETE CASCADE/);
    });

    it('availability_slots gains a nullable delivery_location_id with NO cross-schema FK', async () => {
      const [col] = await dataSource.query(
        `SELECT is_nullable, data_type, column_default FROM information_schema.columns
          WHERE table_schema='booking' AND table_name='availability_slots' AND column_name='delivery_location_id'`,
      );
      expect(col.is_nullable).toBe('YES');
      expect(col.data_type).toBe('uuid');
      expect(col.column_default).toBeNull();

      const fks: string[] = (
        await dataSource.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid='booking.availability_slots'::regclass AND contype='f'`,
        )
      ).map((r: { def: string }) => r.def);
      // No foreign key on this table may reach the business schema.
      expect(fks.filter((d) => /business\./i.test(d))).toEqual([]);
    });

    it('declares the freeze trigger and the partial binding index', async () => {
      const triggers: string[] = (
        await dataSource.query(
          `SELECT tgname FROM pg_trigger WHERE tgrelid='booking.availability_slots'::regclass AND NOT tgisinternal`,
        )
      ).map((r: { tgname: string }) => r.tgname);
      expect(triggers).toContain('tg_availability_slots_delivery_location_frozen');

      const indexes: string[] = (
        await dataSource.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='business' AND tablename='business_staff'`)
      ).map((r: { indexdef: string }) => r.indexdef);
      expect(indexes.join('\n')).toMatch(/ix_business_staff_location_id[\s\S]*WHERE \(location_id IS NOT NULL\)/);
    });

    it('booking.bookings is untouched by this story', async () => {
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='booking' AND table_name='bookings'`,
        )
      ).map((r: { column_name: string }) => r.column_name);
      for (const forbidden of ['delivery_location_id', 'location_id', 'resource_id']) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('adds no resource or assignment object -- those are #131 and #128', async () => {
      const bookingTables: string[] = (
        await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname='booking' ORDER BY tablename`)
      ).map((r: { tablename: string }) => r.tablename);
      expect(bookingTables).toEqual(['availability_slots', 'booking_history', 'bookings', 'idempotency_keys', 'outbox_events']);

      const businessTables: string[] = (
        await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname='business' ORDER BY tablename`)
      ).map((r: { tablename: string }) => r.tablename);
      expect(businessTables).not.toContain('service_resource_requirements');
    });
  });

  // =========================================================================
  // §2 ADD COLUMN compatibility
  // =========================================================================

  describe('§2 adding the columns rewrites no existing row', () => {
    /**
     * The whole proof runs inside ONE transaction that is deliberately rolled
     * back, so the real schema is restored however the assertions land. DDL is
     * transactional in PostgreSQL, which is what makes that safe.
     */
    it('preserves xmin and every value on availability_slots across a genuine drop-and-re-add', async () => {
      const fixture = await seedOwnerWithLocation('+98801');
      const { professional } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98802');
      const slot = await availability.createSlot(professional.id, { ...futureSlot(30), serviceId: null });

      const snap = async (m: DataSource['manager']) =>
        (
          await m.query(
            // Deliberately does NOT select the column under test: it is dropped
            // for part of this transaction. What is asserted is that every OTHER
            // value, and `xmin` itself, survive the add.
            `SELECT xmin::text AS xmin, id::text, professional_id::text, start_at, end_at, status
               FROM booking.availability_slots WHERE id = $1`,
            [slot.id],
          )
        )[0];

      let before: Record<string, unknown> | undefined;
      let after: Record<string, unknown> | undefined;
      let rewritten: Record<string, unknown> | undefined;

      await expect(
        dataSource.transaction(async (m) => {
          await m.query(`ALTER TABLE booking.availability_slots DROP COLUMN delivery_location_id`);
          before = await snap(m);
          await m.query(`ALTER TABLE booking.availability_slots ADD COLUMN delivery_location_id UUID`);
          after = await snap(m);

          // The non-vacuity control: a REAL rewrite must move xmin, or the
          // comparison above proves nothing.
          await m.query(`UPDATE booking.availability_slots SET status = 'open', held_until = NULL WHERE id = $1`, [slot.id]);
          rewritten = await snap(m);

          throw new Error('deliberate rollback -- the schema must be restored exactly');
        }),
      ).rejects.toThrow('deliberate rollback');

      expect(after!.xmin).toBe(before!.xmin);
      expect(rewritten!.xmin).not.toBe(before!.xmin);
    });

    it('preserves xmin on business_staff across a genuine drop-and-re-add', async () => {
      const fixture = await seedOwnerWithLocation('+98803');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98804');

      const snap = async (m: DataSource['manager']) =>
        (await m.query(`SELECT xmin::text AS xmin, id::text, status, role FROM business.business_staff WHERE id = $1`, [membershipId]))[0];

      let before: Record<string, unknown> | undefined;
      let after: Record<string, unknown> | undefined;
      let rewritten: Record<string, unknown> | undefined;

      await expect(
        dataSource.transaction(async (m) => {
          await m.query(`ALTER TABLE business.business_staff DROP CONSTRAINT fk_business_staff_location_same_business`);
          await m.query(`ALTER TABLE business.business_staff DROP COLUMN location_id`);
          before = await snap(m);
          await m.query(`ALTER TABLE business.business_staff ADD COLUMN location_id UUID`);
          after = await snap(m);
          await m.query(`UPDATE business.business_staff SET updated_at = now() WHERE id = $1`, [membershipId]);
          rewritten = await snap(m);
          throw new Error('deliberate rollback');
        }),
      ).rejects.toThrow('deliberate rollback');

      expect(after!.xmin).toBe(before!.xmin);
      expect(rewritten!.xmin).not.toBe(before!.xmin);
    });

    it('the schema really was restored by both rollbacks', async () => {
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE (table_schema='booking' AND table_name='availability_slots' AND column_name='delivery_location_id')
             OR (table_schema='business' AND table_name='business_staff' AND column_name='location_id')`,
      );
      expect(n).toBe(2);
      const [{ f }] = await dataSource.query(
        `SELECT count(*)::int AS f FROM pg_constraint WHERE conname='fk_business_staff_location_same_business'`,
      );
      expect(f).toBe(1);
    });
  });

  // =========================================================================
  // §3 Database-enforced integrity
  // =========================================================================

  describe('§3 a cross-business binding is unwritable', () => {
    it('accepts a membership bound to a location of its OWN business', async () => {
      const fixture = await seedOwnerWithLocation('+98810');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98811');
      await expect(
        dataSource.query(`UPDATE business.business_staff SET location_id = $1 WHERE id = $2`, [fixture.locationId, membershipId]),
      ).resolves.toBeDefined();
    });

    it('REFUSES a membership bound to another business’s location', async () => {
      const a = await seedOwnerWithLocation('+98812');
      const b = await seedOwnerWithLocation('+98813');
      const { membershipId } = await seedActiveProfessionalMembership(a.businessId, a.owner.id, '+98814');
      await expect(
        dataSource.query(`UPDATE business.business_staff SET location_id = $1 WHERE id = $2`, [b.locationId, membershipId]),
      ).rejects.toThrow(/foreign key|fk_business_staff_location_same_business/i);
    });

    it('REFUSES a binding to a location that does not exist', async () => {
      const fixture = await seedOwnerWithLocation('+98815');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98816');
      await expect(
        dataSource.query(`UPDATE business.business_staff SET location_id = $1 WHERE id = $2`, [uuidv7(), membershipId]),
      ).rejects.toThrow(/foreign key|fk_business_staff_location_same_business/i);
    });
  });

  // =========================================================================
  // §4 The owner binding surface
  // =========================================================================

  describe('§4 the owner binds and clears a branch', () => {
    it('reads null, assigns, reads back the reference, and clears', async () => {
      const fixture = await seedOwnerWithLocation('+98820');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98821');
      const path = bindingPath(fixture.businessId, membershipId);

      const initial = await api().get(path).set(auth(fixture.owner)).expect(200);
      expect(initial.body.data).toEqual({ locationRef: null });

      const assigned = await api().put(path).set(auth(fixture.owner)).send({ locationRef: fixture.locationRef }).expect(200);
      expect(assigned.body.data).toEqual({ locationRef: fixture.locationRef });

      const readBack = await api().get(path).set(auth(fixture.owner)).expect(200);
      expect(readBack.body.data).toEqual({ locationRef: fixture.locationRef });

      const cleared = await api().put(path).set(auth(fixture.owner)).send({ locationRef: null }).expect(200);
      expect(cleared.body.data).toEqual({ locationRef: null });
      expect(await dataSource.query(`SELECT location_id FROM business.business_staff WHERE id = $1`, [membershipId])).toEqual([
        { location_id: null },
      ]);
    });

    it('exposes no raw uuid in either response', async () => {
      const fixture = await seedOwnerWithLocation('+98822');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98823');
      const path = bindingPath(fixture.businessId, membershipId);
      const res = await api().put(path).set(auth(fixture.owner)).send({ locationRef: fixture.locationRef }).expect(200);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(fixture.locationId);
      expect(serialized).not.toContain(fixture.businessId);
      expect(serialized).not.toContain(fixture.owner.id);
      expect(Object.keys(res.body.data)).toEqual(['locationRef']);
    });

    it.each([
      ['a malformed reference', 'not-a-reference'],
      ['a well-formed but unknown reference', 'A'.repeat(43)],
    ])('refuses %s', async (_label, ref) => {
      const fixture = await seedOwnerWithLocation('+98824');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98825');
      const res = await api().put(bindingPath(fixture.businessId, membershipId)).set(auth(fixture.owner)).send({ locationRef: ref });
      // A malformed reference is the ordinary syntactic 400 class; an unknown one
      // is the non-enumerating 404. Neither reveals whether a branch exists.
      expect([400, 404]).toContain(res.status);
    });

    it('refuses a FOREIGN business’s locationRef with the standard refusal', async () => {
      const a = await seedOwnerWithLocation('+98826');
      const b = await seedOwnerWithLocation('+98827');
      const { membershipId } = await seedActiveProfessionalMembership(a.businessId, a.owner.id, '+98828');
      await api().put(bindingPath(a.businessId, membershipId)).set(auth(a.owner)).send({ locationRef: b.locationRef }).expect(404);
      expect(await dataSource.query(`SELECT location_id FROM business.business_staff WHERE id = $1`, [membershipId])).toEqual([
        { location_id: null },
      ]);
    });

    it.each([['suspended'], ['closed']] as const)('refuses a %s location', async (lifecycle) => {
      const fixture = await seedOwnerWithLocation('+98829', lifecycle);
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98830');
      await api()
        .put(bindingPath(fixture.businessId, membershipId))
        .set(auth(fixture.owner))
        .send({ locationRef: fixture.locationRef })
        .expect(404);
    });

    it('refuses a membership of another business', async () => {
      const a = await seedOwnerWithLocation('+98831');
      const b = await seedOwnerWithLocation('+98832');
      const { membershipId } = await seedActiveProfessionalMembership(b.businessId, b.owner.id, '+98833');
      await api().get(bindingPath(a.businessId, membershipId)).set(auth(a.owner)).expect(404);
    });

    it.each([
      ['an unknown field', { locationRef: null, colour: 'blue' }],
      ['a raw location id', { locationId: '01930000-0000-7000-8000-000000000001' }],
      ['an actor', { locationRef: null, actorId: '01930000-0000-7000-8000-000000000001' }],
      ['a reason', { locationRef: null, reason: 'because' }],
      ['a missing locationRef', {}],
    ])('rejects %s with 400', async (_label, body) => {
      const fixture = await seedOwnerWithLocation('+98834');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98835');
      await api().put(bindingPath(fixture.businessId, membershipId)).set(auth(fixture.owner)).send(body).expect(400);
    });

    it('does not add the branch to the staff roster or the professional’s own surface', async () => {
      const fixture = await seedOwnerWithLocation('+98836');
      const { proUser, membershipId } = await seedActiveProfessionalMembership(
        fixture.businessId,
        fixture.owner.id,
        '+98837',
        fixture.locationId,
      );

      const roster = await api().get(`/api/v1/businesses/${fixture.businessId}/staff`).set(auth(fixture.owner)).expect(200);
      expect(JSON.stringify(roster.body)).not.toContain(fixture.locationId);
      expect(JSON.stringify(roster.body)).not.toContain(fixture.locationRef);
      expect(Object.keys(roster.body.data[0])).not.toContain('locationRef');

      const mine = await api().get('/api/v1/me/business-staff').set(auth(proUser)).expect(200);
      expect(JSON.stringify(mine.body)).not.toContain(fixture.locationId);
      expect(JSON.stringify(mine.body)).not.toContain(fixture.locationRef);
      expect(membershipId).toBeDefined();
    });
  });

  // =========================================================================
  // §5 Authorization
  // =========================================================================

  describe('§5 owner-only, proved adversarially and byte-identically', () => {
    it('refuses manager, staff, practitioner_chat holder, invitee, stranger and foreign owner — identically', async () => {
      const fixture = await seedOwnerWithLocation('+98840');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98841');

      const mkStaff = async (role: 'manager' | 'staff', prefix: string, activate = true) => {
        const u = await seedUser(app, dataSource, uniquePhone(prefix));
        const id = await seedMembership(dataSource, fixture.businessId, u.id, role, fixture.owner.id);
        if (activate) await dataSource.query(`UPDATE business.business_staff SET status='active' WHERE id = $1`, [id]);
        return { user: u, id };
      };
      const manager = await mkStaff('manager', '+98842');
      const staff = await mkStaff('staff', '+98843');
      const invitee = await mkStaff('staff', '+98844', false);
      const stranger = await seedUser(app, dataSource, uniquePhone('+98845'));
      const foreign = await seedOwnerWithLocation('+98846');

      // A real practitioner_chat holder: scoped authority that confers nothing here.
      const granted = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98847');
      await dataSource.query(
        `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id)
         VALUES ($1, $2, $3, 'practitioner_chat', $4)`,
        [uuidv7(), granted.membershipId, fixture.businessId, fixture.owner.id],
      );

      const path = bindingPath(fixture.businessId, membershipId);
      const bodies: unknown[] = [];
      for (const user of [manager.user, staff.user, invitee.user, stranger, foreign.owner, granted.proUser]) {
        const read = await api().get(path).set(auth(user));
        const write = await api().put(path).set(auth(user)).send({ locationRef: fixture.locationRef });
        for (const res of [read, write]) {
          expect(res.status).toBe(404);
          bodies.push(res.body);
        }
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(await dataSource.query(`SELECT location_id FROM business.business_staff WHERE id = $1`, [membershipId])).toEqual([
        { location_id: null },
      ]);
    });

    it('the positive control: the live owner reads and writes', async () => {
      const fixture = await seedOwnerWithLocation('+98848');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98849');
      const path = bindingPath(fixture.businessId, membershipId);
      await api().get(path).set(auth(fixture.owner)).expect(200);
      await api().put(path).set(auth(fixture.owner)).send({ locationRef: fixture.locationRef }).expect(200);
    });

    it('refuses an unauthenticated caller on both routes', async () => {
      const fixture = await seedOwnerWithLocation('+98850');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98851');
      const path = bindingPath(fixture.businessId, membershipId);
      await api().get(path).expect(401);
      await api().put(path).send({ locationRef: null }).expect(401);
    });

    it('refuses a soft-deleted business', async () => {
      const fixture = await seedOwnerWithLocation('+98852');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98853');
      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [fixture.businessId]);
      await api().get(bindingPath(fixture.businessId, membershipId)).set(auth(fixture.owner)).expect(404);
    });
  });

  // =========================================================================
  // §6 Audit
  // =========================================================================

  async function auditActionsFor(membershipId: string): Promise<string[]> {
    const rows: Array<{ action: string }> = await dataSource.query(
      `SELECT action FROM admin.admin_audit_log WHERE target_type = 'business.staff_location' AND target_id::text = $1 ORDER BY id`,
      [membershipId],
    );
    return rows.map((r) => r.action);
  }

  describe('§6 exactly one audit fact per real change, and none otherwise', () => {
    it('records assignment and clearing, and nothing for reads, no-ops or refusals', async () => {
      const fixture = await seedOwnerWithLocation('+98860');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98861');
      const path = bindingPath(fixture.businessId, membershipId);

      await api().get(path).set(auth(fixture.owner)).expect(200);
      await api().put(path).set(auth(fixture.owner)).send({ locationRef: null }).expect(200); // already null: no-op
      await api().put(path).set(auth(fixture.owner)).send({ locationRef: fixture.locationRef }).expect(200);
      await api().put(path).set(auth(fixture.owner)).send({ locationRef: fixture.locationRef }).expect(200); // idempotent
      await api().put(path).set(auth(fixture.owner)).send({ locationRef: 'A'.repeat(43) }).expect(404); // refusal
      await api().put(path).set(auth(fixture.owner)).send({ locationRef: null }).expect(200);

      expect(await auditActionsFor(membershipId)).toEqual([
        'business.staff_location_assigned',
        'business.staff_location_cleared',
      ]);
    });

    it('carries the acting owner and no reference or name in the snapshot', async () => {
      const fixture = await seedOwnerWithLocation('+98862');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98863');
      await api()
        .put(bindingPath(fixture.businessId, membershipId))
        .set(auth(fixture.owner))
        .send({ locationRef: fixture.locationRef })
        .expect(200);

      const [row] = await dataSource.query(
        `SELECT actor_user_id::text, reason, before_state, after_state FROM admin.admin_audit_log
          WHERE action = 'business.staff_location_assigned' ORDER BY id DESC LIMIT 1`,
      );
      expect(row.actor_user_id).toBe(fixture.owner.id);
      expect(row.reason).toBe('staff delivery location assigned by the business owner');
      expect(row.before_state).toEqual({ locationId: null });
      expect(row.after_state).toEqual({ locationId: fixture.locationId });
      expect(JSON.stringify(row)).not.toContain(fixture.locationRef);
    });

    it('a planted audit failure rolls the binding back', async () => {
      const fixture = await seedOwnerWithLocation('+98864');
      const { membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98865');

      const audit = app.get(AdminAuditService);
      const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('planted audit failure (deliberate)'));
      try {
        await api()
          .put(bindingPath(fixture.businessId, membershipId))
          .set(auth(fixture.owner))
          .send({ locationRef: fixture.locationRef })
          .expect(500);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }

      expect(await dataSource.query(`SELECT location_id FROM business.business_staff WHERE id = $1`, [membershipId])).toEqual([
        { location_id: null },
      ]);
      expect(await auditActionsFor(membershipId)).toEqual([]);

      // The control: with the spy gone, the same request succeeds.
      await api()
        .put(bindingPath(fixture.businessId, membershipId))
        .set(auth(fixture.owner))
        .send({ locationRef: fixture.locationRef })
        .expect(200);
    });
  });

  // =========================================================================
  // §7 The resolver
  // =========================================================================

  describe('§7 the snapshot resolver never guesses', () => {
    it('stamps the branch for an active, bound membership', async () => {
      const fixture = await seedOwnerWithLocation('+98870');
      const { professional } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98871', fixture.locationId);
      const slot = await availability.createSlot(professional.id, { ...futureSlot(40), serviceId: null });
      expect(await snapshotOf(slot.id)).toBe(fixture.locationId);
    });

    it.each([
      ['a standalone professional with no business', 'standalone'],
      ['an affiliated professional with no branch', 'unbound'],
      ['an INACTIVE membership', 'inactive'],
      ['an INVITED membership', 'invited'],
      ['a SUSPENDED branch', 'suspended'],
      ['a CLOSED branch', 'closed'],
      ['a soft-deleted business', 'deleted'],
      ['a business OWNER with no active membership', 'owner-only'],
    ])('returns NULL for %s', async (_label, mode) => {
      if (mode === 'standalone') {
        const u = await seedUser(app, dataSource, uniquePhone('+98872'), ['professional']);
        const pro = await seedProfessional(dataSource, u.id, 'مستقل');
        const slot = await availability.createSlot(pro.id, { ...futureSlot(41), serviceId: null });
        expect(await snapshotOf(slot.id)).toBeNull();
        return;
      }

      if (mode === 'owner-only') {
        // Owns the business AND owns a professional profile, but holds no
        // membership. Ownership is not a binding: guessing the business's only
        // branch here is exactly the first-row rule `V33-DEC-035` R4 forbids.
        const fixture = await seedOwnerWithLocation('+98873');
        const pro = await seedProfessional(dataSource, fixture.owner.id, 'مالک');
        const slot = await availability.createSlot(pro.id, { ...futureSlot(42), serviceId: null });
        expect(await snapshotOf(slot.id)).toBeNull();
        return;
      }

      const lifecycle = mode === 'suspended' ? 'suspended' : mode === 'closed' ? 'closed' : 'active';
      const fixture = await seedOwnerWithLocation('+98874', lifecycle);
      const bind = mode === 'unbound' ? null : fixture.locationId;
      const { professional, membershipId } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98875', bind);

      if (mode === 'inactive') await dataSource.query(`UPDATE business.business_staff SET status='inactive' WHERE id=$1`, [membershipId]);
      if (mode === 'invited') await dataSource.query(`UPDATE business.business_staff SET status='invited' WHERE id=$1`, [membershipId]);
      if (mode === 'deleted') await dataSource.query(`UPDATE business.businesses SET deleted_at=now() WHERE id=$1`, [fixture.businessId]);

      const slot = await availability.createSlot(professional.id, { ...futureSlot(43), serviceId: null });
      expect(await snapshotOf(slot.id)).toBeNull();
    });

    it('costs the same one query whether a binding exists or not', async () => {
      const bound = await seedOwnerWithLocation('+98876');
      const boundPro = await seedActiveProfessionalMembership(bound.businessId, bound.owner.id, '+98877', bound.locationId);
      const soloUser = await seedUser(app, dataSource, uniquePhone('+98878'), ['professional']);
      const soloPro = await seedProfessional(dataSource, soloUser.id, 'مستقل');

      const count = async (professionalId: string, offset: number) => {
        let queries = 0;
        const original = dataSource.logger;
        dataSource.logger = {
          logQuery: (q: string) => {
            if (/business_staff/i.test(q)) queries += 1;
          },
          logQueryError: () => undefined,
          logQuerySlow: () => undefined,
          logSchemaBuild: () => undefined,
          logMigration: () => undefined,
          log: () => undefined,
        };
        try {
          await availability.createSlot(professionalId, { ...futureSlot(offset), serviceId: null });
        } finally {
          dataSource.logger = original;
        }
        return queries;
      };

      expect(await count(boundPro.professional.id, 50)).toBe(1);
      expect(await count(soloPro.id, 51)).toBe(1);
    });
  });

  // =========================================================================
  // §8 Bulk generation
  // =========================================================================

  describe('§8 bulk generation resolves once and stamps every slot', () => {
    it('stamps the same branch on every generated slot with ONE resolver query', async () => {
      const fixture = await seedOwnerWithLocation('+98880');
      const { professional } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98881', fixture.locationId);

      let membershipQueries = 0;
      const original = dataSource.logger;
      dataSource.logger = {
        logQuery: (q: string) => {
          if (/business_staff/i.test(q)) membershipQueries += 1;
        },
        logQueryError: () => undefined,
        logQuerySlow: () => undefined,
        logSchemaBuild: () => undefined,
        logMigration: () => undefined,
        log: () => undefined,
      };
      let result;
      try {
        const from = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
        const to = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
        result = await availability.bulkGenerate(professional.id, {
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          timeStart: '09:00',
          timeEnd: '13:00',
          slotMinutes: 60,
          dateFrom: from,
          dateTo: to,
          serviceId: null,
        });
      } finally {
        dataSource.logger = original;
      }

      expect(result!.created).toBeGreaterThan(4);
      // ONE resolve for the whole command, not one per candidate.
      expect(membershipQueries).toBe(1);

      const rows = await dataSource.query(
        `SELECT DISTINCT delivery_location_id::text AS loc FROM booking.availability_slots WHERE professional_id = $1`,
        [professional.id],
      );
      expect(rows).toEqual([{ loc: fixture.locationId }]);
    });

    it('leaves every generated slot NULL for a standalone professional', async () => {
      const u = await seedUser(app, dataSource, uniquePhone('+98882'), ['professional']);
      const pro = await seedProfessional(dataSource, u.id, 'مستقل');
      const from = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const to = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
      const result = await availability.bulkGenerate(pro.id, {
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        timeStart: '09:00',
        timeEnd: '11:00',
        slotMinutes: 60,
        dateFrom: from,
        dateTo: to,
        serviceId: null,
      });
      expect(result.created).toBeGreaterThan(0);
      const rows = await dataSource.query(
        `SELECT DISTINCT delivery_location_id::text AS loc FROM booking.availability_slots WHERE professional_id = $1`,
        [pro.id],
      );
      expect(rows).toEqual([{ loc: null }]);
    });
  });

  // =========================================================================
  // §9 Rebinding affects future slots only
  // =========================================================================

  describe('§9 a rebinding never moves an existing slot', () => {
    it('old slots keep their snapshot; new slots follow the new branch; clearing yields NULL', async () => {
      const owner = await seedUser(app, dataSource, uniquePhone('+98890'), ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن دوشعبه');
      const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
      const branchA = uuidv7();
      const branchB = uuidv7();
      for (const [id, name] of [[branchA, 'شعبه الف'], [branchB, 'شعبه ب']] as const) {
        await dataSource.query(
          `INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, $3, $4, 'active')`,
          [id, business.id, name, cityId],
        );
      }
      const refFor = (id: string) => deriveLocationReference(referenceSecret, owner.id, business.id, id);
      const { professional, membershipId } = await seedActiveProfessionalMembership(business.id, owner.id, '+98891', branchA);
      const path = bindingPath(business.id, membershipId);

      const first = await availability.createSlot(professional.id, { ...futureSlot(60), serviceId: null });
      expect(await snapshotOf(first.id)).toBe(branchA);

      await api().put(path).set(auth(owner)).send({ locationRef: refFor(branchB) }).expect(200);

      // The already-published slot is untouched.
      expect(await snapshotOf(first.id)).toBe(branchA);
      const second = await availability.createSlot(professional.id, { ...futureSlot(61), serviceId: null });
      expect(await snapshotOf(second.id)).toBe(branchB);

      await api().put(path).set(auth(owner)).send({ locationRef: null }).expect(200);
      const third = await availability.createSlot(professional.id, { ...futureSlot(62), serviceId: null });
      expect(await snapshotOf(third.id)).toBeNull();
      expect(await snapshotOf(first.id)).toBe(branchA);
      expect(await snapshotOf(second.id)).toBe(branchB);
    });

    it('a concurrent rebinding and slot creation linearise -- the slot gets one whole binding', async () => {
      const owner = await seedUser(app, dataSource, uniquePhone('+98892'), ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن');
      const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
      const branchA = uuidv7();
      const branchB = uuidv7();
      for (const id of [branchA, branchB]) {
        await dataSource.query(
          `INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه', $3, 'active')`,
          [id, business.id, cityId],
        );
      }
      const { professional, membershipId } = await seedActiveProfessionalMembership(business.id, owner.id, '+98893', branchA);

      const [, slot] = await Promise.all([
        api()
          .put(bindingPath(business.id, membershipId))
          .set(auth(owner))
          .send({ locationRef: deriveLocationReference(referenceSecret, owner.id, business.id, branchB) }),
        availability.createSlot(professional.id, { ...futureSlot(63), serviceId: null }),
      ]);

      // Either the complete old binding or the complete new one -- never a
      // half-applied change and never NULL.
      expect([branchA, branchB]).toContain(await snapshotOf(slot.id));
    });
  });

  // =========================================================================
  // §9b Reschedule
  // =========================================================================

  describe('§9b a reschedule takes the destination slot’s branch, never the old one', () => {
    it('points the booking at the new slot, whose snapshot is the new branch', async () => {
      const owner = await seedUser(app, dataSource, uniquePhone('+98894'), ['business']);
      const business = await seedBusiness(dataSource, owner.id, 'سالن');
      const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
      const branchA = uuidv7();
      const branchB = uuidv7();
      for (const id of [branchA, branchB]) {
        await dataSource.query(
          `INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه', $3, 'active')`,
          [id, business.id, cityId],
        );
      }
      const { professional, membershipId } = await seedActiveProfessionalMembership(business.id, owner.id, '+98895', branchA);

      // One slot published while bound to A, a second after rebinding to B.
      const slotA = await availability.createSlot(professional.id, { ...futureSlot(64), serviceId: null });
      await api()
        .put(bindingPath(business.id, membershipId))
        .set(auth(owner))
        .send({ locationRef: deriveLocationReference(referenceSecret, owner.id, business.id, branchB) })
        .expect(200);
      const slotB = await availability.createSlot(professional.id, { ...futureSlot(65), serviceId: null });

      expect(await snapshotOf(slotA.id)).toBe(branchA);
      expect(await snapshotOf(slotB.id)).toBe(branchB);

      // A booking on A, rescheduled onto B.
      const customer = await seedUser(app, dataSource, uniquePhone('+98896'));
      const booking = await app
        .get(BookingService)
        .create({ customerId: customer.id, professionalId: professional.id, slotId: slotA.id, serviceId: null });
      await app.get(BookingService).reschedule(booking.id, slotB.id, { type: 'customer', id: customer.id });

      const [moved] = await dataSource.query(`SELECT slot_id::text FROM booking.bookings WHERE id = $1`, [booking.id]);
      expect(moved.slot_id).toBe(slotB.id);

      /*
       * The delivery context of a booking IS its slot's snapshot -- there is no
       * copy on the booking row to go stale. So a reschedule moves the context
       * simply by moving the slot, and the old slot keeps its own branch for
       * whoever books it next. #128 reads the CURRENT slot and therefore never
       * sees the old branch.
       */
      expect(await snapshotOf(slotB.id)).toBe(branchB);
      expect(await snapshotOf(slotA.id)).toBe(branchA);
    });
  });

  // =========================================================================
  // §10 The freeze
  // =========================================================================

  describe('§10 the snapshot is frozen once the slot leaves open', () => {
    async function boundSlot(prefix: string, offset: number) {
      const fixture = await seedOwnerWithLocation(prefix);
      const { professional } = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, `${prefix}9`, fixture.locationId);
      const slot = await availability.createSlot(professional.id, { ...futureSlot(offset), serviceId: null });
      return { ...fixture, slot };
    }

    it('REFUSES changing the snapshot of a held slot', async () => {
      const { slot } = await boundSlot('+98900', 70);
      await dataSource.query(`UPDATE booking.availability_slots SET status='held', held_until=now()+interval '10 min' WHERE id=$1`, [slot.id]);
      await expect(
        dataSource.query(`UPDATE booking.availability_slots SET delivery_location_id=$1 WHERE id=$2`, [uuidv7(), slot.id]),
      ).rejects.toThrow(/frozen/i);
    });

    it('REFUSES changing the snapshot of a booked slot', async () => {
      const { slot } = await boundSlot('+98901', 71);
      await dataSource.query(`UPDATE booking.availability_slots SET status='booked' WHERE id=$1`, [slot.id]);
      await expect(
        dataSource.query(`UPDATE booking.availability_slots SET delivery_location_id=NULL WHERE id=$1`, [slot.id]),
      ).rejects.toThrow(/frozen/i);
    });

    it('REFUSES a combined status-and-snapshot change in one statement', async () => {
      // The loophole this closes: claim and relocate together, so the row looks
      // as though it had always been at the new branch.
      const { slot } = await boundSlot('+98902', 72);
      await expect(
        dataSource.query(
          `UPDATE booking.availability_slots SET status='held', held_until=now()+interval '10 min', delivery_location_id=$1 WHERE id=$2`,
          [uuidv7(), slot.id],
        ),
      ).rejects.toThrow(/frozen/i);
    });

    it('PERMITS the ordinary claim and release paths, which never touch the snapshot', async () => {
      // The positive control for §10: without it every refusal above could be a
      // trigger that rejects all updates.
      const { slot, locationId } = await boundSlot('+98903', 73);
      await dataSource.query(`UPDATE booking.availability_slots SET status='held', held_until=now()+interval '10 min' WHERE id=$1`, [slot.id]);
      await dataSource.query(`UPDATE booking.availability_slots SET status='open', held_until=NULL, held_by_booking_id=NULL WHERE id=$1`, [slot.id]);
      expect(await snapshotOf(slot.id)).toBe(locationId);
    });
  });

  // =========================================================================
  // §11 Customer and professional non-exposure
  // =========================================================================

  describe('§11 no response differs because a snapshot exists', () => {
    it('the public and professional availability shapes are byte-identical with and without a branch', async () => {
      const fixture = await seedOwnerWithLocation('+98910');
      const bound = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98911', fixture.locationId);
      const soloUser = await seedUser(app, dataSource, uniquePhone('+98912'), ['professional']);
      const solo = await seedProfessional(dataSource, soloUser.id, 'مستقل');

      await availability.createSlot(bound.professional.id, { ...futureSlot(80), serviceId: null });
      await availability.createSlot(solo.id, { ...futureSlot(80), serviceId: null });

      const boundPublic = await api().get(`/api/v1/providers/${bound.professional.id}/availability`).expect(200);
      const soloPublic = await api().get(`/api/v1/providers/${solo.id}/availability`).expect(200);
      expect(Object.keys(boundPublic.body.data[0]).sort()).toEqual(Object.keys(soloPublic.body.data[0]).sort());
      expect(Object.keys(boundPublic.body.data[0]).sort()).toEqual(['endAt', 'id', 'serviceId', 'startAt']);
      expect(JSON.stringify(boundPublic.body)).not.toContain(fixture.locationId);

      const boundMine = await api().get('/api/v1/me/availability').set(auth(bound.proUser)).expect(200);
      const soloMine = await api().get('/api/v1/me/availability').set(auth(soloUser)).expect(200);
      expect(Object.keys(boundMine.body.data[0]).sort()).toEqual(Object.keys(soloMine.body.data[0]).sort());
      expect(JSON.stringify(boundMine.body)).not.toContain(fixture.locationId);
      expect(JSON.stringify(boundMine.body)).not.toContain('deliveryLocationId');
    });
  });

  // =========================================================================
  // §12 Privacy
  // =========================================================================

  describe('§12 ADR-027 coverage and dispositions', () => {
    let coverage: SubjectDataCoverageService;
    let contracts: SubjectDataContract[];

    beforeAll(() => {
      coverage = app.get(SubjectDataCoverageService);
      contracts = app.get(SUBJECT_DATA_CONTRACTS);
    });

    it('the live catalogue is fully claimed after both columns land', async () => {
      const catalogue = await coverage.readCatalogue();
      expect(evaluateCoverage(catalogue, contracts).violations).toEqual([]);
    });

    it('pins business.business_staff as subject_data', () => {
      // The heuristic does not recognise `location_id`, so the disposition is
      // pinned here rather than trusted to the boot assertion.
      const contract = app.get(BusinessSubjectDataContract);
      const claims = contract.tables.filter((c) => c.table === 'business.business_staff');
      expect(claims).toHaveLength(1);
      expect(claims[0].disposition).toBe('subject_data');
    });

    it('pins booking.availability_slots as no_subject_data, with the branch named in the reason', () => {
      const claims = contracts
        .flatMap((c) => c.tables)
        .filter((t) => t.table === 'booking.availability_slots');
      expect(claims).toHaveLength(1);
      expect(claims[0].disposition).toBe('no_subject_data');
      // The reason must actually account for the new column, or the claim is
      // stale rather than merely terse.
      expect(claims[0].reason).toContain('delivery_location_id');
    });

    it.each([
      ['unclaimed', 'unclaimed', (c: CatalogueTable[], k: SubjectDataContract[]) => ({
        catalogue: c,
        contracts: k.map((x) => ({ ...x, tables: x.tables.filter((t) => t.table !== 'booking.availability_slots') })) as SubjectDataContract[],
      })],
      ['stale', 'claimed_but_absent', (c: CatalogueTable[], k: SubjectDataContract[]) => ({
        catalogue: c.filter((t) => `${t.schema}.${t.name}` !== 'booking.availability_slots'),
        contracts: k,
      })],
    ])('a %s claim fails coverage with %s', async (_label, kind, mutate) => {
      const catalogue = await coverage.readCatalogue();
      const m = (mutate as (c: CatalogueTable[], k: SubjectDataContract[]) => { catalogue: CatalogueTable[]; contracts: SubjectDataContract[] })(
        [...catalogue],
        [...contracts],
      );
      expect(evaluateCoverage(m.catalogue, m.contracts).violations.map((v) => v.kind)).toContain(kind);
    });

    it('erasing a subject rewrites no slot snapshot', async () => {
      const fixture = await seedOwnerWithLocation('+98920');
      const bound = await seedActiveProfessionalMembership(fixture.businessId, fixture.owner.id, '+98921', fixture.locationId);
      const slot = await availability.createSlot(bound.professional.id, { ...futureSlot(90), serviceId: null });
      const before = await dataSource.query(
        `SELECT xmin::text AS xmin, delivery_location_id::text AS loc FROM booking.availability_slots WHERE id = $1`,
        [slot.id],
      );

      const contract = app.get(BusinessSubjectDataContract);
      await dataSource.transaction((m) => contract.eraseSubjectData(m, bound.proUser.id));

      expect(
        await dataSource.query(
          `SELECT xmin::text AS xmin, delivery_location_id::text AS loc FROM booking.availability_slots WHERE id = $1`,
          [slot.id],
        ),
      ).toEqual(before);
    });
  });
});
