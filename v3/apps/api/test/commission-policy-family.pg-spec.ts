import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage, tombstoneFor } from '@beauclick/subject-data';
import { COMMISSION_ARITHMETIC_VERSION } from '@beauclick/commercial-policy-contract';
import {
  COMMISSION_AUDIT_ACTIONS,
  CommercialActivationOverlapException,
  CommercialLifecycleConflictException,
  CommercialNotFoundException,
  CommercialTermsInvalidException,
  CommissionPolicyService,
  CommissionRuleInput,
} from '@beauclick/commercial-policy';

import { PgTestApp, SeededUser, createPgTestApp, requiredPgEnv, resetDatabase, seedUser } from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * The `#43b-1` commission publication plane against a real PostgreSQL server —
 * V3.3 Story #173, ADR-052 §1 and §3, `V33-DEC-040` R1.
 *
 * ## Why every guarantee here is proved HERE and nowhere else
 *
 * pg-mem has no exclusion constraints, runs no PL/pgSQL, does not honour
 * TypeORM's ROLLBACK and has no `now()` a trigger can compare against. Every
 * invariant this story rests on is one of those: the four-shape CHECK matrix,
 * the lifecycle allow-list, published immutability, the effective-window
 * exclusion, one key per component, non-retroactivity, the transactional
 * audit row and — the one this family adds to the house style — a publication
 * instant that must EQUAL the transaction clock with no tolerance.
 *
 * ## Every probe bypasses the service at least once
 *
 * A guarantee that only the service upholds is a guarantee an operator, a
 * migration or a future story can walk around. Each constraint below is
 * therefore also attacked with raw SQL, and each raw attack is paired with a
 * positive control proving the same statement succeeds when it should.
 *
 * ## Values in this file are TEST values
 *
 * Every basis-point figure and toman amount below is a suite fixture chosen to
 * exercise a constraint. None is a product value, none is an owner-endorsed
 * publication value, and none reaches any migration, seed or default —
 * `story-43b1-boundary.spec.ts` proves that against the real files.
 */
