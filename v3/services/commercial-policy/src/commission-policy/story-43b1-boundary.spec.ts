import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Story #173 (`#43b-1`) contains none of `#43b-2`, `#43c`–`#43h` or `#47`,
 * seeds nothing, publishes no commercial value, and is read by no production
 * caller — proved structurally against the real files.
 *
 * Mirrors `story-42a-boundary.spec.ts`: a detector, its planted positives and
 * its controls, so an empty finding list means something rather than meaning
 * the detector never fired.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

const STORY_FILES = [
  'services/commercial-policy/src/commission-policy/commission-policy.entities.ts',
  'services/commercial-policy/src/commission-policy/commission-policy.constants.ts',
  'services/commercial-policy/src/commission-policy/commission-policy.dto.ts',
  'services/commercial-policy/src/commission-policy/commission-policy.service.ts',
  'services/commercial-policy/src/commission-policy/commission-policy.controller.ts',
  'services/commercial-policy/src/commission-policy/commission-policy.module.ts',
  'services/commercial-policy/src/commission-policy/commission-policy-subject-data.contract.ts',
  'packages/commercial-policy-contract/src/commission-policy-contract.ts',
];

const MIGRATION = 'database/migrations/commercial/20260922100001_create_commission_policy_family.sql';

export const FORBIDDEN_CONSTRUCTS: ReadonlyArray<{ pattern: RegExp; owner: string }> = [
  { pattern: /order_commission_terms|OrderCommissionTerms/, owner: '#192 (`#43b-2`) — the per-order snapshot' },
  { pattern: /CommissionTermsResolver|resolveForOrder|FOR SHARE/i, owner: '#192 (`#43b-2`) — the checkout-transaction resolver' },
  { pattern: /fund_journals|fund_postings|FundJournal|FundPosting/, owner: '`#43a` (#43) — the journal' },
  { pattern: /release_predicate|recogni[sz]e|dispute_hold/i, owner: '#174 (`#43c`) — recognition and release' },
  { pattern: /settlement_schedule|minimum_payout|reserve_bp|risk_class/i, owner: '#175 (`#43d`) — the settlement schedule family' },
  { pattern: /settlement_batches|SettlementService|settlementProposal/i, owner: '#176 (`#43e`) — settlement proposal and batches' },
  /*
   * PERSISTENCE, not the word. ADR-052 §3 gives this story the arithmetic that
   * decides whether an excess arises — `excessToman` and `createsReceivable`
   * are its outputs — while WRITING the receivable row, recovering it from
   * future earnings and collecting a manual claim are `#43f`'s. A detector
   * that forbade the concept outright would forbid the engine this story is
   * required to ship.
   */
  {
    pattern: /financial\.receivables|ReceivableEntity|ReceivableService|createReceivable|receivable_recoveries/i,
    owner: '#177 (`#43f`) — receivable persistence and recovery',
  },
  { pattern: /fee_allocation|provider_fee|bearer/i, owner: '#178 (`#43g`) — provider fees and allocation' },
  { pattern: /revenue_recognition|subscription_term/i, owner: '#179 (`#43h`) — revenue-recognition facts' },
  { pattern: /PaymentProvider|zarinpal/i, owner: '#47 — the production rail' },
  { pattern: /commerce\.orders|OrderService|CheckoutService|BookingService/, owner: '`commerce` — no order path is touched here' },
  { pattern: /workspaceRef|WorkspaceReference|deriveWorkspaceReference/, owner: 'the seller-facing finance surface — this plane is administrator-only' },
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

describe('Story #173 (`#43b-1`) contains none of #43b-2, #43c–#43h or #47', () => {
  const storyFiles = STORY_FILES.map((file) => ({ file, source: read(file) }));
  const migration = read(MIGRATION);
  const sql = migration.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('reads real files, so an empty finding list means something', () => {
    expect(storyFiles).toHaveLength(STORY_FILES.length);
    for (const { source } of storyFiles) expect(source.length).toBeGreaterThan(200);
    expect(migration).toContain('enforce_commission_version_lifecycle');
  });

  it('the detector fires on planted positives, and passes their controls', () => {
    const planted = findForbiddenConstructs('planted.ts', 'const x = order_commission_terms; const y = fund_postings;');
    expect(planted.map((f) => f.owner)).toEqual([
      '#192 (`#43b-2`) — the per-order snapshot',
      '`#43a` (#43) — the journal',
    ]);
    // Controls: the story's own vocabulary is not a false positive, and
    // neither is the excess arithmetic ADR-052 §3 requires it to ship.
    expect(findForbiddenConstructs('control.ts', 'const k = COMMISSION_COMPONENTS; const b = commissionPolicyVersions;')).toEqual([]);
    expect(findForbiddenConstructs('control2.ts', 'const e = result.excessToman; const c = result.createsReceivable;')).toEqual([]);
  });

  it('names no construct owned by a later child of #43, or by the order path', () => {
    expect(storyFiles.flatMap(({ file, source }) => findForbiddenConstructs(file, source))).toEqual([]);
  });

  it('creates exactly the two ADR-052 §1 tables, in the commercial schema, and touches no other schema', () => {
    const created = [...sql.matchAll(/CREATE TABLE\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(created).toEqual(['commercial.commission_policies', 'commercial.commission_policy_versions']);
    expect(sql).not.toMatch(/\b(commerce|booking|payment|financial|identity|dispute)\./);
    // The only ALTER is the exclusion constraint on this story's own version table.
    expect(sql).not.toMatch(/ALTER TABLE\s+(?!commercial\.commission_policy_versions)/i);
  });

  it('seeds nothing at all, and puts no DEFAULT on any value column', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/\bUPDATE\s+commercial\./i);
    expect(sql).not.toMatch(/\bCOPY\b/);

    const defaults = [...sql.matchAll(/^\s*([a-z_]+)\s+[A-Z[\]()0-9]+.*\bDEFAULT\s+([^,\n]+)/gim)].map(
      (m) => `${m[1]}=${m[2].trim()}`,
    );
    // Fail-closed state and the database clock. Nothing else — in particular
    // no `bp`, `fixed_toman`, `base`, `component` or `arithmetic_version`
    // default, because each of those would BE a commercial choice.
    expect(defaults.sort()).toEqual(["created_at=now()", "created_at=now()", "lifecycle_state='draft'"].sort());
  });

  it('publishes no rate, amount or base: every rule column is NOT NULL without a default, or conditionally NULL by CHECK', () => {
    // A rate literal in the migration would be a value the platform chose.
    // The only integers permitted in the rule columns' vicinity are the
    // BOUNDARIES 0 and 10000, and the shape matrix's own `0`.
    const rateLiterals = [...sql.matchAll(/\b(bp|fixed_toman)\b[^,;)]*?\b(\d{2,})\b/gi)]
      .map((m) => m[2])
      .filter((literal) => literal !== '10000');
    expect(rateLiterals).toEqual([]);
    expect(sql).toMatch(/base\s+VARCHAR\(32\)\s*,/); // declared with NO DEFAULT
    expect(sql).not.toMatch(/base\s+VARCHAR\(32\)[^,]*DEFAULT/i);
  });

  it('requires the publication instant to EQUAL the transaction clock — no tolerance anywhere', () => {
    // ADR-052 §1's strictness, and the absence of the ±1 minute every earlier
    // family accepts. A tolerance re-introduced here would widen `#43b-2`'s
    // resolution race from seconds to minutes.
    expect(sql).toMatch(/NEW\.published_at\s*<>\s*now\(\)/);
    expect(sql).toMatch(/NEW\.retired_at\s*<>\s*now\(\)/);
    expect(sql).not.toMatch(/INTERVAL\s+'1 minute'/i);
  });

  it('is read by no production caller: only the composition roots and the package index name it', () => {
    const detector =
      /commission-policy\/|\bCommissionPolicy(Service|Controller|Module|SubjectDataContract|Entity|VersionEntity)\b/;
    const importers = [
      ...readTypeScriptSources('services'),
      ...readTypeScriptSources('apps/api/src'),
      ...readTypeScriptSources('libs'),
    ].filter(
      ({ file, source }) =>
        !file.startsWith('services/commercial-policy/src/commission-policy/') && detector.test(stripComments(source)),
    );

    expect(importers.map((i) => i.file).sort()).toEqual([
      'apps/api/src/composition/domain-composition.module.ts',
      // Imported for its ADR-027 contract only — the plane's two `retained`
      // tables have to be claimed or the application refuses to boot.
      'apps/api/src/composition/privacy-composition.module.ts',
      'services/commercial-policy/src/index.ts',
    ]);
    // And no importer calls the writer.
    for (const importer of importers) {
      expect(stripComments(importer.source)).not.toMatch(/CommissionPolicyService\s*\./);
    }
  });

  it('the pure engine imports nothing: no Nest, no TypeORM, no clock, no configuration', () => {
    const engine = read('packages/commercial-policy-contract/src/commission-policy-contract.ts');
    expect(engine).not.toMatch(/^import /m);
    expect(stripComments(engine)).not.toMatch(/Date\.now|new Date|process\.env|Math\.random/);
    // And it is BigInt throughout: a `Number` multiplication would lose
    // precision at the representational ceiling.
    expect(engine).toMatch(/BigInt\(/);
  });
});
