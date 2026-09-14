import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { AdminAuditService } from '@beauclick/audit';
import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, evaluateCoverage } from '@beauclick/subject-data';
import { BookingOutcomePolicyVersionTermsV1 } from '@beauclick/commercial-policy-contract';
import {
  BookingOutcomePolicyService,
  CommercialActivationOverlapException,
  CommercialLegalEvidenceNotQualifyingException,
  CommercialLifecycleConflictException,
  CommercialNotFoundException,
  CommercialTermsInvalidException,
  CustomerPolicyCopyService,
  LegalEvidenceService,
  OUTCOME_POLICY_AUDIT_ACTIONS,
  sha256Hex,
} from '@beauclick/commercial-policy';

import {
  PgTestApp,
  SeededUser,
  createPgTestApp,
  futureSlotTime,
  requiredPgEnv,
  resetDatabase,
  seedProfessional,
  seedSlot,
  seedUser,
} from './pg-test-app.factory';

const pgConfigured = requiredPgEnv() !== null;
const describePg = pgConfigured ? describe : describe.skip;

/**
 * The `#42a` publication plane against a real PostgreSQL server — V3.3 Story
 * #42, ADR-051 §1, §5, §10; `V33-DEC-039`, `V33-DEC-042`, `V33-DEC-043`.
 *
 * ## Why every guarantee here is proved HERE and nowhere else
 *
 * pg-mem does not honour TypeORM's ROLLBACK, has no exclusion constraints,
 * no `NULLS NOT DISTINCT`, runs no PL/pgSQL and has no `now()` a trigger can
 * compare against. Every invariant this story rests on is one of those: the
 * lifecycle allow-lists, published immutability, the frozen option rows, the
 * effective-window exclusion, the ascending-set and option-shape CHECKs, the
 * body/hash CHECK, non-retroactivity, the Legal-evidence gate and the
 * transactional audit row. None can be observed on the fast layer.
 *
 * ## Values in this file are TEST values
 *
 * Every number below (hours, minutes, basis points, toman) is a suite fixture
 * chosen to exercise a constraint. None is a product value, none is the
 * owner-endorsed initial publication value, and none reaches any migration,
 * seed or default — §1 and `story-42a-boundary.spec.ts` prove that.
 */
