import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage, tombstoneFor } from '@beauclick/subject-data';
import {
  SETTLEMENT_AUDIT_ACTIONS,
  CommercialActivationOverlapException,
  CommercialLifecycleConflictException,
  CommercialTermsInvalidException,
  SellerRiskClassService,
  SettlementScheduleResolutionService,
  SettlementScheduleService,
} from '@beauclick/commercial-policy';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedUser,
} from './pg-test-app.factory';

const describePg = requiredPgEnv() !== null ? describe : describe.skip;

/**
 * The `#43d` settlement plane against a real PostgreSQL server — V3.3 Story
 * #175, ADR-052 §1 and §8, `V33-DEC-040` R4.
 *
 * ## Why every guarantee here is proved HERE
 *
 * pg-mem has no exclusion constraints, runs no PL/pgSQL, no partial unique
 * index semantics worth trusting and no `now()` a trigger can compare
 * against. This story is those things: the effective-window exclusion, the
 * forward-only supersession, one CURRENT class per party, the no-tolerance
 * publication instant, and a `FOR SHARE` resolver.
 *
 * ## Values here are TEST values
 *
 * Every interval, minimum, rate and cap below is a suite fixture. **In
 * particular the sevens are fixtures**, not a ratified weekly cadence:
 * `story-43d-boundary.spec.ts` proves no 7 reaches the migration, the
 * service or any default.
 */