describePg('commission policy family — publication plane (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let policies: CommissionPolicyService;
  let admin: SeededUser;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;

  const BASE = '/api/v1/admin/commercial';
  const KEYS = 'commercial.commission_policies';
  const VERSIONS = 'commercial.commission_policy_versions';

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    policies = app.get(CommissionPolicyService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, `+98913${String(100000 + (sequence % 90000)).slice(0, 6)}`, ['administrator']);
  });

  // -------------------------------------------------------------------------
  // Builders. Real rows through the real service.
  // -------------------------------------------------------------------------

  const rule = (overrides: Partial<CommissionRuleInput> = {}): CommissionRuleInput => ({
    ruleKind: 'percentage',
    basisPoints: 1_500,
    fixedToman: null,
    base: 'platform_collected_amount',
    activationEndsAt: null,
    ...overrides,
  });

  async function policyKey(component: 'booking_commission' | 'acquisition' | 'processing_recovery' = 'booking_commission') {
    const key = nextKey('cm');
    await policies.createPolicy(admin.id, key, component, 'suite commission policy', 'suite setup');
    return key;
  }

  async function draft(key: string, input: CommissionRuleInput = rule()) {
    return policies.createVersionDraft(admin.id, key, input, 'suite setup');
  }

  async function published(key: string, input: CommissionRuleInput = rule()) {
    const version = await draft(key, input);
    return policies.publishVersion(admin.id, key, version.version, 'suite setup');
  }

  /** Inserts a version row directly, bypassing the service entirely. */
  async function insertRawVersion(key: string, columns: Record<string, unknown>): Promise<string> {
    const base: Record<string, unknown> = {
      id: uuidv7(),
      policy_key: key,
      version: 1,
      rule_kind: 'zero',
      arithmetic_version: COMMISSION_ARITHMETIC_VERSION,
      created_by_label: 'suite',
      ...columns,
    };
    const names = Object.keys(base);
    const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
    await dataSource.query(`INSERT INTO ${VERSIONS} (${names.join(', ')}) VALUES (${placeholders})`, Object.values(base));
    return base.id as string;
  }

  /**
   * Audit rows for ONE policy key.
   *
   * `admin.admin_audit_log` deliberately survives `resetDatabase` — the
   * application role cannot TRUNCATE its own audit trail — so rows accumulate
   * for the life of the database, across cases and across earlier runs. A
   * time window is not a filter: every case in this suite writes within the
   * same minute. The key is, because `nextKey` makes it unique per case and
   * every `target_id` here is either the key or `key@version`.
   */
  const auditRowsFor = async (key: string, action?: string) =>
    dataSource.query(
      `SELECT action, target_type, target_id, reason, actor_user_id
         FROM admin.admin_audit_log
        WHERE (target_id = $1 OR target_id LIKE $1 || '@%')${action ? ' AND action = $2' : ''}
        ORDER BY created_at`,
      action ? [key, action] : [key],
    );

  // =========================================================================
  // §1. The key: one per component, immutable, undeletable behind versions
  // =========================================================================

  describe('§1 the policy key', () => {
    it('admits one key per component and refuses a second, through the service and through raw SQL alike', async () => {
      await policyKey('booking_commission');
      await expect(policyKey('booking_commission')).rejects.toBeInstanceOf(Error);

      // Raw, bypassing every service check.
      await expect(
        dataSource.query(
          `INSERT INTO ${KEYS} (policy_key, component, display_name, created_by_label) VALUES ($1, $2, $3, $4)`,
          [nextKey('raw'), 'booking_commission', 'raw', 'suite'],
        ),
      ).rejects.toThrow(/uq_cp_component/);

      // Positive control: a DIFFERENT component is accepted on the same path.
      await dataSource.query(
        `INSERT INTO ${KEYS} (policy_key, component, display_name, created_by_label) VALUES ($1, $2, $3, $4)`,
        [nextKey('raw'), 'acquisition', 'raw', 'suite'],
      );
    });

    it('refuses a component outside the closed vocabulary', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO ${KEYS} (policy_key, component, display_name, created_by_label) VALUES ($1, $2, $3, $4)`,
          [nextKey('raw'), 'platform_tip', 'raw', 'suite'],
        ),
      ).rejects.toThrow(/ck_cp_component/);
    });

    it('freezes the key and its component, and refuses deletion while versions exist', async () => {
      const key = await policyKey();
      await draft(key);

      await expect(dataSource.query(`UPDATE ${KEYS} SET component = 'acquisition' WHERE policy_key = $1`, [key])).rejects.toThrow(
        /identity is immutable/,
      );
      await expect(dataSource.query(`DELETE FROM ${KEYS} WHERE policy_key = $1`, [key])).rejects.toThrow(
        /cannot be deleted while versions exist/,
      );

      // Positive control: a key with no versions is deletable.
      const spare = await policyKey('processing_recovery');
      await dataSource.query(`DELETE FROM ${KEYS} WHERE policy_key = $1`, [spare]);
    });
  });

  // =========================================================================
  // §2. The four shapes
  // =========================================================================

  describe('§2 the shape matrix', () => {
    it('accepts exactly the four shapes ADR-052 §1 names', async () => {
      const key = await policyKey();
      const shapes: CommissionRuleInput[] = [
        rule({ ruleKind: 'zero', basisPoints: null, base: null }),
        rule({ ruleKind: 'percentage', basisPoints: 0, base: 'service_total' }),
        rule({ ruleKind: 'fixed', basisPoints: null, base: null, fixedToman: 50_000 }),
        rule({ ruleKind: 'hybrid', basisPoints: 500, base: 'service_total', fixedToman: 0 }),
      ];
      for (const shape of shapes) {
        const created = await draft(key, shape);
        expect(created.ruleKind).toBe(shape.ruleKind);
        expect(created.arithmeticVersion).toBe(COMMISSION_ARITHMETIC_VERSION);
      }
    });

    it.each([
      ['zero carrying a rate', { rule_kind: 'zero', bp: 100 }],
      ['zero carrying an amount', { rule_kind: 'zero', fixed_toman: 1 }],
      ['percentage without a base', { rule_kind: 'percentage', bp: 100 }],
      ['percentage without a rate', { rule_kind: 'percentage', base: 'service_total' }],
      ['percentage carrying an amount', { rule_kind: 'percentage', bp: 100, base: 'service_total', fixed_toman: 1 }],
      ['fixed at zero', { rule_kind: 'fixed', fixed_toman: 0 }],
      ['fixed carrying a rate', { rule_kind: 'fixed', fixed_toman: 10, bp: 1 }],
      ['fixed carrying a base', { rule_kind: 'fixed', fixed_toman: 10, base: 'service_total' }],
      ['hybrid without an amount', { rule_kind: 'hybrid', bp: 100, base: 'service_total' }],
      ['hybrid without a base', { rule_kind: 'hybrid', bp: 100, fixed_toman: 10 }],
    ])('refuses %s in the database, not merely in the service', async (_label, columns) => {
      const key = await policyKey();
      await expect(insertRawVersion(key, columns)).rejects.toThrow(/ck_cpv_shape/);
    });

    it('refuses a rate above 100% and a rule kind outside the vocabulary', async () => {
      const key = await policyKey();
      await expect(insertRawVersion(key, { rule_kind: 'percentage', bp: 10_001, base: 'service_total' })).rejects.toThrow(
        /ck_cpv_bp_range/,
      );
      await expect(insertRawVersion(key, { rule_kind: 'tiered' })).rejects.toThrow(/ck_cpv_rule_kind/);
      await expect(insertRawVersion(key, { rule_kind: 'percentage', bp: 100, base: 'gross_merchandise_value' })).rejects.toThrow(
        /ck_cpv_base/,
      );
    });

    it('tells an administrator which field is wrong instead of naming a constraint', async () => {
      const key = await policyKey();
      await expect(draft(key, rule({ ruleKind: 'fixed', fixedToman: 0, basisPoints: null, base: null }))).rejects.toBeInstanceOf(
        CommercialTermsInvalidException,
      );
      await expect(draft(key, rule({ ruleKind: 'percentage', base: null }))).rejects.toBeInstanceOf(
        CommercialTermsInvalidException,
      );
    });
  });

  // =========================================================================
  // §3. Lifecycle and immutability
  // =========================================================================

  describe('§3 lifecycle', () => {
    it('cannot be born published', async () => {
      const key = await policyKey();
      await expect(
        insertRawVersion(key, {
          lifecycle_state: 'published',
          published_at: new Date(),
          published_by_label: 'suite',
          activation_starts_at: new Date(),
        }),
      ).rejects.toThrow(/must be created as draft/);
    });

    it('runs draft -> published -> retired and never backwards', async () => {
      const key = await policyKey();
      const version = await published(key);
      expect(version.lifecycleState).toBe('published');

      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET lifecycle_state = 'draft' WHERE id = $1`, [version.id]),
      ).rejects.toThrow(/never backwards/);

      const retired = await policies.retireVersion(admin.id, key, version.version, 'suite');
      expect(retired.lifecycleState).toBe('retired');
      expect(retired.retiredAt).not.toBeNull();

      await expect(policies.publishVersion(admin.id, key, version.version, 'suite')).rejects.toBeInstanceOf(
        CommercialLifecycleConflictException,
      );
    });

    it('freezes the rule the moment it leaves draft, and refuses deletion of a published version', async () => {
      const key = await policyKey();
      const version = await published(key);

      await expect(dataSource.query(`UPDATE ${VERSIONS} SET bp = 1 WHERE id = $1`, [version.id])).rejects.toThrow(
        /rule is immutable/,
      );
      await expect(dataSource.query(`DELETE FROM ${VERSIONS} WHERE id = $1`, [version.id])).rejects.toThrow(
        /cannot be deleted once published/,
      );

      // Positive control: a draft is editable and discardable.
      const editable = await draft(key, rule({ basisPoints: 100 }));
      const replaced = await policies.replaceVersionDraft(admin.id, key, editable.version, rule({ basisPoints: 250 }), 'suite');
      expect(replaced.basisPoints).toBe(250);
      await policies.discardVersionDraft(admin.id, key, editable.version, 'suite');
      await expect(policies.getVersion(key, editable.version)).rejects.toBeInstanceOf(CommercialNotFoundException);
    });

    it('a retired version is permanently immutable', async () => {
      const key = await policyKey();
      const version = await published(key);
      await policies.retireVersion(admin.id, key, version.version, 'suite');
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET activation_ends_at = now() + INTERVAL '1 day' WHERE id = $1`, [version.id]),
      ).rejects.toThrow(/retired and permanently immutable/);
    });
  });

  // =========================================================================
  // §4. The publication instant — ADR-052 §1's no-tolerance rule
  // =========================================================================

  describe('§4 the publication instant', () => {
    it('must EQUAL the transaction clock: one second early is refused, where every other family would accept it', async () => {
      const key = await policyKey();
      const version = await draft(key);

      // The ±1 minute the outcome and collection families allow.
      for (const skew of ["INTERVAL '1 second'", "INTERVAL '30 seconds'"]) {
        await expect(
          dataSource.query(
            `UPDATE ${VERSIONS}
                SET lifecycle_state = 'published', published_at = now() - ${skew},
                    published_by_label = 'suite', activation_starts_at = now()
              WHERE id = $1`,
            [version.id],
          ),
        ).rejects.toThrow(/exactly the transaction clock/);
      }

      // Positive control: the same statement with `now()` succeeds.
      await dataSource.query(
        `UPDATE ${VERSIONS}
            SET lifecycle_state = 'published', published_at = now(),
                published_by_label = 'suite', activation_starts_at = now()
          WHERE id = $1`,
        [version.id],
      );
      const [row] = await dataSource.query(`SELECT lifecycle_state FROM ${VERSIONS} WHERE id = $1`, [version.id]);
      expect(row.lifecycle_state).toBe('published');
    });

    it('retirement takes the same instant rule', async () => {
      const key = await policyKey();
      const version = await published(key);
      await expect(
        dataSource.query(
          `UPDATE ${VERSIONS} SET lifecycle_state = 'retired', retired_at = now() - INTERVAL '2 seconds', retired_by_label = 'suite' WHERE id = $1`,
          [version.id],
        ),
      ).rejects.toThrow(/exactly the transaction clock/);
    });

    it('is never retroactive: activation cannot precede publication', async () => {
      const key = await policyKey();
      const version = await draft(key);
      await expect(
        dataSource.query(
          `UPDATE ${VERSIONS}
              SET lifecycle_state = 'published', published_at = now(),
                  published_by_label = 'suite', activation_starts_at = now() - INTERVAL '1 hour'
            WHERE id = $1`,
          [version.id],
        ),
      ).rejects.toThrow(/never retroactive|ck_cpv_not_retroactive/);
    });

    it('publishes with activation exactly at the publication instant, reachable by a reader', async () => {
      const key = await policyKey();
      const version = await published(key);
      expect(version.activationStartsAt).not.toBeNull();
      expect(version.publishedAt).not.toBeNull();
      expect(version.activationStartsAt!.getTime()).toBe(version.publishedAt!.getTime());
    });
  });

  // =========================================================================
  // §5. The effective window
  // =========================================================================

  describe('§5 the effective window', () => {
    it('refuses two versions of one key effective at the same instant', async () => {
      const key = await policyKey();
      await published(key);
      const second = await draft(key, rule({ basisPoints: 2_000 }));
      await expect(policies.publishVersion(admin.id, key, second.version, 'suite')).rejects.toBeInstanceOf(
        CommercialActivationOverlapException,
      );
    });

    it('frees the timeline on retirement, so a replacement may start at the retirement instant', async () => {
      const key = await policyKey();
      const first = await published(key);
      await policies.retireVersion(admin.id, key, first.version, 'suite');

      const second = await draft(key, rule({ basisPoints: 2_000 }));
      const republished = await policies.publishVersion(admin.id, key, second.version, 'suite');
      expect(republished.lifecycleState).toBe('published');

      // And the historical interval is still occupied: the retired row stays
      // in the index, so a backdated overlap remains unrepresentable.
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM ${VERSIONS} WHERE policy_key = $1 AND lifecycle_state <> 'draft'`,
        [key],
      );
      expect(count).toBe(2);
    });

    it('lets two drafts coexist for the same period — the constraint decides at publication', async () => {
      const key = await policyKey();
      await draft(key, rule({ basisPoints: 100 }));
      await draft(key, rule({ basisPoints: 200 }));
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM ${VERSIONS} WHERE policy_key = $1 AND lifecycle_state = 'draft'`,
        [key],
      );
      expect(count).toBe(2);
    });

    it('keeps each component independent: publishing one never blocks another', async () => {
      const booking = await policyKey('booking_commission');
      const acquisition = await policyKey('acquisition');
      await published(booking);
      const other = await published(acquisition, rule({ ruleKind: 'fixed', fixedToman: 25_000, basisPoints: null, base: null }));
      expect(other.lifecycleState).toBe('published');
    });
  });

  // =========================================================================
  // §6. Authorization and audit
  // =========================================================================

  describe('§6 authorization and audit', () => {
    it('refuses every mutation without the privileged capability, and every one without a token', async () => {
      const key = await policyKey();
      const seller = await seedUser(app, dataSource, `+98912${String(200000 + sequence).slice(0, 6)}`, ['professional']);

      // Every mutation on the surface is a POST, so the sweep needs no
      // dynamic method dispatch — each entry is a path and the body it takes.
      const mutations: Array<[string, Record<string, unknown>]> = [
        [`${BASE}/commission-policies`, { policyKey: nextKey('x'), component: 'acquisition', displayName: 'x', reason: 'r' }],
        [`${BASE}/commission-policies/${key}/versions`, { ruleKind: 'zero', reason: 'r' }],
        [`${BASE}/commission-policies/${key}/versions/1/publish`, { reason: 'r' }],
        [`${BASE}/commission-policies/${key}/versions/1/retire`, { reason: 'r' }],
      ];

      for (const [path, body] of mutations) {
        await request(app.getHttpServer()).post(path).send(body).expect(401);
        await request(app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${seller.accessToken}`)
          .send(body)
          .expect(403);
      }

      // The reads are gated by the same class-level capability.
      for (const path of [`${BASE}/commission-policies`, `${BASE}/commission-policies/${key}/versions`]) {
        await request(app.getHttpServer()).get(path).expect(401);
        await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${seller.accessToken}`).expect(403);
      }

      // Nothing was written by any of the refusals.
      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM ${VERSIONS}`);
      expect(count).toBe(0);
    });

    it('writes exactly one audit row per mutation, in the same transaction, naming the actor and the reason', async () => {
      const key = await policyKey();
      const version = await published(key);
      await policies.retireVersion(admin.id, key, version.version, 'a stated retirement reason');

      const rows = await auditRowsFor(key);
      const actions = rows.map((row: { action: string }) => row.action);
      expect(actions).toEqual([
        COMMISSION_AUDIT_ACTIONS.policyCreated,
        COMMISSION_AUDIT_ACTIONS.versionDrafted,
        COMMISSION_AUDIT_ACTIONS.versionPublished,
        COMMISSION_AUDIT_ACTIONS.versionRetired,
      ]);
      for (const row of rows) {
        expect(row.actor_user_id).toBe(admin.id);
        expect(String(row.reason).length).toBeGreaterThan(0);
        expect(String(row.target_type).length).toBeLessThanOrEqual(40);
      }
      expect(rows[rows.length - 1].reason).toBe('a stated retirement reason');
    });

    it('refuses a mutation with no stated reason, and writes neither the change nor an audit row', async () => {
      const key = await policyKey();
      await expect(policies.createVersionDraft(admin.id, key, rule(), '   ')).rejects.toBeInstanceOf(Error);
      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM ${VERSIONS}`);
      expect(count).toBe(0);
    });

    it('rolls the domain change back with the audit row: a failed publication leaves the version a draft', async () => {
      const key = await policyKey();
      await published(key);
      const second = await draft(key, rule({ basisPoints: 2_000 }));

      await expect(policies.publishVersion(admin.id, key, second.version, 'suite')).rejects.toBeInstanceOf(
        CommercialActivationOverlapException,
      );
      const after = await policies.getVersion(key, second.version);
      expect(after.lifecycleState).toBe('draft');
      expect(after.publishedAt).toBeNull();

      // Exactly one publication ever succeeded FOR THIS KEY, so exactly one
      // audit row names it — the refused one wrote nothing, which is the
      // transactional claim under test.
      const publishedRows = await auditRowsFor(key, COMMISSION_AUDIT_ACTIONS.versionPublished);
      expect(publishedRows).toHaveLength(1);
      expect(publishedRows[0].target_id).toBe(`${key}@1`);
    });
  });

  // =========================================================================
  // §7. The administrator surface
  // =========================================================================

  describe('§7 the HTTP surface', () => {
    const auth = () => ({ Authorization: `Bearer ${admin.accessToken}` });

    it('publishes and reads back a rule, and returns no actor identity in any projection', async () => {
      const key = nextKey('http');
      await request(app.getHttpServer())
        .post(`${BASE}/commission-policies`)
        .set(auth())
        .send({ policyKey: key, component: 'processing_recovery', displayName: 'HTTP suite', reason: 'suite' })
        .expect(201);

      const drafted = await request(app.getHttpServer())
        .post(`${BASE}/commission-policies/${key}/versions`)
        .set(auth())
        .send({ ruleKind: 'hybrid', basisPoints: 250, fixedToman: 15_000, base: 'service_total', reason: 'suite' })
        .expect(201);

      const body = drafted.body.data;
      expect(body).toMatchObject({
        policyKey: key,
        version: 1,
        lifecycleState: 'draft',
        ruleKind: 'hybrid',
        basisPoints: 250,
        fixedToman: 15_000,
        base: 'service_total',
        arithmeticVersion: COMMISSION_ARITHMETIC_VERSION,
      });
      const serialised = JSON.stringify(drafted.body);
      for (const forbidden of [admin.id, 'createdByUserId', 'publishedByUserId', 'retiredByUserId']) {
        expect([forbidden, serialised.includes(forbidden)]).toEqual([forbidden, false]);
      }

      await request(app.getHttpServer())
        .post(`${BASE}/commission-policies/${key}/versions/1/publish`)
        .set(auth())
        .send({ reason: 'suite' })
        .expect(201);

      const read = await request(app.getHttpServer()).get(`${BASE}/commission-policies/${key}/versions/1`).set(auth()).expect(200);
      expect(read.body.data.lifecycleState).toBe('published');
      expect(read.body.data.publishedAt).not.toBeNull();
    });

    it('refuses a body that tries to choose the lifecycle, the activation instant, the actor or the arithmetic version', async () => {
      const key = await policyKey();
      for (const extra of [
        { lifecycleState: 'published' },
        { activationStartsAt: new Date().toISOString() },
        { publishedAt: new Date().toISOString() },
        { createdByUserId: admin.id },
        { arithmeticVersion: 99 },
      ]) {
        await request(app.getHttpServer())
          .post(`${BASE}/commission-policies/${key}/versions`)
          .set(auth())
          .send({ ruleKind: 'zero', reason: 'suite', ...extra })
          .expect(400);
      }
    });
  });

  // =========================================================================
  // §8. Nothing is seeded, and ADR-027 is satisfied
  // =========================================================================

  describe('§8 the plane starts empty and is fully claimed', () => {
    it('has no policy, no version and therefore no rate anywhere, on a freshly migrated database', async () => {
      // `resetDatabase` restores the migrated state; nothing in the migration
      // put a row here, so an empty table after a reset is the seed claim
      // proved against a real server rather than against the file.
      const [keys] = await dataSource.query(`SELECT count(*)::int AS count FROM ${KEYS}`);
      const [versions] = await dataSource.query(`SELECT count(*)::int AS count FROM ${VERSIONS}`);
      expect([keys.count, versions.count]).toEqual([0, 0]);
    });

    it('claims both new tables under ADR-027 — and without the claim the boot check would fail on exactly those two', async () => {
      const rows = await dataSource.query(
        `SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      );
      const catalogue = rows.map((row: { schemaname: string; tablename: string }) => ({
        schema: row.schemaname,
        name: row.tablename,
        columns: [] as string[],
      }));

      const all = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      expect(all.map((contract) => contract.moduleKey)).toContain('commercial-commission-policy');

      // With the claim present, these two tables are clean.
      const complete = evaluateCoverage(catalogue, all);
      expect(complete.violations.filter((violation) => violation.table.startsWith('commercial.commission_'))).toEqual([]);

      // And the check genuinely fires: remove the contract and exactly the two
      // new tables become unclaimed, which is what stops the application
      // starting. A test asserting only the passing case could not tell a
      // working coverage check from one that always returns "fine".
      const without = all.filter((contract) => contract.moduleKey !== 'commercial-commission-policy');
      const unclaimed = evaluateCoverage(catalogue, without)
        .violations.filter((violation) => violation.kind === 'unclaimed' && violation.table.startsWith('commercial.commission_'))
        .map((violation) => violation.table)
        .sort();
      expect(unclaimed).toEqual(['commercial.commission_policies', 'commercial.commission_policy_versions']);
    });

    it('exports nothing and erases nothing for either table, and says so truthfully', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const contract = contracts.find((candidate) => candidate.moduleKey === 'commercial-commission-policy');
      expect(contract).toBeDefined();

      const key = await policyKey();
      await published(key);

      expect(await contract!.exportSubjectData(dataSource.manager, admin.id)).toEqual([]);
      const erasure = await contract!.eraseSubjectData(dataSource.manager, admin.id, tombstoneFor(admin.id, new Date()));
      expect([erasure.anonymized, erasure.deleted]).toEqual([0, 0]);
      expect(erasure.retained.map((entry) => entry.table).sort()).toEqual([
        'commercial.commission_policies',
        'commercial.commission_policy_versions',
      ]);

      // The published rule survived the erasure, which is the point of the claim.
      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM ${VERSIONS} WHERE policy_key = $1`, [key]);
      expect(count).toBe(1);
    });
  });
});