describePg('booking outcome policy, customer copy and Legal evidence — publication plane (real PostgreSQL)', () => {
  let ctx: PgTestApp;
  let app: INestApplication;
  let dataSource: DataSource;
  let policies: BookingOutcomePolicyService;
  let copies: CustomerPolicyCopyService;
  let evidence: LegalEvidenceService;
  let admin: SeededUser;

  let sequence = 0;
  const nextKey = (prefix: string): string => `${prefix}-${(sequence += 1)}-${Date.now() % 100000}`;
  const nextPhone = (): string => `+98915${String(100000 + (sequence += 1)).slice(0, 6)}`;

  const BASE = '/api/v1/admin/commercial';
  const VERSIONS = 'commercial.booking_outcome_policy_versions';
  const OPTIONS = 'commercial.booking_outcome_policy_retention_options';
  const KEYS = 'commercial.booking_outcome_policies';
  const COPY_VERSIONS = 'commercial.customer_policy_copy_versions';
  const EVIDENCE = 'commercial.legal_evidence_records';
  const NEW_TABLES = [
    'booking_outcome_policies',
    'booking_outcome_policy_retention_options',
    'booking_outcome_policy_versions',
    'customer_policy_copies',
    'customer_policy_copy_versions',
    'legal_evidence_records',
  ];

  beforeAll(async () => {
    ctx = await createPgTestApp();
    app = ctx.app;
    dataSource = ctx.dataSource;
    policies = app.get(BookingOutcomePolicyService);
    copies = app.get(CustomerPolicyCopyService);
    evidence = app.get(LegalEvidenceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    admin = await seedUser(app, dataSource, `+98914${String(100000 + (sequence % 90000)).slice(0, 6)}`, ['administrator']);
  });

  // -------------------------------------------------------------------------
  // Builders. Real rows through the real services, no fixtures library.
  // -------------------------------------------------------------------------

  /** Suite fixture terms. Not product values. */
  const terms = (overrides: Partial<BookingOutcomePolicyVersionTermsV1> = {}): BookingOutcomePolicyVersionTermsV1 => ({
    contractVersion: 1,
    cutoffHoursAllowed: [6, 12, 48],
    lateRetentionOptions: [{ kind: 'none' }, { kind: 'percentage_of_collected', basisPoints: 2_500 }, { kind: 'full_collected' }],
    noShowGraceMinutesAllowed: [5, 10, 30],
    noShowRetentionOptions: [{ kind: 'none' }, { kind: 'fixed_toman', amountToman: 40_000 }],
    rescheduleFreeCountBeforeCutoff: 1,
    disputeWindowHours: 36,
    bodilyHarmWindowHours: 96,
    appealWindowHours: 48,
    caseFileRetentionDays: null,
    legalCap: null,
    ...overrides,
  });

  async function policyKey(key = nextKey('op')): Promise<string> {
    await policies.createPolicy(admin.id, key, 'suite outcome policy', 'suite setup');
    return key;
  }

  async function draft(key: string, t = terms(), legalEvidenceKey: string | null = null, activationEndsAt: Date | null = null) {
    return policies.createVersionDraft(admin.id, { policyKey: key, terms: t, legalEvidenceKey, activationEndsAt }, 'suite setup');
  }

  async function published(key: string, t = terms()) {
    const record = await draft(key, t);
    return policies.publishVersion(admin.id, key, record.version.version, 'suite setup');
  }

  async function recordedEvidence(subject: 'retention_cap' | 'policy_copy' = 'retention_cap', key = nextKey('ev')): Promise<string> {
    await evidence.record(
      admin.id,
      key,
      { subject, referenceKind: 'internal_ticket', reference: `LEGAL-${key}`, summary: 'suite attestation' },
      'suite setup',
    );
    return key;
  }

  async function copyKey(key = nextKey('cp')): Promise<string> {
    await copies.createCopy(admin.id, key, 'suite copy', 'suite setup');
    return key;
  }

  async function copyDraft(key: string, body = 'متن نمونهٔ سوئیت — نه متن حقوقی تأییدشده') {
    return copies.createVersionDraft(admin.id, { copyKey: key, terms: { contractVersion: 1, locale: 'fa-IR', body }, activationEndsAt: null }, 'suite setup');
  }

  /** Inserts a version row directly, bypassing the service entirely. */
  async function insertRawVersion(key: string, columns: Record<string, unknown>): Promise<string> {
    const base: Record<string, unknown> = {
      id: uuidv7(),
      policy_key: key,
      version: 1,
      cutoff_hours_allowed: [6, 12],
      no_show_grace_minutes_allowed: [5],
      reschedule_free_count_before_cutoff: 1,
      dispute_window_hours: 36,
      appeal_window_hours: 48,
      created_by_label: 'suite',
      ...columns,
    };
    const names = Object.keys(base);
    const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
    await dataSource.query(`INSERT INTO ${VERSIONS} (${names.join(', ')}) VALUES (${placeholders})`, Object.values(base));
    return base.id as string;
  }

  async function insertRawOption(versionId: string, purpose: string, ordinal: number, kind: string, extra: Record<string, unknown> = {}) {
    const base: Record<string, unknown> = { id: uuidv7(), version_id: versionId, purpose, ordinal, kind, ...extra };
    const names = Object.keys(base);
    await dataSource.query(
      `INSERT INTO ${OPTIONS} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(base),
    );
  }

  async function insertRawEvidence(key: string, columns: Record<string, unknown> = {}): Promise<string> {
    const base: Record<string, unknown> = {
      id: uuidv7(),
      evidence_key: key,
      subject: 'retention_cap',
      reference_kind: 'internal_ticket',
      reference: 'RAW',
      summary: 'raw',
      recorded_by_user_id: admin.id,
      recorded_audit_id: uuidv7(),
      ...columns,
    };
    const names = Object.keys(base);
    await dataSource.query(
      `INSERT INTO ${EVIDENCE} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(base),
    );
    return base.id as string;
  }

  async function versionRow(key: string, version: number): Promise<Record<string, unknown>> {
    const [row] = await dataSource.query(`SELECT * FROM ${VERSIONS} WHERE policy_key = $1 AND version = $2`, [key, version]);
    return row;
  }

  async function auditRows(targetId: string): Promise<Array<Record<string, unknown>>> {
    return dataSource.query(`SELECT action, target_type, reason FROM admin.admin_audit_log WHERE target_id = $1 ORDER BY created_at`, [targetId]);
  }

  const auditCount = async (): Promise<number> => (await dataSource.query(`SELECT count(*)::int AS n FROM admin.admin_audit_log`))[0].n;

  const publishRaw = (id: string) =>
    dataSource.query(
      `UPDATE ${VERSIONS} SET lifecycle_state='published', published_at=now(), activation_starts_at=now(), published_by_label='suite' WHERE id=$1`,
      [id],
    );

  // =========================================================================
  // §1. Schema: exactly the ratified shape, and ZERO rows
  // =========================================================================

  describe('§1 schema and the zero-row foundation', () => {
    it('creates exactly the six tables ADR-051 §1/§5 name, and no other', async () => {
      const tables = await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'commercial' ORDER BY tablename`);
      const names: string[] = tables.map((t: { tablename: string }) => t.tablename);
      for (const table of NEW_TABLES) expect(names).toContain(table);
      // No premature `#42c`–`#42e` table. (`#42b`'s selection table has shipped
      // with #159, which asserts it in its own suite.)
      expect(names.filter((n) => /outcome_decision|no_show_declaration|remedy_choice|dispute/.test(n))).toEqual([]);
    });

    it('declares the exact constraint, trigger, index and function set', async () => {
      const constraints = await dataSource.query(
        `SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'commercial' AND t.relname = ANY($1) AND c.contype IN ('c','u','x') ORDER BY conname`,
        [NEW_TABLES],
      );
      expect(constraints.map((c: { conname: string }) => c.conname)).toEqual([
        'ck_bop_created_actor',
        'ck_bop_display_name',
        'ck_bop_key_shape',
        'ck_bopro_kind',
        'ck_bopro_ordinal',
        'ck_bopro_purpose',
        'ck_bopro_shape',
        'ck_bopv_activation_start_pairing',
        'ck_bopv_appeal_window',
        'ck_bopv_bodily_harm_window',
        'ck_bopv_case_file_retention',
        'ck_bopv_contract_version',
        'ck_bopv_created_actor',
        'ck_bopv_cutoff_set',
        'ck_bopv_dispute_window',
        'ck_bopv_grace_set',
        'ck_bopv_legal_cap_kind',
        'ck_bopv_legal_cap_requires_evidence',
        'ck_bopv_legal_cap_shape',
        'ck_bopv_lifecycle',
        'ck_bopv_not_retroactive',
        'ck_bopv_published_actor',
        'ck_bopv_reschedule_free_count',
        'ck_bopv_retired_actor',
        'ck_bopv_version',
        'ck_bopv_window',
        'ck_cpc_created_actor',
        'ck_cpc_display_name',
        'ck_cpc_key_shape',
        'ck_cpcv_activation_start_pairing',
        'ck_cpcv_body',
        'ck_cpcv_body_hash',
        'ck_cpcv_contract_version',
        'ck_cpcv_created_actor',
        'ck_cpcv_lifecycle',
        'ck_cpcv_locale',
        'ck_cpcv_not_retroactive',
        'ck_cpcv_published_actor',
        'ck_cpcv_retired_actor',
        'ck_cpcv_version',
        'ck_cpcv_window',
        'ck_ler_key_shape',
        'ck_ler_reference',
        'ck_ler_reference_kind',
        'ck_ler_retired_after_recorded',
        'ck_ler_retirement_pairing',
        'ck_ler_status',
        'ck_ler_subject',
        'ck_ler_summary',
        'ex_bopv_no_effective_overlap',
        'ex_cpcv_no_effective_overlap',
        'uq_bopro_meaning',
        'uq_bopro_ordinal',
        'uq_bopv_key_version',
        'uq_cpcv_key_version',
        'uq_ler_evidence_key',
      ]);

      // Foreign keys, by column and target. The evidence FK is the layer behind
      // the trigger: behaviour cannot see it go (the trigger answers first), so
      // it is pinned here.
      const foreignKeys = await dataSource.query(
        `SELECT t.relname || '.' || a.attname || ' -> ' || rt.relname || '.' || ra.attname AS fk
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN pg_class rt ON rt.oid = c.confrelid
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
           JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
          WHERE n.nspname = 'commercial' AND t.relname = ANY($1) AND c.contype = 'f'`,
        [NEW_TABLES],
      );
      expect(foreignKeys.map((f: { fk: string }) => f.fk).sort()).toEqual([
        'booking_outcome_policy_retention_options.version_id -> booking_outcome_policy_versions.id',
        'booking_outcome_policy_versions.legal_evidence_id -> legal_evidence_records.id',
        'booking_outcome_policy_versions.policy_key -> booking_outcome_policies.policy_key',
        'customer_policy_copy_versions.copy_key -> customer_policy_copies.copy_key',
      ]);

      const triggers = await dataSource.query(
        `SELECT tgname FROM pg_trigger tg JOIN pg_class t ON t.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'commercial' AND t.relname = ANY($1) AND NOT tg.tgisinternal ORDER BY tgname`,
        [NEW_TABLES],
      );
      expect(triggers.map((t: { tgname: string }) => t.tgname)).toEqual([
        'tg_booking_outcome_policies_immutable',
        'tg_bopro_freeze',
        'tg_bopv_lifecycle',
        'tg_bopv_require_evidence',
        'tg_cpcv_lifecycle',
        'tg_customer_policy_copies_immutable',
        'tg_ler_lifecycle',
      ]);

      const functions = await dataSource.query(
        `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='commercial' AND proname = ANY($1) ORDER BY proname`,
        [[
          'require_valid_legal_evidence_for_cap',
          'enforce_booking_outcome_version_lifecycle',
          'enforce_booking_outcome_retention_option_freeze',
          'enforce_legal_evidence_lifecycle',
          'enforce_customer_policy_copy_version_lifecycle',
          'smallint_array_is_strictly_ascending',
        ]],
      );
      expect(functions).toHaveLength(6);

      const indexes = await dataSource.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname='commercial' AND tablename = ANY($1) AND indexname LIKE 'ix_%' ORDER BY indexname`,
        [NEW_TABLES],
      );
      expect(indexes.map((i: { indexname: string }) => i.indexname)).toEqual(['ix_bopro_version', 'ix_bopv_key_state', 'ix_bopv_legal_evidence', 'ix_cpcv_key_state']);
    });

    it('stores every value as an integer column (smallint/int/bigint) and puts NO DEFAULT on any of them', async () => {
      const columns = await dataSource.query(
        `SELECT table_name, column_name, data_type, column_default FROM information_schema.columns
          WHERE table_schema='commercial' AND table_name IN ('booking_outcome_policy_versions','booking_outcome_policy_retention_options')
            AND column_name IN ('cutoff_hours_allowed','no_show_grace_minutes_allowed','reschedule_free_count_before_cutoff','dispute_window_hours',
                                'bodily_harm_window_hours','appeal_window_hours','case_file_retention_days','legal_cap_basis_points','legal_cap_amount_toman',
                                'basis_points','amount_toman','ordinal')
          ORDER BY table_name, column_name`,
      );
      expect(columns).toHaveLength(12);
      for (const column of columns) {
        expect(['smallint', 'integer', 'bigint', 'ARRAY']).toContain(column.data_type);
        expect(column.column_default).toBeNull();
      }
      const arrays = await dataSource.query(
        `SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='commercial' AND table_name='booking_outcome_policy_versions' AND data_type='ARRAY'`,
      );
      expect(arrays.map((a: { udt_name: string }) => a.udt_name)).toEqual(['_int2', '_int2']);
      // No floating-point money anywhere in the six tables.
      const floats = await dataSource.query(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='commercial' AND table_name = ANY($1) AND data_type IN ('numeric','real','double precision','money')`,
        [NEW_TABLES],
      );
      expect(floats[0].n).toBe(0);
    });

    it('holds ZERO rows in all six tables, and the API lists nothing', async () => {
      for (const table of NEW_TABLES) {
        const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM commercial.${table}`);
        expect(n).toBe(0);
      }
      for (const path of ['outcome-policies', 'customer-policy-copies', 'legal-evidence']) {
        const res = await request(app.getHttpServer()).get(`${BASE}/${path}`).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
        expect(res.body.data).toEqual({ items: [] });
      }
    });

    it('the copy version row carries NO numeric policy column, by construction', async () => {
      const columns = await dataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='commercial' AND table_name='customer_policy_copy_versions' ORDER BY ordinal_position`,
      );
      expect(columns.map((c: { column_name: string }) => c.column_name)).toEqual([
        'id', 'copy_key', 'version', 'lifecycle_state', 'locale', 'body', 'body_sha256', 'contract_version',
        'activation_starts_at', 'activation_ends_at', 'created_at', 'created_by_user_id', 'created_by_label',
        'published_at', 'published_by_user_id', 'published_by_label', 'retired_at', 'retired_by_user_id', 'retired_by_label',
      ]);
    });

    it('the evidence record carries a reference and a summary only — no document, body, counsel or file column', async () => {
      const columns = await dataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='commercial' AND table_name='legal_evidence_records' ORDER BY ordinal_position`,
      );
      expect(columns.map((c: { column_name: string }) => c.column_name)).toEqual([
        'id', 'evidence_key', 'subject', 'status', 'reference_kind', 'reference', 'summary',
        'recorded_at', 'recorded_by_user_id', 'recorded_audit_id', 'retired_at', 'retired_by_user_id', 'retired_audit_id',
      ]);
    });

    it('refuses a version under a key that does not exist, rather than creating one', async () => {
      await expect(draft(nextKey('missing'))).rejects.toBeInstanceOf(CommercialNotFoundException);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM ${KEYS}`);
      expect(n).toBe(0);
    });
  });

  // =========================================================================
  // §2. Lifecycle of the numeric family
  // =========================================================================

  describe('§2 lifecycle', () => {
    it('walks draft -> published -> retired through the service, with options frozen alongside', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      expect(drafted.version.lifecycleState).toBe('draft');
      expect(drafted.options).toHaveLength(5);
      expect(drafted.version.activationStartsAt).toBeNull();

      const live = await policies.publishVersion(admin.id, key, drafted.version.version, 'go live');
      expect(live.version.lifecycleState).toBe('published');
      expect(live.version.activationStartsAt).not.toBeNull();
      expect(live.version.publishedAt).not.toBeNull();

      const retired = await policies.retireVersion(admin.id, key, drafted.version.version, 'superseded');
      expect(retired.version.lifecycleState).toBe('retired');
      expect(retired.version.retiredAt).not.toBeNull();
      // Retirement rewrote neither the window nor the publication facts.
      expect(retired.version.activationStartsAt?.getTime()).toBe(live.version.activationStartsAt?.getTime());
      expect(retired.version.publishedAt?.getTime()).toBe(live.version.publishedAt?.getTime());
    });

    it('refuses a row born published, and a backwards transition (direct SQL)', async () => {
      const key = await policyKey();
      await expect(insertRawVersion(key, { lifecycle_state: 'published', published_at: new Date(), activation_starts_at: new Date(), published_by_label: 'x' })).rejects.toThrow(/created as draft/);

      const live = await published(key);
      await expect(dataSource.query(`UPDATE ${VERSIONS} SET lifecycle_state='draft' WHERE id=$1`, [live.version.id])).rejects.toThrow(/not permitted/);
      await policies.retireVersion(admin.id, key, live.version.version, 'suite');
      await expect(dataSource.query(`UPDATE ${VERSIONS} SET lifecycle_state='published' WHERE id=$1`, [live.version.id])).rejects.toThrow(/retired and permanently immutable/);
      await expect(dataSource.query(`UPDATE ${VERSIONS} SET dispute_window_hours=1 WHERE id=$1`, [live.version.id])).rejects.toThrow(/retired and permanently immutable/);
    });

    it('freezes every term of a published version and its identity always (direct SQL)', async () => {
      const key = await policyKey();
      const live = await published(key);
      for (const set of [
        `cutoff_hours_allowed='{1}'`,
        `no_show_grace_minutes_allowed='{1}'`,
        `reschedule_free_count_before_cutoff=0`,
        `dispute_window_hours=1`,
        `bodily_harm_window_hours=NULL`,
        `appeal_window_hours=1`,
        `case_file_retention_days=1`,
        `activation_ends_at=now() + interval '1 day'`,
        `published_at=now() - interval '1 hour'`,
      ]) {
        await expect(dataSource.query(`UPDATE ${VERSIONS} SET ${set} WHERE id=$1`, [live.version.id])).rejects.toThrow(/immutable/);
      }
      await expect(dataSource.query(`UPDATE ${VERSIONS} SET version=99 WHERE id=$1`, [live.version.id])).rejects.toThrow(/identity is immutable/);
      await expect(dataSource.query(`DELETE FROM ${VERSIONS} WHERE id=$1`, [live.version.id])).rejects.toThrow(/cannot be deleted once published/);
      await expect(policies.replaceVersionDraft(admin.id, key, live.version.version, { terms: terms(), legalEvidenceKey: null, activationEndsAt: null }, 'edit')).rejects.toBeInstanceOf(CommercialLifecycleConflictException);
    });

    it('freezes the option rows of a published version (direct SQL), and permits replacing them while a draft', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      const replaced = await policies.replaceVersionDraft(
        admin.id, key, drafted.version.version,
        { terms: terms({ lateRetentionOptions: [{ kind: 'full_collected' }], noShowRetentionOptions: [{ kind: 'none' }] }), legalEvidenceKey: null, activationEndsAt: null },
        'narrow the set',
      );
      expect(replaced.options.map((o) => `${o.purpose}:${o.kind}`).sort()).toEqual(['late_cancellation:full_collected', 'no_show:none']);

      await policies.publishVersion(admin.id, key, drafted.version.version, 'go live');
      const [option] = await dataSource.query(`SELECT id FROM ${OPTIONS} WHERE version_id=$1 LIMIT 1`, [drafted.version.id]);
      await expect(dataSource.query(`DELETE FROM ${OPTIONS} WHERE id=$1`, [option.id])).rejects.toThrow(/frozen once their version is published/);
      await expect(dataSource.query(`UPDATE ${OPTIONS} SET kind='none' WHERE id=$1`, [option.id])).rejects.toThrow(/frozen/);
      await expect(insertRawOption(drafted.version.id, 'no_show', 5, 'full_collected')).rejects.toThrow(/frozen/);
    });

    it('permits discarding a draft (with its options) and nothing else', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      await policies.discardVersionDraft(admin.id, key, drafted.version.version, 'abandoned');
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM ${OPTIONS} WHERE version_id=$1`, [drafted.version.id]);
      expect(n).toBe(0);
      await expect(policies.getVersion(key, drafted.version.version)).rejects.toBeInstanceOf(CommercialNotFoundException);

      const live = await published(key);
      await expect(policies.discardVersionDraft(admin.id, key, live.version.version, 'suite')).rejects.toBeInstanceOf(CommercialLifecycleConflictException);
    });

    it('makes the policy key permanent and unrewritable (direct SQL)', async () => {
      const key = await policyKey();
      await expect(dataSource.query(`UPDATE ${KEYS} SET policy_key='renamed' WHERE policy_key=$1`, [key])).rejects.toThrow(/identity is immutable/);
      await expect(dataSource.query(`DELETE FROM ${KEYS} WHERE policy_key=$1`, [key])).rejects.toThrow(/permanent/);
      await expect(policies.createPolicy(admin.id, key, 'again', 'dup')).rejects.toThrow();
    });
  });

  // =========================================================================
  // §3. The clock is PostgreSQL
  // =========================================================================

  describe('§3 the clock is PostgreSQL', () => {
    it('takes the publication instants from the database, not the API host', async () => {
      const key = await policyKey();
      const [{ before }] = await dataSource.query(`SELECT now() AS before`);
      const live = await published(key);
      const [{ after }] = await dataSource.query(`SELECT now() AS after`);
      const row = await versionRow(key, live.version.version);
      expect((row.published_at as Date).getTime()).toBeGreaterThanOrEqual((before as Date).getTime());
      expect((row.published_at as Date).getTime()).toBeLessThanOrEqual((after as Date).getTime());
      expect((row.activation_starts_at as Date).getTime()).toBe((row.published_at as Date).getTime());
    });

    it('cannot be backdated through the DTO, because the field does not exist', async () => {
      const key = await policyKey();
      const body = { ...dtoTerms(), activationStartsAt: '2020-01-01T00:00:00.000Z', reason: 'backdate attempt' };
      await request(app.getHttpServer()).post(`${BASE}/outcome-policies/${key}/versions`).set('Authorization', `Bearer ${admin.accessToken}`).send(body).expect(400);
    });

    it('cannot be backdated through raw SQL either, and refuses a supplied instant (direct SQL)', async () => {
      const key = await policyKey();
      const drafted = await draft(key);
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET lifecycle_state='published', published_at=now(), activation_starts_at=now() - interval '1 day', published_by_label='s' WHERE id=$1`, [drafted.version.id]),
      ).rejects.toThrow(/never retroactive|not_retroactive/);
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET lifecycle_state='published', published_at=now() - interval '1 day', activation_starts_at=now(), published_by_label='s' WHERE id=$1`, [drafted.version.id]),
      ).rejects.toThrow(/database clock/);
      await publishRaw(drafted.version.id);
      await expect(
        dataSource.query(`UPDATE ${VERSIONS} SET lifecycle_state='retired', retired_at=now() - interval '1 day', retired_by_label='s' WHERE id=$1`, [drafted.version.id]),
      ).rejects.toThrow(/database clock/);
    });

    it('refuses publishing a version whose forward bound has already closed', async () => {
      const key = await policyKey();
      const drafted = await draft(key, terms(), null, new Date(Date.now() + 1_500));
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      await expect(policies.publishVersion(admin.id, key, drafted.version.version, 'late')).rejects.toBeInstanceOf(CommercialTermsInvalidException);
    });
  });

  // =========================================================================
  // §4. Effective windows and concurrency
  // =========================================================================

  describe('§4 effective windows and concurrency', () => {
    it('refuses a second published version while the first is live, and permits one after retirement', async () => {
      const key = await policyKey();
      const first = await published(key);
      const second = await draft(key);
      await expect(policies.publishVersion(admin.id, key, second.version.version, 'overlap')).rejects.toBeInstanceOf(CommercialActivationOverlapException);
      await policies.retireVersion(admin.id, key, first.version.version, 'make room');
      const live = await policies.publishVersion(admin.id, key, second.version.version, 'replacement');
      expect(live.version.lifecycleState).toBe('published');
    });

    it('treats the window as half-open: a replacement may start at the exact retirement instant (direct SQL)', async () => {
      const key = await policyKey();
      const first = await published(key);
      await policies.retireVersion(admin.id, key, first.version.version, 'suite');
      const row = await versionRow(key, first.version.version);
      const [{ overlaps }] = await dataSource.query(
        `SELECT commercial.booking_collection_policy_effective_window($1, $2, 'retired', $3) && tstzrange($3, NULL, '[)') AS overlaps`,
        [row.activation_starts_at, row.activation_ends_at, row.retired_at],
      );
      expect(overlaps).toBe(false);

      // The same property through the exclusion constraint itself, not only the
      // function: a replacement ending 1 ms inside the first window is refused,
      // and one starting at exactly its forward bound is accepted. The bound is
      // read inside SQL so no microsecond is lost to a JS Date round trip.
      const bounded = await policyKey();
      const head = await draft(bounded, terms(), null, new Date(Date.now() + 3_600_000));
      await policies.publishVersion(admin.id, bounded, head.version.version, 'suite');
      const next = await insertRawVersion(bounded, { version: 2 });
      await insertRawOption(next, 'late_cancellation', 0, 'none');
      await insertRawOption(next, 'no_show', 0, 'none');
      const startAt = (offset: string) =>
        dataSource.query(
          `UPDATE ${VERSIONS} SET lifecycle_state='published', published_at=now(), published_by_label='suite',
                  activation_starts_at=(SELECT activation_ends_at ${offset} FROM ${VERSIONS} WHERE id=$2)
            WHERE id=$1`,
          [next, head.version.id],
        );
      await expect(startAt(`- INTERVAL '1 millisecond'`)).rejects.toThrow(/ex_bopv_no_effective_overlap/);
      await startAt('');
      expect((await versionRow(bounded, 2)).lifecycle_state).toBe('published');
    });

    it('lets exactly one of two concurrent publications survive', async () => {
      const key = await policyKey();
      const a = await draft(key);
      const b = await draft(key);
      const results = await Promise.allSettled([
        policies.publishVersion(admin.id, key, a.version.version, 'race'),
        policies.publishVersion(admin.id, key, b.version.version, 'race'),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM ${VERSIONS} WHERE policy_key=$1 AND lifecycle_state='published'`, [key]);
      expect(n).toBe(1);
    });

    it('allocates distinct version numbers under concurrent drafting', async () => {
      const key = await policyKey();
      const drafts = await Promise.all([draft(key), draft(key), draft(key)]);
      expect(new Set(drafts.map((d) => d.version.version)).size).toBe(3);
    });
  });

  // =========================================================================
  // §5. Values: sets, options, windows — every shape refused and accepted
  // =========================================================================

  describe('§5 value shapes (direct SQL)', () => {
    it('refuses an empty, duplicate, descending, negative or out-of-range set', async () => {
      const key = await policyKey();
      for (const set of [[], [2, 2], [4, 2], [-1], [9_000]]) {
        await expect(insertRawVersion(key, { cutoff_hours_allowed: set })).rejects.toThrow(/ck_bopv_cutoff_set/);
      }
      for (const set of [[], [5, 5], [10, 5], [-1], [1_441]]) {
        await expect(insertRawVersion(key, { no_show_grace_minutes_allowed: set })).rejects.toThrow(/ck_bopv_grace_set/);
      }
      await expect(insertRawVersion(key, { cutoff_hours_allowed: [0] })).resolves.toBeDefined();
    });

    it('refuses a bodily-harm window shorter than the dispute window, and leaves case-file retention NULL rather than defaulted', async () => {
      const key = await policyKey();
      await expect(insertRawVersion(key, { dispute_window_hours: 36, bodily_harm_window_hours: 35 })).rejects.toThrow(/ck_bopv_bodily_harm_window/);
      const id = await insertRawVersion(key, { dispute_window_hours: 36, bodily_harm_window_hours: 36 });
      const [row] = await dataSource.query(`SELECT case_file_retention_days, bodily_harm_window_hours FROM ${VERSIONS} WHERE id=$1`, [id]);
      expect(row.case_file_retention_days).toBeNull();
      expect(row.bodily_harm_window_hours).toBe(36);
      await expect(insertRawVersion(key, { version: 2, case_file_retention_days: 0 })).rejects.toThrow(/ck_bopv_case_file_retention/);
    });

    it('refuses every wrong retention-option shape and accepts every right one', async () => {
      const key = await policyKey();
      const id = await insertRawVersion(key, {});
      const refused: Array<[string, Record<string, unknown>]> = [
        ['none', { basis_points: 100 }],
        ['none', { amount_toman: 5 }],
        ['full_collected', { basis_points: 100 }],
        ['full_collected', { amount_toman: 5 }],
        ['percentage_of_collected', {}],
        ['percentage_of_collected', { basis_points: 0 }],
        ['percentage_of_collected', { basis_points: 10_000 }],
        ['percentage_of_collected', { basis_points: 100, amount_toman: 5 }],
        ['fixed_toman', {}],
        ['fixed_toman', { amount_toman: 0 }],
        ['fixed_toman', { amount_toman: -1 }],
        ['fixed_toman', { basis_points: 100, amount_toman: 5 }],
      ];
      for (const [kind, extra] of refused) {
        await expect(insertRawOption(id, 'late_cancellation', 0, kind, extra)).rejects.toThrow(/ck_bopro_shape/);
      }
      await expect(insertRawOption(id, 'refund', 0, 'none')).rejects.toThrow(/ck_bopro_purpose/);
      await expect(insertRawOption(id, 'late_cancellation', 0, 'escrow')).rejects.toThrow(/ck_bopro_kind/);

      await insertRawOption(id, 'late_cancellation', 0, 'none');
      await insertRawOption(id, 'late_cancellation', 1, 'percentage_of_collected', { basis_points: 1 });
      await insertRawOption(id, 'late_cancellation', 2, 'percentage_of_collected', { basis_points: 9_999 });
      await insertRawOption(id, 'late_cancellation', 3, 'fixed_toman', { amount_toman: 1 });
      await insertRawOption(id, 'late_cancellation', 4, 'full_collected');
      // One option per meaning: the same `none`, the same percentage or the same amount collides.
      await expect(insertRawOption(id, 'late_cancellation', 5, 'none')).rejects.toThrow(/uq_bopro_meaning/);
      await expect(insertRawOption(id, 'late_cancellation', 6, 'percentage_of_collected', { basis_points: 1 })).rejects.toThrow(/uq_bopro_meaning/);
      await expect(insertRawOption(id, 'late_cancellation', 7, 'fixed_toman', { amount_toman: 1 })).rejects.toThrow(/uq_bopro_meaning/);
      // A different purpose may carry the same meaning.
      await insertRawOption(id, 'no_show', 0, 'none');
    });

    it('refuses publishing a version that offers no option for a purpose (direct SQL)', async () => {
      const key = await policyKey();
      const id = await insertRawVersion(key, {});
      await insertRawOption(id, 'late_cancellation', 0, 'none');
      await expect(publishRaw(id)).rejects.toThrow(/without at least one retention option for each purpose/);
      await insertRawOption(id, 'no_show', 0, 'none');
      await publishRaw(id);
      const [row] = await dataSource.query(`SELECT lifecycle_state FROM ${VERSIONS} WHERE id=$1`, [id]);
      expect(row.lifecycle_state).toBe('published');
    });

    it('the service refuses the same shapes with a readable code, before anything is written', async () => {
      const key = await policyKey();
      const cases: Array<Partial<BookingOutcomePolicyVersionTermsV1>> = [
        { cutoffHoursAllowed: [] },
        { cutoffHoursAllowed: [12, 6] },
        { lateRetentionOptions: [{ kind: 'none' }, { kind: 'none' }] },
        { lateRetentionOptions: [{ kind: 'percentage_of_collected', basisPoints: 0 }] },
        { noShowRetentionOptions: [{ kind: 'fixed_toman', amountToman: 0 }] },
        { bodilyHarmWindowHours: 1, disputeWindowHours: 2 },
        { rescheduleFreeCountBeforeCutoff: -1 },
        { legalCap: { kind: 'none' } },
      ];
      for (const overrides of cases) {
        await expect(draft(key, terms(overrides))).rejects.toBeInstanceOf(CommercialTermsInvalidException);
      }
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM ${VERSIONS} WHERE policy_key=$1`, [key]);
      expect(n).toBe(0);
    });
  });

  // =========================================================================
  // §6. The copy family
  // =========================================================================

  describe('§6 customer policy copy', () => {
    it('walks draft -> published -> retired, stores the text as data, and computes the hash the database agrees with', async () => {
      const key = await copyKey();
      const body = 'متن نمونه برای آزمون. این متن حقوقی تأییدشده نیست.';
      const drafted = await copyDraft(key, body);
      expect(drafted.body).toBe(body);
      expect(drafted.bodySha256).toBe(sha256Hex(body));
      const [{ db }] = await dataSource.query(`SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS db`, [body]);
      expect(drafted.bodySha256).toBe(db);

      const live = await copies.publishVersion(admin.id, key, drafted.version, 'go live');
      expect(live.lifecycleState).toBe('published');
      await expect(dataSource.query(`UPDATE ${COPY_VERSIONS} SET body='edited' WHERE id=$1`, [live.id])).rejects.toThrow(/immutable/);
      const retired = await copies.retireVersion(admin.id, key, drafted.version, 'superseded');
      expect(retired.lifecycleState).toBe('retired');
    });

    it('refuses any locale but fa-IR, a wrong hash, an empty body and a numeric column (direct SQL)', async () => {
      const key = await copyKey();
      const insert = (columns: Record<string, unknown>) => {
        const base: Record<string, unknown> = { id: uuidv7(), copy_key: key, version: 1, locale: 'fa-IR', body: 'x', created_by_label: 'suite', ...columns };
        const names = Object.keys(base);
        return dataSource.query(`INSERT INTO ${COPY_VERSIONS} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(base));
      };
      await expect(insert({ locale: 'en-US', body_sha256: sha256Hex('x') })).rejects.toThrow(/ck_cpcv_locale/);
      await expect(insert({ body_sha256: 'a'.repeat(64) })).rejects.toThrow(/ck_cpcv_body_hash/);
      await expect(insert({ body: '   ', body_sha256: sha256Hex('   ') })).rejects.toThrow(/ck_cpcv_body/);
      await expect(insert({ body_sha256: sha256Hex('x'), cutoff_hours: 24 })).rejects.toThrow(/column "cutoff_hours"/);
      await expect(copies.createVersionDraft(admin.id, { copyKey: key, terms: { contractVersion: 1, locale: 'en-US' as 'fa-IR', body: 'x' }, activationEndsAt: null }, 'suite')).rejects.toBeInstanceOf(CommercialTermsInvalidException);
    });

    it('refuses a second live copy version while the first is open-ended', async () => {
      const key = await copyKey();
      const first = await copyDraft(key);
      await copies.publishVersion(admin.id, key, first.version, 'suite');
      const second = await copyDraft(key, 'نسخهٔ دوم');
      await expect(copies.publishVersion(admin.id, key, second.version, 'suite')).rejects.toBeInstanceOf(CommercialActivationOverlapException);
    });

    it('returns the body on the single read and the hash on the list, never an actor', async () => {
      const key = await copyKey();
      const drafted = await copyDraft(key);
      const one = await request(app.getHttpServer()).get(`${BASE}/customer-policy-copies/${key}/versions/${drafted.version}`).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
      expect(one.body.data.body).toBe(drafted.body);
      const list = await request(app.getHttpServer()).get(`${BASE}/customer-policy-copies/${key}/versions`).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
      expect(list.body.data.items[0].bodySha256).toBe(drafted.bodySha256);
      expect(list.body.data.items[0].body).toBeUndefined();
      expect(JSON.stringify(list.body) + JSON.stringify(one.body)).not.toMatch(/createdBy|publishedBy|_user_id|byLabel/);
    });
  });

  // =========================================================================
  // §7. Legal evidence and the cap gate — the load-bearing section
  // =========================================================================

  describe('§7 Legal evidence and the legalCap gate', () => {
    it('records and retires, one way, with the recorded facts frozen (direct SQL)', async () => {
      const key = await recordedEvidence();
      const [row] = await dataSource.query(`SELECT * FROM ${EVIDENCE} WHERE evidence_key=$1`, [key]);
      expect(row.status).toBe('recorded');
      expect(row.recorded_audit_id).not.toBeNull();
      await expect(dataSource.query(`UPDATE ${EVIDENCE} SET subject='policy_copy' WHERE evidence_key=$1`, [key])).rejects.toThrow(/immutable/);
      await expect(dataSource.query(`UPDATE ${EVIDENCE} SET reference='changed' WHERE evidence_key=$1`, [key])).rejects.toThrow(/immutable/);
      await expect(dataSource.query(`UPDATE ${EVIDENCE} SET retired_at=now() WHERE evidence_key=$1`, [key])).rejects.toThrow(/written only by the retirement transition/);
      await expect(dataSource.query(`DELETE FROM ${EVIDENCE} WHERE evidence_key=$1`, [key])).rejects.toThrow(/permanent/);
      await expect(insertRawEvidence(nextKey('born'), { status: 'retired', retired_at: new Date(), retired_by_user_id: admin.id, retired_audit_id: uuidv7() })).rejects.toThrow(/created as recorded/);
      await expect(insertRawEvidence(nextKey('subj'), { subject: 'lawyer_name' })).rejects.toThrow(/ck_ler_subject/);
      await expect(insertRawEvidence(nextKey('status'), { status: 'approved' })).rejects.toThrow(/ck_ler_status|created as recorded/);

      const retired = await evidence.retire(admin.id, key, 'withdrawn');
      expect(retired.status).toBe('retired');
      expect(retired.retiredAuditId).not.toBeNull();
      await expect(dataSource.query(`UPDATE ${EVIDENCE} SET status='recorded', retired_at=NULL, retired_by_user_id=NULL, retired_audit_id=NULL WHERE evidence_key=$1`, [key])).rejects.toThrow(/permanently immutable/);
      await expect(evidence.retire(admin.id, key, 'again')).rejects.toBeInstanceOf(CommercialLifecycleConflictException);
    });

    it('makes a legalCap unwritable without a qualifying reference, through the service and through raw SQL', async () => {
      const key = await policyKey();
      const cap = terms({ legalCap: { kind: 'percentage_of_collected', basisPoints: 5_000 } });

      // Service: no key, unknown key, wrong subject, retired — one code for all.
      await expect(draft(key, cap, null)).rejects.toBeInstanceOf(CommercialTermsInvalidException);
      await expect(draft(key, cap, nextKey('unknown'))).rejects.toBeInstanceOf(CommercialLegalEvidenceNotQualifyingException);
      const wrong = await recordedEvidence('policy_copy');
      await expect(draft(key, cap, wrong)).rejects.toBeInstanceOf(CommercialLegalEvidenceNotQualifyingException);
      const retiredKey = await recordedEvidence('retention_cap');
      await evidence.retire(admin.id, retiredKey, 'suite');
      await expect(draft(key, cap, retiredKey)).rejects.toBeInstanceOf(CommercialLegalEvidenceNotQualifyingException);
      // A key with a cap but no legalCap is refused too: the pairing is both ways.
      await expect(draft(key, terms(), 'ev-any')).rejects.toBeInstanceOf(CommercialTermsInvalidException);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM ${VERSIONS} WHERE policy_key=$1`, [key]);
      expect(n).toBe(0);

      // Raw SQL, every cause: the CHECK, the FK and the trigger each refuse.
      // The BEFORE trigger answers first; the CHECK `ck_bopv_legal_cap_requires_evidence` stands behind it (proved by the trigger-bypass mutation probe).
      await expect(insertRawVersion(key, { legal_cap_kind: 'full_collected' })).rejects.toThrow(/requires a Legal-evidence reference|ck_bopv_legal_cap_requires_evidence/);
      // With qualifying evidence the trigger passes, so the shape CHECK alone refuses an absent number.
      const okId = (await dataSource.query(`SELECT id FROM ${EVIDENCE} WHERE evidence_key=$1`, [await recordedEvidence('retention_cap')]))[0].id;
      await expect(insertRawVersion(key, { legal_cap_kind: 'percentage_of_collected', legal_evidence_id: okId })).rejects.toThrow(/ck_bopv_legal_cap_shape/);
      await expect(insertRawVersion(key, { legal_cap_kind: 'fixed_toman', legal_evidence_id: okId })).rejects.toThrow(/ck_bopv_legal_cap_shape/);
      // A nonexistent reference: the trigger answers first; the FK stands behind it.
      await expect(insertRawVersion(key, { legal_cap_kind: 'full_collected', legal_evidence_id: uuidv7() })).rejects.toThrow(/record does not exist|foreign key/);
      const wrongId = (await dataSource.query(`SELECT id FROM ${EVIDENCE} WHERE evidence_key=$1`, [wrong]))[0].id;
      await expect(insertRawVersion(key, { legal_cap_kind: 'full_collected', legal_evidence_id: wrongId })).rejects.toThrow(/only evidence of subject retention_cap/);
      // Qualifying evidence again, so each CHECK is what refuses rather than the trigger.
      await expect(insertRawVersion(key, { legal_cap_kind: 'full_collected', legal_cap_basis_points: 100, legal_evidence_id: okId })).rejects.toThrow(/ck_bopv_legal_cap_shape/);
      await expect(insertRawVersion(key, { legal_cap_kind: 'none', legal_evidence_id: okId })).rejects.toThrow(/ck_bopv_legal_cap_kind/);
    });

    it('refuses PUBLICATION against evidence retired before it (direct SQL), and accepts a currently recorded retention_cap record', async () => {
      const key = await policyKey();
      const evKey = await recordedEvidence('retention_cap');
      const evId = (await dataSource.query(`SELECT id FROM ${EVIDENCE} WHERE evidence_key=$1`, [evKey]))[0].id;
      const id = await insertRawVersion(key, { legal_cap_kind: 'fixed_toman', legal_cap_amount_toman: 100_000, legal_evidence_id: evId });
      await insertRawOption(id, 'late_cancellation', 0, 'none');
      await insertRawOption(id, 'no_show', 0, 'none');

      await evidence.retire(admin.id, evKey, 'withdrawn before publication');
      await expect(publishRaw(id)).rejects.toThrow(/not currently recorded/);
      const [still] = await dataSource.query(`SELECT lifecycle_state FROM ${VERSIONS} WHERE id=$1`, [id]);
      expect(still.lifecycle_state).toBe('draft');

      // Re-point the draft at a live record: publication succeeds.
      const freshKey = await recordedEvidence('retention_cap');
      const freshId = (await dataSource.query(`SELECT id FROM ${EVIDENCE} WHERE evidence_key=$1`, [freshKey]))[0].id;
      await dataSource.query(`UPDATE ${VERSIONS} SET legal_evidence_id=$2 WHERE id=$1`, [id, freshId]);
      await publishRaw(id);
      const [live] = await dataSource.query(`SELECT lifecycle_state, legal_cap_kind, legal_cap_amount_toman FROM ${VERSIONS} WHERE id=$1`, [id]);
      expect(live.lifecycle_state).toBe('published');
      expect(live.legal_cap_kind).toBe('fixed_toman');
      expect(Number(live.legal_cap_amount_toman)).toBe(100_000);
    });

    it('publishes a cap through the service against a recorded record, and refuses it through the service once the record is retired', async () => {
      const key = await policyKey();
      const evKey = await recordedEvidence('retention_cap');
      const drafted = await draft(key, terms({ legalCap: { kind: 'full_collected' } }), evKey);
      expect(drafted.legalEvidenceKey).toBe(evKey);

      await evidence.retire(admin.id, evKey, 'withdrawn');
      await expect(policies.publishVersion(admin.id, key, drafted.version.version, 'publish anyway')).rejects.toBeInstanceOf(CommercialLegalEvidenceNotQualifyingException);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM admin.admin_audit_log WHERE action=$1 AND target_id=$2`, [OUTCOME_POLICY_AUDIT_ACTIONS.versionPublished, `${key}@${drafted.version.version}`]);
      expect(n).toBe(0);

      const fresh = await recordedEvidence('retention_cap');
      await policies.replaceVersionDraft(admin.id, key, drafted.version.version, { terms: terms({ legalCap: { kind: 'full_collected' } }), legalEvidenceKey: fresh, activationEndsAt: null }, 're-point');
      const live = await policies.publishVersion(admin.id, key, drafted.version.version, 'go live');
      expect(live.version.lifecycleState).toBe('published');
      expect(live.legalEvidenceKey).toBe(fresh);
    });

    it('retiring evidence AFTER publication rewrites no published version', async () => {
      const key = await policyKey();
      const evKey = await recordedEvidence('retention_cap');
      const drafted = await draft(key, terms({ legalCap: { kind: 'percentage_of_collected', basisPoints: 3_000 } }), evKey);
      await policies.publishVersion(admin.id, key, drafted.version.version, 'go live');
      const before = await versionRow(key, drafted.version.version);

      await evidence.retire(admin.id, evKey, 'withdrawn after publication');
      const after = await versionRow(key, drafted.version.version);
      expect(after).toEqual(before);
      expect(after.lifecycle_state).toBe('published');
      expect(after.legal_cap_kind).toBe('percentage_of_collected');
    });

    it('the refusal does not distinguish a missing record from a retired or wrong-subject one', async () => {
      const key = await policyKey();
      const wrong = await recordedEvidence('policy_copy');
      const gone = await recordedEvidence('retention_cap');
      await evidence.retire(admin.id, gone, 'suite');
      const bodies: string[] = [];
      for (const evidenceKey of [nextKey('absent'), wrong, gone]) {
        const res = await request(app.getHttpServer())
          .post(`${BASE}/outcome-policies/${key}/versions`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({ ...dtoTerms(), legalCap: { kind: 'full_collected' }, legalEvidenceKey: evidenceKey, reason: 'cap attempt' })
          .expect(409);
        bodies.push(JSON.stringify(res.body));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).not.toMatch(/retired|subject|exist|constraint|ck_|tg_|fk_/i);
    });

    it('the DTO has no evidence id field: an id is a 400, and the response never carries one', async () => {
      const key = await policyKey();
      const evKey = await recordedEvidence('retention_cap');
      const evId = (await dataSource.query(`SELECT id FROM ${EVIDENCE} WHERE evidence_key=$1`, [evKey]))[0].id;
      await request(app.getHttpServer())
        .post(`${BASE}/outcome-policies/${key}/versions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...dtoTerms(), legalCap: { kind: 'full_collected' }, legalEvidenceId: evId, reason: 'forged id' })
        .expect(400);
      const ok = await request(app.getHttpServer())
        .post(`${BASE}/outcome-policies/${key}/versions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...dtoTerms(), legalCap: { kind: 'full_collected' }, legalEvidenceKey: evKey, reason: 'cap draft' })
        .expect(201);
      expect(ok.body.data.legalEvidenceKey).toBe(evKey);
      expect(JSON.stringify(ok.body)).not.toContain(evId);
    });
  });

  // =========================================================================
  // §8. Authorization, audit and refusals
  // =========================================================================

  const dtoTerms = () => ({
    cutoffHoursAllowed: [6, 12],
    lateRetentionOptions: [{ kind: 'none' }, { kind: 'full_collected' }],
    noShowGraceMinutesAllowed: [5],
    noShowRetentionOptions: [{ kind: 'none' }],
    rescheduleFreeCountBeforeCutoff: 1,
    disputeWindowHours: 36,
    appealWindowHours: 48,
  });

  describe('§8 authorization, audit and refusals', () => {
    const ROUTES: Array<[string, string]> = [
      ['get', `${BASE}/outcome-policies`],
      ['post', `${BASE}/outcome-policies`],
      ['get', `${BASE}/outcome-policies/k/versions`],
      ['post', `${BASE}/outcome-policies/k/versions`],
      ['get', `${BASE}/outcome-policies/k/versions/1`],
      ['put', `${BASE}/outcome-policies/k/versions/1`],
      ['post', `${BASE}/outcome-policies/k/versions/1/publish`],
      ['post', `${BASE}/outcome-policies/k/versions/1/retire`],
      ['delete', `${BASE}/outcome-policies/k/versions/1`],
      ['get', `${BASE}/customer-policy-copies`],
      ['post', `${BASE}/customer-policy-copies`],
      ['get', `${BASE}/customer-policy-copies/k/versions`],
      ['post', `${BASE}/customer-policy-copies/k/versions`],
      ['get', `${BASE}/customer-policy-copies/k/versions/1`],
      ['put', `${BASE}/customer-policy-copies/k/versions/1`],
      ['post', `${BASE}/customer-policy-copies/k/versions/1/publish`],
      ['post', `${BASE}/customer-policy-copies/k/versions/1/retire`],
      ['delete', `${BASE}/customer-policy-copies/k/versions/1`],
      ['get', `${BASE}/legal-evidence`],
      ['get', `${BASE}/legal-evidence/k`],
      ['post', `${BASE}/legal-evidence`],
      ['post', `${BASE}/legal-evidence/k/retire`],
    ];

    it('refuses every route unauthenticated (401) and for a customer, a professional and a platform operator (403), with a 404 control', async () => {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const professional = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const operator = await seedUser(app, dataSource, nextPhone(), ['platform_operator']);
      for (const [method, path] of ROUTES) {
        const agent = request(app.getHttpServer()) as unknown as Record<string, (p: string) => request.Test>;
        await agent[method](path).expect(401);
        for (const user of [customer, professional, operator]) {
          await agent[method](path).set('Authorization', `Bearer ${user.accessToken}`).expect(403);
        }
      }
      await request(app.getHttpServer()).get(`${BASE}/outcome-policies-that-do-not-exist`).set('Authorization', `Bearer ${admin.accessToken}`).expect(404);
    });

    // The seller routes `/api/v1/me/outcome-policies` and
    // `/api/v1/me/outcome-policy-assignments/:ref` are `#42b`'s (#159) and are
    // pinned by its own suite; this plane still exposes no route of its own
    // outside the administrator prefix.
    it('exposes no seller- or customer-facing route of its own', async () => {
      for (const path of ['/api/v1/outcome-policies', '/api/v1/legal-evidence', '/api/v1/customer-policy-copies']) {
        const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
        await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${customer.accessToken}`).expect(404);
      }
    });

    it('refuses on the next request after the role is revoked, with the SAME token, for reads and writes', async () => {
      await request(app.getHttpServer()).get(`${BASE}/legal-evidence`).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
      await dataSource.query(`DELETE FROM identity.user_roles WHERE user_id = $1`, [admin.id]);
      await request(app.getHttpServer()).get(`${BASE}/legal-evidence`).set('Authorization', `Bearer ${admin.accessToken}`).expect(403);
      await request(app.getHttpServer())
        .post(`${BASE}/legal-evidence`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ evidenceKey: nextKey('rev'), subject: 'retention_cap', referenceKind: 'internal_ticket', reference: 'T', summary: 's', reason: 'after revocation' })
        .expect(403);
      const [{ n }] = await dataSource.query(`SELECT count(*)::int AS n FROM ${EVIDENCE}`);
      expect(n).toBe(0);
    });

    it('rejects an unknown field, a forged actor, a forged lifecycle and a whitespace reason', async () => {
      const key = await policyKey();
      const post = (path: string, body: Record<string, unknown>) =>
        request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${admin.accessToken}`).send(body);
      await post(`${BASE}/outcome-policies/${key}/versions`, { ...dtoTerms(), lifecycleState: 'published', reason: 'forged' }).expect(400);
      await post(`${BASE}/outcome-policies/${key}/versions`, { ...dtoTerms(), lateRetentionOptions: [{ kind: 'none', secret: 1 }], reason: 'nested unknown' }).expect(400);
      await post(`${BASE}/outcome-policies`, { policyKey: nextKey('k'), displayName: 'x', createdByUserId: admin.id, reason: 'forged actor' }).expect(400);
      await post(`${BASE}/legal-evidence`, { evidenceKey: nextKey('e'), subject: 'retention_cap', referenceKind: 'internal_ticket', reference: 'T', summary: 's', document: 'base64...', reason: 'file smuggled' }).expect(400);
      await post(`${BASE}/legal-evidence`, { evidenceKey: nextKey('e'), subject: 'retention_cap', referenceKind: 'internal_ticket', reference: 'T', summary: 's', reason: '     ' }).expect(400);
      await post(`${BASE}/customer-policy-copies/${await copyKey()}/versions`, { locale: 'fa-IR', body: 'x', cutoffHours: 24, reason: 'number on copy' }).expect(400);
    });

    it('writes exactly one audit row per real mutation across all three families, and none for a read', async () => {
      const key = await policyKey();
      const d = await draft(key);
      await policies.publishVersion(admin.id, key, d.version.version, 'go live');
      await policies.retireVersion(admin.id, key, d.version.version, 'superseded');
      expect((await auditRows(`${key}@${d.version.version}`)).map((r) => r.action)).toEqual([
        OUTCOME_POLICY_AUDIT_ACTIONS.versionDrafted,
        OUTCOME_POLICY_AUDIT_ACTIONS.versionPublished,
        OUTCOME_POLICY_AUDIT_ACTIONS.versionRetired,
      ]);
      expect((await auditRows(key)).map((r) => r.action)).toEqual([OUTCOME_POLICY_AUDIT_ACTIONS.policyCreated]);

      const c = await copyKey();
      const cd = await copyDraft(c);
      await copies.replaceVersionDraft(admin.id, c, cd.version, { terms: { contractVersion: 1, locale: 'fa-IR', body: 'ویرایش' }, activationEndsAt: null }, 'edit');
      await copies.publishVersion(admin.id, c, cd.version, 'suite');
      await copies.retireVersion(admin.id, c, cd.version, 'suite');
      expect((await auditRows(`${c}@${cd.version}`)).map((r) => r.action)).toEqual([
        OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionDrafted,
        OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionUpdated,
        OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionPublished,
        OUTCOME_POLICY_AUDIT_ACTIONS.copyVersionRetired,
      ]);
      expect((await auditRows(c)).map((r) => r.action)).toEqual([OUTCOME_POLICY_AUDIT_ACTIONS.copyCreated]);

      const e = await recordedEvidence();
      await evidence.retire(admin.id, e, 'suite');
      const evidenceAudit = await auditRows(e);
      expect(evidenceAudit.map((r) => r.action)).toEqual([OUTCOME_POLICY_AUDIT_ACTIONS.legalEvidenceRecorded, OUTCOME_POLICY_AUDIT_ACTIONS.legalEvidenceRetired]);
      // The audit snapshot never carries the reference or the summary.
      const [snap] = await dataSource.query(`SELECT after_state::text AS s FROM admin.admin_audit_log WHERE target_id=$1 AND action=$2`, [e, OUTCOME_POLICY_AUDIT_ACTIONS.legalEvidenceRecorded]);
      expect(snap.s).not.toContain(`LEGAL-${e}`);
      expect(snap.s).not.toContain('suite attestation');

      const before = await auditCount();
      await policies.listPolicies();
      await policies.listVersions(key);
      await copies.listVersions(c);
      await evidence.list();
      await evidence.get(e);
      for (const path of [`${BASE}/outcome-policies`, `${BASE}/outcome-policies/${key}/versions`, `${BASE}/customer-policy-copies`, `${BASE}/legal-evidence`, `${BASE}/legal-evidence/${e}`]) {
        await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
      }
      expect(await auditCount()).toBe(before);
    });

    it('writes nothing at all when a request is refused before the transaction opens', async () => {
      const key = await policyKey();
      const before = await auditCount();
      await expect(draft(key, terms({ cutoffHoursAllowed: [] }))).rejects.toThrow();
      await expect(evidence.record(admin.id, nextKey('e'), { subject: 'retention_cap', referenceKind: 'internal_ticket', reference: 'T', summary: 's' }, ' x ')).rejects.toThrow();
      const [{ n }] = await dataSource.query(`SELECT (SELECT count(*) FROM ${VERSIONS})::int + (SELECT count(*) FROM ${EVIDENCE})::int AS n`);
      expect(n).toBe(0);
      expect(await auditCount()).toBe(before);
    });

    /**
     * The audit row and the domain row commit together, or neither does —
     * proved the way the collection-policy suite proves it: `record` is
     * patched to write its row and then throw. Sharing the caller's
     * `EntityManager`, the throw rolls both back; on a separate connection the
     * audit row would survive, attributing a publication that never happened.
     * Three families, three probes.
     */
    it('rolls the DOMAIN row back when the audit write fails after inserting — policy, copy and evidence', async () => {
      const key = await policyKey();
      const c = await copyKey();
      const audit = app.get(AdminAuditService) as unknown as {
        record: (manager: EntityManager, input: Parameters<AdminAuditService['record']>[1]) => Promise<string>;
      };
      const original = audit.record.bind(audit);
      const before = await auditCount();
      audit.record = async (manager, input) => {
        const id = await original(manager, input);
        throw new Error(`probe: the audit row ${id} is written, then the mutation fails`);
      };
      try {
        await expect(draft(key)).rejects.toThrow(/probe/);
        await expect(copyDraft(c)).rejects.toThrow(/probe/);
        await expect(evidence.record(admin.id, nextKey('e'), { subject: 'retention_cap', referenceKind: 'internal_ticket', reference: 'T', summary: 's' }, 'atomicity')).rejects.toThrow(/probe/);
      } finally {
        audit.record = original;
      }
      const [{ n }] = await dataSource.query(
        `SELECT (SELECT count(*) FROM ${VERSIONS})::int + (SELECT count(*) FROM ${OPTIONS})::int + (SELECT count(*) FROM ${COPY_VERSIONS})::int + (SELECT count(*) FROM ${EVIDENCE})::int AS n`,
      );
      expect(n).toBe(0);
      expect(await auditCount()).toBe(before);
    });

    it('the atomicity case is not vacuous: the same writes DO land on success', async () => {
      const key = await policyKey();
      const before = await auditCount();
      await draft(key);
      await copyDraft(await copyKey());
      await recordedEvidence();
      expect(await auditCount()).toBe(before + 4); // draft + copy key + copy draft + evidence
    });

    it('never returns an actor identity, an audit id or a foreign row id from a read', async () => {
      const key = await policyKey();
      const evKey = await recordedEvidence('retention_cap');
      const d = await draft(key, terms({ legalCap: { kind: 'full_collected' } }), evKey);
      await policies.publishVersion(admin.id, key, d.version.version, 'suite');
      const evId = (await dataSource.query(`SELECT id FROM ${EVIDENCE} WHERE evidence_key=$1`, [evKey]))[0].id;
      const paths = [`${BASE}/outcome-policies`, `${BASE}/outcome-policies/${key}/versions`, `${BASE}/outcome-policies/${key}/versions/${d.version.version}`, `${BASE}/legal-evidence`, `${BASE}/legal-evidence/${evKey}`];
      for (const path of paths) {
        const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
        const body = JSON.stringify(res.body);
        expect(body).not.toContain(admin.id);
        expect(body).not.toContain(evId);
        expect(body).not.toContain(d.version.id);
        expect(body).not.toMatch(/createdBy|publishedBy|retiredBy|recordedBy|_user_id|byLabel|auditId|AuditId/);
      }
      const list = await request(app.getHttpServer()).get(`${BASE}/legal-evidence`).set('Authorization', `Bearer ${admin.accessToken}`).expect(200);
      expect(list.body.data.items[0].reference).toBeUndefined();
      expect(list.body.data.items[0].summary).toBeUndefined();
    });
  });

  // =========================================================================
  // §9. Zero-behaviour boundary
  // =========================================================================

  describe('§9 zero booking behaviour change', () => {
    // The post-commit fast-path drain is a no-op while another drain is still
    // running, so one cycle's events can otherwise be dispatched inside the
    // next cycle's window. Settle every outbox the cycle writes before counting.
    async function settleOutbox(): Promise<void> {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await ctx.relay.drain();
        const [{ pending }] = await dataSource.query(
          `SELECT ((SELECT count(*) FROM booking.outbox_events WHERE published_at IS NULL)
                 + (SELECT count(*) FROM commerce.outbox_events WHERE published_at IS NULL)
                 + (SELECT count(*) FROM payment.outbox_events WHERE published_at IS NULL)
                 + (SELECT count(*) FROM notification.outbox_events WHERE published_at IS NULL))::int AS pending`,
        );
        if (pending === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('outbox did not settle');
    }

    async function bookAndCancel(): Promise<Record<string, unknown>> {
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const owner = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      const professional = await seedProfessional(dataSource, owner.id, 'متخصص آزمون', 150_000);
      const slotId = await seedSlot(dataSource, professional.id, professional.serviceId, futureSlotTime(48));
      const created = await request(app.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ professionalId: professional.id, slotId, serviceId: professional.serviceId })
        .expect(201);
      const bookingId = created.body.data.booking.id;
      const orderId = created.body.data.order.id;
      const cancelled = await request(app.getHttpServer())
        .post(`/api/v1/bookings/${bookingId}/cancel`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ reason: 'changed my mind' })
        .expect(201);
      await settleOutbox();
      const [order] = await dataSource.query(`SELECT status, collected_total_toman, refunded_total_toman FROM commerce.orders WHERE id=$1`, [orderId]);
      const [schedule] = await dataSource.query(`SELECT collection_mode, policy_key, policy_version, policy_accepted_at FROM commerce.order_payment_schedules WHERE order_id=$1`, [orderId]);
      const [{ refunds }] = await dataSource.query(`SELECT count(*)::int AS refunds FROM payment.refunds WHERE order_id=$1`, [orderId]);
      // Per-row identities drop out; the sandbox redirect keeps every part but its random payment reference.
      const strip = (o: Record<string, unknown>) =>
        JSON.parse(
          JSON.stringify(o, (k, v) => {
            if (/id$|At$|Id$|^id$|token|slot/i.test(k)) return undefined;
            if (k === 'redirectUrl' && typeof v === 'string') return v.replace(/reference=[^&]+/, 'reference=<ref>');
            return v;
          }),
        );
      return {
        checkout: strip(created.body.data),
        cancel: strip(cancelled.body),
        order: { ...order, collected_total_toman: Number(order.collected_total_toman), refunded_total_toman: Number(order.refunded_total_toman) },
        schedule: { ...schedule, policy_version: schedule.policy_version },
        refunds,
      };
    }

    const counts = async () =>
      dataSource.query(
        `SELECT (SELECT count(*) FROM payment.refunds)::int AS refunds,
                (SELECT count(*) FROM commercial.booking_credit_returns)::int AS credit_returns,
                (SELECT count(*) FROM commercial.seller_collection_policy_assignments)::int AS assignments,
                (SELECT count(*) FROM commerce.order_payment_schedules WHERE policy_accepted_at IS NOT NULL)::int AS accepted,
                (SELECT count(*) FROM notification.notifications)::int AS notifications`,
      );

    it('publishing a full policy, copy and evidence set changes no checkout, order, schedule, cancellation, refund, credit or notification outcome', async () => {
      const c0 = (await counts())[0];
      const baseline = await bookAndCancel();
      const c1 = (await counts())[0];
      const baselineDelta = Object.fromEntries(Object.keys(c0).map((k) => [k, c1[k] - c0[k]]));

      const evKey = await recordedEvidence('retention_cap');
      const key = await policyKey();
      const d = await draft(key, terms({ legalCap: { kind: 'percentage_of_collected', basisPoints: 5_000 }, caseFileRetentionDays: 30 }), evKey);
      await policies.publishVersion(admin.id, key, d.version.version, 'go live');
      const c = await copyKey();
      const cd = await copyDraft(c);
      await copies.publishVersion(admin.id, c, cd.version, 'go live');

      const c2 = (await counts())[0];
      const after = await bookAndCancel();
      const c3 = (await counts())[0];
      const afterDelta = Object.fromEntries(Object.keys(c2).map((k) => [k, c3[k] - c2[k]]));

      // Same responses, same order and schedule facts, same refund count, and
      // the same per-cycle deltas in refunds, credit returns, assignments,
      // acceptances and notifications: the published families changed nothing.
      expect(after).toEqual(baseline);
      expect(after.schedule).toEqual(expect.objectContaining({ policy_key: null, policy_accepted_at: null }));
      expect(after.refunds).toBe(0);
      expect(afterDelta).toEqual(baselineDelta);
      expect(c3.assignments).toBe(0);
      expect(c3.accepted).toBe(0);
      // Publishing itself wrote nothing outside the six tables and the audit log.
      expect(c2).toEqual(c1);
      // The published families are readable and untouched by the booking cycle.
      expect((await policies.getVersion(key, d.version.version)).version.lifecycleState).toBe('published');
      expect((await copies.getVersion(c, cd.version)).lifecycleState).toBe('published');
    });
  });

  // =========================================================================
  // §10. Privacy coverage
  // =========================================================================

  describe('§10 privacy coverage', () => {
    it('claims all six tables RETAINED, with reasons, and the exact-set check sees them', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const claims = contracts.flatMap((contract) => contract.tables).filter((t) => NEW_TABLES.some((n) => t.table === `commercial.${n}`));
      expect(claims).toHaveLength(6);
      for (const claim of claims) {
        expect(claim.disposition).toBe('retained');
        expect((claim.reason ?? '').length).toBeGreaterThan(40);
      }
      const rows = await dataSource.query(
        `SELECT t.schemaname AS schema, t.tablename AS name, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM pg_tables t JOIN information_schema.columns c ON c.table_schema = t.schemaname AND c.table_name = t.tablename
          WHERE t.schemaname = 'commercial' GROUP BY t.schemaname, t.tablename`,
      );
      expect(evaluateCoverage(rows, contracts).violations.filter((v) => v.table.startsWith('commercial.'))).toEqual([]);
    });

    it('a dishonest no_subject_data claim on any of the six is caught — by the heuristic where a _user_id column exists, and by this pin where it does not', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const rows = await dataSource.query(
        `SELECT t.schemaname AS schema, t.tablename AS name, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
           FROM pg_tables t JOIN information_schema.columns c ON c.table_schema = t.schemaname AND c.table_name = t.tablename
          WHERE t.schemaname = 'commercial' GROUP BY t.schemaname, t.tablename`,
      );
      for (const table of NEW_TABLES) {
        const dishonest = contracts.map((contract) => ({
          ...contract,
          tables: contract.tables.map((t) => (t.table === `commercial.${table}` ? { ...t, disposition: 'no_subject_data' as const } : t)),
        }));
        const report = evaluateCoverage(rows, dishonest as SubjectDataContract[]);
        const flagged = report.violations.some((v) => v.table === `commercial.${table}`);
        // The option table carries no `_user_id` column, so ADR-027's heuristic
        // cannot see it; the pin below is what refuses that claim.
        if (table === 'booking_outcome_policy_retention_options') expect(flagged).toBe(false);
        else expect(flagged).toBe(true);
      }
      const options = contracts.flatMap((c) => c.tables).find((t) => t.table === 'commercial.booking_outcome_policy_retention_options');
      expect(options?.disposition).toBe('retained');
    });

    it('exports nothing to a customer, a seller or the administrator, and reports erasure truthfully', async () => {
      const contracts = app.get<SubjectDataContract[]>(SUBJECT_DATA_CONTRACTS);
      const contract = contracts.find((c) => c.moduleKey === 'commercial-outcome-policy');
      expect(contract).toBeDefined();
      await recordedEvidence();
      await published(await policyKey());
      const customer = await seedUser(app, dataSource, nextPhone(), ['customer']);
      const seller = await seedUser(app, dataSource, nextPhone(), ['customer', 'professional']);
      for (const user of [customer, seller, admin]) {
        expect(await contract!.exportSubjectData(dataSource.manager, user.id)).toEqual([]);
      }
      const outcome = await contract!.eraseSubjectData(dataSource.manager, admin.id, { userId: admin.id, phoneAlias: 'del:s42a', displayAlias: 'x', erasedAt: new Date() });
      expect(outcome.anonymized).toBe(0);
      expect(outcome.deleted).toBe(0);
      expect(outcome.retained.map((r) => r.table).sort()).toEqual(NEW_TABLES.map((n) => `commercial.${n}`).sort());
      const [{ n }] = await dataSource.query(`SELECT (SELECT count(*) FROM ${VERSIONS})::int + (SELECT count(*) FROM ${EVIDENCE})::int AS n`);
      expect(n).toBe(2);
    });
  });
});
