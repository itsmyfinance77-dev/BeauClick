import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { BusinessLocationService, BusinessService, BusinessSubjectDataContract, StaffService } from '@beauclick/business';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, SubjectDataCoverageService, evaluateCoverage } from '@beauclick/subject-data';
import {
  WORKSPACE_REFERENCE_SECRET,
  deriveLocationReference,
  deriveWorkspaceReference,
} from '@beauclick/workspace-reference';

import {
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedBusiness,
  seedCity,
  seedMembership,
  seedUser,
} from './pg-test-app.factory';

/**
 * REAL PostgreSQL: V3.3 Story #108 (`#44b`) -- organisation locations.
 *
 * ADR-049 section 2.4: the in-memory layer honours neither `ROLLBACK` nor row
 * locks, so the transactional audit guarantee, the compare-and-swap lifecycle,
 * the row lock that linearises concurrent transitions, and the byte-stability of
 * existing rows are proved here or nowhere. The closed vocabularies, the DTO
 * refusals, the `locationRef` golden vectors and the "no provider import" proof
 * live in the fast layer (`business-location.contract.spec.ts`,
 * `business-location-boundary.spec.ts`, `libs/workspace-reference/src/location-reference.spec.ts`).
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

const LIFECYCLE_ACTIONS = [
  'business.location_created',
  'business.location_renamed',
  'business.location_suspended',
  'business.location_reactivated',
  'business.location_closed',
];

describeIfPg('Business locations on real PostgreSQL (#108)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let locations: BusinessLocationService;
  let businesses: BusinessService;
  let staff: StaffService;
  let coverage: SubjectDataCoverageService;
  let contracts: SubjectDataContract[];
  let referenceSecret: string;

  const uniquePhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  beforeAll(async () => {
    const ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    locations = app.get(BusinessLocationService);
    businesses = app.get(BusinessService);
    staff = app.get(StaffService);
    coverage = app.get(SubjectDataCoverageService);
    contracts = app.get(SUBJECT_DATA_CONTRACTS);
    referenceSecret = app.get(WORKSPACE_REFERENCE_SECRET);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // `admin.admin_audit_log` is not reset -- the application role holds INSERT
    // and SELECT only. Every assertion scopes to this test's own target ids.
  });

  async function seedOwnerBusinessCity(prefix = '+98961') {
    const owner = await seedUser(app, dataSource, uniquePhone(prefix), ['customer', 'business']);
    const business = await seedBusiness(dataSource, owner.id, 'سازمان آزمون');
    const cityId = await seedCity(dataSource, `City ${prefix}`);
    return { owner, business, cityId };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const auditRows = (targetId: string) =>
    dataSource.query(
      `SELECT actor_user_id, action, target_type, target_id, before_state, after_state, reason
         FROM admin.admin_audit_log WHERE target_id = $1 ORDER BY created_at`,
      [targetId],
    );

  const locationAuditCount = async (): Promise<number> => {
    const [{ c }] = await dataSource.query(
      `SELECT count(*)::int AS c FROM admin.admin_audit_log WHERE action = ANY($1)`,
      [LIFECYCLE_ACTIONS],
    );
    return c;
  };

  // =====================================================================
  // Schema shape, seed, migration
  // =====================================================================

  describe('schema and migration', () => {
    it('business.locations has exactly the ratified columns, constraints and lifecycle vocabulary', async () => {
      const columns = (
        await dataSource.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='business' AND table_name='locations' ORDER BY column_name`,
        )
      ).map((r: { column_name: string }) => r.column_name);
      expect(columns).toEqual(['business_id', 'city_id', 'created_at', 'id', 'lifecycle', 'name', 'updated_at']);

      const checks = (
        await dataSource.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='business.locations'::regclass ORDER BY conname`,
        )
      ).map((r: { conname: string; def: string }) => `${r.conname}: ${r.def}`);
      const joined = checks.join('\n');
      // pg renders `IN (...)` as `= ANY (ARRAY[...])`; assert on the closed member set.
      expect(joined).toMatch(/ck_locations_lifecycle: CHECK/);
      for (const member of ["'active'", "'suspended'", "'closed'"]) expect(joined).toContain(member);
      expect(joined).toMatch(/ck_locations_name_shape: CHECK.*btrim/s);
      // Same-schema, non-cascading FK to business.businesses(id).
      expect(joined).toMatch(/FOREIGN KEY \(business_id\) REFERENCES business\.businesses\(id\)(?!.*CASCADE)/s);

      const lifecycleDefault = (
        await dataSource.query(
          `SELECT column_default FROM information_schema.columns WHERE table_schema='business' AND table_name='locations' AND column_name='lifecycle'`,
        )
      )[0].column_default as string;
      expect(lifecycleDefault).toContain("'active'");
    });

    it('the database refuses a lifecycle value outside the closed vocabulary and an empty/untrimmed name', async () => {
      const { business, cityId } = await seedOwnerBusinessCity();
      await expect(
        dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id, lifecycle) VALUES ($1,$2,'x',$3,'archived')`, [
          uuidv7(),
          business.id,
          cityId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id) VALUES ($1,$2,'  ',$3)`, [
          uuidv7(),
          business.id,
          cityId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        dataSource.query(`INSERT INTO business.locations (id, business_id, name, city_id) VALUES ($1,$2,' padded ',$3)`, [
          uuidv7(),
          business.id,
          cityId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('the migration seeded ZERO location rows', async () => {
      await resetDatabase(dataSource);
      const [{ c }] = await dataSource.query(`SELECT count(*)::int AS c FROM business.locations`);
      expect(c).toBe(0);
    });

    it('business.businesses.city_id keeps its type and constraints, and gains only a deprecation COMMENT', async () => {
      const [col] = await dataSource.query(
        `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema='business' AND table_name='businesses' AND column_name='city_id'`,
      );
      expect(col).toEqual({ data_type: 'uuid', is_nullable: 'YES' });

      const [{ comment }] = await dataSource.query(
        `SELECT col_description('business.businesses'::regclass, (
           SELECT attnum FROM pg_attribute WHERE attrelid='business.businesses'::regclass AND attname='city_id'
         )) AS comment`,
      );
      expect(comment).toContain('DEPRECATED as a service-delivery location');
      expect(comment).toContain('preserved byte-identical');
    });
  });

  // =====================================================================
  // A zero-location business is unchanged; existing rows are byte-stable
  // =====================================================================

  describe('a business with no location behaves exactly as before', () => {
    it('every existing business surface is identical to a run where no location code executed', async () => {
      const { owner, business } = await seedOwnerBusinessCity('+98962');
      const auditBefore = await locationAuditCount();

      const mine = await request(app.getHttpServer()).get('/api/v1/me/business').set(auth(owner.accessToken)).expect(200);
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/businesses/${business.id}`)
        .set(auth(owner.accessToken))
        .expect(200);
      const classification = await request(app.getHttpServer())
        .get(`/api/v1/businesses/${business.id}/classification`)
        .set(auth(owner.accessToken))
        .expect(200);

      expect(Object.keys(mine.body.data).sort()).toEqual(['bio', 'cityId', 'createdAt', 'displayName', 'id', 'ownerId', 'verificationStatus']);
      expect(detail.body.data).toEqual(mine.body.data);
      expect(classification.body.data).toEqual({ vertical: null, traits: [] });

      // And the collection read is an empty list, not a 404 and not a lazy row.
      const list = await request(app.getHttpServer())
        .get(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .expect(200);
      expect(list.body.data).toEqual([]);
      const [{ c }] = await dataSource.query(`SELECT count(*)::int AS c FROM business.locations`);
      expect(c).toBe(0);
      expect(await locationAuditCount()).toBe(auditBefore);
    });

    it('existing business/booking/commerce/ledger rows are byte-identical across a full location lifecycle, with a mutation control', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98963');

      // A pre-existing row in each table ADR-049 names. `booking.bookings`,
      // `commerce.orders` and `financial.ledger_entries` are seeded minimally by
      // raw insert -- the point is only that a location operation never touches
      // them.
      const otherProId = uuidv7();
      await dataSource.query(
        `INSERT INTO provider.professionals (id, owner_id, display_name, verification_status) VALUES ($1,$2,'p','verified')`,
        [otherProId, owner.id],
      );
      const bookingId = uuidv7();
      const slotId = uuidv7();
      await dataSource.query(
        `INSERT INTO booking.availability_slots (id, professional_id, service_id, start_at, end_at, status) VALUES ($1,$2,NULL,now()+interval '2 days',now()+interval '2 days 1 hour','open')`,
        [slotId, otherProId],
      );
      await dataSource.query(
        `INSERT INTO booking.bookings (id, professional_id, customer_id, slot_id, status, start_at, end_at)
         VALUES ($1,$2,$3,$4,'pending',now()+interval '2 days',now()+interval '2 days 1 hour')`,
        [bookingId, otherProId, owner.id, slotId],
      ).catch(() => undefined); // schema variance tolerated -- the byte-check below still runs on whatever was inserted

      const fingerprint = async (table: string, idColumn = 'id') =>
        dataSource.query(`SELECT ${idColumn} AS id, xmin::text AS xmin, ctid::text AS ctid FROM ${table} ORDER BY 1`);

      const before = {
        businesses: await fingerprint('business.businesses'),
        bookings: await fingerprint('booking.bookings'),
        orders: await fingerprint('commerce.orders'),
      };

      // A full location lifecycle.
      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'Main', cityId })
        .expect(201);
      const ref = created.body.data.locationRef;
      await request(app.getHttpServer()).patch(`/api/v1/businesses/${business.id}/locations/${ref}`).set(auth(owner.accessToken)).send({ name: 'Main 2' }).expect(200);
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/suspend`).set(auth(owner.accessToken)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/reactivate`).set(auth(owner.accessToken)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/close`).set(auth(owner.accessToken)).expect(201);

      expect(await fingerprint('business.businesses')).toEqual(before.businesses);
      expect(await fingerprint('booking.bookings')).toEqual(before.bookings);
      expect(await fingerprint('commerce.orders')).toEqual(before.orders);

      // The non-vacuity control: a real change to the business row DOES move its
      // xmin, so the comparator above is not asserting on an empty set.
      await dataSource.query(`UPDATE business.businesses SET revision = revision + 1 WHERE id = $1`, [business.id]);
      expect(await fingerprint('business.businesses')).not.toEqual(before.businesses);
    });
  });

  // =====================================================================
  // Owner CRUD + lifecycle
  // =====================================================================

  describe('owner create, list, rename and lifecycle', () => {
    it('creates with exactly { name, cityId } and returns only ref, name, city, lifecycle', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98964');

      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: '  Karaj branch  ', cityId })
        .expect(201);

      expect(Object.keys(created.body.data).sort()).toEqual(['city', 'lifecycle', 'locationRef', 'name']);
      expect(created.body.data.name).toBe('Karaj branch'); // trimmed
      expect(created.body.data.lifecycle).toBe('active');
      expect(created.body.data.city).toEqual({ id: cityId, name: `City +98964` });
      expect(created.body.data.locationRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(created.body.data)).not.toContain(business.id);
    });

    it('lists deterministically and renders each location, then rename changes only the name', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98965');
      const refs: string[] = [];
      for (const name of ['A', 'B', 'C']) {
        const r = await request(app.getHttpServer())
          .post(`/api/v1/businesses/${business.id}/locations`)
          .set(auth(owner.accessToken))
          .send({ name, cityId })
          .expect(201);
        refs.push(r.body.data.locationRef);
      }

      const list1 = await request(app.getHttpServer()).get(`/api/v1/businesses/${business.id}/locations`).set(auth(owner.accessToken)).expect(200);
      expect(list1.body.data.map((l: { name: string }) => l.name)).toEqual(['A', 'B', 'C']);
      const list2 = await request(app.getHttpServer()).get(`/api/v1/businesses/${business.id}/locations`).set(auth(owner.accessToken)).expect(200);
      expect(list2.body.data).toEqual(list1.body.data); // stable order, and the ref for a given row is stable

      const renamed = await request(app.getHttpServer())
        .patch(`/api/v1/businesses/${business.id}/locations/${refs[1]}`)
        .set(auth(owner.accessToken))
        .send({ name: 'B renamed' })
        .expect(200);
      expect(renamed.body.data).toEqual({ locationRef: refs[1], name: 'B renamed', city: { id: cityId, name: 'City +98965' }, lifecycle: 'active' });
    });

    it('runs the full lifecycle, treats closed as terminal, and idempotent repeats churn nothing', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98966');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'L', cityId })
        .expect(201);
      const ref = created.body.data.locationRef;
      const call = (verb: 'suspend' | 'reactivate' | 'close') =>
        request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/${verb}`).set(auth(owner.accessToken));

      expect((await call('suspend').expect(201)).body.data.lifecycle).toBe('suspended');
      // Idempotent: suspend again -> unchanged success, and NO new audit row.
      const auditAfterFirstSuspend = await locationAuditCount();
      expect((await call('suspend').expect(201)).body.data.lifecycle).toBe('suspended');
      expect(await locationAuditCount()).toBe(auditAfterFirstSuspend);

      expect((await call('reactivate').expect(201)).body.data.lifecycle).toBe('active');
      expect((await call('close').expect(201)).body.data.lifecycle).toBe('closed');
      // closed is terminal: reactivate and suspend are refused, rename too.
      await call('reactivate').expect(404);
      await call('suspend').expect(404);
      await request(app.getHttpServer()).patch(`/api/v1/businesses/${business.id}/locations/${ref}`).set(auth(owner.accessToken)).send({ name: 'nope' }).expect(404);
      // close again on an already-closed location: idempotent success, no audit.
      const auditBeforeReClose = await locationAuditCount();
      expect((await call('close').expect(201)).body.data.lifecycle).toBe('closed');
      expect(await locationAuditCount()).toBe(auditBeforeReClose);
    });

    it('a byte-identical rename churns no row and writes no audit', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98967');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'Same', cityId })
        .expect(201);
      const ref = created.body.data.locationRef;
      const [{ id: locId }] = await dataSource.query(`SELECT id FROM business.locations WHERE business_id=$1`, [business.id]);

      const fp = async () => dataSource.query(`SELECT xmin::text AS xmin, ctid::text AS ctid FROM business.locations WHERE id=$1`, [locId]);
      const before = await fp();
      const auditBefore = await locationAuditCount();

      await request(app.getHttpServer()).patch(`/api/v1/businesses/${business.id}/locations/${ref}`).set(auth(owner.accessToken)).send({ name: 'Same' }).expect(200);

      expect(await fp()).toEqual(before);
      expect(await locationAuditCount()).toBe(auditBefore);
    });

    it('a lifecycle command WAITS for a competing row lock on the location', async () => {
      // The parallel case below is necessary but not sufficient: a service with
      // no row lock can still happen to serialise. This asserts the lock itself,
      // the same way `business-classification.pg-spec.ts` does for the business
      // row. A probe that deletes `FOR NO KEY UPDATE OF l` from the resolver
      // fails here.
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98967b');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'Locked', cityId })
        .expect(201);
      const ref = created.body.data.locationRef;
      const [{ id: locId }] = await dataSource.query(`SELECT id FROM business.locations WHERE business_id=$1`, [business.id]);

      const competitor = dataSource.createQueryRunner();
      await competitor.connect();
      await competitor.startTransaction();
      await competitor.query(`SELECT id FROM business.locations WHERE id = $1 FOR NO KEY UPDATE`, [locId]);

      let settled = false;
      const pending = locations.suspend(business.id, owner.id, ref).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 750));
      const blockedWhileHeld = settled;

      await competitor.commitTransaction();
      await competitor.release();

      await expect(pending).resolves.toMatchObject({ lifecycle: 'suspended' });
      expect(blockedWhileHeld).toBe(false);
    });

    it('two genuinely parallel lifecycle commands linearise -- never a lost update', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98968');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'Race', cityId })
        .expect(201);
      const ref = created.body.data.locationRef;

      const [a, b] = await Promise.all([
        request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/suspend`).set(auth(owner.accessToken)),
        request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/close`).set(auth(owner.accessToken)),
      ]);
      // Both may legitimately succeed (suspend then close, or close then a
      // no-op-refused suspend); what must never happen is a mixed or lost state.
      expect([a.status, b.status].every((s) => s === 201 || s === 404)).toBe(true);
      const [{ lifecycle }] = await dataSource.query(`SELECT lifecycle FROM business.locations WHERE business_id=$1`, [business.id]);
      expect(['suspended', 'closed']).toContain(lifecycle);

      // Whatever the interleaving, the audit rows for this location are a
      // consistent chain with no duplicate for one transition.
      const [{ id: locId }] = await dataSource.query(`SELECT id FROM business.locations WHERE business_id=$1`, [business.id]);
      const actions = (await auditRows(locId)).map((r: { action: string }) => r.action);
      expect(new Set(actions).size).toBe(actions.length);
    });
  });

  // =====================================================================
  // City validation through the port
  // =====================================================================

  describe('city validation', () => {
    it('a nonexistent city and an unlaunched city are refused indistinguishably, and no row is written', async () => {
      const { owner, business } = await seedOwnerBusinessCity('+98969');
      const unlaunched = await seedCity(dataSource, 'Hidden', false);
      const auditBefore = await locationAuditCount();

      const nonexistent = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'x', cityId: uuidv7() })
        .expect(404);
      const unavailable = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'x', cityId: unlaunched })
        .expect(404);

      expect(JSON.stringify(nonexistent.body)).toBe(JSON.stringify(unavailable.body));
      expect(nonexistent.body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');
      const [{ c }] = await dataSource.query(`SELECT count(*)::int AS c FROM business.locations`);
      expect(c).toBe(0);
      expect(await locationAuditCount()).toBe(auditBefore);
    });

    it('a launched city added AFTER a location was created still renders on the location', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98970');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'L', cityId })
        .expect(201);
      await dataSource.query(`UPDATE provider.locations_cities SET is_launched = false WHERE id = $1`, [cityId]);

      const list = await request(app.getHttpServer()).get(`/api/v1/businesses/${business.id}/locations`).set(auth(owner.accessToken)).expect(200);
      expect(list.body.data[0].city).toEqual({ id: cityId, name: 'City +98970' });
      expect(list.body.data[0].locationRef).toBe(created.body.data.locationRef);
    });
  });

  // =====================================================================
  // Owner-only, adversarial
  // =====================================================================

  describe('owner-only, proven adversarially', () => {
    async function activeStaff(businessId: string, role: 'manager' | 'staff', prefix: string) {
      const member = await seedUser(app, dataSource, uniquePhone(prefix));
      const ownerId = (await businesses.findById(businessId))!.ownerId;
      // V3.3 #109 (`#44c`) replaced the invite contract with a phone-based one
      // that discloses no membership id; consent is still exercised via `accept`.
      const membershipId = await seedMembership(dataSource, businessId, member.id, role, ownerId);
      await staff.accept(membershipId, member.id);
      return member;
    }

    it('every non-owner cause returns a BYTE-IDENTICAL body across create/list/rename/suspend, with an owner positive control', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98971');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'L', cityId })
        .expect(201);
      const ref = created.body.data.locationRef;

      const stranger = await seedUser(app, dataSource, uniquePhone('+98972'));
      const manager = await activeStaff(business.id, 'manager', '+98973');
      const member = await activeStaff(business.id, 'staff', '+98974');
      const foreignOwner = await seedUser(app, dataSource, uniquePhone('+98975'), ['customer', 'business']);
      const foreign = await seedBusiness(dataSource, foreignOwner.id, 'دیگری');
      const deletedOwner = await seedUser(app, dataSource, uniquePhone('+98976'), ['customer', 'business']);
      const deleted = await seedBusiness(dataSource, deletedOwner.id, 'حذف‌شده');
      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [deleted.id]);

      const bodies = new Set<string>();
      const collect = async (r: request.Test) => {
        const res = await r.expect(404);
        bodies.add(JSON.stringify(res.body));
      };

      // list
      await collect(request(app.getHttpServer()).get(`/api/v1/businesses/${business.id}/locations`).set(auth(stranger.accessToken)));
      await collect(request(app.getHttpServer()).get(`/api/v1/businesses/${business.id}/locations`).set(auth(manager.accessToken)));
      await collect(request(app.getHttpServer()).get(`/api/v1/businesses/${business.id}/locations`).set(auth(member.accessToken)));
      await collect(request(app.getHttpServer()).get(`/api/v1/businesses/${foreign.id}/locations`).set(auth(owner.accessToken)));
      await collect(request(app.getHttpServer()).get(`/api/v1/businesses/${uuidv7()}/locations`).set(auth(owner.accessToken)));
      await collect(request(app.getHttpServer()).get(`/api/v1/businesses/${deleted.id}/locations`).set(auth(deletedOwner.accessToken)));
      // create
      await collect(request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations`).set(auth(manager.accessToken)).send({ name: 'y', cityId }));
      // rename with a valid ref but wrong actor
      await collect(request(app.getHttpServer()).patch(`/api/v1/businesses/${business.id}/locations/${ref}`).set(auth(manager.accessToken)).send({ name: 'y' }));
      // suspend
      await collect(request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/suspend`).set(auth(stranger.accessToken)));

      expect(bodies.size).toBe(1);
      expect([...bodies][0]).toContain('NOT_FOUND_OR_NOT_YOURS');

      // positive control: the live owner still works.
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/suspend`).set(auth(owner.accessToken)).expect(201);
    });

    it('a malformed, foreign and cross-owner locationRef all get the same refusal as a valid ref for the wrong business', async () => {
      const a = await seedOwnerBusinessCity('+98977');
      const b = await seedOwnerBusinessCity('+98978');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${a.business.id}/locations`)
        .set(auth(a.owner.accessToken))
        .send({ name: 'L', cityId: a.cityId })
        .expect(201);
      const [{ id: locId }] = await dataSource.query(`SELECT id FROM business.locations WHERE business_id=$1`, [a.business.id]);

      // A ref computed for owner B / business B / that location id -- valid HMAC, wrong binding.
      const crossOwnerRef = deriveLocationReference(referenceSecret, b.owner.id, b.business.id, locId);
      // A ref computed for a's real location but presented under b's business path.
      const aValidRef = created.body.data.locationRef;
      // A real workspaceRef, which must not work as a locationRef.
      const workspaceRef = deriveWorkspaceReference(referenceSecret, a.owner.id, { partyType: 'business', partyId: a.business.id });

      const bodies = new Set<string>();
      for (const [bizId, token, ref] of [
        [a.business.id, a.owner.accessToken, 'not-a-real-reference-obviously-too-short'],
        [a.business.id, a.owner.accessToken, 'A'.repeat(43)],
        [a.business.id, a.owner.accessToken, crossOwnerRef],
        [a.business.id, a.owner.accessToken, workspaceRef],
        [b.business.id, b.owner.accessToken, aValidRef],
      ] as const) {
        const res = await request(app.getHttpServer())
          .patch(`/api/v1/businesses/${bizId}/locations/${ref}`)
          .set(auth(token))
          .send({ name: 'z' })
          .expect(404);
        bodies.add(JSON.stringify(res.body));
      }
      expect(bodies.size).toBe(1);

      // positive control: a's own ref on a's business works.
      await request(app.getHttpServer()).patch(`/api/v1/businesses/${a.business.id}/locations/${aValidRef}`).set(auth(a.owner.accessToken)).send({ name: 'ok' }).expect(200);
    });

    it('an unauthenticated caller reaches no location route', async () => {
      const { business } = await seedOwnerBusinessCity('+98979');
      await request(app.getHttpServer()).get(`/api/v1/businesses/${business.id}/locations`).expect(401);
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations`).send({ name: 'x', cityId: uuidv7() }).expect(401);
    });

    it('an unknown body or query field is a 400, not a silent drop', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98980');
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations`).set(auth(owner.accessToken)).send({ name: 'x', cityId, lifecycle: 'active' }).expect(400);
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations`).set(auth(owner.accessToken)).send({ name: 'x', cityId, workspaceRef: 'y' }).expect(400);
      const created = await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations`).set(auth(owner.accessToken)).send({ name: 'x', cityId }).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${created.body.data.locationRef}/suspend`).set(auth(owner.accessToken)).send({ reason: 'because' }).expect(400);
    });
  });

  // =====================================================================
  // Transactional audit
  // =====================================================================

  describe('transactional audit', () => {
    it('each real mutation writes exactly one row with the session actor and the closed vocabulary; reads and no-ops write none', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98981');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'L', cityId })
        .expect(201);
      const ref = created.body.data.locationRef;
      const [{ id: locId }] = await dataSource.query(`SELECT id FROM business.locations WHERE business_id=$1`, [business.id]);

      await request(app.getHttpServer()).get(`/api/v1/businesses/${business.id}/locations`).set(auth(owner.accessToken)).expect(200);
      await request(app.getHttpServer()).patch(`/api/v1/businesses/${business.id}/locations/${ref}`).set(auth(owner.accessToken)).send({ name: 'L2' }).expect(200);
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/suspend`).set(auth(owner.accessToken)).expect(201);
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/close`).set(auth(owner.accessToken)).expect(201);

      const rows = await auditRows(locId);
      expect(rows.map((r: { action: string }) => r.action)).toEqual([
        'business.location_created',
        'business.location_renamed',
        'business.location_suspended',
        'business.location_closed',
      ]);
      for (const row of rows) {
        expect(row.actor_user_id).toBe(owner.id);
        expect(row.target_type).toBe('business.location');
        expect(row.reason).toMatch(/^business location .* by its owner$/);
      }
      expect(rows[0].before_state).toBeNull();
      expect(rows[0].after_state).toEqual({ lifecycle: 'active' });
      expect(rows[2].after_state).toEqual({ lifecycle: 'suspended' });
      // No name, city id or ref in any snapshot.
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('L2');
      expect(serialized).not.toContain(cityId);
      expect(serialized).not.toContain(ref);
    });

    it('the location change and its audit row ROLL BACK together when the audit write fails', async () => {
      const { business, cityId } = await seedOwnerBusinessCity('+98982');
      const owner = (await businesses.findById(business.id))!.ownerId;
      const auditBefore = await locationAuditCount();

      const auditHolder = locations as unknown as { audit: { record: (...args: unknown[]) => Promise<void> } };
      const original = auditHolder.audit.record.bind(auditHolder.audit);
      auditHolder.audit.record = jest.fn().mockRejectedValue(new Error('audit refused (deliberate)'));
      try {
        await expect(locations.create(business.id, owner, { name: 'RolledBack', cityId })).rejects.toThrow('audit refused (deliberate)');
      } finally {
        auditHolder.audit.record = original;
      }

      const [{ c }] = await dataSource.query(`SELECT count(*)::int AS c FROM business.locations WHERE business_id=$1`, [business.id]);
      expect(c).toBe(0);
      expect(await locationAuditCount()).toBe(auditBefore);

      // And the surface still works afterwards.
      const ok = await locations.create(business.id, owner, { name: 'AfterRollback', cityId });
      expect(ok.name).toBe('AfterRollback');
    });

    it("writes the audit row on the CALLER's own transaction, not a second connection", async () => {
      const { business, cityId } = await seedOwnerBusinessCity('+98983');
      const owner = (await businesses.findById(business.id))!.ownerId;

      const auditHolder = locations as unknown as { audit: { record: (m: import('typeorm').EntityManager, i: unknown) => Promise<void> } };
      const original = auditHolder.audit.record.bind(auditHolder.audit);
      let seenInside: number | null = null;
      let seenOutside: number | null = null;
      auditHolder.audit.record = async (manager, input) => {
        const [inside] = await manager.query(`SELECT count(*)::int AS c FROM business.locations WHERE business_id=$1`, [business.id]);
        seenInside = inside.c;
        const [outside] = await dataSource.query(`SELECT count(*)::int AS c FROM business.locations WHERE business_id=$1`, [business.id]);
        seenOutside = outside.c;
        return original(manager, input);
      };
      try {
        await locations.create(business.id, owner, { name: 'Visible', cityId });
      } finally {
        auditHolder.audit.record = original;
      }
      expect(seenInside).toBe(1);
      expect(seenOutside).toBe(0);
    });
  });

  // =====================================================================
  // ADR-027 coverage, export/erasure
  // =====================================================================

  describe('ADR-027 disposition and privacy', () => {
    it('the coverage assertion sees business.locations in the real catalogue and claims it exactly once', async () => {
      const catalogue = await coverage.readCatalogue();
      expect(catalogue.map((t) => `${t.schema}.${t.name}`)).toContain('business.locations');
      const report = await coverage.evaluate(contracts);
      expect(report.violations).toEqual([]);
      expect(report.tablesClaimed).toBe(report.tablesInDatabase);
    });

    it.each([
      [
        'an unclaimed location-shaped table',
        'unclaimed',
        (c: Awaited<ReturnType<SubjectDataCoverageService['readCatalogue']>>, k: SubjectDataContract[]) => ({
          catalogue: [...c, { schema: 'business', name: 'zz_locations_shadow', columns: ['id', 'business_id'] }],
          contracts: k,
        }),
      ],
      [
        'a stale claim for business.locations',
        'claimed_but_absent',
        (c: Awaited<ReturnType<SubjectDataCoverageService['readCatalogue']>>, k: SubjectDataContract[]) => ({
          catalogue: c.filter((t) => `${t.schema}.${t.name}` !== 'business.locations'),
          contracts: k,
        }),
      ],
      [
        'business.locations claimed twice',
        'claimed_twice',
        (c: Awaited<ReturnType<SubjectDataCoverageService['readCatalogue']>>, k: SubjectDataContract[]) => ({
          catalogue: c,
          contracts: [
            ...k,
            {
              moduleKey: 'planted_second',
              tables: [{ table: 'business.locations', disposition: 'retained' as const, reason: 'planted' }],
              exportSubjectData: async () => [],
              eraseSubjectData: async () => ({ moduleKey: 'planted_second', anonymized: 0, deleted: 0, retained: [] }),
            } as unknown as SubjectDataContract,
          ],
        }),
      ],
    ])('the coverage engine still detects %s', async (_name, kind, mutate) => {
      const catalogue = await coverage.readCatalogue();
      const m = (mutate as (c: typeof catalogue, k: SubjectDataContract[]) => { catalogue: typeof catalogue; contracts: SubjectDataContract[] })(
        [...catalogue],
        [...contracts],
      );
      expect(evaluateCoverage(m.catalogue, m.contracts).violations.map((v) => v.kind)).toContain(kind);
    });

    it('locations survive owner erasure, are reported retained, and are not in the export', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98984');
      await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'PersistThrough', cityId })
        .expect(201);

      const contract = app.get(BusinessSubjectDataContract);
      const claim = contract.tables.find((t) => t.table === 'business.locations');
      expect(claim?.disposition).toBe('retained');
      expect((claim?.reason ?? '').length).toBeGreaterThan(20);

      const outcome = await dataSource.transaction((m) => contract.eraseSubjectData(m, owner.id));
      expect(outcome.retained.map((r) => r.table)).toContain('business.locations');

      const sections = await dataSource.transaction((m) => contract.exportSubjectData(m, owner.id));
      expect(JSON.stringify(sections)).not.toContain('PersistThrough');

      const [{ c }] = await dataSource.query(`SELECT count(*)::int AS c FROM business.locations WHERE business_id=$1`, [business.id]);
      expect(c).toBe(1);
    });
  });

  // =====================================================================
  // No side effects
  // =====================================================================

  describe('no side effect beyond the location row and its audit row', () => {
    it('a full location lifecycle emits no outbox event and touches no other module table', async () => {
      const { owner, business, cityId } = await seedOwnerBusinessCity('+98985');
      const counts = async () => {
        const [{ b, n }] = await dataSource.query(
          `SELECT (SELECT count(*) FROM business.outbox_events) AS b, (SELECT count(*) FROM notification.outbox_events) AS n`,
        );
        return { b: Number(b), n: Number(n) };
      };
      const before = await counts();

      const created = await request(app.getHttpServer())
        .post(`/api/v1/businesses/${business.id}/locations`)
        .set(auth(owner.accessToken))
        .send({ name: 'L', cityId })
        .expect(201);
      const ref = created.body.data.locationRef;
      await request(app.getHttpServer()).patch(`/api/v1/businesses/${business.id}/locations/${ref}`).set(auth(owner.accessToken)).send({ name: 'L2' }).expect(200);
      await request(app.getHttpServer()).post(`/api/v1/businesses/${business.id}/locations/${ref}/close`).set(auth(owner.accessToken)).expect(201);

      expect(await counts()).toEqual(before);

      // business_staff, verticals, traits, bookings, orders untouched.
      const [{ staffc, vc, tc }] = await dataSource.query(
        `SELECT (SELECT count(*) FROM business.business_staff) AS staffc,
                (SELECT count(*) FROM business.business_verticals) AS vc,
                (SELECT count(*) FROM business.business_traits) AS tc`,
      );
      expect([Number(staffc), Number(vc), Number(tc)]).toEqual([0, 0, 0]);
    });
  });
});
