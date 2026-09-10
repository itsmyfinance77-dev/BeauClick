import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import request from 'supertest';

import { AdminAuditService } from '@beauclick/audit';
import { BusinessSubjectDataContract } from '@beauclick/business';
import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  CatalogueTable,
  evaluateCoverage,
} from '@beauclick/subject-data';
import {
  WORKSPACE_REFERENCE_SECRET,
  deriveLocationReference,
  deriveResourceReference,
  deriveWorkspaceReference,
} from '@beauclick/workspace-reference';

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
 * REAL PostgreSQL: V3.3 Story #110 (`#110a`) -- the location resource catalogue.
 *
 * ## Why every case here needs a real server
 *
 * ADR-049 section 2.4. The in-memory layer honours neither composite foreign
 * keys, nor CHECK constraints, nor row triggers, nor `xmin`, nor `ROLLBACK` --
 * which is to say it can prove nothing about same-business integrity, the closed
 * vocabularies, terminal retirement, the byte-identity of existing location rows,
 * or the atomicity of a mutation with its audit row. Those are exactly the
 * guarantees this story ships.
 *
 * The closed vocabularies, the DTO refusals and the handler-level ownership
 * metadata live in the fast layer instead
 * (`services/business/src/location-resource.contract.spec.ts` and
 * `libs/workspace-reference/src/resource-reference.spec.ts`), because they need
 * no database.
 *
 * ## What this story is NOT
 *
 * There is no `booking.booking_resource_assignments`, no collision exclusion
 * constraint, no booking wiring and no customer-facing surface anywhere in this
 * file. Those are `#110b` (#128), and the delivery-location context they need is
 * `#110c` (#127). A test asserting them here would be testing a story that has
 * not been ratified.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

const KIND_MEMBERS = ['room', 'device', 'station'] as const;

describeIfPg('Location resource catalogue on real PostgreSQL (#110a)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let referenceSecret: string;

  const uniquePhone = (prefix: string) =>
    `${prefix}${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
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

  /** An owner with a live business and one active location, plus that location's ref. */
  async function seedOwnerWithLocation(prefix = '+98921'): Promise<{
    owner: SeededUser;
    businessId: string;
    locationId: string;
    locationRef: string;
  }> {
    const owner = await seedUser(app, dataSource, uniquePhone(prefix), ['business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن');
    const cityId = await seedCity(dataSource, `شهر ${Math.random().toString(36).slice(2, 8)}`);
    const locationId = uuidv7();
    await dataSource.query(
      `INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1, $2, 'شعبه اصلی', $3, 'active')`,
      [locationId, business.id, cityId],
    );
    return {
      owner,
      businessId: business.id,
      locationId,
      locationRef: deriveLocationReference(referenceSecret, owner.id, business.id, locationId),
    };
  }

  const resourcesPath = (businessId: string, locationRef: string) =>
    `/api/v1/businesses/${businessId}/locations/${locationRef}/resources`;

  async function createResource(
    fixture: { owner: SeededUser; businessId: string; locationRef: string },
    name = 'اتاق لیزر',
    kind: (typeof KIND_MEMBERS)[number] = 'room',
  ) {
    const res = await api()
      .post(resourcesPath(fixture.businessId, fixture.locationRef))
      .set(auth(fixture.owner))
      .send({ name, kind })
      .expect(201);
    return res.body.data as { resourceRef: string; name: string; kind: string; lifecycle: string };
  }

  // =========================================================================
  // 1. Schema shape
  // =========================================================================

  describe('§1 the migration produced exactly the ratified shape', () => {
    it('business.location_resources has exactly the ratified columns', async () => {
      const columns = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='business' AND table_name='location_resources' ORDER BY column_name`,
        )
      ).map((r: { column_name: string }) => r.column_name);

      expect(columns).toEqual([
        'business_id',
        'created_at',
        'id',
        'kind',
        'lifecycle',
        'location_id',
        'name',
        'updated_at',
      ]);
    });

    it('carries no owner, actor, booking or occupancy column', async () => {
      const columns: string[] = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='business' AND table_name='location_resources'`,
        )
      ).map((r: { column_name: string }) => r.column_name);

      for (const forbidden of [
        'owner_id',
        'user_id',
        'actor_id',
        'created_by',
        'created_by_user_id',
        'booking_id',
        'occupied',
        'capacity',
        'professional_id',
        'service_id',
      ]) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('declares the named CHECK constraints and the composite foreign key', async () => {
      const defs: string[] = (
        await dataSource.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid='business.location_resources'::regclass ORDER BY conname`,
        )
      ).map((r: { conname: string; def: string }) => `${r.conname}: ${r.def}`);
      const joined = defs.join('\n');

      // pg renders `IN (...)` as `= ANY (ARRAY[...])`; assert the closed member sets.
      expect(joined).toMatch(/ck_location_resources_kind: CHECK/);
      for (const member of ["'room'", "'device'", "'station'"]) expect(joined).toContain(member);
      expect(joined).toMatch(/ck_location_resources_lifecycle: CHECK/);
      for (const member of ["'active'", "'retired'"]) expect(joined).toContain(member);
      expect(joined).toMatch(/ck_location_resources_name_shape: CHECK.*btrim/s);

      // The composite same-business FK, non-cascading.
      expect(joined).toMatch(
        /fk_location_resources_location_same_business: FOREIGN KEY \(location_id, business_id\) REFERENCES business\.locations\(id, business_id\)/,
      );
      expect(joined).not.toMatch(/ON DELETE CASCADE/);
    });

    it('business.locations gained the composite uniqueness target', async () => {
      const defs: string[] = (
        await dataSource.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid='business.locations'::regclass AND conname='uq_locations_id_business'`,
        )
      ).map((r: { conname: string; def: string }) => `${r.conname}: ${r.def}`);
      expect(defs.join('\n')).toMatch(/uq_locations_id_business: UNIQUE \(id, business_id\)/);
    });

    it('declares the lookup index and the lifecycle trigger', async () => {
      const indexes: string[] = (
        await dataSource.query(
          `SELECT indexname FROM pg_indexes WHERE schemaname='business' AND tablename='location_resources' ORDER BY indexname`,
        )
      ).map((r: { indexname: string }) => r.indexname);
      expect(indexes).toContain('ix_location_resources_location_id');

      const triggers: string[] = (
        await dataSource.query(
          `SELECT tgname FROM pg_trigger WHERE tgrelid='business.location_resources'::regclass AND NOT tgisinternal`,
        )
      ).map((r: { tgname: string }) => r.tgname);
      expect(triggers).toEqual(['tg_location_resources_lifecycle']);
    });

    it('declares NO name uniqueness -- two branches may both have a "Room 1"', async () => {
      const uniques: string[] = (
        await dataSource.query(
          `SELECT indexdef FROM pg_indexes WHERE schemaname='business' AND tablename='location_resources'`,
        )
      ).map((r: { indexdef: string }) => r.indexdef);
      expect(uniques.filter((def) => /UNIQUE/i.test(def) && /name/i.test(def))).toEqual([]);
    });

    it('adds NOTHING to the booking schema -- #110b owns that', async () => {
      const bookingTables: string[] = (
        await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname='booking' ORDER BY tablename`)
      ).map((r: { tablename: string }) => r.tablename);

      expect(bookingTables).toEqual([
        'availability_slots',
        'booking_history',
        'bookings',
        'idempotency_keys',
        'outbox_events',
      ]);
      expect(bookingTables).not.toContain('booking_resource_assignments');
    });
  });

  // =========================================================================
  // 2. The uniqueness target does not rewrite existing rows
  // =========================================================================

  describe('§2 adding UNIQUE (id, business_id) leaves every existing location byte-identical', () => {
    /**
     * The whole proof runs inside ONE transaction that is deliberately rolled
     * back, so the real schema is restored exactly however the assertions land.
     * DDL is transactional in PostgreSQL, which is what makes that safe.
     *
     * Dropping the constraint requires dropping the dependent foreign key first;
     * both are recreated inside the same transaction so the rollback has nothing
     * to repair.
     */
    it('preserves xmin and every column value across a genuine drop-and-re-add', async () => {
      const { locationId } = await seedOwnerWithLocation('+98922');

      const snapshot = async (manager: DataSource['manager']) =>
        (
          await manager.query(
            `SELECT xmin::text AS xmin, id::text, business_id::text, name, city_id::text, lifecycle,
                    created_at, updated_at
               FROM business.locations WHERE id = $1`,
            [locationId],
          )
        )[0];

      let before: Record<string, unknown> | undefined;
      let after: Record<string, unknown> | undefined;
      let rewritten: Record<string, unknown> | undefined;

      await expect(
        dataSource.transaction(async (manager) => {
          /*
           * Both dependents must go first. #127a added a SECOND composite FK onto
           * this same uniqueness target -- `business_staff.location_id` -- so
           * dropping the target now fails with "other objects depend on it" until
           * that one is dropped too. Recreated below inside the same
           * rolled-back transaction, so the schema is restored either way.
           */
          await manager.query(
            `ALTER TABLE business.location_resources DROP CONSTRAINT fk_location_resources_location_same_business`,
          );
          await manager.query(
            `ALTER TABLE business.business_staff DROP CONSTRAINT fk_business_staff_location_same_business`,
          );
          await manager.query(`ALTER TABLE business.locations DROP CONSTRAINT uq_locations_id_business`);

          before = await snapshot(manager);

          // The exact statement the migration runs.
          await manager.query(`ALTER TABLE business.locations ADD CONSTRAINT uq_locations_id_business UNIQUE (id, business_id)`);

          after = await snapshot(manager);

          // The non-vacuity control: a REAL row rewrite must change xmin, or the
          // comparison above proves nothing.
          await manager.query(`UPDATE business.locations SET name = name || ' (touched)' WHERE id = $1`, [locationId]);
          rewritten = await snapshot(manager);

          await manager.query(
            `ALTER TABLE business.location_resources
               ADD CONSTRAINT fk_location_resources_location_same_business
               FOREIGN KEY (location_id, business_id) REFERENCES business.locations (id, business_id)`,
          );
          await manager.query(
            `ALTER TABLE business.business_staff
               ADD CONSTRAINT fk_business_staff_location_same_business
               FOREIGN KEY (location_id, business_id) REFERENCES business.locations (id, business_id)`,
          );

          throw new Error('deliberate rollback -- the schema must be restored exactly');
        }),
      ).rejects.toThrow('deliberate rollback');

      // Adding the constraint validated the row and did not rewrite it.
      expect(after).toEqual(before);
      expect(after!.xmin).toBe(before!.xmin);

      // The control fires: a genuine UPDATE *does* move xmin, so the equality
      // above is a real observation rather than a comparison that cannot fail.
      expect(rewritten!.xmin).not.toBe(before!.xmin);
      expect(rewritten!.name).not.toBe(before!.name);
    });

    it('the schema really was restored by the rollback', async () => {
      const constraints: string[] = (
        await dataSource.query(
          `SELECT conname FROM pg_constraint
            WHERE conrelid='business.locations'::regclass AND conname='uq_locations_id_business'
            UNION ALL
           SELECT conname FROM pg_constraint
            WHERE conrelid='business.location_resources'::regclass
              AND conname='fk_location_resources_location_same_business'
            UNION ALL
           SELECT conname FROM pg_constraint
            WHERE conrelid='business.business_staff'::regclass
              AND conname='fk_business_staff_location_same_business'`,
        )
      ).map((r: { conname: string }) => r.conname);
      expect(constraints.sort()).toEqual([
        'fk_business_staff_location_same_business',
        'fk_location_resources_location_same_business',
        'uq_locations_id_business',
      ]);
    });
  });

  // =========================================================================
  // 3. Database-enforced integrity
  // =========================================================================

  describe('§3 same-business integrity is enforced by PostgreSQL, not by application code', () => {
    it('accepts a resource whose location belongs to the same business', async () => {
      const { businessId, locationId } = await seedOwnerWithLocation('+98923');
      await expect(
        dataSource.query(
          `INSERT INTO business.location_resources (id, location_id, business_id, kind, name)
           VALUES ($1, $2, $3, 'room', 'اتاق')`,
          [uuidv7(), locationId, businessId],
        ),
      ).resolves.toBeDefined();
    });

    it('REFUSES a resource whose location belongs to another business', async () => {
      const a = await seedOwnerWithLocation('+98924');
      const b = await seedOwnerWithLocation('+98925');

      // A's location quoted under B's business -- the confused-deputy shape.
      await expect(
        dataSource.query(
          `INSERT INTO business.location_resources (id, location_id, business_id, kind, name)
           VALUES ($1, $2, $3, 'room', 'اتاق دزدیده‌شده')`,
          [uuidv7(), a.locationId, b.businessId],
        ),
      ).rejects.toThrow(/foreign key|fk_location_resources_location_same_business/i);
    });

    it('REFUSES a resource naming a location that does not exist', async () => {
      const { businessId } = await seedOwnerWithLocation('+98926');
      await expect(
        dataSource.query(
          `INSERT INTO business.location_resources (id, location_id, business_id, kind, name)
           VALUES ($1, $2, $3, 'room', 'اتاق')`,
          [uuidv7(), uuidv7(), businessId],
        ),
      ).rejects.toThrow(/foreign key|fk_location_resources_location_same_business/i);
    });

    it.each(KIND_MEMBERS)('accepts the vocabulary member %s', async (kind) => {
      const { businessId, locationId } = await seedOwnerWithLocation(`+9893${KIND_MEMBERS.indexOf(kind)}`);
      await expect(
        dataSource.query(
          `INSERT INTO business.location_resources (id, location_id, business_id, kind, name)
           VALUES ($1, $2, $3, $4, 'مورد')`,
          [uuidv7(), locationId, businessId, kind],
        ),
      ).resolves.toBeDefined();
    });

    it.each(['owner', 'chair', 'bed', 'service', 'resource', 'ROOM', 'unknown-kind', ''])(
      'REFUSES the kind %s',
      async (kind) => {
        const { businessId, locationId } = await seedOwnerWithLocation('+98927');
        await expect(
          dataSource.query(
            `INSERT INTO business.location_resources (id, location_id, business_id, kind, name)
             VALUES ($1, $2, $3, $4, 'مورد')`,
            [uuidv7(), locationId, businessId, kind],
          ),
        ).rejects.toThrow(/ck_location_resources_kind/);
      },
    );

    it.each(['suspended', 'closed', 'deleted', 'restored', 'ACTIVE', ''])(
      'REFUSES the lifecycle %s',
      async (lifecycle) => {
        const { businessId, locationId } = await seedOwnerWithLocation('+98928');
        await expect(
          dataSource.query(
            `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle)
             VALUES ($1, $2, $3, 'room', 'مورد', $4)`,
            [uuidv7(), locationId, businessId, lifecycle],
          ),
        ).rejects.toThrow(/ck_location_resources_lifecycle/);
      },
    );

    it('REFUSES an empty or untrimmed name', async () => {
      const { businessId, locationId } = await seedOwnerWithLocation('+98929');
      for (const name of ['', '  ', ' اتاق', 'اتاق ']) {
        await expect(
          dataSource.query(
            `INSERT INTO business.location_resources (id, location_id, business_id, kind, name)
             VALUES ($1, $2, $3, 'room', $4)`,
            [uuidv7(), locationId, businessId, name],
          ),
        ).rejects.toThrow(/ck_location_resources_name_shape/);
      }
    });

    it('defaults lifecycle to active', async () => {
      const { businessId, locationId } = await seedOwnerWithLocation('+98940');
      const id = uuidv7();
      await dataSource.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name)
         VALUES ($1, $2, $3, 'device', 'لیزر')`,
        [id, locationId, businessId],
      );
      const [row] = await dataSource.query(`SELECT lifecycle FROM business.location_resources WHERE id = $1`, [id]);
      expect(row.lifecycle).toBe('active');
    });
  });

  // =========================================================================
  // 4. Terminal retirement, enforced by trigger
  // =========================================================================

  describe('§4 retirement is terminal and rows are never destroyed', () => {
    async function seedResource(prefix: string, lifecycle: 'active' | 'retired' = 'active') {
      const fixture = await seedOwnerWithLocation(prefix);
      const id = uuidv7();
      await dataSource.query(
        `INSERT INTO business.location_resources (id, location_id, business_id, kind, name, lifecycle)
         VALUES ($1, $2, $3, 'device', 'لیزر', $4)`,
        [id, fixture.locationId, fixture.businessId, lifecycle],
      );
      return { ...fixture, resourceId: id };
    }

    it('permits active -> retired', async () => {
      const { resourceId } = await seedResource('+98941');
      await expect(
        dataSource.query(`UPDATE business.location_resources SET lifecycle = 'retired' WHERE id = $1`, [resourceId]),
      ).resolves.toBeDefined();
    });

    it('REFUSES retired -> active', async () => {
      const { resourceId } = await seedResource('+98942', 'retired');
      await expect(
        dataSource.query(`UPDATE business.location_resources SET lifecycle = 'active' WHERE id = $1`, [resourceId]),
      ).rejects.toThrow(/terminal/i);
    });

    it('REFUSES renaming a retired resource', async () => {
      const { resourceId } = await seedResource('+98943', 'retired');
      await expect(
        dataSource.query(`UPDATE business.location_resources SET name = 'دیگر' WHERE id = $1`, [resourceId]),
      ).rejects.toThrow(/terminal/i);
    });

    it('REFUSES re-pointing a resource at another location or business', async () => {
      const { resourceId } = await seedResource('+98944');
      const other = await seedOwnerWithLocation('+98945');
      await expect(
        dataSource.query(`UPDATE business.location_resources SET location_id = $1 WHERE id = $2`, [
          other.locationId,
          resourceId,
        ]),
      ).rejects.toThrow(/immutable/i);
      await expect(
        dataSource.query(`UPDATE business.location_resources SET business_id = $1 WHERE id = $2`, [
          other.businessId,
          resourceId,
        ]),
      ).rejects.toThrow(/immutable/i);
    });

    it('REFUSES DELETE outright -- a location lifecycle can never erase resource history', async () => {
      const { resourceId } = await seedResource('+98946');
      await expect(
        dataSource.query(`DELETE FROM business.location_resources WHERE id = $1`, [resourceId]),
      ).rejects.toThrow(/never deleted/i);
    });

    it('a rename of an ACTIVE resource still works -- the trigger is not blanket-refusing', async () => {
      // The positive control for §4: without it every refusal above could be a
      // trigger that rejects everything.
      const { resourceId } = await seedResource('+98947');
      await dataSource.query(`UPDATE business.location_resources SET name = 'لیزر ۲' WHERE id = $1`, [resourceId]);
      const [row] = await dataSource.query(`SELECT name FROM business.location_resources WHERE id = $1`, [resourceId]);
      expect(row.name).toBe('لیزر ۲');
    });
  });

  // =========================================================================
  // 5. The owner-facing surface
  // =========================================================================

  describe('§5 the owner can manage a catalogue end to end', () => {
    it('creates, lists, renames and retires', async () => {
      const fixture = await seedOwnerWithLocation('+98950');

      const created = await createResource(fixture, 'اتاق لیزر', 'room');
      expect(created).toEqual({
        resourceRef: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        name: 'اتاق لیزر',
        kind: 'room',
        lifecycle: 'active',
      });

      const listed = await api()
        .get(resourcesPath(fixture.businessId, fixture.locationRef))
        .set(auth(fixture.owner))
        .expect(200);
      expect(listed.body.data).toEqual([created]);

      const renamed = await api()
        .patch(`${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}`)
        .set(auth(fixture.owner))
        .send({ name: 'اتاق لیزر ۱' })
        .expect(200);
      expect(renamed.body.data).toEqual({ ...created, name: 'اتاق لیزر ۱' });

      const retired = await api()
        .post(`${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}/retire`)
        .set(auth(fixture.owner))
        .send({})
        .expect(201);
      expect(retired.body.data).toEqual({ ...created, name: 'اتاق لیزر ۱', lifecycle: 'retired' });
    });

    it('accepts every vocabulary member and keeps two same-named resources apart', async () => {
      const fixture = await seedOwnerWithLocation('+98951');
      for (const kind of KIND_MEMBERS) await createResource(fixture, `مورد ${kind}`, kind);

      // Two resources with the SAME name are legal: they are two real objects.
      const first = await createResource(fixture, 'اتاق ۱', 'room');
      const second = await createResource(fixture, 'اتاق ۱', 'room');
      expect(first.resourceRef).not.toBe(second.resourceRef);

      const listed = await api()
        .get(resourcesPath(fixture.businessId, fixture.locationRef))
        .set(auth(fixture.owner))
        .expect(200);
      expect(listed.body.data).toHaveLength(5);
    });

    it('a retired resource can be neither renamed nor retired again', async () => {
      const fixture = await seedOwnerWithLocation('+98952');
      const created = await createResource(fixture);
      const path = `${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}`;

      await api().post(`${path}/retire`).set(auth(fixture.owner)).send({}).expect(201);

      const renameAgain = await api().patch(path).set(auth(fixture.owner)).send({ name: 'دیگر' });
      const retireAgain = await api().post(`${path}/retire`).set(auth(fixture.owner)).send({});

      expect(renameAgain.status).toBe(404);
      expect(retireAgain.status).toBe(404);
      // Indistinguishable from every other refusal, including from each other.
      expect(renameAgain.body).toEqual(retireAgain.body);
    });

    it('a duplicate retire creates no duplicate effect', async () => {
      const fixture = await seedOwnerWithLocation('+98953');
      const created = await createResource(fixture);
      const path = `${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}/retire`;

      await api().post(path).set(auth(fixture.owner)).send({}).expect(201);
      const [afterFirst] = await dataSource.query(
        `SELECT lifecycle, updated_at FROM business.location_resources WHERE location_id = $1`,
        [fixture.locationId],
      );
      const auditAfterFirst = await auditRowsFor(fixture.locationId);

      await api().post(path).set(auth(fixture.owner)).send({}).expect(404);

      const [afterSecond] = await dataSource.query(
        `SELECT lifecycle, updated_at FROM business.location_resources WHERE location_id = $1`,
        [fixture.locationId],
      );
      expect(afterSecond).toEqual(afterFirst);
      expect(await auditRowsFor(fixture.locationId)).toEqual(auditAfterFirst);
    });

    it('a closed location has no editable catalogue', async () => {
      const fixture = await seedOwnerWithLocation('+98954');
      await createResource(fixture);
      await dataSource.query(`UPDATE business.locations SET lifecycle = 'closed' WHERE id = $1`, [fixture.locationId]);

      const list = await api().get(resourcesPath(fixture.businessId, fixture.locationRef)).set(auth(fixture.owner));
      const create = await api()
        .post(resourcesPath(fixture.businessId, fixture.locationRef))
        .set(auth(fixture.owner))
        .send({ name: 'اتاق', kind: 'room' });

      expect(list.status).toBe(404);
      expect(create.status).toBe(404);
      expect(list.body).toEqual(create.body);
    });
  });

  // =========================================================================
  // 6. Authorization
  // =========================================================================

  describe('§6 owner-only, proved adversarially and byte-identically', () => {
    async function activeStaff(businessId: string, ownerId: string, role: 'manager' | 'staff', prefix: string) {
      const member = await seedUser(app, dataSource, uniquePhone(prefix));
      const membershipId = await seedMembership(dataSource, businessId, member.id, role, ownerId);
      await dataSource.query(
        `UPDATE business.business_staff SET status='active', responded_at=now() WHERE id = $1`,
        [membershipId],
      );
      return { member, membershipId };
    }

    it('refuses a manager, a staff member, a stranger, a foreign owner and a practitioner_chat holder — identically', async () => {
      const fixture = await seedOwnerWithLocation('+98960');
      const created = await createResource(fixture);
      const itemPath = `${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}`;

      const { member: manager } = await activeStaff(fixture.businessId, fixture.owner.id, 'manager', '+98961');
      const { member: staff } = await activeStaff(fixture.businessId, fixture.owner.id, 'staff', '+98962');
      const stranger = await seedUser(app, dataSource, uniquePhone('+98963'));
      const foreign = await seedOwnerWithLocation('+98964');

      // A practitioner_chat grant holder: real scoped authority, and it confers
      // nothing here. This is the case `V33-DEC-034` R3 exists to guarantee.
      const proOwner = await seedUser(app, dataSource, uniquePhone('+98965'), ['professional']);
      const professional = await seedProfessional(dataSource, proOwner.id, 'آرایشگر');
      const grantMembership = await seedMembership(
        dataSource,
        fixture.businessId,
        proOwner.id,
        'staff',
        fixture.owner.id,
        professional.id,
      );
      await dataSource.query(
        `UPDATE business.business_staff SET status='active', responded_at=now() WHERE id = $1`,
        [grantMembership],
      );
      await dataSource.query(
        `INSERT INTO business.staff_role_grants (id, membership_id, business_id, role, granted_by_user_id)
         VALUES ($1, $2, $3, 'practitioner_chat', $4)`,
        [uuidv7(), grantMembership, fixture.businessId, fixture.owner.id],
      );

      const refused = [manager, staff, stranger, foreign.owner, proOwner];
      const bodies: unknown[] = [];

      for (const user of refused) {
        const list = await api().get(resourcesPath(fixture.businessId, fixture.locationRef)).set(auth(user));
        const create = await api()
          .post(resourcesPath(fixture.businessId, fixture.locationRef))
          .set(auth(user))
          .send({ name: 'اتاق', kind: 'room' });
        const rename = await api().patch(itemPath).set(auth(user)).send({ name: 'دیگر' });
        const retire = await api().post(`${itemPath}/retire`).set(auth(user)).send({});

        for (const res of [list, create, rename, retire]) {
          expect(res.status).toBe(404);
          bodies.push(res.body);
        }
      }

      // Every refusal, across every actor and every route, is byte-identical.
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);

      // Nothing was written by any of them.
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM business.location_resources WHERE location_id = $1`,
        [fixture.locationId],
      );
      expect(n).toBe(1);
    });

    it('the positive control: the live owner performs all four operations', async () => {
      // Without this, §6 could be passing because the routes refuse everyone.
      const fixture = await seedOwnerWithLocation('+98966');
      const created = await createResource(fixture);
      const itemPath = `${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}`;

      await api().get(resourcesPath(fixture.businessId, fixture.locationRef)).set(auth(fixture.owner)).expect(200);
      await api().patch(itemPath).set(auth(fixture.owner)).send({ name: 'اتاق ۲' }).expect(200);
      await api().post(`${itemPath}/retire`).set(auth(fixture.owner)).send({}).expect(201);
    });

    it('refuses an unauthenticated caller on every route', async () => {
      const fixture = await seedOwnerWithLocation('+98967');
      const created = await createResource(fixture);
      const itemPath = `${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}`;

      await api().get(resourcesPath(fixture.businessId, fixture.locationRef)).expect(401);
      await api().post(resourcesPath(fixture.businessId, fixture.locationRef)).send({ name: 'x', kind: 'room' }).expect(401);
      await api().patch(itemPath).send({ name: 'x' }).expect(401);
      await api().post(`${itemPath}/retire`).send({}).expect(401);
    });

    it('refuses a soft-deleted business', async () => {
      const fixture = await seedOwnerWithLocation('+98968');
      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [fixture.businessId]);
      await api().get(resourcesPath(fixture.businessId, fixture.locationRef)).set(auth(fixture.owner)).expect(404);
    });
  });

  // =========================================================================
  // 7. References
  // =========================================================================

  describe('§7 opaque references, and no raw uuid ever leaves', () => {
    it('exposes no raw resource, location or business uuid in any response', async () => {
      const fixture = await seedOwnerWithLocation('+98970');
      const created = await createResource(fixture);
      const [row] = await dataSource.query(`SELECT id FROM business.location_resources WHERE location_id = $1`, [
        fixture.locationId,
      ]);

      const listed = await api()
        .get(resourcesPath(fixture.businessId, fixture.locationRef))
        .set(auth(fixture.owner))
        .expect(200);

      const serialized = JSON.stringify(listed.body);
      expect(serialized).not.toContain(row.id);
      expect(serialized).not.toContain(fixture.locationId);
      expect(serialized).not.toContain(fixture.owner.id);
      // And the shape carries exactly the four ratified fields.
      expect(Object.keys(listed.body.data[0]).sort()).toEqual(['kind', 'lifecycle', 'name', 'resourceRef']);
      expect(created.resourceRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('the resourceRef is the one the server derives, and it is location-bound', async () => {
      const fixture = await seedOwnerWithLocation('+98971');
      const created = await createResource(fixture);
      const [row] = await dataSource.query(`SELECT id FROM business.location_resources WHERE location_id = $1`, [
        fixture.locationId,
      ]);

      expect(created.resourceRef).toBe(
        deriveResourceReference(referenceSecret, fixture.owner.id, fixture.businessId, fixture.locationId, row.id),
      );
    });

    it.each([
      ['a malformed ref', 'not-a-reference'],
      ['a wrong-length ref', 'A'.repeat(42)],
      ['a well-formed but unknown ref', 'A'.repeat(43)],
    ])('refuses %s identically', async (_label, ref) => {
      const fixture = await seedOwnerWithLocation('+9897' + Math.floor(Math.random() * 9));
      await createResource(fixture);

      const res = await api()
        .patch(`${resourcesPath(fixture.businessId, fixture.locationRef)}/${ref}`)
        .set(auth(fixture.owner))
        .send({ name: 'دیگر' });
      expect(res.status).toBe(404);
    });

    it('a locationRef or workspaceRef presented as a resourceRef is refused', async () => {
      const fixture = await seedOwnerWithLocation('+98980');
      await createResource(fixture);
      const workspaceRef = deriveWorkspaceReference(referenceSecret, fixture.owner.id, {
        partyType: 'business',
        partyId: fixture.businessId,
      });

      for (const ref of [fixture.locationRef, workspaceRef]) {
        const res = await api()
          .patch(`${resourcesPath(fixture.businessId, fixture.locationRef)}/${ref}`)
          .set(auth(fixture.owner))
          .send({ name: 'دیگر' });
        expect(res.status).toBe(404);
      }
    });

    it('a resourceRef is refused where a locationRef is expected', async () => {
      const fixture = await seedOwnerWithLocation('+98981');
      const created = await createResource(fixture);

      // #108's own rename route, handed a resourceRef.
      const res = await api()
        .patch(`/api/v1/businesses/${fixture.businessId}/locations/${created.resourceRef}`)
        .set(auth(fixture.owner))
        .send({ name: 'دیگر' });
      expect(res.status).toBe(404);
    });

    it('another owner’s resourceRef does not resolve in this owner’s session', async () => {
      const a = await seedOwnerWithLocation('+98982');
      const b = await seedOwnerWithLocation('+98983');
      const created = await createResource(b);

      const res = await api()
        .patch(`${resourcesPath(a.businessId, a.locationRef)}/${created.resourceRef}`)
        .set(auth(a.owner))
        .send({ name: 'دیگر' });
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // 8. Input contract
  // =========================================================================

  describe('§8 unknown fields are refused, never ignored', () => {
    it.each([
      ['a forbidden identity field', { name: 'اتاق', kind: 'room', businessId: uuidv7() }],
      ['a caller-supplied lifecycle', { name: 'اتاق', kind: 'room', lifecycle: 'retired' }],
      ['a caller-supplied reason', { name: 'اتاق', kind: 'room', reason: 'because' }],
      ['a caller-supplied id', { name: 'اتاق', kind: 'room', id: uuidv7() }],
      ['an unknown field', { name: 'اتاق', kind: 'room', colour: 'blue' }],
    ])('create rejects %s with 400', async (_label, body) => {
      const fixture = await seedOwnerWithLocation('+98990');
      await api()
        .post(resourcesPath(fixture.businessId, fixture.locationRef))
        .set(auth(fixture.owner))
        .send(body)
        .expect(400);
    });

    it('create rejects an invalid kind with 400 and writes nothing', async () => {
      const fixture = await seedOwnerWithLocation('+98991');
      for (const kind of ['owner', 'chair', 'bed', 'service']) {
        await api()
          .post(resourcesPath(fixture.businessId, fixture.locationRef))
          .set(auth(fixture.owner))
          .send({ name: 'اتاق', kind })
          .expect(400);
      }
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM business.location_resources WHERE location_id = $1`,
        [fixture.locationId],
      );
      expect(n).toBe(0);
    });

    it('rename rejects a kind change and the retire command rejects any body field', async () => {
      const fixture = await seedOwnerWithLocation('+98992');
      const created = await createResource(fixture);
      const itemPath = `${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}`;

      await api().patch(itemPath).set(auth(fixture.owner)).send({ name: 'x', kind: 'device' }).expect(400);
      await api().post(`${itemPath}/retire`).set(auth(fixture.owner)).send({ reason: 'broken' }).expect(400);
    });

    it('the list route rejects an unknown query parameter', async () => {
      const fixture = await seedOwnerWithLocation('+98993');
      await api()
        .get(`${resourcesPath(fixture.businessId, fixture.locationRef)}?lifecycle=retired`)
        .set(auth(fixture.owner))
        .expect(400);
    });
  });

  // =========================================================================
  // 9. Audit
  // =========================================================================

  async function auditRowsFor(locationId: string): Promise<Array<{ action: string; target_id: string }>> {
    return dataSource.query(
      `SELECT a.action, a.target_id::text
         FROM admin.admin_audit_log a
         JOIN business.location_resources r ON r.id::text = a.target_id::text
        WHERE r.location_id = $1
        ORDER BY a.id`,
      [locationId],
    );
  }

  describe('§9 exactly one audit fact per real mutation, and none otherwise', () => {
    it('records created, renamed and retired -- and nothing on a read or a refusal', async () => {
      const fixture = await seedOwnerWithLocation('+98995');
      const created = await createResource(fixture);
      const itemPath = `${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}`;

      await api().get(resourcesPath(fixture.businessId, fixture.locationRef)).set(auth(fixture.owner)).expect(200);
      await api().patch(itemPath).set(auth(fixture.owner)).send({ name: 'اتاق ۲' }).expect(200);
      // A no-op rename to the SAME name writes nothing.
      await api().patch(itemPath).set(auth(fixture.owner)).send({ name: 'اتاق ۲' }).expect(200);
      await api().post(`${itemPath}/retire`).set(auth(fixture.owner)).send({}).expect(201);
      // A refusal writes nothing.
      await api().post(`${itemPath}/retire`).set(auth(fixture.owner)).send({}).expect(404);

      expect((await auditRowsFor(fixture.locationId)).map((r) => r.action)).toEqual([
        'business.location_resource_created',
        'business.location_resource_renamed',
        'business.location_resource_retired',
      ]);
    });

    it('carries the acting owner and no reference, name or kind in the snapshot', async () => {
      const fixture = await seedOwnerWithLocation('+98996');
      const created = await createResource(fixture, 'اتاق محرمانه', 'room');

      const [row] = await dataSource.query(
        `SELECT actor_user_id::text, action, target_type, reason, before_state, after_state
           FROM admin.admin_audit_log WHERE action = 'business.location_resource_created'
          ORDER BY id DESC LIMIT 1`,
      );
      expect(row.actor_user_id).toBe(fixture.owner.id);
      expect(row.target_type).toBe('business.location_resource');
      expect(row.reason).toBe('location resource created by the business owner');
      expect(row.after_state).toEqual({ lifecycle: 'active' });

      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(created.resourceRef);
      expect(serialized).not.toContain('اتاق محرمانه');
      expect(serialized).not.toContain(fixture.locationRef);
    });

    it('a planted audit failure rolls the resource mutation back', async () => {
      const fixture = await seedOwnerWithLocation('+98997');

      /*
       * The failure is planted at the audit SERVICE, not on the table.
       *
       * The obvious version -- `ALTER TABLE admin.admin_audit_log ADD
       * CONSTRAINT …` -- cannot run here, and the reason is itself a guarantee
       * worth stating: `admin.admin_audit_log` is owned by
       * `beauclick_admin_audit_owner`, so the application role this suite
       * connects as is refused with "must be owner of table admin_audit_log".
       * The append-only ownership contract (ADR-009 / ADR-017) is doing exactly
       * its job.
       *
       * Spying on the last write in the transaction proves the property this
       * case is actually about -- that the resource insert and its audit row
       * share one transaction boundary -- without needing a privilege the
       * application is deliberately never given.
       */
      const audit = app.get(AdminAuditService);
      const spy = jest
        .spyOn(audit, 'record')
        .mockRejectedValueOnce(new Error('planted audit failure (deliberate)'));
      try {
        await api()
          .post(resourcesPath(fixture.businessId, fixture.locationRef))
          .set(auth(fixture.owner))
          .send({ name: 'اتاق', kind: 'room' })
          .expect(500);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }

      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM business.location_resources WHERE location_id = $1`,
        [fixture.locationId],
      );
      expect(n).toBe(0);

      // And NO audit row survived either. This is the half that catches an audit
      // written on a second connection: a `record` call handed
      // `this.dataSource.manager` instead of the caller's `manager` would commit
      // independently and outlive the rolled-back mutation, leaving the log
      // asserting a resource that does not exist.
      const [{ audits }] = await dataSource.query(
        `SELECT count(*)::int AS audits FROM admin.admin_audit_log
          WHERE action = 'business.location_resource_created' AND actor_user_id = $1`,
        [fixture.owner.id],
      );
      expect(audits).toBe(0);

      // The control: with the constraint gone, the same request succeeds.
      await api()
        .post(resourcesPath(fixture.businessId, fixture.locationRef))
        .set(auth(fixture.owner))
        .send({ name: 'اتاق', kind: 'room' })
        .expect(201);
    });
  });

  // =========================================================================
  // 10. Cost
  // =========================================================================

  describe('§10 listing does not grow a query per resource', () => {
    it('costs the same for one resource as for six', async () => {
      const one = await seedOwnerWithLocation('+99000');
      await createResource(one, 'تنها', 'room');

      const many = await seedOwnerWithLocation('+99001');
      for (let i = 0; i < 6; i += 1) await createResource(many, `مورد ${i}`, 'station');

      const count = async (fixture: { owner: SeededUser; businessId: string; locationRef: string }) => {
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
          await api().get(resourcesPath(fixture.businessId, fixture.locationRef)).set(auth(fixture.owner)).expect(200);
        } finally {
          dataSource.logger = original;
        }
        return queries;
      };

      const withOne = await count(one);
      const withSix = await count(many);

      // Deliberately not "assert the count is 2": the point is that it does not
      // GROW with the collection, which is what an N+1 would do.
      expect(withOne).toBeGreaterThan(0);
      expect(withSix).toBe(withOne);
    });
  });

  // =========================================================================
  // 11. Privacy
  // =========================================================================

  describe('§11 ADR-027 coverage and subject privacy', () => {
    let coverage: SubjectDataCoverageService;
    let contracts: SubjectDataContract[];

    beforeAll(() => {
      coverage = app.get(SubjectDataCoverageService);
      contracts = app.get(SUBJECT_DATA_CONTRACTS);
    });

    it('claims business.location_resources exactly once, as retained', async () => {
      const contract = app.get(BusinessSubjectDataContract);
      const claims = contract.tables.filter((c) => c.table === 'business.location_resources');
      expect(claims).toHaveLength(1);
      expect(claims[0].disposition).toBe('retained');
      expect((claims[0].reason ?? '').length).toBeGreaterThan(20);
    });

    it('the live catalogue is fully claimed, including the new table', async () => {
      const catalogue = await coverage.readCatalogue();
      expect(catalogue.map((t) => `${t.schema}.${t.name}`)).toContain('business.location_resources');
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
            tables: contract.tables.filter((t) => t.table !== 'business.location_resources'),
          })) as SubjectDataContract[],
        }),
      ],
      [
        'stale',
        'claimed_but_absent',
        (c: CatalogueTable[], k: SubjectDataContract[]) => ({
          catalogue: c.filter((t) => `${t.schema}.${t.name}` !== 'business.location_resources'),
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
              tables: [{ table: 'business.location_resources', disposition: 'retained', reason: 'x'.repeat(30) }],
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

    it('a customer export never returns catalogue resources', async () => {
      const fixture = await seedOwnerWithLocation('+99010');
      await createResource(fixture);
      const customer = await seedUser(app, dataSource, uniquePhone('+99011'));

      const contract = app.get(BusinessSubjectDataContract);
      const sections = await dataSource.transaction((m) => contract.exportSubjectData(m, customer.id));
      expect(JSON.stringify(sections)).not.toContain('location_resource');

      // And the owner's own export does not turn the catalogue into subject data either.
      const ownerSections = await dataSource.transaction((m) => contract.exportSubjectData(m, fixture.owner.id));
      expect(ownerSections.map((s) => s.key)).not.toContain('location_resources');
    });

    it('erasure neither deletes nor mutates a resource, and reports it retained', async () => {
      const fixture = await seedOwnerWithLocation('+99012');
      await createResource(fixture);
      const before = await dataSource.query(
        `SELECT xmin::text AS xmin, id::text, name, kind, lifecycle FROM business.location_resources WHERE location_id = $1`,
        [fixture.locationId],
      );

      const contract = app.get(BusinessSubjectDataContract);
      const outcome = await dataSource.transaction((m) => contract.eraseSubjectData(m, fixture.owner.id));

      expect(outcome.retained.map((r) => r.table)).toContain('business.location_resources');
      expect(
        await dataSource.query(
          `SELECT xmin::text AS xmin, id::text, name, kind, lifecycle FROM business.location_resources WHERE location_id = $1`,
          [fixture.locationId],
        ),
      ).toEqual(before);
    });
  });

  // =========================================================================
  // 12. Concurrency
  // =========================================================================

  describe('§12 a rename cannot land after a concurrent retirement', () => {
    it('serialises rename against retire -- one wins, and the row stays coherent', async () => {
      const fixture = await seedOwnerWithLocation('+99020');
      const created = await createResource(fixture, 'اتاق', 'room');
      const itemPath = `${resourcesPath(fixture.businessId, fixture.locationRef)}/${created.resourceRef}`;

      const [rename, retire] = await Promise.all([
        api().patch(itemPath).set(auth(fixture.owner)).send({ name: 'اتاق تازه' }),
        api().post(`${itemPath}/retire`).set(auth(fixture.owner)).send({}),
      ]);

      // The retire always succeeds; the rename either landed first or was
      // refused. What must never happen is a renamed-after-retirement row.
      expect(retire.status).toBe(201);
      expect([200, 404]).toContain(rename.status);

      const [row] = await dataSource.query(
        `SELECT name, lifecycle FROM business.location_resources WHERE location_id = $1`,
        [fixture.locationId],
      );
      expect(row.lifecycle).toBe('retired');
      if (rename.status === 404) expect(row.name).toBe('اتاق');
    });
  });
});
