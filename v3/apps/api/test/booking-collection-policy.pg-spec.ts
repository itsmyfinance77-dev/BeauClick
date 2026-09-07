import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage } from '@beauclick/subject-data';
import { BookingCollectionPercentageBase, BookingCollectionTermsV1 } from '@beauclick/commercial-policy-contract';
import {
  BookingCollectionPolicyService,
  CommercialActivationOverlapException,
  CommercialLifecycleConflictException,
  CommercialNotFoundException,
  CommercialTermsInvalidException,
} from '@beauclick/commercial-policy';

import { PgTestApp, SeededUser, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * Administrator-published booking collection policy against a real PostgreSQL
 * server — V3.3 Story #83 (`#41d-1`), ADR-048, `V33-DEC-028`, `V33-DEC-029`.
 *
 * ## Why every guarantee here is proved HERE and nowhere else
 *
 * pg-mem does not honour TypeORM's ROLLBACK, has no exclusion constraints, runs
 * no PL/pgSQL and has no `now()` a trigger can compare against. **Every single
 * invariant this story rests on is one of those.** The lifecycle allow-list, the
 * immutability of a published version, the effective-window non-overlap, the
 * deposit-shape and percentage-base CHECKs, non-retroactivity and the
 * transactional audit row are triggers, EXCLUDE constraints and rollbacks. None
 * can be observed on the fast layer, so this file is the evidence or there is
 * none.
 *
 * ## Two kinds of case, deliberately mixed
 *
 * Some drive the SERVICE, which is how an administrator reaches the catalogue.
 * Others issue raw SQL, which is how a future migration, a maintenance script
 * or a bug would reach it. The second kind matters more: a rule the service
 * upholds is a rule the service upholds, and ADR-048's whole claim is that
 * these rules hold against anything holding a connection.
 *
 * Where a case does both, the raw-SQL half is named `(direct SQL)`.
 */
describePg('booking collection policy — publication, lifecycle and constraints (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let policies: BookingCollectionPolicyService;
  let admin: SeededUser;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;

  const VERSIONS = 'commercial.booking_collection_policy_versions';
  const KEYS = 'commercial.booking_collection_policies';

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    policies = app.get(BookingCollectionPolicyService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, `+98914${String(100000 + (sequence % 90000)).slice(0, 6)}`, [
      'administrator',
    ]);
  });

  // -------------------------------------------------------------------------
  // Builders. Real rows through the real service, no fixtures library.
  // -------------------------------------------------------------------------

  const fullOnline: BookingCollectionTermsV1 = {
    contractVersion: 1,
    collectionMode: 'full_payment_online',
    deposit: { kind: 'none' },
  };
  const payAtVenue: BookingCollectionTermsV1 = {
    contractVersion: 1,
    collectionMode: 'pay_at_venue',
    deposit: { kind: 'none' },
  };
  const percentage = (base: BookingCollectionPercentageBase = 'service_total'): BookingCollectionTermsV1 => ({
    contractVersion: 1,
    collectionMode: 'deposit_online_balance_at_venue',
    deposit: { kind: 'percentage', basisPoints: 2_500, percentageBase: base, minimumToman: 0, maximumToman: null },
  });
  const fixed: BookingCollectionTermsV1 = {
    contractVersion: 1,
    collectionMode: 'deposit_online_balance_at_venue',
    deposit: { kind: 'fixed', amountToman: 50_000 },
  };

  async function policyKey(key = nextKey('cp')): Promise<string> {
    await policies.createPolicy(admin.id, key, 'suite policy', 'suite setup');
    return key;
  }

  async function draft(key: string, terms: BookingCollectionTermsV1 = fullOnline, activationEndsAt: Date | null = null) {
    return policies.createVersionDraft(admin.id, { policyKey: key, terms, activationEndsAt }, 'suite setup');
  }

  async function published(key: string, terms: BookingCollectionTermsV1 = fullOnline) {
    const version = await draft(key, terms);
    return policies.publishVersion(admin.id, key, version.version, 'suite setup');
  }

  /** Inserts a version row directly, bypassing the service entirely. */
  async function insertRaw(key: string, columns: Record<string, unknown>): Promise<void> {
    const base: Record<string, unknown> = {
      id: uuidv7(),
      policy_key: key,
      version: 1,
      collection_mode: 'full_payment_online',
      deposit_kind: 'none',
      created_by_label: 'suite',
      ...columns,
    };
    const names = Object.keys(base);
    const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
    await dataSource.query(`INSERT INTO ${VERSIONS} (${names.join(', ')}) VALUES (${placeholders})`, Object.values(base));
  }

  async function rowOf(key: string, version: number): Promise<Record<string, unknown>> {
    const [row] = await dataSource.query(`SELECT * FROM ${VERSIONS} WHERE policy_key = $1 AND version = $2`, [key, version]);
    return row;
  }

  async function auditRows(targetId: string): Promise<Array<Record<string, unknown>>> {
    return dataSource.query(`SELECT action, target_type, reason FROM admin.admin_audit_log WHERE target_id = $1 ORDER BY created_at`, [targetId]);
  }

  // =========================================================================
  // §1. The clean schema, and the zero-row foundation
  // =========================================================================

  describe('§1 schema and the zero-row foundation', () => {
    it('creates the two tables Story #83 owns, and assigns nobody', async () => {
      /*
       * This case used to assert that `seller_collection_policy_assignments`
       * did NOT EXIST. That was true only until Story #104 (`#41d-2a`) landed,
       * so it was a statement about the calendar rather than an invariant --
       * the kind of assertion that must be replaced when it comes due, never
       * deleted quietly.
       *
       * What is permanent is the boundary it was standing in for: #83 ships
       * PUBLICATION, and creates no assignment. Its two halves now live where
       * each can stay true forever -- that #83's own migrations do not create
       * the table is proved by scanning their SQL in
       * `story-83-boundary.spec.ts`, and that #104 enrols nobody is proved
       * here, at runtime, against the real catalogue.
       */
      const tables = await dataSource.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'commercial' ORDER BY tablename`,
      );
      const names = tables.map((t: { tablename: string }) => t.tablename);
      expect(names).toContain('booking_collection_policies');
      expect(names).toContain('booking_collection_policy_versions');

      // Publication changes no seller's behaviour: the assignment table exists
      // and is EMPTY, so every party is unenrolled and on the legacy path.
      const [{ assignments }] = await dataSource.query(
        `SELECT count(*)::int AS assignments FROM commercial.seller_collection_policy_assignments`,
      );
      expect(assignments).toBe(0);
    });

    it('carries every named invariant ADR-048 requires', async () => {
      const constraints = await dataSource.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = '${VERSIONS}'::regclass ORDER BY conname`,
      );
      const names = constraints.map((c: { conname: string }) => c.conname);
      for (const required of [
        'uq_bcpv_key_version',
        'ck_bcpv_lifecycle',
        'ck_bcpv_mode',
        'ck_bcpv_deposit_kind',
        'ck_bcpv_mode_requires_deposit',
        'ck_bcpv_deposit_shape',
        'ck_bcpv_deposit_amount',
        'ck_bcpv_deposit_rate',
        'ck_bcpv_deposit_bounds',
        'ck_bcpv_percentage_base',
        'ck_bcpv_activation_start_pairing',
        'ck_bcpv_window',
        'ck_bcpv_not_retroactive',
        'ck_bcpv_created_actor',
        'ck_bcpv_published_actor',
        'ck_bcpv_retired_actor',
        'ex_bcpv_no_effective_overlap',
      ]) {
        expect(names).toContain(required);
      }

      const triggers = await dataSource.query(
        `SELECT tgname FROM pg_trigger WHERE tgrelid IN ('${VERSIONS}'::regclass, '${KEYS}'::regclass) AND NOT tgisinternal`,
      );
      const triggerNames = triggers.map((t: { tgname: string }) => t.tgname);
      expect(triggerNames).toContain('tg_bcpv_lifecycle');
      expect(triggerNames).toContain('tg_booking_collection_policies_immutable');
    });

    it('declares the effective-window expression IMMUTABLE, which an index requires', async () => {
      const [fn] = await dataSource.query(
        `SELECT provolatile::text AS volatility FROM pg_proc WHERE proname = 'booking_collection_policy_effective_window'`,
      );
      expect(fn.volatility).toBe('i');
    });

    it('holds ZERO policies and ZERO versions, and the API lists nothing', async () => {
      const [{ count: keys }] = await dataSource.query(`SELECT count(*)::int FROM ${KEYS}`);
      const [{ count: versions }] = await dataSource.query(`SELECT count(*)::int FROM ${VERSIONS}`);
      expect(keys).toBe(0);
      expect(versions).toBe(0);

      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/commercial/collection-policies')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(response.body.data.items).toEqual([]);
    });

    it('refuses a version under a key that does not exist, rather than creating one', async () => {
      await expect(draft('never-created')).rejects.toBeInstanceOf(CommercialNotFoundException);
      const [{ count }] = await dataSource.query(`SELECT count(*)::int FROM ${KEYS}`);
      expect(count).toBe(0);
    });
  });

  // =========================================================================
  // §2. Lifecycle
  // =========================================================================

  describe('§2 lifecycle', () => {
    it('walks draft -> published -> retired through the service', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      expect(drafted.lifecycleState).toBe('draft');
      expect(drafted.activationStartsAt).toBeNull();

      const live = await policies.publishVersion(admin.id, key, drafted.version, 'go live');
      expect(live.lifecycleState).toBe('published');
      expect(live.activationStartsAt).not.toBeNull();
      expect(live.publishedAt).not.toBeNull();

      const retired = await policies.retireVersion(admin.id, key, drafted.version, 'superseded');
      expect(retired.lifecycleState).toBe('retired');
      expect(retired.retiredAt).not.toBeNull();
    });

    it('refuses a row born published (direct SQL)', async () => {
      const key = await policyKey();
      await expect(
        insertRaw(key, { lifecycle_state: 'published', published_at: new Date(), published_by_label: 'forged', activation_starts_at: new Date() }),
      ).rejects.toThrow(/must be created as draft/);
    });

    it('refuses publish -> draft and retired -> published (direct SQL)', async () => {
      const key = await policyKey();
      const live = await published(key);
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET lifecycle_state='draft' WHERE id=$1`, [live.id]),
      ).rejects.toThrow(/is not permitted/);

      await policies.retireVersion(admin.id, key, live.version, 'done');
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET lifecycle_state='published' WHERE id=$1`, [live.id]),
      ).rejects.toThrow(/retired and permanently immutable/);
    });

    it('permits discarding a draft and refuses deleting anything else (direct SQL)', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      await policies.discardVersionDraft(admin.id, key, drafted.version, 'wrong terms');
      expect(await rowOf(key, drafted.version)).toBeUndefined();

      const live = await published(key);
      await expect(dataSource.query(`DELETE FROM ${VERSIONS} WHERE id=$1`, [live.id])).rejects.toThrow(
        /cannot be deleted once published/,
      );
      await expect(policies.discardVersionDraft(admin.id, key, live.version, 'too late')).rejects.toBeInstanceOf(
        CommercialLifecycleConflictException,
      );
    });

    it('freezes the terms of a published version, and its identity always (direct SQL)', async () => {
      const key = await policyKey();
      const live = await published(key, percentage());

      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET deposit_basis_points=9999 WHERE id=$1`, [live.id]),
      ).rejects.toThrow(/published and its terms are immutable/);
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET activation_starts_at=now() - interval '1 day' WHERE id=$1`, [live.id]),
      ).rejects.toThrow(/published and its terms are immutable/);
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET version=99 WHERE id=$1`, [live.id]),
      ).rejects.toThrow(/identity is immutable/);
    });

    it('replaces a draft as a whole value, leaving no leftover from the previous shape', async () => {
      const key = await policyKey();
      const drafted = await draft(key, percentage('service_subtotal'));
      expect((await rowOf(key, drafted.version)).percentage_base).toBe('service_subtotal');

      await policies.replaceVersionDraft(admin.id, key, drafted.version, { terms: fixed, activationEndsAt: null }, 'switch');
      const row = await rowOf(key, drafted.version);
      expect(row.deposit_kind).toBe('fixed');
      expect(row.percentage_base).toBeNull();
      expect(row.deposit_basis_points).toBeNull();
      expect(row.deposit_minimum_toman).toBeNull();
      expect(Number(row.deposit_amount_toman)).toBe(50_000);
    });

    it('makes the policy key permanent and unrewritable (direct SQL)', async () => {
      const key = await policyKey();
      await expect(dataSource.query(`UPDATE ${KEYS} SET policy_key='other' WHERE policy_key=$1`, [key])).rejects.toThrow(
        /identity is immutable/,
      );
      await expect(dataSource.query(`DELETE FROM ${KEYS} WHERE policy_key=$1`, [key])).rejects.toThrow(/are permanent/);
    });
  });

  // =========================================================================
  // §3. The database clock, and non-retroactivity
  // =========================================================================

  describe('§3 the clock is PostgreSQL', () => {
    it('takes publication instants from the database, not the API host', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      const [{ before }] = await dataSource.query(`SELECT now() AS before`);
      const live = await policies.publishVersion(admin.id, key, drafted.version, 'go live');
      const [{ after }] = await dataSource.query(`SELECT now() AS after`);

      expect(live.publishedAt!.getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      expect(live.publishedAt!.getTime()).toBeLessThanOrEqual(new Date(after).getTime());
      // Both instants come from the same statement, so they are equal.
      expect(live.activationStartsAt!.toISOString()).toBe(live.publishedAt!.toISOString());
    });

    it('cannot be backdated through the DTO, because the field does not exist', async () => {
      const key = await policyKey();
      const response = await request(app.getHttpServer())
        .post(`/api/v1/admin/commercial/collection-policies/${key}/versions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          collectionMode: 'full_payment_online',
          deposit: { kind: 'none' },
          activationStartsAt: '1999-01-01T00:00:00.000Z',
          reason: 'attempting a backdate',
        })
        .expect(400);
      expect(JSON.stringify(response.body)).toMatch(/activationStartsAt/);

      const [{ count }] = await dataSource.query(`SELECT count(*)::int FROM ${VERSIONS}`);
      expect(count).toBe(0);
    });

    it('cannot be backdated through raw SQL either (direct SQL)', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      await expect(
        dataSource.query(
          `UPDATE ${VERSIONS} SET lifecycle_state='published', published_at=now(), activation_starts_at=now() - interval '1 year', published_by_label='forged' WHERE id=$1`,
          [drafted.id],
        ),
      ).rejects.toThrow(/never retroactive/);
    });

    it('refuses a publication whose published_at is not the database clock (direct SQL)', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      await expect(
        dataSource.query(
          `UPDATE ${VERSIONS} SET lifecycle_state='published', published_at=now() - interval '1 hour', activation_starts_at=now(), published_by_label='forged' WHERE id=$1`,
          [drafted.id],
        ),
      ).rejects.toThrow(/must be the database clock/);
    });

    it('refuses a retirement whose retired_at is not the database clock (direct SQL)', async () => {
      const key = await policyKey();
      const live = await published(key);
      await expect(
        dataSource.query(
          `UPDATE ${VERSIONS} SET lifecycle_state='retired', retired_at=now() + interval '1 year', retired_by_label='forged' WHERE id=$1`,
          [live.id],
        ),
      ).rejects.toThrow(/must be the database clock/);
    });

    it('refuses publishing a version whose forward bound has already closed', async () => {
      const key = await policyKey();
      const soon = new Date(Date.now() + 1_500);
      const drafted = await draft(key, fullOnline, soon);
      await new Promise((resolve) => setTimeout(resolve, 1_800));
      await expect(policies.publishVersion(admin.id, key, drafted.version, 'too late')).rejects.toBeInstanceOf(
        CommercialTermsInvalidException,
      );
    });
  });

  // =========================================================================
  // §4. The effective window — the ADR-048 correction
  // =========================================================================

  describe('§4 effective windows', () => {
    it('refuses a second published version while the first is open-ended and live', async () => {
      const key = await policyKey();
      await published(key);
      const second = await draft(key, payAtVenue);
      await expect(policies.publishVersion(admin.id, key, second.version, 'replace')).rejects.toBeInstanceOf(
        CommercialActivationOverlapException,
      );
    });

    it('publishes a replacement AFTER retirement — the sequence the uncorrected interval made impossible', async () => {
      const key = await policyKey();
      const first = await published(key);
      const second = await draft(key, payAtVenue);

      await policies.retireVersion(admin.id, key, first.version, 'superseded');
      const live = await policies.publishVersion(admin.id, key, second.version, 'replacement');

      expect(live.lifecycleState).toBe('published');
      // Retirement did NOT rewrite the configured window.
      const retired = await rowOf(key, first.version);
      expect(retired.activation_ends_at).toBeNull();
      expect(retired.retired_at).not.toBeNull();
    });

    it('closes an open-ended retired version into a finite historical interval', async () => {
      const [row] = await dataSource.query(
        `SELECT commercial.booking_collection_policy_effective_window(
            '2027-01-01Z'::timestamptz, NULL, 'published', NULL)::text AS live,
          commercial.booking_collection_policy_effective_window(
            '2027-01-01Z'::timestamptz, NULL, 'retired', '2027-07-01Z'::timestamptz)::text AS closed`,
      );
      expect(row.live).toMatch(/infinity\)$/);
      expect(row.closed).toBe('["2027-01-01 00:00:00+00","2027-07-01 00:00:00+00")');
    });

    it('ends at the EARLIER of the configured end and the retirement instant', async () => {
      const [row] = await dataSource.query(
        `SELECT commercial.booking_collection_policy_effective_window(
            '2027-01-01Z'::timestamptz, '2028-01-01Z'::timestamptz, 'retired', '2027-07-01Z'::timestamptz)::text AS retired_early,
          commercial.booking_collection_policy_effective_window(
            '2027-01-01Z'::timestamptz, '2027-03-01Z'::timestamptz, 'retired', '2027-07-01Z'::timestamptz)::text AS retired_late`,
      );
      expect(row.retired_early).toBe('["2027-01-01 00:00:00+00","2027-07-01 00:00:00+00")');
      expect(row.retired_late).toBe('["2027-01-01 00:00:00+00","2027-03-01 00:00:00+00")');
    });

    it('yields an EMPTY interval, not a range error, for a version retired before it activated', async () => {
      const [row] = await dataSource.query(
        `SELECT commercial.booking_collection_policy_effective_window(
            '2030-01-01Z'::timestamptz, NULL, 'retired', '2029-01-01Z'::timestamptz)::text AS window`,
      );
      expect(row.window).toBe('empty');
    });

    it('treats adjacency at the retirement instant as legal, and genuine historical overlap as not', async () => {
      const [row] = await dataSource.query(
        `SELECT (commercial.booking_collection_policy_effective_window('2027-01-01Z'::timestamptz, NULL, 'retired', '2027-06-01Z'::timestamptz)
              && commercial.booking_collection_policy_effective_window('2027-06-01Z'::timestamptz, NULL, 'published', NULL)) AS adjacent,
                (commercial.booking_collection_policy_effective_window('2027-01-01Z'::timestamptz, NULL, 'retired', '2027-07-01Z'::timestamptz)
              && commercial.booking_collection_policy_effective_window('2027-06-01Z'::timestamptz, NULL, 'retired', '2027-09-01Z'::timestamptz)) AS overlapping`,
      );
      // The second is the positive control: historical overlap is DETECTED,
      // which is what makes the constraint's refusal of it meaningful.
      expect(row.adjacent).toBe(false);
      expect(row.overlapping).toBe(true);
    });

    it('leaves no pair of historical effective intervals overlapping after a full cycle', async () => {
      const key = await policyKey();
      const first = await published(key);
      await policies.retireVersion(admin.id, key, first.version, 'superseded');
      const second = await draft(key, payAtVenue);
      await policies.publishVersion(admin.id, key, second.version, 'replacement');

      const [{ overlaps }] = await dataSource.query(
        `SELECT count(*)::int AS overlaps
           FROM ${VERSIONS} a JOIN ${VERSIONS} b
             ON a.policy_key = b.policy_key AND a.id < b.id
            AND commercial.booking_collection_policy_effective_window(a.activation_starts_at, a.activation_ends_at, a.lifecycle_state, a.retired_at)
             && commercial.booking_collection_policy_effective_window(b.activation_starts_at, b.activation_ends_at, b.lifecycle_state, b.retired_at)`,
      );
      expect(overlaps).toBe(0);
    });
  });

  // =========================================================================
  // §5. Concurrency — the database decides
  // =========================================================================

  describe('§5 concurrency', () => {
    it('lets exactly one of two concurrent publications survive', async () => {
      const key = await policyKey();
      const a = await draft(key, fullOnline);
      const b = await draft(key, payAtVenue);

      const results = await Promise.allSettled([
        policies.publishVersion(admin.id, key, a.version, 'race a'),
        policies.publishVersion(admin.id, key, b.version, 'race b'),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int FROM ${VERSIONS} WHERE policy_key=$1 AND lifecycle_state='published'`,
        [key],
      );
      expect(count).toBe(1);
    });

    it('allocates distinct version numbers under concurrent drafting', async () => {
      const key = await policyKey();
      const results = await Promise.allSettled([draft(key), draft(key), draft(key)]);
      const versions = results
        .flatMap((r) => (r.status === 'fulfilled' ? [r.value.version] : []));
      expect(new Set(versions).size).toBe(versions.length);
    });
  });

  // =========================================================================
  // §6. Every invalid shape, refused by the database
  // =========================================================================

  describe('§6 invalid shapes (direct SQL)', () => {
    it.each([
      ['a deposit rule outside deposit mode', { collection_mode: 'full_payment_online', deposit_kind: 'fixed', deposit_amount_toman: 1 }],
      ['deposit mode with no rule', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'none' }],
      ['a fixed rule carrying a rate', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'fixed', deposit_amount_toman: 1, deposit_basis_points: 100 }],
      ['a percentage rule with no base', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'percentage', deposit_basis_points: 100, deposit_minimum_toman: 0 }],
      ['a percentage base on a fixed rule', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'fixed', deposit_amount_toman: 1, percentage_base: 'service_total' }],
      ['an unknown percentage base', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'percentage', deposit_basis_points: 100, deposit_minimum_toman: 0, percentage_base: 'service_after_tax' }],
      ['a zero-basis-point rate', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'percentage', deposit_basis_points: 0, deposit_minimum_toman: 0, percentage_base: 'service_total' }],
      ['a rate above 10000', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'percentage', deposit_basis_points: 10_001, deposit_minimum_toman: 0, percentage_base: 'service_total' }],
      ['a zero fixed amount', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'fixed', deposit_amount_toman: 0 }],
      ['a maximum below the minimum', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'percentage', deposit_basis_points: 100, deposit_minimum_toman: 100, deposit_maximum_toman: 99, percentage_base: 'service_total' }],
      ['an unknown collection mode', { collection_mode: 'invoice_later', deposit_kind: 'none' }],
      ['an unknown deposit kind', { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'installments' }],
      ['an unknown lifecycle state', { lifecycle_state: 'archived' }],
      ['a draft carrying an activation start', { activation_starts_at: new Date() }],
      ['both an actor id and a label', { created_by_user_id: '01930000-0000-7000-8000-00000000000f', created_by_label: 'both' }],
    ])('refuses %s', async (_label, columns) => {
      const key = await policyKey();
      await expect(insertRaw(key, columns)).rejects.toThrow();
      const [{ count }] = await dataSource.query(`SELECT count(*)::int FROM ${VERSIONS} WHERE policy_key=$1`, [key]);
      expect(count).toBe(0);
    });

    it('accepts each VALID shape, so the refusals above mean something', async () => {
      for (const [index, columns] of [
        { collection_mode: 'pay_at_venue', deposit_kind: 'none' },
        { collection_mode: 'full_payment_online', deposit_kind: 'none' },
        { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'fixed', deposit_amount_toman: 1 },
        { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'percentage', deposit_basis_points: 1, deposit_minimum_toman: 0, percentage_base: 'service_subtotal' },
        { collection_mode: 'deposit_online_balance_at_venue', deposit_kind: 'percentage', deposit_basis_points: 10_000, deposit_minimum_toman: 0, deposit_maximum_toman: 10, percentage_base: 'service_total' },
      ].entries()) {
        const key = await policyKey(nextKey(`ok${index}`));
        await expect(insertRaw(key, columns)).resolves.toBeUndefined();
      }
    });
  });

  // =========================================================================
  // §7. Authorization, audit and the request surface
  // =========================================================================

  describe('§7 authorization, audit and refusals', () => {
    it('refuses every new route without the privileged capability, with a 404 control', async () => {
      const nobody = await seedUser(app, dataSource, '+989140000001', ['customer']);
      const routes: Array<[string, string]> = [
        ['get', '/api/v1/admin/commercial/collection-policies'],
        ['post', '/api/v1/admin/commercial/collection-policies'],
        ['get', '/api/v1/admin/commercial/collection-policies/k/versions'],
        ['post', '/api/v1/admin/commercial/collection-policies/k/versions'],
        ['put', '/api/v1/admin/commercial/collection-policies/k/versions/1'],
        ['post', '/api/v1/admin/commercial/collection-policies/k/versions/1/publish'],
        ['post', '/api/v1/admin/commercial/collection-policies/k/versions/1/retire'],
        ['delete', '/api/v1/admin/commercial/collection-policies/k/versions/1'],
      ];

      for (const [method, path] of routes) {
        const agent = request(app.getHttpServer()) as unknown as Record<string, (p: string) => request.Test>;
        await agent[method](path).expect(401);
        await agent[method](path).set('Authorization', `Bearer ${nobody.accessToken}`).expect(403);
      }

      // The control: a route that genuinely does not exist is a 404, so the
      // 401/403 above are the guard and not a missing handler.
      await request(app.getHttpServer())
        .get('/api/v1/admin/commercial/collection-policies-that-do-not-exist')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(404);
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      const key = await policyKey();
      await request(app.getHttpServer())
        .post(`/api/v1/admin/commercial/collection-policies/${key}/versions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ collectionMode: 'full_payment_online', deposit: { kind: 'none' }, lifecycleState: 'published', reason: 'forged' })
        .expect(400);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/commercial/collection-policies`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ policyKey: nextKey('k'), displayName: 'x', createdByUserId: admin.id, reason: 'forged actor' })
        .expect(400);
    });

    it('writes exactly one audit row per real mutation, and none for a read', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      await policies.publishVersion(admin.id, key, drafted.version, 'go live');
      await policies.retireVersion(admin.id, key, drafted.version, 'superseded');

      const rows = await auditRows(`${key}@${drafted.version}`);
      expect(rows.map((r) => r.action)).toEqual([
        'commercial.collection_policy_version_drafted',
        'commercial.collection_policy_version_published',
        'commercial.collection_policy_version_retired',
      ]);
      expect(rows.every((r) => typeof r.reason === 'string' && (r.reason as string).length >= 3)).toBe(true);

      const before = await dataSource.query(`SELECT count(*)::int FROM admin.admin_audit_log`);
      await policies.listVersions(key);
      await policies.getVersion(key, drafted.version);
      const after = await dataSource.query(`SELECT count(*)::int FROM admin.admin_audit_log`);
      expect(after[0].count).toBe(before[0].count);
    });

    it('writes nothing at all when the request is refused before the transaction opens', async () => {
      const key = await policyKey();
      const before = await dataSource.query(`SELECT count(*)::int FROM admin.admin_audit_log`);

      // A reason of one character fails the service's own trim check, after the
      // key exists and before anything is written.
      await expect(
        policies.createVersionDraft(admin.id, { policyKey: key, terms: fullOnline, activationEndsAt: null }, ' x '),
      ).rejects.toThrow();

      const [{ count }] = await dataSource.query(`SELECT count(*)::int FROM ${VERSIONS} WHERE policy_key=$1`, [key]);
      expect(count).toBe(0);
      const after = await dataSource.query(`SELECT count(*)::int FROM admin.admin_audit_log`);
      expect(after[0].count).toBe(before[0].count);
    });

    /**
     * The audit row and the domain row commit together, or neither does.
     *
     * The refusal above does not prove this, and an earlier version of this
     * suite mistook it for proof: it fails before `dataSource.transaction` ever
     * opens, so nothing is written either way and an audit service writing on a
     * SEPARATE connection would pass it unchanged. A mutation probe caught that.
     *
     * This case distinguishes them. `AdminAuditService.record` is patched to
     * write its row and then throw, which is the only ordering that tells the
     * two apart:
     *
     *   - sharing the caller's `EntityManager` -> the audit INSERT is inside the
     *     domain transaction, the throw rolls both back, and NO audit row
     *     survives;
     *   - opening its own connection -> the audit INSERT has already committed
     *     when the domain transaction rolls back, and the row SURVIVES,
     *     attributing a publication that never happened.
     *
     * Patching a service method inside a real-database spec follows the
     * precedent `subscription-foundation.pg-spec.ts` sets for the same kind of
     * seam.
     */
    it('rolls the DOMAIN row back when the audit write fails after inserting', async () => {
      const key = await policyKey();
      const audit = app.get(AdminAuditService) as unknown as {
        record: (manager: EntityManager, input: Parameters<AdminAuditService['record']>[1]) => Promise<void>;
      };
      const original = audit.record.bind(audit);

      const before = await dataSource.query(`SELECT count(*)::int FROM admin.admin_audit_log`);
      audit.record = async (manager, input) => {
        await original(manager, input);
        throw new Error('probe: the audit row is written, then the mutation fails');
      };

      try {
        await expect(
          policies.createVersionDraft(admin.id, { policyKey: key, terms: percentage(), activationEndsAt: null }, 'atomicity'),
        ).rejects.toThrow(/probe/);
      } finally {
        audit.record = original;
      }

      const [{ count: versions }] = await dataSource.query(
        `SELECT count(*)::int FROM ${VERSIONS} WHERE policy_key=$1`,
        [key],
      );
      const after = await dataSource.query(`SELECT count(*)::int FROM admin.admin_audit_log`);

      expect(versions).toBe(0);
      expect(after[0].count).toBe(before[0].count);
    });

    it('the atomicity case is not vacuous: the same audit write DOES land on success', async () => {
      const key = await policyKey();
      const before = await dataSource.query(`SELECT count(*)::int FROM admin.admin_audit_log`);
      await draft(key, percentage());
      const after = await dataSource.query(`SELECT count(*)::int FROM admin.admin_audit_log`);
      expect(after[0].count).toBe(before[0].count + 1);
    });

    it('never returns an actor identity from a read', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      await policies.publishVersion(admin.id, key, drafted.version, 'go live');

      const listed = await request(app.getHttpServer())
        .get(`/api/v1/admin/commercial/collection-policies/${key}/versions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      const body = JSON.stringify(listed.body);
      expect(body).not.toContain(admin.id);
      expect(body).not.toMatch(/createdBy|publishedBy|retiredBy|_user_id|byLabel/);

      const keys = await request(app.getHttpServer())
        .get('/api/v1/admin/commercial/collection-policies')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(JSON.stringify(keys.body)).not.toContain(admin.id);
    });
  });

  // =========================================================================
  // §8. The #104 boundary — nothing in commerce moved
  // =========================================================================

  describe('§8 the #104 boundary', () => {
    it('changes no order or payment-schedule row across a full publish/retire cycle', async () => {
      const snapshot = async () =>
        dataSource.query(
          `SELECT (SELECT count(*)::int FROM commerce.orders) AS orders,
                  (SELECT count(*)::int FROM commerce.order_payment_schedules) AS schedules,
                  (SELECT count(*)::int FROM commerce.order_payment_schedules WHERE policy_key IS NOT NULL) AS with_policy,
                  (SELECT count(*)::int FROM commerce.order_payment_schedules WHERE policy_accepted_at IS NOT NULL) AS accepted`,
        );

      const before = await snapshot();
      const key = await policyKey();
      const live = await published(key, percentage());
      await policies.retireVersion(admin.id, key, live.version, 'superseded');
      const after = await snapshot();

      expect(after).toEqual(before);
      expect(after[0].with_policy).toBe(0);
      expect(after[0].accepted).toBe(0);
    });

    it('writes no commerce row and owns no commerce migration', async () => {
      /*
       * This case used to assert that `ck_ops_policy_reference` still required
       * all THREE columns -- "#104 replaces this; #83 must not have touched
       * it". That was a statement about the calendar, not an invariant: V3.3
       * #115 (`#41d-2b`) has since replaced the constraint exactly as ADR-048
       * §2 ratifies, so key and version are now all-or-none and
       * `policy_accepted_at` is independently nullable.
       *
       * The permanent claim underneath it is that PUBLICATION touches commerce
       * at all -- no row, and no migration of its own. That stays true forever,
       * and it is what this now asserts.
       */
      const [reference] = await dataSource.query(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'ck_ops_policy_reference'`,
      );
      // #115's shape, not #83's doing.
      expect(reference.definition).not.toContain('policy_accepted_at');

      // Publication wrote nothing into commerce.
      const [{ schedules }] = await dataSource.query(
        `SELECT count(*)::int AS schedules FROM commerce.order_payment_schedules`,
      );
      expect(schedules).toBe(0);

      /*
       * And #83 owns no commerce migration.
       *
       * Matched on `booking_collection_polic`, which is #83's own naming, not
       * on a bare "collection" -- that matched
       * `20260905900002_add_online_collection_not_required_status.sql`, which
       * is #82's and predates this story entirely.
       */
      const owned = await dataSource.query(
        `SELECT filename FROM public.schema_migrations
          WHERE filename LIKE 'commerce/%' AND filename LIKE '%booking_collection_polic%'`,
      );
      expect(owned).toEqual([]);
    });

    it('adds no capability of its own, and does not widen the one #104 added', async () => {
      /*
       * Also formerly temporal: it asserted that NO `%collection%` capability
       * existed anywhere, which Story #104 legitimately ended by adding
       * `bc_manage_own_collection_policy`.
       *
       * The permanent claim is that publication stays on the PRIVILEGED
       * administrator capability and grants nothing to a seller. So the set is
       * still exact -- there is exactly one, it belongs to #104, it is
       * non-privileged, and it reaches only the two seller roles. A #83
       * migration that quietly granted itself a capability would still fail
       * here, which is what the original case was for.
       */
      const rows: Array<{ slug: string }> = await dataSource.query(
        `SELECT slug FROM identity.capabilities WHERE slug LIKE '%collection%' ORDER BY slug`,
      );
      expect(rows.map((row) => row.slug)).toEqual(['bc_manage_own_collection_policy']);

      const [capability] = await dataSource.query(
        `SELECT is_privileged FROM identity.capabilities WHERE slug = 'bc_manage_own_collection_policy'`,
      );
      expect(capability.is_privileged).toBe(false);

      const grants: Array<{ role_slug: string }> = await dataSource.query(
        `SELECT role_slug FROM identity.role_capabilities
          WHERE capability_slug = 'bc_manage_own_collection_policy' ORDER BY role_slug`,
      );
      expect(grants.map((row) => row.role_slug)).toEqual(['business', 'professional']);
    });
  });

  // =========================================================================
  // §9. Privacy
  // =========================================================================

  describe('§9 privacy coverage', () => {
    it('claims both new tables, and the exact-set check sees them', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const claimed = contracts.flatMap((contract) => contract.tables.map((table) => table.table));
      expect(claimed).toContain('commercial.booking_collection_policies');
      expect(claimed).toContain('commercial.booking_collection_policy_versions');

      const rows = await dataSource.query(
        `SELECT t.schemaname AS schema, t.tablename AS name,
                array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM pg_tables t
           JOIN information_schema.columns c
             ON c.table_schema = t.schemaname AND c.table_name = t.tablename
          WHERE t.schemaname = 'commercial'
          GROUP BY t.schemaname, t.tablename`,
      );
      // Thirteen: the ten that predate #83, the two collection-policy tables
      // #83 added, and the one assignment table Story #104 added with its own
      // claim. Asserted exactly, so a table added without a claim fails HERE
      // with a readable message rather than at application boot -- which is
      // what this number is for, and why it is bumped deliberately rather than
      // loosened to a lower bound.
      expect(rows).toHaveLength(13);

      const report = evaluateCoverage(rows, contracts);
      expect(report.violations.filter((v) => v.table.startsWith('commercial.'))).toEqual([]);
    });

    it('claims them RETAINED rather than no_subject_data, matching their actor columns', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const claims = contracts
        .flatMap((contract) => contract.tables)
        .filter((table) => table.table.includes('booking_collection'));
      expect(claims).toHaveLength(2);
      for (const claim of claims) {
        expect(claim.disposition).toBe('retained');
        expect((claim.reason ?? '').length).toBeGreaterThan(40);
      }

      // The claim is truthful: both tables really do carry subject columns.
      const columns = await dataSource.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='commercial' AND table_name LIKE 'booking_collection%' AND column_name LIKE '%_user_id'`,
      );
      expect(columns.length).toBeGreaterThanOrEqual(4);
    });

    it('reports erasure truthfully — nothing anonymized, nothing deleted, both tables retained', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const commercial = contracts.find((contract) => contract.moduleKey === 'commercial');
      const outcome = await commercial!.eraseSubjectData(dataSource.manager, admin.id, {
        userId: admin.id,
        phoneAlias: 'del:story83',
        displayAlias: 'x',
        erasedAt: new Date(),
      });
      expect(outcome.anonymized).toBe(0);
      expect(outcome.deleted).toBe(0);
      expect(outcome.retained.map((r) => r.table)).toEqual(
        expect.arrayContaining([
          'commercial.booking_collection_policies',
          'commercial.booking_collection_policy_versions',
        ]),
      );

      const exported = await commercial!.exportSubjectData(dataSource.manager, admin.id);
      expect(exported).toEqual([]);
    });
  });
});
