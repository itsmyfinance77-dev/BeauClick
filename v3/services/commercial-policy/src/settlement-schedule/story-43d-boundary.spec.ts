import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Story #175 (`#43d`) publishes no cadence, infers no risk class, contains
 * none of `#43e`–`#43h`, and is read by no production caller — proved
 * structurally against the real files.
 *
 * Mirrors `story-43b1-boundary.spec.ts`: a detector, its planted positives
 * and its controls, so an empty finding list means something.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

const STORY_FILES = [
  'services/commercial-policy/src/settlement-schedule/settlement-schedule.entities.ts',
  'services/commercial-policy/src/settlement-schedule/settlement-schedule.constants.ts',
  'services/commercial-policy/src/settlement-schedule/settlement-schedule.dto.ts',
  'services/commercial-policy/src/settlement-schedule/settlement-schedule.service.ts',
  'services/commercial-policy/src/settlement-schedule/seller-risk-class.service.ts',
  'services/commercial-policy/src/settlement-schedule/settlement-schedule-resolution.service.ts',
  'services/commercial-policy/src/settlement-schedule/settlement-schedule.controller.ts',
  'services/commercial-policy/src/settlement-schedule/settlement-schedule.module.ts',
  'services/commercial-policy/src/settlement-schedule/settlement-schedule-subject-data.contract.ts',
  'packages/commercial-policy-contract/src/settlement-schedule-contract.ts',
];

const MIGRATION = 'database/migrations/commercial/20260924100001_create_settlement_schedule_family.sql';

