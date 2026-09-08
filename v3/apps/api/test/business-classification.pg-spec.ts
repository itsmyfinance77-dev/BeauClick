import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  BusinessClassificationService,
  BusinessService,
  BusinessSubjectDataContract,
  StaffService,
} from '@beauclick/business';

import {
  CatalogueTable,
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectDataCoverageService,
  evaluateCoverage,
} from '@beauclick/subject-data';

import { createPgTestApp, requiredPgEnv, resetDatabase, seedBusiness, seedMembership, seedUser } from './pg-test-app.factory';

/**
 * REAL PostgreSQL: V3.3 Story #107 (`#44a`) -- business classification and
 * operating traits, and the active-owner index correction the same story owns.
 *
 * ## Why every case here needs a real server
 *
 * ADR-049 section 2.4. The in-memory layer honours neither `ROLLBACK` nor
 * partial unique indexes, so it can prove nothing about the transactional audit
 * guarantee, the row lock that linearizes concurrent replacements, or the
 * soft-delete-then-recreate behaviour that is the whole point of the index
 * change. Those are exactly the guarantees this story ships.
 *
 * The closed vocabularies, the DTO's refusals and the structural
 * "authorizes nothing" proof live in the fast layer instead
 * (`business-classification.contract.spec.ts`,
 * `business-classification-boundary.spec.ts`), because they need no database.
 */
const describeIfPg = requiredPgEnv() ? describe : describe.skip;

const AUDIT_ACTION = 'business.classification_replaced';

