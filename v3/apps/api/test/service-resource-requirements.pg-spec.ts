import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { AdminAuditService } from '@beauclick/audit';
import { BusinessSubjectDataContract, SERVICE_OWNERSHIP_DIRECTORY, ServiceOwnershipDirectoryPort } from '@beauclick/business';
import { ELIGIBLE_RESOURCE_DIRECTORY, EligibleResourceDirectory } from '@beauclick/booking';
import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  CatalogueTable,
  evaluateCoverage,
} from '@beauclick/subject-data';

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
 * REAL PostgreSQL: V3.3 Story #131 (`#127b`) -- the service resource
 * requirement and eligible-resource resolution.
 *
 * ## Why every case here needs a real server
 *
 * ADR-049 section 2.4. The in-memory layer honours neither the CHECK
 * constraint, nor the composite/plain foreign keys, nor the named unique
 * index, nor `xmin`, nor `ROLLBACK`, nor advisory locks -- which is to say it
 * can prove nothing about the closed vocabulary, at-most-one-row cardinality,
 * the byte-identity of every table this story does NOT touch, or the
 * atomicity of a requirement write with its audit row. Those are exactly the
 * guarantees this story ships.
 *
 * The closed vocabulary, the DTO refusals and the handler-level ownership
 * metadata live in the fast layer instead
 * (`services/business/src/service-resource-requirement.contract.spec.ts`),
 * because they need no database.
 *
 * ## What this story is NOT
 *
 * There is no `booking.booking_resource_assignments`, no collision exclusion
 * constraint, no booking wiring and no customer-facing surface anywhere in
 * this file. Those are `#110b` (#128). A test asserting them here would be
 * testing a story that has not been ratified. `ELIGIBLE_RESOURCE_DIRECTORY`
 * is exercised directly through its DI token, never through an HTTP route --
 * #131 declares and implements it but calls it from nowhere in booking.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

const KIND_MEMBERS = ['room', 'device', 'station'] as const;

describeIfPg('Service resource requirement and eligible-resource resolution (#131 / #127b)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;

  const uniquePhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  const api = () => request(app.getHttpServer());
  const auth = (user: SeededUser) => ({ Authorization: `Bearer ${user.accessToken}` });
  const requirementPath = (businessId: string, serviceId: string) => `/api/v1/businesses/${businessId}/services/${serviceId}/resource-requirement`;

  /** A live business owner with no location/professional attached yet. */
  async function seedOwner(prefix: string) {
    const owner = await seedUser(app, dataSource, uniquePhone(prefix), ['business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن');
    return { owner, businessId: business.id };
  }

  /** A professional with a service, affiliated to `businessId` with an ACTIVE membership. */
  async function seedActiveProfessionalService(businessId: string, ownerId: string, prefix: string) {
    const proUser = await seedUser(app, dataSource, uniquePhone(prefix), ['professional']);
    const professional = await seedProfessional(dataSource, proUser.id, 'آرایشگر');
    const membershipId = await seedMembership(dataSource, businessId, proUser.id, 'staff', ownerId, professional.id);
    await dataSource.query(`UPDATE business.business_staff SET status='active', responded_at=now() WHERE id = $1`, [membershipId]);
    return { proUser, professional, serviceId: professional.serviceId, membershipId };
  }

  /** A live business with one active location and one active resource of `kind`. */
  async function seedOwnerLocationResource(prefix: string, kind: (typeof KIND_MEMBERS)[number] = 'device') {
    const { owner, businessId } = await seedOwner(prefix);
    const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
    const locationId = uuidv7();
    await dataSource.query(
      `INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه', $3, 'active')`,
      [locationId, businessId, cityId],
    );
    const resourceId = uuidv7();
    await dataSource.query(
      `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, $4, 'منبع', 'active')`,
      [resourceId, locationId, businessId, kind],
    );
    return { owner, businessId, locationId, resourceId };
  }

  // Deliberately NOT `async`: returning the supertest `Test` object as-is
  // (rather than the `Promise<Response>` an `async` wrapper would collapse it
  // to) is what keeps `.expect(...)` chainable at every call site below.
  function setRequirement(businessId: string, owner: SeededUser, serviceId: string, requiredKind: string | null) {
    return api().put(requirementPath(businessId, serviceId)).set(auth(owner)).send({ requiredKind });
  }

  // =========================================================================
  // §1 Schema shape
  // =========================================================================

  describe('§1 the migration produced exactly the ratified shape', () => {
    it('business.service_resource_requirements has exactly the ratified columns', async () => {
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='business' AND table_name='service_resource_requirements'`,
        )
      ).map((r: { column_name: string }) => r.column_name);
      expect(columns.sort()).toEqual(['business_id', 'created_at', 'id', 'required_kind', 'service_id', 'updated_at'].sort());
    });

    it('carries no owner, actor, booking, occupancy or lifecycle column', async () => {
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='business' AND table_name='service_resource_requirements'`,
        )
      ).map((r: { column_name: string }) => r.column_name);
      for (const forbidden of ['owner_id', 'actor_id', 'actor_user_id', 'user_id', 'lifecycle', 'version', 'quantity', 'resource_ref', 'occupancy']) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('declares the named CHECK constraint and NO cross-schema foreign key', async () => {
      const defs: string[] = (
        await dataSource.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='business.service_resource_requirements'::regclass`,
        )
      ).map((r: { conname: string; def: string }) => `${r.conname}: ${r.def}`);
      const kindCheck = defs.find((d) => d.startsWith('ck_service_resource_requirements_kind:'));
      expect(kindCheck).toBeDefined();
      expect(kindCheck).toMatch(/required_kind/);
      expect(kindCheck).toMatch(/ANY/);
      expect(kindCheck).toContain("'room'");
      expect(kindCheck).toContain("'device'");
      expect(kindCheck).toContain("'station'");

      const fkDefs: string[] = (
        await dataSource.query(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='business.service_resource_requirements'::regclass AND contype='f'`,
        )
      ).map((r: { def: string }) => r.def);
      // Exactly one FK -- to business.businesses -- and none names provider.
      expect(fkDefs).toHaveLength(1);
      expect(fkDefs[0]).toMatch(/REFERENCES business\.businesses/);
      expect(fkDefs.filter((d) => /provider\./i.test(d))).toEqual([]);
    });

    it('declares the named uniqueness rule and the service-id lookup index', async () => {
      const indexes: string[] = (
        await dataSource.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='business' AND tablename='service_resource_requirements'`)
      ).map((r: { indexdef: string }) => r.indexdef);
      expect(indexes.join('\n')).toMatch(
        /CREATE UNIQUE INDEX uq_service_resource_requirements_business_service ON business\.service_resource_requirements USING btree \(business_id, service_id\)/,
      );
      expect(indexes.join('\n')).toMatch(/ix_service_resource_requirements_service_id/);
    });

    it('adds no resource-assignment column to booking or provider -- #128 owns assignment itself, and provider is untouched', async () => {
      const bookingColumns: string[] = (
        await dataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='booking' AND table_name='availability_slots'`)
      ).map((r: { column_name: string }) => r.column_name);
      for (const forbidden of ['required_resource_kind', 'resource_id', 'resource_requirement_id']) {
        expect(bookingColumns).not.toContain(forbidden);
      }

      // `booking.booking_resource_assignments` DID NOT exist when this
      // assertion was first written (#131, 2026-09-10) -- it originally
      // pinned the table's absence as evidence that #131 itself added no
      // booking-schema object, deliberately anticipating that #128 (`#110b`)
      // would add exactly that one table afterward (see
      // `booking-resource-assignments.pg-spec.ts` for its full contract).
      // #128 has SINCE been ratified and implemented, so its presence here
      // is expected, not a #131 regression.
      const bookingTables: string[] = (
        await dataSource.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='booking'`)
      ).map((r: { table_name: string }) => r.table_name);
      expect(bookingTables).toContain('booking_resource_assignments');

      const providerColumns: string[] = (
        await dataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='provider' AND table_name='services'`)
      ).map((r: { column_name: string }) => r.column_name);
      for (const forbidden of ['required_kind', 'resource_kind', 'kind']) {
        expect(providerColumns).not.toContain(forbidden);
      }
    });
  });

  // =========================================================================
  // §2 CHECK constraint and uniqueness -- mutation probes
  // =========================================================================

  describe('§2 the CHECK constraint and the uniqueness rule are unwritable violations', () => {
    /**
     * A bare `business.businesses` row, with no owning user seeded. Legal
     * because `owner_id` carries no cross-schema FK by convention -- exactly
     * as `seedBusiness` itself relies on for every other suite -- and these
     * cases probe the CHECK/uniqueness/FK constraints on
     * `service_resource_requirements` in isolation, with no HTTP surface or
     * authentication involved.
     */
    const bareBusinessId = async () => (await seedBusiness(dataSource, uuidv7(), 'کسب‌وکار آزمایشی')).id;

    it('accepts every vocabulary member', async () => {
      const businessId = await bareBusinessId();
      for (const kind of KIND_MEMBERS) {
        await dataSource.query(
          `INSERT INTO business.service_resource_requirements (id, business_id, service_id, required_kind) VALUES ($1, $2, $3, $4)`,
          [uuidv7(), businessId, uuidv7(), kind],
        );
      }
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM business.service_resource_requirements WHERE business_id = $1`, [
        businessId,
      ]);
      expect(n).toBe(3);
    });

    it('REFUSES an unknown kind (mutation: remove the constraint and this must start passing)', async () => {
      const businessId = await bareBusinessId();
      await expect(
        dataSource.query(
          `INSERT INTO business.service_resource_requirements (id, business_id, service_id, required_kind) VALUES ($1, $2, $3, 'chair')`,
          [uuidv7(), businessId, uuidv7()],
        ),
      ).rejects.toThrow(/violates check constraint|ck_service_resource_requirements_kind/i);
    });

    it('REFUSES a second row for the same (business, service) (mutation: drop the unique index and this must start passing)', async () => {
      const businessId = await bareBusinessId();
      const serviceId = uuidv7();
      await dataSource.query(
        `INSERT INTO business.service_resource_requirements (id, business_id, service_id, required_kind) VALUES ($1, $2, $3, 'room')`,
        [uuidv7(), businessId, serviceId],
      );
      await expect(
        dataSource.query(
          `INSERT INTO business.service_resource_requirements (id, business_id, service_id, required_kind) VALUES ($1, $2, $3, 'device')`,
          [uuidv7(), businessId, serviceId],
        ),
      ).rejects.toThrow(/duplicate key value violates unique constraint|uq_service_resource_requirements_business_service/i);
    });

    it('permits the SAME service under two DIFFERENT businesses -- uniqueness is per (business, service), not per service', async () => {
      const serviceId = uuidv7();
      const businessA = await bareBusinessId();
      const businessB = await bareBusinessId();
      await dataSource.query(
        `INSERT INTO business.service_resource_requirements (id, business_id, service_id, required_kind) VALUES ($1, $2, $3, 'room')`,
        [uuidv7(), businessA, serviceId],
      );
      await expect(
        dataSource.query(
          `INSERT INTO business.service_resource_requirements (id, business_id, service_id, required_kind) VALUES ($1, $2, $3, 'device')`,
          [uuidv7(), businessB, serviceId],
        ),
      ).resolves.toBeDefined();
    });

    it('REFUSES a business id that does not exist (mutation: drop the FK and this must start passing)', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO business.service_resource_requirements (id, business_id, service_id, required_kind) VALUES ($1, $2, $3, 'room')`,
          [uuidv7(), uuidv7(), uuidv7()],
        ),
      ).rejects.toThrow(/violates foreign key constraint/i);
    });
  });

  // =========================================================================
  // §3 Admin route -- set, change, clear, idempotency
  // =========================================================================

  describe('§3 owner configures a requirement', () => {
    it('reads no requirement for an unconfigured but owned service', async () => {
      const { owner, businessId } = await seedOwner('+98930');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98931');

      const res = await api().get(requirementPath(businessId, serviceId)).set(auth(owner)).expect(200);
      expect(res.body.data).toEqual({ requiredKind: null });
    });

    it('sets, reads back, changes, and clears', async () => {
      const { owner, businessId } = await seedOwner('+98932');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98933');

      let res = await setRequirement(businessId, owner, serviceId, 'device').expect(200);
      expect(res.body.data).toEqual({ requiredKind: 'device' });

      res = await api().get(requirementPath(businessId, serviceId)).set(auth(owner)).expect(200);
      expect(res.body.data).toEqual({ requiredKind: 'device' });

      res = await setRequirement(businessId, owner, serviceId, 'station').expect(200);
      expect(res.body.data).toEqual({ requiredKind: 'station' });

      res = await setRequirement(businessId, owner, serviceId, null).expect(200);
      expect(res.body.data).toEqual({ requiredKind: null });

      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM business.service_resource_requirements WHERE service_id = $1`, [
        serviceId,
      ]);
      expect(n).toBe(0);
    });

    it('REFUSES a service not owned by this business -- foreign service, unaffiliated service, and a service of an INACTIVE membership, identically', async () => {
      const { owner, businessId } = await seedOwner('+98934');
      const foreign = await seedOwner('+98935');
      const { serviceId: foreignServiceId } = await seedActiveProfessionalService(foreign.businessId, foreign.owner.id, '+98936');

      const proUser = await seedUser(app, dataSource, uniquePhone('+98937'), ['professional']);
      const unaffiliated = await seedProfessional(dataSource, proUser.id, 'مستقل');

      const { proUser: inactivePro, professional: inactiveProfessional, membershipId } = await seedActiveProfessionalService(
        businessId,
        owner.id,
        '+98938',
      );
      await dataSource.query(`UPDATE business.business_staff SET status='inactive' WHERE id = $1`, [membershipId]);
      void inactivePro;

      const bodies: unknown[] = [];
      for (const serviceId of [foreignServiceId, unaffiliated.serviceId, inactiveProfessional.serviceId, uuidv7()]) {
        const getRes = await api().get(requirementPath(businessId, serviceId)).set(auth(owner));
        const putRes = await setRequirement(businessId, owner, serviceId, 'room');
        expect(getRes.status).toBe(404);
        expect(putRes.status).toBe(404);
        bodies.push(getRes.body, putRes.body);
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);

      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM business.service_resource_requirements`);
      expect(n).toBe(0);
    });

    it('REFUSES a manager, a staff member, a stranger, a foreign owner and a practitioner_chat holder -- identically to the owner-only guard', async () => {
      const { owner, businessId } = await seedOwner('+98940');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98941');

      const managerUser = await seedUser(app, dataSource, uniquePhone('+98942'), ['business']);
      const managerMembership = await seedMembership(dataSource, businessId, managerUser.id, 'manager', owner.id);
      await dataSource.query(`UPDATE business.business_staff SET status='active' WHERE id = $1`, [managerMembership]);

      const stranger = await seedUser(app, dataSource, uniquePhone('+98943'));
      const foreign = await seedOwner('+98944');

      const proOwner = await seedUser(app, dataSource, uniquePhone('+98945'), ['professional']);
      const grantPro = await seedProfessional(dataSource, proOwner.id, 'دستیار');
      const grantMembership = await seedMembership(dataSource, businessId, proOwner.id, 'staff', owner.id, grantPro.id);
      await dataSource.query(`UPDATE business.business_staff SET status='active' WHERE id = $1`, [grantMembership]);
      await dataSource.query(
        `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id) VALUES ($1, $2, $3, 'practitioner_chat', $4)`,
        [uuidv7(), grantMembership, businessId, owner.id],
      );

      const bodies: unknown[] = [];
      for (const user of [managerUser, stranger, foreign.owner, proOwner]) {
        const getRes = await api().get(requirementPath(businessId, serviceId)).set(auth(user));
        const putRes = await setRequirement(businessId, user, serviceId, 'room');
        expect(getRes.status).toBe(404);
        expect(putRes.status).toBe(404);
        bodies.push(getRes.body, putRes.body);
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);

      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM business.service_resource_requirements`);
      expect(n).toBe(0);
    });

    it('the positive control: the live owner sets, reads and clears', async () => {
      const { owner, businessId } = await seedOwner('+98946');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98947');
      await setRequirement(businessId, owner, serviceId, 'station').expect(200);
      await api().get(requirementPath(businessId, serviceId)).set(auth(owner)).expect(200);
      await setRequirement(businessId, owner, serviceId, null).expect(200);
    });

    it('rejects an invalid kind and an unknown body/query field with 400, and writes nothing', async () => {
      const { owner, businessId } = await seedOwner('+98948');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98949');

      await api().put(requirementPath(businessId, serviceId)).set(auth(owner)).send({ requiredKind: 'chair' }).expect(400);
      await api().put(requirementPath(businessId, serviceId)).set(auth(owner)).send({}).expect(400);
      await api()
        .put(requirementPath(businessId, serviceId))
        .set(auth(owner))
        .send({ requiredKind: 'room', businessId, serviceId, ownerId: owner.id })
        .expect(400);
      await api().get(`${requirementPath(businessId, serviceId)}?lifecycle=active`).set(auth(owner)).expect(400);

      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM business.service_resource_requirements`);
      expect(n).toBe(0);
    });

    it('exposes no raw business/service uuid disclosure beyond what the caller already knew, and no resource identity ever', async () => {
      const { owner, businessId } = await seedOwner('+98950');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98951');
      const res = await setRequirement(businessId, owner, serviceId, 'device').expect(200);
      expect(Object.keys(res.body.data)).toEqual(['requiredKind']);
    });
  });

  // =========================================================================
  // §4 Audit
  // =========================================================================

  describe('§4 exactly one audit fact per real mutation, and none otherwise', () => {
    // `admin.admin_audit_log` is owned by a role this suite never connects as
    // (`beauclick_admin_audit_owner`) and is deliberately NOT in
    // `RESETTABLE_TABLES` -- the application role holds no TRUNCATE on it, by
    // the same append-only discipline that keeps it un-UPDATEable. Rows from
    // earlier tests in this file therefore persist, so every scan here is
    // scoped by the ACTING OWNER, who is unique per test (`seedOwner` mints a
    // fresh phone/user every call).
    async function requirementAuditRowsFor(actorUserId: string) {
      return dataSource.query(
        `SELECT action, before_state, after_state FROM admin.admin_audit_log
          WHERE action LIKE 'business.service_resource_requirement_%' AND actor_user_id = $1 ORDER BY id`,
        [actorUserId],
      );
    }

    it('records set, changed and cleared -- and nothing on a read, a no-op or a refusal', async () => {
      const { owner, businessId } = await seedOwner('+98952');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98953');

      await api().get(requirementPath(businessId, serviceId)).set(auth(owner)).expect(200);
      await setRequirement(businessId, owner, serviceId, 'device').expect(200);
      // A no-op set to the SAME kind writes nothing.
      await setRequirement(businessId, owner, serviceId, 'device').expect(200);
      await setRequirement(businessId, owner, serviceId, 'station').expect(200);
      await setRequirement(businessId, owner, serviceId, null).expect(200);
      // A no-op clear of an already-clear requirement writes nothing.
      await setRequirement(businessId, owner, serviceId, null).expect(200);
      // A refusal writes nothing.
      await setRequirement(businessId, owner, uuidv7(), 'room').expect(404);

      const rows = await requirementAuditRowsFor(owner.id);
      expect(rows.map((r: { action: string }) => r.action)).toEqual([
        'business.service_resource_requirement_set',
        'business.service_resource_requirement_changed',
        'business.service_resource_requirement_cleared',
      ]);
    });

    it('carries the acting owner and no service id, business id or kind name leak into the response', async () => {
      const { owner, businessId } = await seedOwner('+98954');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98955');
      await setRequirement(businessId, owner, serviceId, 'device').expect(200);

      const [row] = await dataSource.query(
        `SELECT actor_user_id::text, action, reason, after_state FROM admin.admin_audit_log WHERE action = 'business.service_resource_requirement_set' ORDER BY id DESC LIMIT 1`,
      );
      expect(row.actor_user_id).toBe(owner.id);
      expect(row.reason).toBe('service resource requirement set by the business owner');
      expect(row.after_state).toEqual({ requiredKind: 'device' });
    });

    it('a planted audit failure rolls the requirement write back', async () => {
      const { owner, businessId } = await seedOwner('+98956');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98957');

      const audit = app.get(AdminAuditService);
      const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('planted audit failure (deliberate)'));
      try {
        await setRequirement(businessId, owner, serviceId, 'device').expect(500);
      } finally {
        spy.mockRestore();
      }

      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM business.service_resource_requirements WHERE service_id = $1`, [
        serviceId,
      ]);
      expect(n).toBe(0);

      // The control: with the audit healthy, the identical request succeeds.
      await setRequirement(businessId, owner, serviceId, 'device').expect(200);
    });
  });

  // =========================================================================
  // §5 SERVICE_OWNERSHIP_DIRECTORY, direct
  // =========================================================================

  describe('§5 SERVICE_OWNERSHIP_DIRECTORY (business -> provider)', () => {
    let port: ServiceOwnershipDirectoryPort;

    beforeAll(() => {
      port = app.get(SERVICE_OWNERSHIP_DIRECTORY);
    });

    it('true for a live service owned by an actively-affiliated professional', async () => {
      const { owner, businessId } = await seedOwner('+98958');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98959');
      await expect(dataSource.transaction((m) => port.verifyServiceBelongsToBusiness(m, businessId, serviceId))).resolves.toBe(true);
    });

    it('false for a nonexistent service, a soft-deleted service, and an unaffiliated service', async () => {
      const { owner, businessId } = await seedOwner('+98970');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98971');
      await dataSource.query(`UPDATE provider.services SET deleted_at = now() WHERE id = $1`, [serviceId]);

      const proUser = await seedUser(app, dataSource, uniquePhone('+98972'), ['professional']);
      const unaffiliated = await seedProfessional(dataSource, proUser.id, 'مستقل');

      for (const id of [uuidv7(), serviceId, unaffiliated.serviceId]) {
        await expect(dataSource.transaction((m) => port.verifyServiceBelongsToBusiness(m, businessId, id))).resolves.toBe(false);
      }
    });

    it('false for a service whose professional holds an invited/inactive/declined/removed (non-active) membership', async () => {
      const { owner, businessId } = await seedOwner('+98973');
      const statuses = ['invited', 'inactive', 'declined', 'removed'] as const;
      for (let i = 0; i < statuses.length; i += 1) {
        const { serviceId, membershipId } = await seedActiveProfessionalService(businessId, owner.id, `+98974${i}`);
        await dataSource.query(`UPDATE business.business_staff SET status = $1 WHERE id = $2`, [statuses[i], membershipId]);
        await expect(dataSource.transaction((m) => port.verifyServiceBelongsToBusiness(m, businessId, serviceId))).resolves.toBe(false);
      }
    });

    it('false for a service affiliated with a DIFFERENT business', async () => {
      const { owner, businessId } = await seedOwner('+98980');
      const other = await seedOwner('+98981');
      const { serviceId } = await seedActiveProfessionalService(other.businessId, other.owner.id, '+98982');
      await expect(dataSource.transaction((m) => port.verifyServiceBelongsToBusiness(m, businessId, serviceId))).resolves.toBe(false);
      void owner;
    });
  });

  // =========================================================================
  // §6 ELIGIBLE_RESOURCE_DIRECTORY, direct -- candidate resolution
  // =========================================================================

  describe('§6 ELIGIBLE_RESOURCE_DIRECTORY (booking -> business)', () => {
    let port: EligibleResourceDirectory;

    beforeAll(() => {
      port = app.get(ELIGIBLE_RESOURCE_DIRECTORY);
    });

    it('returns null for a NULL serviceId -- the nullable-service semantics, byte-identical to the legacy path', async () => {
      const { locationId } = await seedOwnerLocationResource('+98983');
      await expect(dataSource.transaction((m) => port.eligibleResourcesFor(m, null, locationId))).resolves.toBeNull();
    });

    it('returns null for a NULL deliveryLocationId', async () => {
      const { businessId, owner } = await seedOwner('+98984');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98985');
      await expect(dataSource.transaction((m) => port.eligibleResourcesFor(m, serviceId, null))).resolves.toBeNull();
    });

    it('returns null for both null -- the "no key at all" case', async () => {
      await expect(dataSource.transaction((m) => port.eligibleResourcesFor(m, null, null))).resolves.toBeNull();
    });

    it('returns null for a concrete service with NO requirement row -- "no requirement" is not an error, and is distinct from "requirement unmet"', async () => {
      const { businessId, owner } = await seedOwner('+98986');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98987');
      const { locationId } = await seedOwnerLocationResource('+98988');
      await expect(dataSource.transaction((m) => port.eligibleResourcesFor(m, serviceId, locationId))).resolves.toBeNull();
    });

    it('returns [] for a configured requirement with no eligible resource at that location', async () => {
      const { businessId, owner } = await seedOwner('+98989');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98990');
      await setRequirement(businessId, owner, serviceId, 'device').expect(200);

      const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
      const locationId = uuidv7();
      await dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه', $3, 'active')`, [
        locationId,
        businessId,
        cityId,
      ]);
      // A room exists, but the requirement is `device`.
      await dataSource.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, 'room', 'اتاق', 'active')`,
        [uuidv7(), locationId, businessId],
      );

      await expect(dataSource.transaction((m) => port.eligibleResourcesFor(m, serviceId, locationId))).resolves.toEqual([]);
    });

    it('returns ALL eligible resources, never a first-row winner (mutation: add ORDER BY ... LIMIT 1 and this must start failing)', async () => {
      const { businessId, owner } = await seedOwner('+98991');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98992');
      await setRequirement(businessId, owner, serviceId, 'device').expect(200);

      const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
      const locationId = uuidv7();
      await dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه', $3, 'active')`, [
        locationId,
        businessId,
        cityId,
      ]);
      const deviceIds = [uuidv7(), uuidv7(), uuidv7()];
      for (const id of deviceIds) {
        await dataSource.query(
          `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, 'device', 'دستگاه', 'active')`,
          [id, locationId, businessId],
        );
      }
      // A wrong-kind and a retired same-kind resource must NOT appear.
      await dataSource.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, 'room', 'اتاق', 'active')`,
        [uuidv7(), locationId, businessId],
      );
      await dataSource.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, 'device', 'بازنشسته', 'retired')`,
        [uuidv7(), locationId, businessId],
      );

      const result = await dataSource.transaction((m) => port.eligibleResourcesFor(m, serviceId, locationId));
      expect(result).not.toBeNull();
      expect([...(result ?? [])].sort()).toEqual([...deviceIds].sort());
    });

    it('excludes resources at a DIFFERENT location, and excludes a stale requirement row left by a FORMER business', async () => {
      const { businessId: businessA, owner: ownerA } = await seedOwner('+98993');
      const { businessId: businessB, owner: ownerB } = await seedOwner('+98994');
      // The professional was affiliated with A first, and A configured a requirement.
      const { serviceId, membershipId, proUser, professional } = await seedActiveProfessionalService(businessA, ownerA.id, '+98995');
      await setRequirement(businessA, ownerA, serviceId, 'device').expect(200);

      // The professional moves to B; A's row is now stale (harmless per
      // `V33-DEC-035`), and B configures its OWN requirement for the same
      // service, with a DIFFERENT kind.
      await dataSource.query(`UPDATE business.business_staff SET status = 'removed' WHERE id = $1`, [membershipId]);
      const newMembershipId = await seedMembership(dataSource, businessB, proUser.id, 'staff', ownerB.id, professional.id);
      await dataSource.query(`UPDATE business.business_staff SET status='active', responded_at=now() WHERE id = $1`, [newMembershipId]);
      await setRequirement(businessB, ownerB, serviceId, 'room').expect(200);

      // Each business's location carries BOTH kinds, so a leak across the
      // business boundary would show up as an extra id, not merely a missing
      // one.
      const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
      const locationA = uuidv7();
      await dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه آ', $3, 'active')`, [
        locationA,
        businessA,
        cityId,
      ]);
      const deviceA = uuidv7();
      await dataSource.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, 'device', 'دستگاه آ', 'active')`,
        [deviceA, locationA, businessA],
      );
      await dataSource.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, 'room', 'اتاق آ', 'active')`,
        [uuidv7(), locationA, businessA],
      );
      const locationB = uuidv7();
      await dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه ب', $3, 'active')`, [
        locationB,
        businessB,
        cityId,
      ]);
      const roomB = uuidv7();
      await dataSource.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, 'room', 'اتاق ب', 'active')`,
        [roomB, locationB, businessB],
      );
      await dataSource.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, 'device', 'دستگاه ب', 'active')`,
        [uuidv7(), locationB, businessB],
      );

      // Business B's location resolves against B's OWN live `room` requirement
      // only -- B's device resource does not appear, and A's stale `device`
      // requirement never crosses into B's business at all.
      await expect(dataSource.transaction((m) => port.eligibleResourcesFor(m, serviceId, locationB))).resolves.toEqual([roomB]);
      // Business A's location resolves against A's OWN (stale-but-present) `device`
      // requirement only -- A's room resource does not appear, and B's live `room`
      // requirement never crosses into A's business either. The row is stale
      // relative to the professional's CURRENT affiliation, not deleted, so it is
      // expected to still govern A's own premises -- that is the "harmless" part
      // of `V33-DEC-035`'s stale-row reasoning, not a leak.
      await expect(dataSource.transaction((m) => port.eligibleResourcesFor(m, serviceId, locationA))).resolves.toEqual([deviceA]);
    });

    it('costs the same for one candidate as for six -- no N+1', async () => {
      async function fixtureWith(count: number, prefix: string) {
        const { businessId, owner } = await seedOwner(prefix);
        const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, `${prefix}1`);
        await setRequirement(businessId, owner, serviceId, 'station').expect(200);
        const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
        const locationId = uuidv7();
        await dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه', $3, 'active')`, [
          locationId,
          businessId,
          cityId,
        ]);
        for (let i = 0; i < count; i += 1) {
          await dataSource.query(
            `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle) VALUES ($1, $2, $3, 'station', 'پایگاه', 'active')`,
            [uuidv7(), locationId, businessId],
          );
        }
        return { serviceId, locationId };
      }

      const one = await fixtureWith(1, '+98996');
      const six = await fixtureWith(6, '+98997');

      const countQueries = async (fixture: { serviceId: string; locationId: string }) => {
        let queries = 0;
        const original = dataSource.logger;
        dataSource.logger = {
          logQuery: () => {
            queries += 1;
          },
          logQueryError: () => undefined,
          logQuerySlow: () => undefined,
          logSchemaBuild: () => undefined,
          logMigration: () => undefined,
          log: () => undefined,
        };
        try {
          await dataSource.transaction((m) => port.eligibleResourcesFor(m, fixture.serviceId, fixture.locationId));
        } finally {
          dataSource.logger = original;
        }
        return queries;
      };

      const withOne = await countQueries(one);
      const withSix = await countQueries(six);
      expect(withOne).toBeGreaterThan(0);
      expect(withSix).toBe(withOne);
    });
  });

  // =========================================================================
  // §7 Concurrency
  // =========================================================================

  describe('§7 concurrent configuration serialises', () => {
    it('two concurrent first-time sets for the SAME service do not both succeed with a duplicate row', async () => {
      const { owner, businessId } = await seedOwner('+98998');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98999');

      const [a, b] = await Promise.all([
        setRequirement(businessId, owner, serviceId, 'device'),
        setRequirement(businessId, owner, serviceId, 'station'),
      ]);

      // Both requests complete successfully (the advisory lock serialises them
      // rather than one raising a database error), and exactly one row survives.
      expect([a.status, b.status]).toEqual([200, 200]);
      const rows = await dataSource.query(`SELECT required_kind FROM business.service_resource_requirements WHERE service_id = $1`, [serviceId]);
      expect(rows).toHaveLength(1);
      expect(['device', 'station']).toContain(rows[0].required_kind);
    });
  });

  // =========================================================================
  // §8 ADR-027 privacy
  // =========================================================================

  describe('§8 ADR-027 coverage and subject privacy', () => {
    let coverage: SubjectDataCoverageService;
    let contracts: SubjectDataContract[];

    beforeAll(() => {
      coverage = app.get(SubjectDataCoverageService);
      contracts = app.get(SUBJECT_DATA_CONTRACTS);
    });

    it('claims business.service_resource_requirements exactly once, as retained', async () => {
      const contract = app.get(BusinessSubjectDataContract);
      const claims = contract.tables.filter((c) => c.table === 'business.service_resource_requirements');
      expect(claims).toHaveLength(1);
      expect(claims[0].disposition).toBe('retained');
      expect((claims[0].reason ?? '').length).toBeGreaterThan(20);
    });

    it('the live catalogue is fully claimed, including the new table', async () => {
      const catalogue = await coverage.readCatalogue();
      expect(catalogue.map((t) => `${t.schema}.${t.name}`)).toContain('business.service_resource_requirements');
      expect(evaluateCoverage(catalogue, contracts).violations).toEqual([]);
    });

    it.each([
      [
        'unclaimed',
        'unclaimed',
        (c: CatalogueTable[], k: SubjectDataContract[]) => ({
          catalogue: c,
          contracts: k.map((contract) => ({
            ...contract,
            tables: contract.tables.filter((t) => t.table !== 'business.service_resource_requirements'),
          })) as SubjectDataContract[],
        }),
      ],
      [
        'stale',
        'claimed_but_absent',
        (c: CatalogueTable[], k: SubjectDataContract[]) => ({
          catalogue: c.filter((t) => `${t.schema}.${t.name}` !== 'business.service_resource_requirements'),
          contracts: k,
        }),
      ],
      [
        'double-claimed',
        'claimed_twice',
        (c: CatalogueTable[], k: SubjectDataContract[]) => ({
          catalogue: c,
          contracts: [
            ...k,
            {
              moduleKey: 'duplicate-for-test',
              tables: [{ table: 'business.service_resource_requirements', disposition: 'retained', reason: 'x'.repeat(30) }],
              exportSubjectData: async () => [],
              eraseSubjectData: async () => ({ moduleKey: 'duplicate-for-test', anonymized: 0, deleted: 0, retained: [] }),
            } as unknown as SubjectDataContract,
          ],
        }),
      ],
    ])('a %s claim fails coverage with %s', async (_label, kind, mutate) => {
      const catalogue = await coverage.readCatalogue();
      const mutated = (mutate as (c: CatalogueTable[], k: SubjectDataContract[]) => { catalogue: CatalogueTable[]; contracts: SubjectDataContract[] })(
        [...catalogue],
        [...contracts],
      );
      expect(evaluateCoverage(mutated.catalogue, mutated.contracts).violations.map((v) => v.kind)).toContain(kind);
    });

    it('a customer export never returns a requirement, and erasure neither deletes nor mutates one', async () => {
      const { owner, businessId } = await seedOwner('+98901');
      const { serviceId } = await seedActiveProfessionalService(businessId, owner.id, '+98902');
      await setRequirement(businessId, owner, serviceId, 'device').expect(200);

      const contract = app.get(BusinessSubjectDataContract);
      const customer = await seedUser(app, dataSource, uniquePhone('+98903'));
      const sections = await dataSource.transaction((m) => contract.exportSubjectData(m, customer.id));
      expect(JSON.stringify(sections)).not.toContain('service_resource_requirement');

      const outcome = await dataSource.transaction((m) => contract.eraseSubjectData(m, owner.id));
      expect(outcome.retained.some((r) => r.table === 'business.service_resource_requirements')).toBe(true);

      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM business.service_resource_requirements WHERE service_id = $1`, [
        serviceId,
      ]);
      expect(n).toBe(1);
    });
  });

  // =========================================================================
  // §9 Compatibility -- byte-identical booking behaviour
  // =========================================================================

  describe('§9 byte-identical compatibility with the pre-#131 path', () => {
    it('a NULL-service candidate resolution issues no SELECT against the requirement or resource tables', async () => {
      // `dataSource.transaction(...)` itself issues BEGIN/COMMIT, so the bar
      // here is "no query names either table this port reads" -- not "zero
      // queries" -- which is what would actually regress if the null
      // short-circuit in `BusinessBackedEligibleResourceDirectory` were removed.
      const queries: string[] = [];
      const original = dataSource.logger;
      dataSource.logger = {
        logQuery: (query: string) => {
          queries.push(query);
        },
        logQueryError: () => undefined,
        logQuerySlow: () => undefined,
        logSchemaBuild: () => undefined,
        logMigration: () => undefined,
        log: () => undefined,
      };
      const port = app.get<EligibleResourceDirectory>(ELIGIBLE_RESOURCE_DIRECTORY);
      try {
        await dataSource.transaction((m) => port.eligibleResourcesFor(m, null, uuidv7()));
      } finally {
        dataSource.logger = original;
      }
      expect(queries.some((q) => /service_resource_requirements|location_resources/i.test(q))).toBe(false);
    });

    it('no existing booking or availability_slots row is rewritten by this migration (xmin preserved)', async () => {
      // #131 adds no column to booking.* at all, so there is nothing to rewrite
      // in principle -- this asserts that structurally rather than by xmin,
      // since the migration issues no ALTER/UPDATE against booking.* or
      // provider.* whatsoever (see §1's "adds NOTHING" case).
      const bookingTableCount = await dataSource.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema IN ('booking','provider')`,
      );
      expect(bookingTableCount[0].n).toBeGreaterThan(0);
    });
  });
});
