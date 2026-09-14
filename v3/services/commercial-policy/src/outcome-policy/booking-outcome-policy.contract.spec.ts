import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getMetadataArgsStorage } from 'typeorm';

import {
  BOOKING_OUTCOME_LIFECYCLE_STATES,
  BOOKING_OUTCOME_RETENTION_KINDS,
  BOOKING_OUTCOME_RETENTION_PURPOSES,
  BookingOutcomePolicyVersionTermsV1,
  CUSTOMER_POLICY_COPY_LOCALES,
  LEGAL_EVIDENCE_REFERENCE_KINDS,
  LEGAL_EVIDENCE_STATUSES,
  LEGAL_EVIDENCE_SUBJECTS,
  LEGAL_EVIDENCE_SUBJECT_FOR_CAP,
  retentionRuleIdentity,
  utf8ByteLength,
  validateBookingOutcomePolicyVersionTermsV1,
  validateBookingOutcomeRetentionRule,
  validateCustomerPolicyCopyVersionTermsV1,
  validateLegalEvidenceRecordInputV1,
} from '@beauclick/commercial-policy-contract';

import { OUTCOME_POLICY_AUDIT_ACTIONS, OUTCOME_POLICY_AUDIT_TARGETS } from './booking-outcome-policy.constants';
import {
  BOOKING_OUTCOME_POLICY_ENTITIES,
  BookingOutcomePolicyRetentionOptionEntity,
  BookingOutcomePolicyVersionEntity,
  CustomerPolicyCopyVersionEntity,
  LegalEvidenceRecordEntity,
} from './booking-outcome-policy.entities';