describeIfPg('Business classification on real PostgreSQL (#107)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let classification: BusinessClassificationService;
  let businesses: BusinessService;
  let staff: StaffService;
  let coverage: SubjectDataCoverageService;
  let contracts: SubjectDataContract[];

  const uniquePhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  beforeAll(async () => {
    const ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    classification = app.get(BusinessClassificationService);
    businesses = app.get(BusinessService);
    staff = app.get(StaffService);
    coverage = app.get(SubjectDataCoverageService);
    contracts = app.get(SUBJECT_DATA_CONTRACTS);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    // `admin.admin_audit_log` is deliberately NOT reset: the application role
    // holds INSERT and SELECT only, and a suite that could clear it would be
    // proving something the production role cannot do. Every assertion below
    // therefore scopes to this test's own `target_id`, which is a fresh uuidv7
    // per case.
  });

  async function seedOwnerWithBusiness(prefix = '+98931') {
    const owner = await seedUser(app, dataSource, uniquePhone(prefix), ['customer', 'business']);
    const business = await seedBusiness(dataSource, owner.id, 'سالن آزمون');
    return { owner, business };
  }

  const auditRows = async (businessId: string) =>
    dataSource.query(
      `SELECT actor_user_id, action, target_type, target_id, before_state, after_state, reason
         FROM admin.admin_audit_log WHERE action = $1 AND target_id = $2 ORDER BY created_at`,
      [AUDIT_ACTION, businessId],
    );

  // =====================================================================
  // Unclassified is a legal state, and a read never writes
  // =====================================================================

  describe('unclassified is legal', () => {
    it('a live business with no classification reads as { vertical: null, traits: [] }', async () => {
      const { owner, business } = await seedOwnerWithBusiness();

      const response = await request(app.getHttpServer())
        .get(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(response.body.data).toEqual({ vertical: null, traits: [] });
    });

    it('reading does NOT create a row -- no lazy default, no repair, no initialization', async () => {
      const { owner, business } = await seedOwnerWithBusiness();

      for (let i = 0; i < 3; i += 1) {
        await request(app.getHttpServer())
          .get(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .expect(200);
      }

      const [{ verticals, traits }] = await dataSource.query(
        `SELECT (SELECT count(*) FROM business.business_verticals) AS verticals,
                (SELECT count(*) FROM business.business_traits) AS traits`,
      );
      expect(Number(verticals)).toBe(0);
      expect(Number(traits)).toBe(0);
      expect(await auditRows(business.id)).toHaveLength(0);
    });

    it('business creation is UNCHANGED and writes zero classification rows', async () => {
      // `POST /v1/businesses` accepts no vertical (`V33-DEC-032` R5). The
      // creation contract is proved through HTTP so a DTO widening would fail
      // here even if the service kept working.
      const user = await seedUser(app, dataSource, uniquePhone('+98932'), ['customer', 'business']);

      const created = await request(app.getHttpServer())
        .post('/api/v1/businesses')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: 'کسب‌وکار تازه' })
        .expect(201);

      expect(created.body.data.id).toBeDefined();
      expect(created.body.data).not.toHaveProperty('vertical');
      expect(created.body.data).not.toHaveProperty('traits');

      const [{ count }] = await dataSource.query(
        `SELECT (SELECT count(*) FROM business.business_verticals) + (SELECT count(*) FROM business.business_traits) AS count`,
      );
      expect(Number(count)).toBe(0);
    });

    it('creation REFUSES a classification field rather than ignoring it', async () => {
      const user = await seedUser(app, dataSource, uniquePhone('+98933'), ['customer', 'business']);

      await request(app.getHttpServer())
        .post('/api/v1/businesses')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: 'کسب‌وکار', vertical: 'salon' })
        .expect(400);
    });
  });

  // =====================================================================
  // Owner replacement
  // =====================================================================

  describe('owner replacement', () => {
    it('writes the vertical and the trait set, and reads them back sorted', async () => {
      const { owner, business } = await seedOwnerWithBusiness();

      const put = await request(app.getHttpServer())
        .put(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ vertical: 'clinic', traits: ['mobile', 'multi_location'] })
        .expect(200);

      // Deterministic order at the boundary, not physical row order.
      expect(put.body.data).toEqual({ vertical: 'clinic', traits: ['mobile', 'multi_location'] });

      const get = await request(app.getHttpServer())
        .get(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(get.body.data).toEqual({ vertical: 'clinic', traits: ['mobile', 'multi_location'] });
    });

    it('accepts an empty trait set, one trait and both', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      const put = (traits: string[]) =>
        request(app.getHttpServer())
          .put(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ vertical: 'salon', traits })
          .expect(200);

      expect((await put([])).body.data.traits).toEqual([]);
      expect((await put(['mobile'])).body.data.traits).toEqual(['mobile']);
      expect((await put(['multi_location', 'mobile'])).body.data.traits).toEqual(['mobile', 'multi_location']);
      expect((await put([])).body.data.traits).toEqual([]);
    });

    it('replacing the vertical REPLACES the single row -- there is never a second one', async () => {
      const { owner, business } = await seedOwnerWithBusiness();

      for (const vertical of ['salon', 'clinic', 'academy', 'wholesale']) {
        await request(app.getHttpServer())
          .put(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ vertical, traits: [] })
          .expect(200);
      }

      const rows = await dataSource.query(`SELECT vertical FROM business.business_verticals WHERE business_id = $1`, [
        business.id,
      ]);
      expect(rows).toEqual([{ vertical: 'wholesale' }]);
    });

    it('the database refuses a second vertical row for one business', async () => {
      // The invariant is the PRIMARY KEY, not application code
      // (`V33-DEC-032` R2). Proved by going around the service.
      const { business } = await seedOwnerWithBusiness();
      await dataSource.query(`INSERT INTO business.business_verticals (business_id, vertical) VALUES ($1, 'salon')`, [
        business.id,
      ]);

      await expect(
        dataSource.query(`INSERT INTO business.business_verticals (business_id, vertical) VALUES ($1, 'clinic')`, [
          business.id,
        ]),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('the database refuses a member outside either closed vocabulary', async () => {
      const { business } = await seedOwnerWithBusiness();

      await expect(
        dataSource.query(`INSERT INTO business.business_verticals (business_id, vertical) VALUES ($1, 'spa')`, [business.id]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        dataSource.query(`INSERT INTO business.business_traits (business_id, trait) VALUES ($1, 'franchise')`, [business.id]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses a duplicate trait, an unknown trait and an unknown vertical over HTTP', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      const send = (body: unknown) =>
        request(app.getHttpServer())
          .put(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send(body as object);

      await send({ vertical: 'salon', traits: ['mobile', 'mobile'] }).expect(400);
      await send({ vertical: 'salon', traits: ['laser'] }).expect(400);
      await send({ vertical: 'spa', traits: [] }).expect(400);
      await send({ vertical: 'salon' }).expect(400);
      await send({ traits: [] }).expect(400);
      // `isPrimary` is refused by the whitelist pipe rather than ignored.
      await send({ vertical: 'salon', traits: [], isPrimary: true }).expect(400);
      await send({ vertical: 'salon', traits: [], businessId: business.id }).expect(400);

      const [{ count }] = await dataSource.query(
        `SELECT (SELECT count(*) FROM business.business_verticals) + (SELECT count(*) FROM business.business_traits) AS count`,
      );
      expect(Number(count)).toBe(0);
      expect(await auditRows(business.id)).toHaveLength(0);
    });
  });

  // =====================================================================
  // Idempotent replay
  // =====================================================================

  describe('idempotent replay', () => {
    it('a byte-identical replay succeeds, churns no row and writes NO audit record', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      const body = { vertical: 'maison', traits: ['multi_location'] };
      const put = () =>
        request(app.getHttpServer())
          .put(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send(body)
          .expect(200);

      await put();

      // The two current-state tables carry no timestamps on purpose, so change
      // is detected from the rows themselves: `xmin` is the transaction that
      // last wrote each row, and `ctid` its physical location. A delete/insert
      // cycle would move both even when the values matched.
      const fingerprint = async () =>
        dataSource.query(
          `SELECT 'v' AS kind, xmin::text AS xmin, ctid::text AS ctid FROM business.business_verticals WHERE business_id = $1
           UNION ALL
           SELECT 't', xmin::text, ctid::text FROM business.business_traits WHERE business_id = $1
           ORDER BY 1, 3`,
          [business.id],
        );

      const before = await fingerprint();
      expect(before).toHaveLength(2);

      const replay = await put();
      expect(replay.body.data).toEqual({ vertical: 'maison', traits: ['multi_location'] });
      expect(await fingerprint()).toEqual(before);
      expect(await auditRows(business.id)).toHaveLength(1);
    });

    it('a partial overlap churns only what actually differs', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      const put = (traits: string[]) =>
        request(app.getHttpServer())
          .put(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ vertical: 'salon', traits })
          .expect(200);

      await put(['mobile', 'multi_location']);
      const kept = await dataSource.query(
        `SELECT xmin::text AS xmin, ctid::text AS ctid FROM business.business_traits WHERE business_id = $1 AND trait = 'mobile'`,
        [business.id],
      );

      await put(['mobile']);

      const stillThere = await dataSource.query(
        `SELECT xmin::text AS xmin, ctid::text AS ctid FROM business.business_traits WHERE business_id = $1 AND trait = 'mobile'`,
        [business.id],
      );
      expect(stillThere).toEqual(kept);

      const remaining = await dataSource.query(`SELECT trait FROM business.business_traits WHERE business_id = $1`, [
        business.id,
      ]);
      expect(remaining).toEqual([{ trait: 'mobile' }]);
    });
  });

  // =====================================================================
  // Concurrency
  // =====================================================================

  describe('concurrency', () => {
    it('a replacement WAITS for a competing lock on the business row', async () => {
      // The two racing-request cases below are necessary but not sufficient: a
      // service with no lock at all can still happen to serialize, and a
      // mutation probe that deleted `FOR NO KEY UPDATE` survived them. This case
      // asserts the lock itself.
      //
      // A competing transaction takes `FOR NO KEY UPDATE` on the business row
      // and holds it. If the service takes the same lock, its replacement must
      // block until that transaction commits. If it does not, the replacement
      // finishes immediately -- the FK check's `FOR KEY SHARE` does not conflict
      // with `FOR NO KEY UPDATE` -- and this fails.
      const { business } = await seedOwnerWithBusiness();
      const owner = (await businesses.findById(business.id))!.ownerId;

      const competitor = dataSource.createQueryRunner();
      await competitor.connect();
      await competitor.startTransaction();
      await competitor.query(`SELECT id FROM business.businesses WHERE id = $1 FOR NO KEY UPDATE`, [business.id]);

      let settled = false;
      const pending = classification
        .replace(business.id, owner, { vertical: 'salon', traits: ['mobile'] })
        .then((result) => {
          settled = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 750));
      const blockedWhileHeld = settled;

      await competitor.commitTransaction();
      await competitor.release();

      await expect(pending).resolves.toEqual({ vertical: 'salon', traits: ['mobile'] });
      expect(blockedWhileHeld).toBe(false);
      expect(settled).toBe(true);
    });

    it('two genuinely parallel replacements linearize -- never a torn vertical/trait combination', async () => {
      const { owner, business } = await seedOwnerWithBusiness();

      const a = { vertical: 'salon', traits: ['mobile'] };
      const b = { vertical: 'academy', traits: ['multi_location'] };

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .put(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send(a),
        request(app.getHttpServer())
          .put(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send(b),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const [vertical] = await dataSource.query(
        `SELECT vertical FROM business.business_verticals WHERE business_id = $1`,
        [business.id],
      );
      const traits = (
        await dataSource.query(`SELECT trait FROM business.business_traits WHERE business_id = $1 ORDER BY trait`, [
          business.id,
        ])
      ).map((row: { trait: string }) => row.trait);

      // The committed state must be exactly one of the two requests, whole.
      const settled = { vertical: vertical.vertical, traits };
      expect([a, b]).toContainEqual(settled);
    });

    it('runs the same race repeatedly and never produces a mixed state', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      const a = { vertical: 'retail', traits: [] as string[] };
      const b = { vertical: 'clinic', traits: ['mobile', 'multi_location'] };

      for (let round = 0; round < 6; round += 1) {
        const [left, right] = round % 2 === 0 ? [a, b] : [b, a];
        await Promise.all([
          request(app.getHttpServer())
            .put(`/api/v1/businesses/${business.id}/classification`)
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .send(left),
          request(app.getHttpServer())
            .put(`/api/v1/businesses/${business.id}/classification`)
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .send(right),
        ]);

        const settled = await classification.read(business.id);
        expect([a, b]).toContainEqual({ vertical: settled.vertical, traits: [...settled.traits] });
      }
    });
  });

  // =====================================================================
  // Authorization
  // =====================================================================

  describe('authorization', () => {
    async function seedActiveStaff(businessId: string, role: 'manager' | 'staff', phonePrefix: string) {
      const member = await seedUser(app, dataSource, uniquePhone(phonePrefix));
      const ownerId = (await businesses.findById(businessId))!.ownerId;
      // V3.3 #109 (`#44c`) replaced the invite contract with a phone-based one
      // that discloses no membership id, so a spec that needs a specific
      // membership seeds it and still exercises consent through `accept`.
      const membershipId = await seedMembership(dataSource, businessId, member.id, role, ownerId);
      await staff.accept(membershipId, member.id);
      return member;
    }

    it('an active manager and an active staff member may READ but never MUTATE', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      await request(app.getHttpServer())
        .put(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ vertical: 'salon', traits: [] })
        .expect(200);

      for (const role of ['manager', 'staff'] as const) {
        const member = await seedActiveStaff(business.id, role, '+98934');

        await request(app.getHttpServer())
          .get(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${member.accessToken}`)
          .expect(200);

        await request(app.getHttpServer())
          .put(`/api/v1/businesses/${business.id}/classification`)
          .set('Authorization', `Bearer ${member.accessToken}`)
          .send({ vertical: 'clinic', traits: [] })
          .expect(404);
      }

      expect((await classification.read(business.id)).vertical).toBe('salon');
    });

    it('every refused mutation cause returns a BYTE-IDENTICAL body, with an owner positive control', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      const stranger = await seedUser(app, dataSource, uniquePhone('+98935'));
      const foreignOwner = await seedUser(app, dataSource, uniquePhone('+98936'), ['customer', 'business']);
      const foreign = await seedBusiness(dataSource, foreignOwner.id, 'سالن دیگر');
      const member = await seedActiveStaff(business.id, 'manager', '+98937');

      const deletedOwner = await seedUser(app, dataSource, uniquePhone('+98938'), ['customer', 'business']);
      const deleted = await seedBusiness(dataSource, deletedOwner.id, 'سالن حذف‌شده');
      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [deleted.id]);

      const body = { vertical: 'salon', traits: [] };
      const refuse = (id: string, token: string) =>
        request(app.getHttpServer())
          .put(`/api/v1/businesses/${id}/classification`)
          .set('Authorization', `Bearer ${token}`)
          .send(body)
          .expect(404);

      const refusals = [
        await refuse(business.id, stranger.accessToken), // not a member
        await refuse(business.id, member.accessToken), // a member, but not the owner
        await refuse(foreign.id, owner.accessToken), // someone else's business
        await refuse(uuidv7(), owner.accessToken), // no such business
        await refuse(deleted.id, deletedOwner.accessToken), // its own owner, but soft-deleted
      ];

      const shapes = new Set(refusals.map((response) => JSON.stringify(response.body)));
      expect(shapes.size).toBe(1);
      expect(refusals[0].body.error.code).toBe('NOT_FOUND_OR_NOT_YOURS');

      // The positive control: the same request from the live owner succeeds, so
      // the five refusals above are the authorization boundary and not a route
      // that refuses everybody.
      await request(app.getHttpServer())
        .put(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send(body)
        .expect(200);
    });

    it('an unauthenticated caller reaches neither route', async () => {
      const { business } = await seedOwnerWithBusiness();
      await request(app.getHttpServer()).get(`/api/v1/businesses/${business.id}/classification`).expect(401);
      await request(app.getHttpServer())
        .put(`/api/v1/businesses/${business.id}/classification`)
        .send({ vertical: 'salon', traits: [] })
        .expect(401);
    });
  });

  // =====================================================================
  // Classification authorizes nothing -- clinic == salon
  // =====================================================================

  describe('classification changes no authorization outcome', () => {
    it('a `clinic` owner and a `salon` owner get byte-identical results on every business route', async () => {
      const clinic = await seedOwnerWithBusiness('+98940');
      const salon = await seedOwnerWithBusiness('+98941');

      const classify = (ctx: typeof clinic, vertical: string) =>
        request(app.getHttpServer())
          .put(`/api/v1/businesses/${ctx.business.id}/classification`)
          .set('Authorization', `Bearer ${ctx.owner.accessToken}`)
          .send({ vertical, traits: ['mobile'] })
          .expect(200);

      await classify(clinic, 'clinic');
      await classify(salon, 'salon');

      const probe = async (ctx: typeof clinic) => {
        const detail = await request(app.getHttpServer())
          .get(`/api/v1/businesses/${ctx.business.id}`)
          .set('Authorization', `Bearer ${ctx.owner.accessToken}`);
        const staffList = await request(app.getHttpServer())
          .get(`/api/v1/businesses/${ctx.business.id}/staff`)
          .set('Authorization', `Bearer ${ctx.owner.accessToken}`);
        const mine = await request(app.getHttpServer())
          .get('/api/v1/me/business')
          .set('Authorization', `Bearer ${ctx.owner.accessToken}`);
        const foreignProbe = await request(app.getHttpServer())
          .get(`/api/v1/businesses/${uuidv7()}`)
          .set('Authorization', `Bearer ${ctx.owner.accessToken}`);
        return {
          detailStatus: detail.status,
          detailKeys: Object.keys(detail.body.data).sort(),
          staffStatus: staffList.status,
          staffLength: staffList.body.data.length,
          mineStatus: mine.status,
          mineKeys: Object.keys(mine.body.data).sort(),
          foreignStatus: foreignProbe.status,
          foreignBody: JSON.stringify(foreignProbe.body),
        };
      };

      expect(await probe(clinic)).toEqual(await probe(salon));
    });

    it('`GET /v1/me/business` and the business projection are UNCHANGED by classification', async () => {
      const { owner, business } = await seedOwnerWithBusiness();

      const before = await request(app.getHttpServer())
        .get('/api/v1/me/business')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .put(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ vertical: 'clinic', traits: ['mobile', 'multi_location'] })
        .expect(200);

      const after = await request(app.getHttpServer())
        .get('/api/v1/me/business')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      expect(after.body).toEqual(before.body);
      expect(Object.keys(after.body.data)).not.toContain('vertical');
      expect(Object.keys(after.body.data)).not.toContain('traits');
    });

    it('classifying emits NO outbox event and no other side effect', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      const [{ before }] = await dataSource.query(`SELECT count(*) AS before FROM business.outbox_events`);

      await request(app.getHttpServer())
        .put(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ vertical: 'salon', traits: [] })
        .expect(200);

      const [{ after }] = await dataSource.query(`SELECT count(*) AS after FROM business.outbox_events`);
      expect(Number(after)).toBe(Number(before));
    });
  });

  // =====================================================================
  // Transactional audit
  // =====================================================================

  describe('transactional audit', () => {
    it('a real replacement writes exactly ONE record, with the session actor and the closed vocabulary', async () => {
      const { owner, business } = await seedOwnerWithBusiness();

      await request(app.getHttpServer())
        .put(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ vertical: 'clinic', traits: ['mobile'] })
        .expect(200);

      const rows = await auditRows(business.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: owner.id,
        action: AUDIT_ACTION,
        target_type: 'business.classification',
        target_id: business.id,
        reason: 'business classification replaced by its owner',
      });
      expect(rows[0].before_state).toEqual({ vertical: null, traits: '' });
      expect(rows[0].after_state).toEqual({ vertical: 'clinic', traits: 'mobile' });
    });

    it('the audit record carries no phone number, no opaque reference and no free text', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      await request(app.getHttpServer())
        .put(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ vertical: 'salon', traits: [] })
        .expect(200);

      const [row] = await auditRows(business.id);
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(owner.phone);
      expect(row.reason).toBe('business classification replaced by its owner');
    });

    it("writes the audit row on the CALLER's own transaction, not a second connection", async () => {
      // The rollback case below proves the two fail together. It does NOT, on
      // its own, prove they share a transaction: an audit written on a second
      // connection that also fails looks identical. A mutation probe
      // (`AdminAuditService.record` -> `recordDetached`) survived that test,
      // which is what this case exists to kill.
      //
      // The proof is visibility. While the classification transaction is still
      // open, the manager handed to `record` must already SEE the uncommitted
      // vertical row, and a different connection must NOT. A detached audit
      // transaction is a different connection and would see zero.
      const { business } = await seedOwnerWithBusiness();
      const owner = (await businesses.findById(business.id))!.ownerId;

      const audit = (classification as unknown as { audit: Record<string, unknown> }).audit;
      const original = (audit.record as (...args: unknown[]) => Promise<void>).bind(audit);
      let seenByAuditsManager: number | null = null;
      let seenByAnotherConnection: number | null = null;

      audit.record = async (manager: EntityManager, input: unknown) => {
        const [inside] = await manager.query(
          `SELECT count(*)::int AS c FROM business.business_verticals WHERE business_id = $1`,
          [business.id],
        );
        seenByAuditsManager = inside.c;
        const [outside] = await dataSource.query(
          `SELECT count(*)::int AS c FROM business.business_verticals WHERE business_id = $1`,
          [business.id],
        );
        seenByAnotherConnection = outside.c;
        return original(manager, input);
      };

      try {
        await classification.replace(business.id, owner, { vertical: 'salon', traits: [] });
      } finally {
        audit.record = original;
      }

      expect(seenByAuditsManager).toBe(1);
      expect(seenByAnotherConnection).toBe(0);
      expect(await auditRows(business.id)).toHaveLength(1);
    });

    it('the classification and its audit row ROLL BACK together when the audit write fails', async () => {
      // The guarantee `AdminAuditService.record` exists for: a mutation that
      // cannot be recorded must not happen. Proved by making the audit insert
      // fail inside the caller's transaction -- which real PostgreSQL honours
      // and the in-memory layer cannot (ADR-049 section 2.4).
      const { business } = await seedOwnerWithBusiness();
      const owner = (await businesses.findById(business.id))!.ownerId;

      const audit = (classification as unknown as { audit: { record: (...args: unknown[]) => Promise<void> } }).audit;
      const original = audit.record.bind(audit);
      const boom = new Error('audit write refused (deliberate)');
      audit.record = jest.fn().mockRejectedValue(boom);

      try {
        await expect(
          classification.replace(business.id, owner, { vertical: 'salon', traits: ['mobile'] }),
        ).rejects.toThrow('audit write refused (deliberate)');
      } finally {
        audit.record = original;
      }

      const [{ count }] = await dataSource.query(
        `SELECT (SELECT count(*) FROM business.business_verticals WHERE business_id = $1)
              + (SELECT count(*) FROM business.business_traits WHERE business_id = $1) AS count`,
        [business.id],
      );
      expect(Number(count)).toBe(0);
      expect(await auditRows(business.id)).toHaveLength(0);

      // And the surface still works afterwards, so the rollback did not wedge it.
      const after = await classification.replace(business.id, owner, { vertical: 'salon', traits: ['mobile'] });
      expect(after).toEqual({ vertical: 'salon', traits: ['mobile'] });
      expect(await auditRows(business.id)).toHaveLength(1);
    });
  });

  // =====================================================================
  // The active-owner index correction, and the two authorization fixes
  // =====================================================================

  describe('active-owner uniqueness (ADR-049 section 2.3)', () => {
    it('the real index is PARTIAL on `deleted_at IS NULL`', async () => {
      const [row] = await dataSource.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'business' AND indexname = 'uq_businesses_owner_id'`,
      );
      expect(row.indexdef).toContain('UNIQUE');
      expect(row.indexdef).toContain('(owner_id)');
      expect(row.indexdef).toContain('WHERE (deleted_at IS NULL)');
    });

    it('an owner may create a new business after soft-deleting the previous one', async () => {
      const user = await seedUser(app, dataSource, uniquePhone('+98950'), ['customer', 'business']);
      const first = await request(app.getHttpServer())
        .post('/api/v1/businesses')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: 'اولی' })
        .expect(201);

      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [first.body.data.id]);

      const second = await request(app.getHttpServer())
        .post('/api/v1/businesses')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: 'دومی' })
        .expect(201);

      expect(second.body.data.id).not.toBe(first.body.data.id);
    });

    it('two LIVE businesses for one owner are still refused, as a domain refusal and never a raw 23505', async () => {
      const user = await seedUser(app, dataSource, uniquePhone('+98951'), ['customer', 'business']);
      await request(app.getHttpServer())
        .post('/api/v1/businesses')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: 'یکی' })
        .expect(201);

      const refused = await request(app.getHttpServer())
        .post('/api/v1/businesses')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: 'دوتایی' })
        .expect(409);

      expect(refused.body.error.code).toBe('BUSINESS_ALREADY_EXISTS');
      expect(JSON.stringify(refused.body)).not.toContain('23505');
      expect(refused.status).not.toBe(500);
    });

    it('the DEAD predecessor is unreachable: `roleFor` grants nothing and the guard refuses every route', async () => {
      const user = await seedUser(app, dataSource, uniquePhone('+98952'), ['customer', 'business']);
      const first = await request(app.getHttpServer())
        .post('/api/v1/businesses')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: 'قبلی' })
        .expect(201);
      const deadId = first.body.data.id;

      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [deadId]);
      await request(app.getHttpServer())
        .post('/api/v1/businesses')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: 'جدید' })
        .expect(201);

      // The resolver's own answer, and then every route the guard protects.
      expect(await staff.roleFor(deadId, user.id)).toBeNull();

      await request(app.getHttpServer())
        .get(`/api/v1/businesses/${deadId}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .patch(`/api/v1/businesses/${deadId}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: 'ویرایش مرده' })
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/businesses/${deadId}/classification`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(404);
      await request(app.getHttpServer())
        .put(`/api/v1/businesses/${deadId}/classification`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ vertical: 'salon', traits: [] })
        .expect(404);
    });

    it('`BusinessService.update` refuses a soft-deleted business directly, not only behind the guard', async () => {
      const { business } = await seedOwnerWithBusiness();
      await dataSource.query(`UPDATE business.businesses SET deleted_at = now() WHERE id = $1`, [business.id]);

      await expect(businesses.update(business.id, { displayName: 'نباید' })).rejects.toMatchObject({
        response: { code: 'NOT_FOUND_OR_NOT_YOURS' },
      });
    });
  });

  // =====================================================================
  // Schema shape and privacy
  // =====================================================================

  describe('schema shape and ADR-027 disposition', () => {
    it('both tables exist with exactly the ratified columns and no identity column', async () => {
      const columns = async (table: string) =>
        (
          await dataSource.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = 'business' AND table_name = $1 ORDER BY column_name`,
            [table],
          )
        ).map((row: { column_name: string }) => row.column_name);

      expect(await columns('business_verticals')).toEqual(['business_id', 'vertical']);
      expect(await columns('business_traits')).toEqual(['business_id', 'trait']);
    });

    it('neither table carries a column the subject-data heuristic would treat as an identity', async () => {
      // ADR-027's `no_subject_data` cross-check keys on `user_id`, `*_by` and
      // `*_user_id` among others. These tables are claimed `retained`, but the
      // absence of any such column is what makes that claim honest.
      const rows = await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'business' AND table_name IN ('business_verticals','business_traits')`,
      );
      for (const { column_name: name } of rows) {
        expect(name).not.toMatch(/_by$|_user_id$|^user_id$|^phone$|^email$|^actor|^owner_id$/);
      }
    });

    it('the migration seeded NO classification for any pre-existing business', async () => {
      const [{ count }] = await dataSource.query(
        `SELECT (SELECT count(*) FROM business.business_verticals) + (SELECT count(*) FROM business.business_traits) AS count`,
      );
      expect(Number(count)).toBe(0);
    });

    it('the ADR-027 coverage assertion sees BOTH new tables in the real catalogue and claims them exactly once', async () => {
      const catalogue = await coverage.readCatalogue();
      const names = catalogue.map((table) => `${table.schema}.${table.name}`);
      expect(names).toContain('business.business_verticals');
      expect(names).toContain('business.business_traits');

      const report = await coverage.evaluate(contracts);
      expect(report.violations).toEqual([]);
      expect(report.tablesClaimed).toBe(report.tablesInDatabase);
    });

    it.each([
      // Every violation kind the coverage engine can raise, planted against the
      // REAL catalogue and the REAL contract list -- so each is a control over
      // the assertion above rather than over a toy fixture. Without these, a
      // passing coverage report is indistinguishable from an engine that stopped
      // detecting anything.
      [
        'an unclaimed new table',
        'unclaimed',
        (catalogue: CatalogueTable[], contracts: SubjectDataContract[]) => ({
          catalogue: [...catalogue, { schema: 'business', name: 'zz_never_a_real_classification_table', columns: ['business_id'] }],
          contracts,
        }),
      ],
      [
        'a stale claim for a table that no longer exists',
        'claimed_but_absent',
        (catalogue: CatalogueTable[], contracts: SubjectDataContract[]) => ({
          catalogue: catalogue.filter((table) => `${table.schema}.${table.name}` !== 'business.business_traits'),
          contracts,
        }),
      ],
      [
        'the same table claimed by two modules',
        'claimed_twice',
        (catalogue: CatalogueTable[], contracts: SubjectDataContract[]) => ({
          catalogue,
          contracts: [
            ...contracts,
            {
              moduleKey: 'planted_second_owner',
              tables: [{ table: 'business.business_verticals', disposition: 'retained' as const, reason: 'planted duplicate' }],
              exportSubjectData: async () => [],
              eraseSubjectData: async () => ({ moduleKey: 'planted_second_owner', anonymized: 0, deleted: 0, retained: [] }),
            } as unknown as SubjectDataContract,
          ],
        }),
      ],
      [
        'a dishonest `no_subject_data` claim on a table carrying an identity column',
        'wrongly_declared_empty',
        (catalogue: CatalogueTable[], contracts: SubjectDataContract[]) => ({
          catalogue: [...catalogue, { schema: 'business', name: 'zz_planted_identity_table', columns: ['id', 'user_id'] }],
          contracts: [
            ...contracts,
            {
              moduleKey: 'planted_dishonest',
              tables: [
                { table: 'business.zz_planted_identity_table', disposition: 'no_subject_data' as const, reason: 'planted dishonest claim' },
              ],
              exportSubjectData: async () => [],
              eraseSubjectData: async () => ({ moduleKey: 'planted_dishonest', anonymized: 0, deleted: 0, retained: [] }),
            } as unknown as SubjectDataContract,
          ],
        }),
      ],
    ])('the coverage engine still detects %s', async (_name, kind, mutate) => {
      const catalogue = await coverage.readCatalogue();
      const mutated = (mutate as (c: CatalogueTable[], k: SubjectDataContract[]) => { catalogue: CatalogueTable[]; contracts: SubjectDataContract[] })(
        [...catalogue],
        [...contracts],
      );

      const report = evaluateCoverage(mutated.catalogue, mutated.contracts);
      expect(report.violations.map((violation) => violation.kind)).toContain(kind);
    });

    it('classification survives erasure of the owner and is reported as retained', async () => {
      const { owner, business } = await seedOwnerWithBusiness();
      await request(app.getHttpServer())
        .put(`/api/v1/businesses/${business.id}/classification`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ vertical: 'retail', traits: ['multi_location'] })
        .expect(200);

      const contract = app.get(BusinessSubjectDataContract);

      const claims = contract.tables.filter((claim) =>
        ['business.business_verticals', 'business.business_traits'].includes(claim.table),
      );
      expect(claims).toHaveLength(2);
      for (const claim of claims) {
        expect(claim.disposition).toBe('retained');
        expect((claim.reason ?? '').length).toBeGreaterThan(20);
      }

      const outcome = await dataSource.transaction(async (manager) => contract.eraseSubjectData(manager, owner.id));
      expect(outcome.retained.map((entry) => entry.table)).toEqual(
        expect.arrayContaining(['business.business_verticals', 'business.business_traits']),
      );

      const sections = await dataSource.transaction(async (manager) => contract.exportSubjectData(manager, owner.id));
      // V3.3 Story #109 (`#44c`) added the third section. The list stays EXACT
      // rather than being relaxed to `arrayContaining`: this assertion exists to
      // notice a new export section, and it did.
      expect(sections.map((section) => section.key)).toEqual([
        'owned_businesses',
        'staff_memberships',
        'staff_role_grants',
      ]);
      expect(JSON.stringify(sections)).not.toContain('retail');

      const [{ count }] = await dataSource.query(
        `SELECT (SELECT count(*) FROM business.business_verticals WHERE business_id = $1)
              + (SELECT count(*) FROM business.business_traits WHERE business_id = $1) AS count`,
        [business.id],
      );
      expect(Number(count)).toBe(2);
    });
  });
});