export const FORBIDDEN_CONSTRUCTS: ReadonlyArray<{ pattern: RegExp; owner: string }> = [
  { pattern: /settlement_batches|settlement_proposals|proposeSettlement|SettlementBatchEntity/, owner: '#176 (`#43e`) — proposal and batch' },
  { pattern: /reserve_holds|postReserve|releaseReserve/, owner: '#176 (`#43e`) — reserve posting' },
  { pattern: /financial\.receivables|ReceivableEntity|claim_collected/i, owner: '#177 (`#43f`) — receivable and recovery' },
  { pattern: /fee_allocation|provider_fee|bearer/i, owner: '#178 (`#43g`) — provider fees' },
  { pattern: /revenue_recognition|subscription_term/i, owner: '#179 (`#43h`) — revenue recognition' },
  { pattern: /fund_journals|fund_postings|FundJournal/, owner: '`#43a` — the journal' },
  /*
   * EXECUTION, not the word. ADR-052 §1 names `minimum_payout_toman` as part
   * of this story's own schedule, so a bare /payout/ would forbid the very
   * column the story exists to publish. What belongs to #47 is sending money.
   */
  { pattern: /PaymentProvider|zarinpal|payoutBatch|executePayout|PayoutService|payout_instructions/i, owner: '#47 — the production rail' },
  { pattern: /commerce\.orders|OrderService|CheckoutService/, owner: '`commerce` — no order path is touched here' },
  // The one this story exists to keep out of the code.
  { pattern: /riskScore|computeRiskClass|inferRiskClass|autoClassif/i, owner: '`V33-DEC-040` R4 — a risk class is never inferred' },
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

describe('Story #175 (`#43d`) publishes no cadence and infers no class', () => {
  const storyFiles = STORY_FILES.map((file) => ({ file, source: read(file) }));
  const migration = read(MIGRATION);
  const sql = migration.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

  it('reads real files, so an empty finding list means something', () => {
    expect(storyFiles).toHaveLength(STORY_FILES.length);
    for (const { source } of storyFiles) expect(source.length).toBeGreaterThan(200);
    expect(migration).toContain('enforce_settlement_schedule_lifecycle');
  });

  it('the detector fires on planted positives, and passes its controls', () => {
    const planted = findForbiddenConstructs('planted.ts', 'const a = settlement_batches; const b = computeRiskClass();');
    expect(planted.map((f) => f.owner)).toEqual([
      '#176 (`#43e`) — proposal and batch',
      '`V33-DEC-040` R4 — a risk class is never inferred',
    ]);
    // Controls: this story's own vocabulary is not a false positive.
    expect(
      findForbiddenConstructs('control.ts', 'const k = SELLER_RISK_CLASSES; const s = settlementIntervalDays; const r = reserveBasisPoints;'),
    ).toEqual([]);
  });

  it('names no construct owned by a later child of #43, and computes no risk class', () => {
    expect(storyFiles.flatMap(({ file, source }) => findForbiddenConstructs(file, source))).toEqual([]);
  });

  it('creates exactly the three tables, in the commercial schema, and touches no other schema', () => {
    const created = [...sql.matchAll(/CREATE TABLE\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(created).toEqual([
      'commercial.settlement_schedule_policies',
      'commercial.settlement_schedule_policy_versions',
      'commercial.seller_risk_class_assignments',
    ]);
    expect(sql).not.toMatch(/\b(commerce|booking|payment|financial|identity|dispute)\./);
  });

  it('seeds nothing, and — the point of this story — publishes NO cadence: there is no 7 anywhere', () => {
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/\bUPDATE\s+commercial\./i);

    // No DEFAULT on any value column. The only defaults are the fail-closed
    // lifecycle state and the database clock.
    const defaults = [...sql.matchAll(/^\s*([a-z_]+)\s+[A-Z[\]()0-9]+.*\bDEFAULT\s+([^,\n]+)/gim)].map(
      (m) => `${m[1]}=${m[2].trim()}`,
    );
    expect(defaults.sort()).toEqual(
      ['assigned_at=now()', 'created_at=now()', 'created_at=now()', "lifecycle_state='draft'"].sort(),
    );

    // And no cadence literal reaches the migration or the service. `365` is
    // the published BOUNDARY, `10000` is 100% in basis points, `500`/`120`/`64`/`40`/`16`
    // are column lengths — everything else would be somebody's schedule.
    // The key-shape regexes carry `{0,63}` — a length bound, not a cadence —
    // so they are removed before the scan rather than added to the allow-list,
    // which would let a real 63-day interval hide behind them.
    // String literals go too: a `RAISE EXCEPTION '… ADR-052 §1 …'` message is
    // PROSE, and its digits are a document number rather than anybody's
    // cadence. Stripping them is safe because a seeded value would have to
    // arrive through an INSERT, which the assertion above already forbids.
    const withoutProse = sql.replace(/'(?:[^']|'')*'/g, " '' ");
    const withoutKeyShapes = withoutProse.replace(/~\s*''/g, ' ');
    const allowed = new Set(['365', '10000', '500', '120', '64', '40', '32', '16']);
    const suspicious = [...withoutKeyShapes.matchAll(/\b(\d{2,})\b/g)]
      .map((m) => m[1])
      .filter((literal) => !allowed.has(literal));
    expect(suspicious).toEqual([]);

    const serviceSource = read('services/commercial-policy/src/settlement-schedule/settlement-schedule.service.ts');
    expect(stripComments(serviceSource)).not.toMatch(/settlementIntervalDays\s*[:=]\s*\d/);
  });

  it('requires the publication instant to EQUAL the transaction clock — no tolerance', () => {
    expect(sql).toMatch(/NEW\.published_at\s*<>\s*now\(\)/);
    expect(sql).toMatch(/NEW\.retired_at\s*<>\s*now\(\)/);
    expect(sql).toMatch(/NEW\.superseded_at\s*<>\s*now\(\)/);
    expect(sql).not.toMatch(/INTERVAL\s+'1 minute'/i);
  });

  it('is read by the composition roots only: `#43e` does not exist yet', () => {
    const detector =
      /settlement-schedule\/|SETTLEMENT_SCHEDULE_ENTITIES|\b(SettlementSchedule(Service|ResolutionService|Controller|Module|SubjectDataContract|PolicyEntity|PolicyVersionEntity)|SellerRiskClass(Service|AssignmentEntity))\b/;
    const importers = [
      ...readTypeScriptSources('services'),
      ...readTypeScriptSources('apps/api/src'),
      ...readTypeScriptSources('libs'),
    ].filter(
      ({ file, source }) =>
        !file.startsWith('services/commercial-policy/src/settlement-schedule/') && detector.test(stripComments(source)),
    );

    expect(importers.map((i) => i.file).sort()).toEqual([
      'apps/api/src/app.module.ts',
      'apps/api/src/composition/domain-composition.module.ts',
      'apps/api/src/composition/privacy-composition.module.ts',
      'services/commercial-policy/src/index.ts',
    ]);
    // No importer CALLS a writer: the composition roots wire, they do not use.
    for (const importer of importers) {
      expect(stripComments(importer.source)).not.toMatch(/SettlementScheduleService\s*\.|SellerRiskClassService\s*\./);
    }
  });
});