describePg('settlement schedule family and seller risk class (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let schedules: SettlementScheduleService;
  let riskClasses: SellerRiskClassService;
  let resolver: SettlementScheduleResolutionService;
  let admin: SeededUser;

  let sequence = 0;
  const nextPhone = (): string => `+98918${String(100000 + (sequence += 1)).slice(0, 6)}`;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;

  const BASE = '/api/v1/admin/commercial';
  const KEYS = 'commercial.settlement_schedule_policies';
  const VERSIONS = 'commercial.settlement_schedule_policy_versions';
  const CLASSES = 'commercial.seller_risk_class_assignments';

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    schedules = app.get(SettlementScheduleService);
    riskClasses = app.get(SellerRiskClassService);
    resolver = app.get(SettlementScheduleResolutionService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, nextPhone(), ['administrator']);
  });

  // -------------------------------------------------------------------------
  // Builders
  // -------------------------------------------------------------------------

  const schedule = (overrides: Partial<Parameters<SettlementScheduleService['createVersionDraft']>[2]> = {}) => ({
    settlementIntervalDays: 7,
    minimumPayoutToman: null,
    reserveBasisPoints: null,
    reserveCapToman: null,
    activationEndsAt: null,
    ...overrides,
  });

  async function policyKey(planKey: string, riskClass: 'standard' | 'elevated') {
    const key = nextKey('ss');
    await schedules.createPolicy(admin.id, key, planKey, riskClass, 'suite schedule', 'suite setup');
    return key;
  }

  async function published(key: string, overrides = {}) {
    const draft = await schedules.createVersionDraft(admin.id, key, schedule(overrides), 'suite setup');
    return schedules.publishVersion(admin.id, key, draft.version, 'suite setup');
  }

  async function sellerParty() {
    const owner = await seedUser(app, dataSource, nextPhone(), ['professional']);
    const professional = await seedProfessional(dataSource, owner.id, 'فروشندهٔ سوئیت');
    return { owner, partyType: 'professional' as const, partyId: professional.id };
  }

  async function insertRawVersion(key: string, columns: Record<string, unknown>): Promise<string> {
    const base: Record<string, unknown> = {
      id: uuidv7(),
      policy_key: key,
      version: 1,
      settlement_interval_days: 7,
      created_by_label: 'suite',
      ...columns,
    };
    const names = Object.keys(base);
    const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
    await dataSource.query(`INSERT INTO ${VERSIONS} (${names.join(', ')}) VALUES (${placeholders})`, Object.values(base));
    return base.id as string;
  }

  // =========================================================================
  // §1. The schedule key
  // =========================================================================

  describe('§1 the key', () => {
    it('admits one key per (plan, risk class) and refuses a second, through the service and raw SQL alike', async () => {
      const plan = nextKey('plan');
      await policyKey(plan, 'standard');
      await expect(policyKey(plan, 'standard')).rejects.toBeInstanceOf(Error);

      await expect(
        dataSource.query(
          `INSERT INTO ${KEYS} (policy_key, plan_key, risk_class, display_name, created_by_label) VALUES ($1, $2, 'standard', 'raw', 'suite')`,
          [nextKey('raw'), plan],
        ),
      ).rejects.toThrow(/uq_ssp_plan_risk/);

      // Positive control: the SAME plan at the other class is a different key.
      const elevated = await policyKey(plan, 'elevated');
      expect(elevated).toBeTruthy();
    });

    it('freezes the pair and refuses deletion while versions exist', async () => {
      const key = await policyKey(nextKey('plan'), 'standard');
      await schedules.createVersionDraft(admin.id, key, schedule(), 'suite');

      await expect(dataSource.query(`UPDATE ${KEYS} SET risk_class = 'elevated' WHERE policy_key = $1`, [key])).rejects.toThrow(
        /identity is immutable/,
      );
      await expect(dataSource.query(`DELETE FROM ${KEYS} WHERE policy_key = $1`, [key])).rejects.toThrow(
        /cannot be deleted while versions exist/,
      );
    });
  });

  // =========================================================================
  // §2. The schedule itself — no implicit cadence
  // =========================================================================

  describe('§2 the schedule', () => {
    it('refuses a version with NO interval: there is no default cadence anywhere', async () => {
      const key = await policyKey(nextKey('plan'), 'standard');
      await expect(
        dataSource.query(
          `INSERT INTO ${VERSIONS} (id, policy_key, version, created_by_label) VALUES ($1, $2, 1, 'suite')`,
          [uuidv7(), key],
        ),
      ).rejects.toThrow(/settlement_interval_days/);
    });

    it.each([
      ['a zero interval', { settlement_interval_days: 0 }],
      ['an interval beyond a year', { settlement_interval_days: 366 }],
      ['a negative minimum', { minimum_payout_toman: -1 }],
      ['a reserve above 100%', { reserve_bp: 10_001 }],
      ['a negative reserve cap', { reserve_cap_toman: -5 }],
    ])('refuses %s in the database, not merely in the service', async (_label, columns) => {
      const key = await policyKey(nextKey('plan'), 'standard');
      await expect(insertRawVersion(key, columns)).rejects.toThrow(/ck_sspv_/);
    });

    it('keeps "no minimum" and "no reserve" as real states, distinct from zero', async () => {
      const key = await policyKey(nextKey('plan'), 'standard');
      const none = await schedules.createVersionDraft(admin.id, key, schedule(), 'suite');
      expect([none.minimumPayoutToman, none.reserveBasisPoints, none.reserveCapToman]).toEqual([null, null, null]);

      const key2 = await policyKey(nextKey('plan'), 'standard');
      const zeroes = await schedules.createVersionDraft(
        admin.id,
        key2,
        schedule({ minimumPayoutToman: 0, reserveBasisPoints: 0, reserveCapToman: 0 }),
        'suite',
      );
      expect([zeroes.minimumPayoutToman, zeroes.reserveBasisPoints, zeroes.reserveCapToman]).toEqual([0, 0, 0]);
    });

    it('tells an administrator which field is wrong instead of naming a constraint', async () => {
      const key = await policyKey(nextKey('plan'), 'standard');
      await expect(
        schedules.createVersionDraft(admin.id, key, schedule({ settlementIntervalDays: 0 }), 'suite'),
      ).rejects.toBeInstanceOf(CommercialTermsInvalidException);
    });
  });

  // =========================================================================
  // §3. Lifecycle and the publication instant
  // =========================================================================

  describe('§3 lifecycle', () => {
    it('cannot be born published, and runs one way only', async () => {
      const key = await policyKey(nextKey('plan'), 'standard');
      await expect(
        insertRawVersion(key, {
          lifecycle_state: 'published',
          published_at: new Date(),
          published_by_label: 'suite',
          activation_starts_at: new Date(),
        }),
      ).rejects.toThrow(/must be created as draft/);

      const version = await published(key);
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET lifecycle_state = 'draft' WHERE id = $1`, [version.id]),
      ).rejects.toThrow(/never backwards/);

      const retired = await schedules.retireVersion(admin.id, key, version.version, 'suite');
      expect(retired.lifecycleState).toBe('retired');
    });

    it('requires the publication instant to EQUAL the transaction clock', async () => {
      const key = await policyKey(nextKey('plan'), 'standard');
      const draft = await schedules.createVersionDraft(admin.id, key, schedule(), 'suite');
      const [row] = await dataSource.query(`SELECT id FROM ${VERSIONS} WHERE policy_key = $1 AND version = $2`, [
        key,
        draft.version,
      ]);

      await expect(
        dataSource.query(
          `UPDATE ${VERSIONS}
              SET lifecycle_state = 'published', published_at = now() - INTERVAL '1 second',
                  published_by_label = 'suite', activation_starts_at = now()
            WHERE id = $1`,
          [row.id],
        ),
      ).rejects.toThrow(/exactly the transaction clock/);

      // Positive control.
      await dataSource.query(
        `UPDATE ${VERSIONS}
            SET lifecycle_state = 'published', published_at = now(),
                published_by_label = 'suite', activation_starts_at = now()
          WHERE id = $1`,
        [row.id],
      );
    });

    it('refuses two versions of one key effective at once, and keeps different keys independent', async () => {
      const plan = nextKey('plan');
      const standard = await policyKey(plan, 'standard');
      await published(standard);
      const second = await schedules.createVersionDraft(admin.id, standard, schedule({ settlementIntervalDays: 14 }), 'suite');
      await expect(schedules.publishVersion(admin.id, standard, second.version, 'suite')).rejects.toBeInstanceOf(
        CommercialActivationOverlapException,
      );

      // The elevated key for the SAME plan publishes freely.
      const elevated = await policyKey(plan, 'elevated');
      expect((await published(elevated, { settlementIntervalDays: 14 })).lifecycleState).toBe('published');
    });

    it('freezes a published schedule', async () => {
      const key = await policyKey(nextKey('plan'), 'standard');
      const version = await published(key);
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET settlement_interval_days = 30 WHERE id = $1`, [version.id]),
      ).rejects.toThrow(/terms are immutable/);
    });
  });

  // =========================================================================
  // §4. The risk class — never inferred, superseded never edited
  // =========================================================================

  describe('§4 the risk class', () => {
    it('does not exist until somebody assigns it', async () => {
      const party = await sellerParty();
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM ${CLASSES} WHERE seller_party_id = $1`,
        [party.partyId],
      );
      expect(count).toBe(0);
    });

    it('supersedes rather than edits, keeping exactly one current row and a complete history', async () => {
      const party = await sellerParty();
      const first = await riskClasses.assign(admin.id, party, 'standard', 'suite: initial classification');
      const second = await riskClasses.assign(admin.id, party, 'elevated', 'suite: chargeback pattern');

      const rows = await dataSource.query(
        `SELECT risk_class, superseded_at IS NULL AS current, superseded_by_assignment_id
           FROM ${CLASSES} WHERE seller_party_id = $1 ORDER BY assigned_at`,
        [party.partyId],
      );
      expect(rows.map((row: { risk_class: string; current: boolean }) => [row.risk_class, row.current])).toEqual([
        ['standard', false],
        ['elevated', true],
      ]);
      // The superseded row points at the one that replaced it.
      expect(rows[0].superseded_by_assignment_id).toBe(second.id);
      expect(first.id).not.toBe(second.id);
    });

    it('refuses a second CURRENT row, an edit and a delete, in the database', async () => {
      const party = await sellerParty();
      await riskClasses.assign(admin.id, party, 'standard', 'suite');

      await expect(
        dataSource.query(
          `INSERT INTO ${CLASSES} (id, seller_party_type, seller_party_id, risk_class, reason, assigned_by_label)
           VALUES ($1, 'professional', $2, 'elevated', 'raw', 'suite')`,
          [uuidv7(), party.partyId],
        ),
      ).rejects.toThrow(/uq_srca_one_current_per_party/);

      await expect(
        dataSource.query(`UPDATE ${CLASSES} SET risk_class = 'elevated' WHERE seller_party_id = $1`, [party.partyId]),
      ).rejects.toThrow(/immutable apart from its supersession/);

      await expect(dataSource.query(`DELETE FROM ${CLASSES} WHERE seller_party_id = $1`, [party.partyId])).rejects.toThrow(
        /permanent/,
      );
    });

    it('requires a stated reason, and writes nothing without one', async () => {
      const party = await sellerParty();
      await expect(riskClasses.assign(admin.id, party, 'standard', '   ')).rejects.toBeInstanceOf(Error);
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM ${CLASSES} WHERE seller_party_id = $1`,
        [party.partyId],
      );
      expect(count).toBe(0);
    });

    it('writes one audit row per classification, naming the actor and the reason', async () => {
      const party = await sellerParty();
      await riskClasses.assign(admin.id, party, 'elevated', 'suite: a stated reason');

      const rows = await dataSource.query(
        `SELECT action, actor_user_id, reason FROM admin.admin_audit_log
          WHERE target_id = $1 AND action = $2 ORDER BY created_at`,
        [`professional:${party.partyId}`, SETTLEMENT_AUDIT_ACTIONS.riskClassAssigned],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBe(admin.id);
      expect(rows[0].reason).toBe('suite: a stated reason');
    });
  });

  // =========================================================================
  // §5. The resolver — fail closed, twice
  // =========================================================================

  describe('§5 resolution', () => {
    it('answers `no_risk_class` for an unclassified seller, never `standard`', async () => {
      const party = await sellerParty();
      const plan = nextKey('plan');
      await published(await policyKey(plan, 'standard'));

      const resolved = await resolver.resolveForParty(dataSource.manager, party.partyType, party.partyId, plan);
      expect(resolved).toEqual({ outcome: 'unresolved', cause: 'no_risk_class' });
    });

    it('answers `no_active_schedule` for a classified seller whose pair has none', async () => {
      const party = await sellerParty();
      await riskClasses.assign(admin.id, party, 'elevated', 'suite');
      const plan = nextKey('plan');
      // A schedule exists for STANDARD only; the seller is elevated.
      await published(await policyKey(plan, 'standard'));

      const resolved = await resolver.resolveForParty(dataSource.manager, party.partyType, party.partyId, plan);
      expect(resolved).toEqual({ outcome: 'unresolved', cause: 'no_active_schedule' });
    });

    it('resolves the published terms BY VALUE for the matching pair', async () => {
      const party = await sellerParty();
      await riskClasses.assign(admin.id, party, 'elevated', 'suite');
      const plan = nextKey('plan');
      const key = await policyKey(plan, 'elevated');
      const version = await published(key, {
        settlementIntervalDays: 14,
        minimumPayoutToman: 500_000,
        reserveBasisPoints: 1_000,
        reserveCapToman: 5_000_000,
      });

      const resolved = await resolver.resolveForParty(dataSource.manager, party.partyType, party.partyId, plan);
      expect(resolved).toEqual({
        outcome: 'resolved',
        terms: {
          policyKey: key,
          policyVersion: version.version,
          planKey: plan,
          riskClass: 'elevated',
          settlementIntervalDays: 14,
          minimumPayoutToman: 500_000,
          reserveBasisPoints: 1_000,
          reserveCapToman: 5_000_000,
        },
      });
    });

    it('follows a re-classification on the NEXT resolution, without touching what came before', async () => {
      const party = await sellerParty();
      const plan = nextKey('plan');
      await published(await policyKey(plan, 'standard'), { settlementIntervalDays: 7 });
      await published(await policyKey(plan, 'elevated'), { settlementIntervalDays: 30 });

      await riskClasses.assign(admin.id, party, 'standard', 'suite');
      const before = await resolver.resolveForParty(dataSource.manager, party.partyType, party.partyId, plan);
      await riskClasses.assign(admin.id, party, 'elevated', 'suite');
      const after = await resolver.resolveForParty(dataSource.manager, party.partyType, party.partyId, plan);

      expect(before.outcome === 'resolved' && before.terms.settlementIntervalDays).toBe(7);
      expect(after.outcome === 'resolved' && after.terms.settlementIntervalDays).toBe(30);
    });
  });

  // =========================================================================
  // §6. Authorization
  // =========================================================================

  describe('§6 authorization', () => {
    it('refuses every mutation without the capability and without a token, and writes nothing', async () => {
      const seller = await seedUser(app, dataSource, nextPhone(), ['professional']);
      const mutations: Array<[string, Record<string, unknown>]> = [
        [`${BASE}/settlement-schedules`, { policyKey: nextKey('x'), planKey: 'plan-x', riskClass: 'standard', displayName: 'x', reason: 'r' }],
        [`${BASE}/seller-risk-classes`, { partyType: 'professional', partyId: uuidv7(), riskClass: 'elevated', reason: 'r' }],
      ];

      for (const [path, body] of mutations) {
        await request(app.getHttpServer()).post(path).send(body).expect(401);
        await request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${seller.accessToken}`).send(body).expect(403);
      }

      const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM ${KEYS}`);
      expect(count).toBe(0);
    });

    it('publishes and reads back through HTTP, returning no actor identity', async () => {
      const auth = { Authorization: `Bearer ${admin.accessToken}` };
      const key = nextKey('http');
      await request(app.getHttpServer())
        .post(`${BASE}/settlement-schedules`)
        .set(auth)
        .send({ policyKey: key, planKey: nextKey('plan'), riskClass: 'standard', displayName: 'HTTP suite', reason: 'suite' })
        .expect(201);

      const drafted = await request(app.getHttpServer())
        .post(`${BASE}/settlement-schedules/${key}/versions`)
        .set(auth)
        .send({ settlementIntervalDays: 10, minimumPayoutToman: 100_000, reason: 'suite' })
        .expect(201);

      expect(drafted.body.data).toMatchObject({
        policyKey: key,
        version: 1,
        lifecycleState: 'draft',
        settlementIntervalDays: 10,
        minimumPayoutToman: 100_000,
        reserveBasisPoints: null,
      });
      const serialised = JSON.stringify(drafted.body);
      for (const forbidden of [admin.id, 'createdByUserId', 'publishedByUserId']) {
        expect([forbidden, serialised.includes(forbidden)]).toEqual([forbidden, false]);
      }
    });
  });

  // =========================================================================
  // §7. ADR-027 — the class is exported, the reason is not
  // =========================================================================

  describe('§7 privacy', () => {
    const contractOf = () =>
      app
        .get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS)
        .find((contract) => contract.moduleKey === 'commercial-settlement-schedule')!;

    it('claims all three tables, and without the claim the boot check fails on exactly them', async () => {
      const rows = await dataSource.query(
        `SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      );
      const catalogue = rows.map((row: { schemaname: string; tablename: string }) => ({
        schema: row.schemaname,
        name: row.tablename,
        columns: [] as string[],
      }));
      const all = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);

      expect(evaluateCoverage(catalogue, all).violations.filter((v) => v.table.includes('settlement_schedule') || v.table.includes('risk_class'))).toEqual([]);

      const without = all.filter((contract) => contract.moduleKey !== 'commercial-settlement-schedule');
      const unclaimed = evaluateCoverage(catalogue, without)
        .violations.filter((v) => v.kind === 'unclaimed')
        .map((v) => v.table)
        .filter((table) => table.includes('settlement_schedule') || table.includes('risk_class'))
        .sort();
      expect(unclaimed).toEqual([
        'commercial.seller_risk_class_assignments',
        'commercial.settlement_schedule_policies',
        'commercial.settlement_schedule_policy_versions',
      ]);
    });

    it('exports the seller their own CLASS and instants — and never the administrator`s reason', async () => {
      const party = await sellerParty();
      await riskClasses.assign(admin.id, party, 'elevated', 'suite: a chargeback pattern nobody should see');

      const sections = await contractOf().exportSubjectData(dataSource.manager, party.owner.id);
      expect(sections).toHaveLength(1);
      expect(sections[0].rows).toEqual([
        { riskClass: 'elevated', assignedAt: expect.any(String), supersededAt: null },
      ]);

      // The decision this story's preflight recorded, asserted rather than
      // written in prose: the reason and the administrator are absent.
      const serialised = JSON.stringify(sections);
      expect(serialised).not.toContain('chargeback');
      expect(serialised).not.toContain(admin.id);
    });

    it('exports nothing to somebody who owns no seller party', async () => {
      const party = await sellerParty();
      await riskClasses.assign(admin.id, party, 'standard', 'suite');
      const stranger = await seedUser(app, dataSource, nextPhone(), ['customer']);
      expect(await contractOf().exportSubjectData(dataSource.manager, stranger.id)).toEqual([]);
    });

    it('erases nothing and says so truthfully, leaving the classification intact', async () => {
      const party = await sellerParty();
      await riskClasses.assign(admin.id, party, 'elevated', 'suite');

      const outcome = await contractOf().eraseSubjectData(dataSource.manager, party.owner.id, tombstoneFor(party.owner.id, new Date()));
      expect([outcome.anonymized, outcome.deleted]).toEqual([0, 0]);
      expect(outcome.retained.map((entry) => entry.table).sort()).toEqual([
        'commercial.seller_risk_class_assignments',
        'commercial.settlement_schedule_policies',
        'commercial.settlement_schedule_policy_versions',
      ]);

      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM ${CLASSES} WHERE seller_party_id = $1`,
        [party.partyId],
      );
      expect(count).toBe(1);
    });
  });

  // =========================================================================
  // §8. Nothing is seeded
  // =========================================================================

  describe('§8 the plane starts empty', () => {
    it('has no schedule, no version and no classification on a freshly migrated database', async () => {
      const [keys] = await dataSource.query(`SELECT count(*)::int AS count FROM ${KEYS}`);
      const [versions] = await dataSource.query(`SELECT count(*)::int AS count FROM ${VERSIONS}`);
      const [classes] = await dataSource.query(`SELECT count(*)::int AS count FROM ${CLASSES}`);
      expect([keys.count, versions.count, classes.count]).toEqual([0, 0, 0]);
    });
  });
});