/**
 * The `#42a` contract on the fast layer — vocabularies, validators, entity
 * shapes, the exact route set and the audit vocabulary (ADR-051 §1, §5, §10).
 * Everything that needs PostgreSQL is in `booking-outcome-policy.pg-spec.ts`.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(resolve(WORKSPACE_ROOT, file), 'utf8');

const validTerms = (overrides: Partial<BookingOutcomePolicyVersionTermsV1> = {}): BookingOutcomePolicyVersionTermsV1 => ({
  contractVersion: 1,
  cutoffHoursAllowed: [6, 12],
  lateRetentionOptions: [{ kind: 'none' }, { kind: 'percentage_of_collected', basisPoints: 2_500 }],
  noShowGraceMinutesAllowed: [5, 10],
  noShowRetentionOptions: [{ kind: 'fixed_toman', amountToman: 40_000 }, { kind: 'full_collected' }],
  rescheduleFreeCountBeforeCutoff: 1,
  disputeWindowHours: 36,
  bodilyHarmWindowHours: null,
  appealWindowHours: 48,
  caseFileRetentionDays: null,
  legalCap: null,
  ...overrides,
});

describe('booking-outcome policy contract (#42a)', () => {
  describe('the vocabularies are closed', () => {
    it('lifecycle is EXACTLY draft | published | retired', () => {
      expect([...BOOKING_OUTCOME_LIFECYCLE_STATES]).toEqual(['draft', 'published', 'retired']);
    });
    it('retention purpose is EXACTLY late_cancellation | no_show', () => {
      expect([...BOOKING_OUTCOME_RETENTION_PURPOSES]).toEqual(['late_cancellation', 'no_show']);
    });
    it('retention kind is EXACTLY the four V33-DEC-039 R5 shapes', () => {
      expect([...BOOKING_OUTCOME_RETENTION_KINDS]).toEqual(['none', 'percentage_of_collected', 'fixed_toman', 'full_collected']);
    });
    it('Legal-evidence status is EXACTLY recorded | retired, and the cap subject is retention_cap', () => {
      expect([...LEGAL_EVIDENCE_STATUSES]).toEqual(['recorded', 'retired']);
      expect(LEGAL_EVIDENCE_SUBJECTS).toContain('retention_cap');
      expect(LEGAL_EVIDENCE_SUBJECT_FOR_CAP).toBe('retention_cap');
      expect([...LEGAL_EVIDENCE_REFERENCE_KINDS]).toEqual(['document_reference', 'counsel_letter_reference', 'internal_ticket']);
    });
    it('the copy locale is EXACTLY fa-IR', () => {
      expect([...CUSTOMER_POLICY_COPY_LOCALES]).toEqual(['fa-IR']);
    });
  });

  describe('the retention-rule validator', () => {
    it('accepts each kind with exactly its field', () => {
      expect(validateBookingOutcomeRetentionRule({ kind: 'none' }, 'r')).toEqual([]);
      expect(validateBookingOutcomeRetentionRule({ kind: 'full_collected' }, 'r')).toEqual([]);
      expect(validateBookingOutcomeRetentionRule({ kind: 'percentage_of_collected', basisPoints: 1 }, 'r')).toEqual([]);
      expect(validateBookingOutcomeRetentionRule({ kind: 'percentage_of_collected', basisPoints: 9_999 }, 'r')).toEqual([]);
      expect(validateBookingOutcomeRetentionRule({ kind: 'fixed_toman', amountToman: 1 }, 'r')).toEqual([]);
    });
    it.each([
      [{ kind: 'none', basisPoints: 1 }],
      [{ kind: 'full_collected', amountToman: 1 }],
      [{ kind: 'percentage_of_collected' }],
      [{ kind: 'percentage_of_collected', basisPoints: 0 }],
      [{ kind: 'percentage_of_collected', basisPoints: 10_000 }],
      [{ kind: 'percentage_of_collected', basisPoints: 12.5 }],
      [{ kind: 'percentage_of_collected', basisPoints: 100, amountToman: 5 }],
      [{ kind: 'fixed_toman' }],
      [{ kind: 'fixed_toman', amountToman: 0 }],
      [{ kind: 'fixed_toman', amountToman: 1.5 }],
      [{ kind: 'fixed_toman', amountToman: 10_000_000_000_001 }],
      [{ kind: 'escrow' }],
      [null],
    ])('refuses %j', (rule) => {
      expect(validateBookingOutcomeRetentionRule(rule, 'r')).not.toEqual([]);
    });
    it('identifies duplicate meaning across the three shapes', () => {
      expect(retentionRuleIdentity({ kind: 'none' })).toBe('none');
      expect(retentionRuleIdentity({ kind: 'percentage_of_collected', basisPoints: 5 })).toBe('percentage_of_collected:5');
      expect(retentionRuleIdentity({ kind: 'fixed_toman', amountToman: 5 })).toBe('fixed_toman:5');
    });
  });

  describe('the version-terms validator', () => {
    it('accepts the fixture', () => {
      expect(validateBookingOutcomePolicyVersionTermsV1(validTerms())).toEqual([]);
      expect(validateBookingOutcomePolicyVersionTermsV1(validTerms({ bodilyHarmWindowHours: 36, caseFileRetentionDays: 1, legalCap: { kind: 'full_collected' } }))).toEqual([]);
    });
    it.each([
      ['empty cutoff set', { cutoffHoursAllowed: [] }],
      ['descending cutoff set', { cutoffHoursAllowed: [12, 6] }],
      ['duplicate cutoff', { cutoffHoursAllowed: [6, 6] }],
      ['fractional cutoff', { cutoffHoursAllowed: [1.5] }],
      ['negative cutoff', { cutoffHoursAllowed: [-1] }],
      ['cutoff above one year', { cutoffHoursAllowed: [8_761] }],
      ['empty grace set', { noShowGraceMinutesAllowed: [] }],
      ['grace above one day', { noShowGraceMinutesAllowed: [1_441] }],
      ['empty late options', { lateRetentionOptions: [] }],
      ['duplicate late option', { lateRetentionOptions: [{ kind: 'none' }, { kind: 'none' }] }],
      ['duplicate percentage', { noShowRetentionOptions: [{ kind: 'percentage_of_collected', basisPoints: 5 }, { kind: 'percentage_of_collected', basisPoints: 5 }] }],
      ['negative free count', { rescheduleFreeCountBeforeCutoff: -1 }],
      ['zero dispute window', { disputeWindowHours: 0 }],
      ['bodily-harm shorter than dispute', { disputeWindowHours: 48, bodilyHarmWindowHours: 47 }],
      ['zero appeal window', { appealWindowHours: 0 }],
      ['zero retention days', { caseFileRetentionDays: 0 }],
      ['cap of kind none', { legalCap: { kind: 'none' } }],
      ['cap with a bad shape', { legalCap: { kind: 'fixed_toman' } }],
      ['wrong contract version', { contractVersion: 2 as unknown as 1 }],
    ])('refuses %s', (_label, overrides) => {
      expect(validateBookingOutcomePolicyVersionTermsV1(validTerms(overrides as Partial<BookingOutcomePolicyVersionTermsV1>))).not.toEqual([]);
    });
    it('accepts the bodily-harm window equal to the dispute window (the boundary)', () => {
      expect(validateBookingOutcomePolicyVersionTermsV1(validTerms({ disputeWindowHours: 48, bodilyHarmWindowHours: 48 }))).toEqual([]);
    });
  });

  describe('the copy validator and the byte counter', () => {
    it('accepts fa-IR Persian text and refuses another locale, an empty body and an oversized body', () => {
      expect(validateCustomerPolicyCopyVersionTermsV1({ contractVersion: 1, locale: 'fa-IR', body: 'متن' })).toEqual([]);
      expect(validateCustomerPolicyCopyVersionTermsV1({ contractVersion: 1, locale: 'en-US' as 'fa-IR', body: 'x' })).not.toEqual([]);
      expect(validateCustomerPolicyCopyVersionTermsV1({ contractVersion: 1, locale: 'fa-IR', body: '   ' })).not.toEqual([]);
      expect(validateCustomerPolicyCopyVersionTermsV1({ contractVersion: 1, locale: 'fa-IR', body: 'م'.repeat(40_000) })).not.toEqual([]);
    });
    it('counts UTF-8 bytes like Node does, without Buffer', () => {
      for (const sample of ['abc', 'متن فارسی', 'é', '😀 emoji', '']) {
        expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
      }
    });
  });

  describe('the Legal-evidence input validator', () => {
    it('accepts a reference and a summary and refuses a wrong subject or kind', () => {
      const ok = { subject: 'retention_cap' as const, referenceKind: 'internal_ticket' as const, reference: 'LEGAL-1', summary: 'attested' };
      expect(validateLegalEvidenceRecordInputV1(ok)).toEqual([]);
      expect(validateLegalEvidenceRecordInputV1({ ...ok, subject: 'lawyer' as 'retention_cap' })).not.toEqual([]);
      expect(validateLegalEvidenceRecordInputV1({ ...ok, referenceKind: 'upload' as 'internal_ticket' })).not.toEqual([]);
      expect(validateLegalEvidenceRecordInputV1({ ...ok, reference: '' })).not.toEqual([]);
      expect(validateLegalEvidenceRecordInputV1({ ...ok, summary: 'x'.repeat(1_001) })).not.toEqual([]);
    });
  });

  describe('the entities', () => {
    const columnsOf = (target: abstract new (...args: never[]) => unknown) =>
      getMetadataArgsStorage()
        .columns.filter((c) => c.target === target)
        .map((c) => c.options.name ?? c.propertyName)
        .sort();

    it('the version entity declares exactly the ADR-051 §1 columns and nothing from a later story', () => {
      expect(columnsOf(BookingOutcomePolicyVersionEntity)).toEqual(
        [
          'id', 'policy_key', 'version', 'lifecycle_state', 'cutoff_hours_allowed', 'no_show_grace_minutes_allowed',
          'reschedule_free_count_before_cutoff', 'dispute_window_hours', 'bodily_harm_window_hours', 'appeal_window_hours',
          'case_file_retention_days', 'legal_cap_kind', 'legal_cap_basis_points', 'legal_cap_amount_toman', 'legal_evidence_id',
          'contract_version', 'activation_starts_at', 'activation_ends_at', 'created_at', 'created_by_user_id', 'created_by_label',
          'published_at', 'published_by_user_id', 'published_by_label', 'retired_at', 'retired_by_user_id', 'retired_by_label',
        ].sort(),
      );
    });
    it('the option entity carries kind plus exactly two nullable numeric fields', () => {
      expect(columnsOf(BookingOutcomePolicyRetentionOptionEntity)).toEqual(['amount_toman', 'basis_points', 'id', 'kind', 'ordinal', 'purpose', 'version_id']);
    });
    it('the copy version entity carries no numeric policy column', () => {
      const columns = columnsOf(CustomerPolicyCopyVersionEntity);
      expect(columns.filter((c) => /hours|minutes|days|toman|basis|count|cap/.test(c))).toEqual([]);
      expect(columns).toContain('body');
      expect(columns).toContain('body_sha256');
      expect(columns).toContain('locale');
    });
    it('the evidence entity carries a reference and a summary, never a document, name or file', () => {
      const columns = columnsOf(LegalEvidenceRecordEntity);
      expect(columns).toEqual(
        ['id', 'evidence_key', 'subject', 'status', 'reference_kind', 'reference', 'summary', 'recorded_at', 'recorded_by_user_id', 'recorded_audit_id', 'retired_at', 'retired_by_user_id', 'retired_audit_id'].sort(),
      );
      expect(columns.filter((c) => /document|body|file|counsel|lawyer|advice|upload|url/.test(c))).toEqual([]);
    });
    it('all six map to the commercial schema under their ratified names', () => {
      const tables = getMetadataArgsStorage()
        .tables.filter((t) => BOOKING_OUTCOME_POLICY_ENTITIES.includes(t.target as never))
        .map((t) => `${t.schema}.${t.name}`)
        .sort();
      expect(tables).toEqual([
        'commercial.booking_outcome_policies',
        'commercial.booking_outcome_policy_retention_options',
        'commercial.booking_outcome_policy_versions',
        'commercial.customer_policy_copies',
        'commercial.customer_policy_copy_versions',
        'commercial.legal_evidence_records',
      ]);
    });
  });

  describe('the administrator surface', () => {
    const controller = read('services/commercial-policy/src/outcome-policy/booking-outcome-policy.controller.ts');

    it('is mounted under the existing commercial admin namespace and class-gated on the privileged capability', () => {
      expect(controller).toContain("@Controller('v1/admin/commercial')");
      expect(controller).toContain("@RequireCapability('bc_manage_commercial_plans')");
      expect((controller.match(/@RequireCapability/g) ?? []).length).toBe(1);
    });

    it('declares exactly the twenty-two #42a routes, and no seller, customer, selection or dispute route', () => {
      const routes = [...controller.matchAll(/@(Get|Post|Put|Delete)\('([^']*)'\)/g)].map((m) => `${m[1]} ${m[2]}`);
      expect(routes).toEqual([
        'Get outcome-policies',
        'Post outcome-policies',
        'Get outcome-policies/:policyKey/versions',
        'Get outcome-policies/:policyKey/versions/:version',
        'Post outcome-policies/:policyKey/versions',
        'Put outcome-policies/:policyKey/versions/:version',
        'Post outcome-policies/:policyKey/versions/:version/publish',
        'Post outcome-policies/:policyKey/versions/:version/retire',
        'Delete outcome-policies/:policyKey/versions/:version',
        'Get customer-policy-copies',
        'Post customer-policy-copies',
        'Get customer-policy-copies/:copyKey/versions',
        'Get customer-policy-copies/:copyKey/versions/:version',
        'Post customer-policy-copies/:copyKey/versions',
        'Put customer-policy-copies/:copyKey/versions/:version',
        'Post customer-policy-copies/:copyKey/versions/:version/publish',
        'Post customer-policy-copies/:copyKey/versions/:version/retire',
        'Delete customer-policy-copies/:copyKey/versions/:version',
        'Get legal-evidence',
        'Get legal-evidence/:evidenceKey',
        'Post legal-evidence',
        'Post legal-evidence/:evidenceKey/retire',
      ]);
      const code = controller.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
      expect(code).not.toMatch(/v1\/me|workspaceRef|assignments|disputes|remedy|declarations/);
    });

    it('every mutation carries an audit action from the closed vocabulary, and no read does', () => {
      const handlers = [...controller.matchAll(/@(Get|Post|Put|Delete)\('[^']*'\)\s*\n(\s*@AuditAction\(([^)]+)\))?/g)].map((m) => ({ verb: m[1], audit: m[3] ?? null }));
      expect(handlers).toHaveLength(22);
      for (const handler of handlers) {
        if (handler.verb === 'Get') expect(handler.audit).toBeNull();
        else expect(handler.audit).toMatch(/^OUTCOME_POLICY_AUDIT_ACTIONS\.[a-zA-Z]+$/);
      }
      const used = handlers.filter((h) => h.audit).map((h) => h.audit!.replace('OUTCOME_POLICY_AUDIT_ACTIONS.', ''));
      expect(new Set(used)).toEqual(new Set(Object.keys(OUTCOME_POLICY_AUDIT_ACTIONS)));
    });

    it('the audit vocabulary has fourteen members, each namespaced and unique, and every target type fits the column', () => {
      const actions = Object.values(OUTCOME_POLICY_AUDIT_ACTIONS);
      expect(actions).toHaveLength(14);
      expect(new Set(actions).size).toBe(14);
      for (const action of actions) expect(action).toMatch(/^commercial\.[a-z_]+$/);
      for (const action of actions) expect(action.length).toBeLessThanOrEqual(80);
      for (const target of Object.values(OUTCOME_POLICY_AUDIT_TARGETS)) expect(target.length).toBeLessThanOrEqual(40);
    });

    it('exposes no actor, audit id or evidence row id in any view', () => {
      const views = controller.slice(controller.indexOf('// Views.'));
      expect(views).not.toMatch(/createdBy|publishedBy|retiredBy|recordedBy|AuditId|legalEvidenceId|row\.id\b/);
    });
  });

  describe('no seed and no value', () => {
    it('the migration inserts nothing and the story files assign no product number to a policy identifier', () => {
      const sql = read('database/migrations/commercial/20260918100001_create_booking_outcome_policy_family.sql').replace(/--[^\n]*/g, ' ');
      expect(sql).not.toMatch(/INSERT\s+INTO/i);
      const sources = [
        'services/commercial-policy/src/outcome-policy/booking-outcome-policy.service.ts',
        'services/commercial-policy/src/outcome-policy/customer-policy-copy.service.ts',
        'services/commercial-policy/src/outcome-policy/legal-evidence.service.ts',
        'services/commercial-policy/src/outcome-policy/booking-outcome-policy.controller.ts',
        'services/commercial-policy/src/outcome-policy/booking-outcome-policy.entities.ts',
      ].map(read);
      for (const source of sources) {
        const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
        // No identifier carrying a policy value is initialised to a non-zero number.
        const literals = [...cleaned.matchAll(/(cutoff|grace|dispute|appeal|retention|legalCap|window|Hours|Minutes|Days)[A-Za-z]*\s*[:=]\s*(\d[\d_]*)/g)];
        expect(literals.filter((m) => Number(m[2].replace(/_/g, '')) !== 0)).toEqual([]);
        expect(cleaned).not.toMatch(/'fa-IR'.*body|body:\s*'[^']{20,}'/);
      }
    });
  });
});
