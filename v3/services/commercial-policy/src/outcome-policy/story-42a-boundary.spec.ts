import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Story #42 (`#42a`) contains none of `#42b`–`#42e`, #43, #47 or #99, seeds
 * nothing, is read by no production caller, and touches no superseded
 * contract — proved structurally against the real files.
 *
 * Mirrors `story-83-boundary.spec.ts`: a detector, its planted positives and
 * its controls, so an empty finding list means something.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

const STORY_FILES = [
  'services/commercial-policy/src/outcome-policy/booking-outcome-policy.entities.ts',
  'services/commercial-policy/src/outcome-policy/booking-outcome-policy.constants.ts',
  'services/commercial-policy/src/outcome-policy/booking-outcome-policy.dto.ts',
  'services/commercial-policy/src/outcome-policy/booking-outcome-policy.service.ts',
  'services/commercial-policy/src/outcome-policy/customer-policy-copy.service.ts',
  'services/commercial-policy/src/outcome-policy/legal-evidence.service.ts',
  'services/commercial-policy/src/outcome-policy/booking-outcome-policy.controller.ts',
  'services/commercial-policy/src/outcome-policy/booking-outcome-policy.module.ts',
  'services/commercial-policy/src/outcome-policy/booking-outcome-policy-subject-data.contract.ts',
  'packages/commercial-policy-contract/src/booking-outcome-policy-contract.ts',
];

const MIGRATION = 'database/migrations/commercial/20260918100001_create_booking_outcome_policy_family.sql';

export const FORBIDDEN_CONSTRUCTS: ReadonlyArray<{ pattern: RegExp; owner: string }> = [
  { pattern: /seller_outcome_policy_assignments|SellerOutcomePolicyAssignment/, owner: '#159 (`#42b`) — seller selection' },
  { pattern: /order_outcome_terms|OrderOutcomeTerms|BookingOutcomeTermsV1|BookingOutcomeSnapshotV1/, owner: '#159 (`#42b`) — the order snapshot contract' },
  { pattern: /BookingOutcomePolicyResolver|resolveForSellerParty/, owner: '#159 (`#42b`) — the commerce resolver port' },
  { pattern: /workspaceRef|WorkspaceReference|deriveWorkspaceReference/, owner: '#159 (`#42b`) — the seller-facing surface' },
  { pattern: /policyAcceptedAt|policy_accepted_at|acceptedPolicy/, owner: '#159 (`#42b`) — customer acceptance' },
  { pattern: /booking_outcome_decisions|evaluateBookingOutcome|BookingOutcomeDecision/, owner: '#160 (`#42c`) — the evaluator' },
  { pattern: /remainingRefundable|PaymentService|refund\(/, owner: '#160 (`#42c`) — refund execution' },
  { pattern: /no_show_declarations|NoShowDeclar|markNoShow|customer_remedy_choices|RemedyChoice/, owner: '#161 (`#42d`) — no-show and remedy' },
  { pattern: /dispute\.cases|DisputeCase|bc_review_disputes|services\/dispute|case_statements/, owner: '#162 (`#42e`) — the dispute case model' },
  { pattern: /OrderService|CheckoutService|BookingService|commerce\.orders/, owner: '#42b/#42c — the order and booking paths' },
  { pattern: /commissionRate|commission_rate|settlement|pendingFunds/i, owner: '#43 — commission and settlement' },
  { pattern: /PaymentProvider|zarinpal/i, owner: '#47 — the production rail' },
  { pattern: /credit_purchases|custom_purchase/, owner: '#99 — paid credit activation' },
  { pattern: /BookingCommercialTermsV1|CommercialPolicyRegistry/, owner: 'ADR-051 §2 — the superseded v1 contract, not reused' },
];

export interface BoundaryFinding {
  readonly file: string;
  readonly owner: string;
  readonly detail: string;
}

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export function findForbiddenConstructs(file: string, source: string): BoundaryFinding[] {
  const cleaned = stripComments(source);
  const findings: BoundaryFinding[] = [];
  for (const { pattern, owner } of FORBIDDEN_CONSTRUCTS) {
    const match = pattern.exec(cleaned);
    if (match) findings.push({ file, owner, detail: `matches ${pattern} ("${match[0]}")` });
  }
  return findings;
}

function read(file: string): string {
  return readFileSync(resolve(WORKSPACE_ROOT, file), 'utf8');
}

function readTypeScriptSources(directory: string): Array<{ file: string; source: string }> {
  const collected: Array<{ file: string; source: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.pg-spec.ts')) continue;
      collected.push({ file: path.slice(WORKSPACE_ROOT.length + 1).replace(/\\/g, '/'), source: readFileSync(path, 'utf8') });
    }
  };
  walk(resolve(WORKSPACE_ROOT, directory));
  return collected;
}

describe('Story #42 (`#42a`) contains none of #42b–#42e, #43, #47 or #99', () => {
  const storyFiles = STORY_FILES.map((file) => ({ file, source: read(file) }));
  const migration = read(MIGRATION);
  const sql = migration.replace(/--[^\n]*/g, ' ');

  it('reads real files, so an empty finding list means something', () => {
    expect(storyFiles).toHaveLength(STORY_FILES.length);
    for (const { source } of storyFiles) expect(source.length).toBeGreaterThan(200);
    expect(migration).toContain('require_valid_legal_evidence_for_cap');
  });

  it('names no construct owned by a later story or by the superseded v1 contract', () => {
    expect(storyFiles.flatMap(({ file, source }) => findForbiddenConstructs(file, source))).toEqual([]);
  });

  it('creates exactly the six ADR-051 §1/§5 tables, in the commercial schema, and touches no other schema', () => {
    const created = [...sql.matchAll(/CREATE TABLE\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(created).toEqual([
      'commercial.legal_evidence_records',
      'commercial.booking_outcome_policies',
      'commercial.booking_outcome_policy_versions',
      'commercial.booking_outcome_policy_retention_options',
      'commercial.customer_policy_copies',
      'commercial.customer_policy_copy_versions',
    ]);
    expect(sql).not.toMatch(/\b(commerce|booking|payment|financial|identity|admin|dispute)\./);
    expect(sql).not.toMatch(/ALTER TABLE\s+(?!commercial\.(booking_outcome_policy_versions|customer_policy_copy_versions))/i);
    expect(sql).toContain('CREATE TRIGGER tg_bopv_require_evidence');
    expect(sql).toContain('FUNCTION commercial.require_valid_legal_evidence_for_cap()');
  });

  it('seeds nothing at all, and puts no DEFAULT on any value column', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/\bUPDATE\s+commercial\./i);
    expect(sql).not.toMatch(/\bCOPY\b/);
    const defaults = [...sql.matchAll(/^\s*([a-z_]+)\s+[A-Z[\]()0-9]+.*\bDEFAULT\s+([^,\n]+)/gim)].map((m) => `${m[1]}=${m[2].trim()}`);
    // The only defaults are fail-closed states, the contract version and the database clock.
    expect(defaults.sort()).toEqual(
      [
        "lifecycle_state='draft'", "lifecycle_state='draft'",
        'contract_version=1', 'contract_version=1',
        'created_at=now()', 'created_at=now()', 'created_at=now()', 'created_at=now()',
        'recorded_at=now()',
        "status='recorded'",
      ].sort(),
    );
  });

  it('is read by no production caller: only its own module and the two composition roots import it', () => {
    const importers = [
      ...readTypeScriptSources('services'),
      ...readTypeScriptSources('apps/api/src'),
      ...readTypeScriptSources('libs'),
    ].filter(({ file, source }) => !file.startsWith('services/commercial-policy/src/outcome-policy/') && /outcome-policy\/|BookingOutcomePolicy|CustomerPolicyCopy|LegalEvidence/.test(stripComments(source)));
    expect(importers.map((i) => i.file).sort()).toEqual([
      'apps/api/src/composition/domain-composition.module.ts',
      'apps/api/src/composition/privacy-composition.module.ts',
      'services/commercial-policy/src/index.ts',
    ]);
    // And those two roots only COMPOSE it: no root calls a service method.
    for (const importer of importers.filter((i) => i.file.startsWith('apps/'))) {
      expect(stripComments(importer.source)).not.toMatch(/BookingOutcomePolicyService|CustomerPolicyCopyService|LegalEvidenceService/);
    }
  });

  it('registers its entities outside COMMERCIAL_ENTITIES and the collection-policy array', () => {
    expect(read('services/commercial-policy/src/catalogue/commercial-catalogue.entities.ts')).not.toMatch(/Outcome|LegalEvidence|CustomerPolicyCopy/);
    expect(read('services/commercial-policy/src/catalogue/booking-collection-policy.entities.ts')).not.toMatch(/Outcome|LegalEvidence|CustomerPolicyCopy/);
  });

  it('adds no capability anywhere and uses only the one that already existed', () => {
    const capabilities = [...stripComments(read('libs/auth/src/privileged-capability.port.ts')).matchAll(/'(bc_[a-z_]+)'/g)].map((m) => m[1]);
    expect(capabilities.filter((c) => /outcome|dispute|evidence/.test(c))).toEqual([]);
    for (const { source } of storyFiles) {
      const capabilities = [...stripComments(source).matchAll(/'(bc_[a-z_]+)'/g)].map((m) => m[1]);
      expect(new Set(capabilities)).toEqual(new Set(capabilities.filter((c) => c === 'bc_manage_commercial_plans')));
    }
  });

  it('leaves the superseded v1 contract, the collection contract and the in-memory registry byte-identical to their committed content', () => {
    // A structural pin: the three files must still contain their pre-#42a
    // markers and must not mention anything from this story.
    const v1 = read('packages/commercial-policy-contract/src/commercial-policy-contract.ts');
    expect(v1).toContain('export interface BookingCommercialTermsV1');
    expect(v1).toContain('readonly customerPolicyCopyVersion: string;');
    expect(v1).not.toMatch(/outcome|legal_evidence|LegalEvidence|retention_cap/i);
    const collection = read('packages/commercial-policy-contract/src/booking-collection-policy-contract.ts');
    expect(collection).toContain('export interface BookingCollectionTermsV1');
    expect(collection).not.toMatch(/outcome|LegalEvidence/i);
    const registry = read('services/commercial-policy/src/commercial-policy.registry.ts');
    expect(registry).toContain('BookingCommercialTermsV1');
    expect(registry).not.toMatch(/outcome|LegalEvidence/i);
  });

  describe('the boundary detector is not vacuous', () => {
    it.each([
      ['a selection table', "const t = 'seller_outcome_policy_assignments';"],
      ['the snapshot contract', 'const x: BookingOutcomeTermsV1 = {};'],
      ['acceptance', 'const x = { policyAcceptedAt: new Date() };'],
      ['the evaluator', 'evaluateBookingOutcome(input);'],
      ['a refund call', 'await this.payments.refund({});'],
      ['a no-show declaration', "await manager.insert('no_show_declarations', {});"],
      ['a dispute', 'class DisputeCase {}'],
      ['the order path', 'constructor(private readonly orders: OrderService) {}'],
      ['a provider', 'const p = new PaymentProvider();'],
      ['the superseded contract', 'const t: BookingCommercialTermsV1 = {};'],
    ])('finds %s when it is planted', (_label, planted) => {
      expect(findForbiddenConstructs('planted.ts', planted)).not.toEqual([]);
    });

    it('does NOT fire on the same words inside a comment', () => {
      const documented = `
        // Selection is #42b's: seller_outcome_policy_assignments does not exist here.
        /* policy_accepted_at stays #42b's; the evaluator is #42c's; disputes are #42e's. */
        export const x = 1;
      `;
      expect(findForbiddenConstructs('documented.ts', documented)).toEqual([]);
    });

    it('catches a planted seed and a planted default in the migration detector', () => {
      const seeded = sql + "\nINSERT INTO commercial.booking_outcome_policies (policy_key, display_name, created_by_label) VALUES ('launch', 'x', 'seed');";
      expect(seeded).toMatch(/INSERT\s+INTO/i);
      const defaulted = sql.replace('dispute_window_hours SMALLINT NOT NULL,', 'dispute_window_hours SMALLINT NOT NULL DEFAULT 72,');
      expect(defaulted).not.toBe(sql);
      const defaults = [...defaulted.matchAll(/^\s*([a-z_]+)\s+[A-Z[\]()0-9]+.*\bDEFAULT\s+([^,\n]+)/gim)].map((m) => m[1]);
      expect(defaults).toContain('dispute_window_hours');
    });
  });
});
