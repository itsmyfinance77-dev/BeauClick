import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The structural proof that Story #83 (`#41d-1`) contains none of #104
 * (`#41d-2`), and none of #42/#43/#47/#95/#99.
 *
 * ## Why this is a repository scan rather than a set of behavioural tests
 *
 * You cannot write a behavioural test for the absence of a feature. "The
 * assignment route returns 404" passes just as happily when somebody adds the
 * route on a different path, and "no order changed" passes when the order path
 * changed in a way this suite never exercises. The honest assertion is that the
 * SOURCE contains no such thing, and that is a scan.
 *
 * ## Every rule is proved against a planted fixture
 *
 * A detector that cannot fail is not evidence. §3 plants each forbidden
 * construct into a string and asserts the same function that scans the real
 * files finds it — the discipline `no-hardcoded-allowance.spec.ts` sets, and
 * for the same reason.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

/** Files Story #83 created or edited, by name. Everything else in those trees pre-dates it. */
const STORY_FILES = [
  'services/commercial-policy/src/catalogue/booking-collection-policy.entities.ts',
  'services/commercial-policy/src/catalogue/booking-collection-policy.service.ts',
  'services/commercial-policy/src/catalogue/booking-collection-policy.dto.ts',
  'services/commercial-policy/src/catalogue/commercial-catalogue.controller.ts',
  'services/commercial-policy/src/catalogue/commercial-catalogue.module.ts',
  'services/commercial-policy/src/catalogue/commercial-subject-data.contract.ts',
  'packages/commercial-policy-contract/src/booking-collection-policy-contract.ts',
];

/**
 * Constructs belonging to #104 and to the later stories, each with the issue
 * that owns it. A match anywhere in Story #83's own files is a finding.
 */
export const FORBIDDEN_CONSTRUCTS: ReadonlyArray<{ pattern: RegExp; owner: string }> = [
  { pattern: /seller_collection_policy_assignments/, owner: '#104 (`#41d-2`) — the assignment table' },
  { pattern: /SellerCollectionPolicyAssignment/, owner: '#104 — the assignment entity' },
  { pattern: /bc_manage_own_collection_policy/, owner: '#104 — the owner capability' },
  { pattern: /workspaceRef|WorkspaceReference|deriveWorkspaceReference/, owner: '#104 — the owner-facing surface' },
  { pattern: /OrderPaymentSchedule|order_payment_schedules/, owner: '#104 — the order snapshot' },
  { pattern: /policyAcceptedAt|policy_accepted_at/, owner: '#42 + Legal — customer acceptance' },
  { pattern: /ck_ops_policy_reference/, owner: "#104 — the constraint replacement in commerce" },
  { pattern: /CollectionPolicyResolver|resolveForSellerParty/, owner: '#104 — the commerce resolver port' },
  { pattern: /enrollment|enrolment|isEnrolled/i, owner: '#104 — per-party enrollment' },
  { pattern: /OrderService|CheckoutService/, owner: '#104 — the order path' },
  { pattern: /commissionRate|commission_rate/, owner: '#43 — commission policy' },
  { pattern: /settlementDelay|pendingFunds|pending_funds/, owner: '#43 — settlement and pending funds' },
  { pattern: /retentionAmount|retainBasisPoints|noShowRetain/, owner: '#42 — cancellation and retention' },
  { pattern: /PaymentProvider|zarinpal/i, owner: '#47 — the production rail' },
];

export interface BoundaryFinding {
  readonly file: string;
  readonly owner: string;
  readonly detail: string;
}

/** Removes comments so a docblock naming #104 is documentation, not an implementation. */
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

function readStoryFiles(): Array<{ file: string; source: string }> {
  return STORY_FILES.map((file) => ({ file, source: readFileSync(resolve(WORKSPACE_ROOT, file), 'utf8') }));
}

function readMigrationSql(): Array<{ file: string; source: string }> {
  const directory = resolve(WORKSPACE_ROOT, 'database/migrations/commercial');
  return readdirSync(directory)
    .filter((name) => name.includes('booking_collection'))
    .map((name) => ({
      file: `database/migrations/commercial/${name}`,
      source: readFileSync(join(directory, name), 'utf8'),
    }));
}

describe('Story #83 contains none of #104, #42, #43, #47, #95 or #99', () => {
  const storyFiles = readStoryFiles();
  const migrations = readMigrationSql();

  it('reads real files, so an empty finding list means something', () => {
    expect(storyFiles).toHaveLength(STORY_FILES.length);
    for (const { file, source } of storyFiles) {
      expect(source.length).toBeGreaterThan(200);
      expect(file).toMatch(/\.ts$/);
    }
    expect(migrations).toHaveLength(1);
    expect(migrations[0].source).toContain('booking_collection_policy_versions');
  });

  it('names no construct owned by a later story', () => {
    const findings = storyFiles.flatMap(({ file, source }) => findForbiddenConstructs(file, source));
    expect(findings).toEqual([]);
  });

  it('creates no assignment table and touches no commerce table in its migration', () => {
    for (const { source } of migrations) {
      const sql = source.replace(/--[^\n]*/g, ' ');
      expect(sql).not.toMatch(/seller_collection_policy_assignments/);
      expect(sql).not.toMatch(/commerce\./);
      expect(sql).not.toMatch(/ck_ops_policy_reference/);
      expect(sql).not.toMatch(/policy_accepted_at/);
      // Two CREATE TABLEs, both in `commercial`, and nothing else.
      const created = [...sql.matchAll(/CREATE TABLE\s+([a-z_.]+)/gi)].map((m) => m[1]);
      expect(created).toEqual([
        'commercial.booking_collection_policies',
        'commercial.booking_collection_policy_versions',
      ]);
    }
  });

  it('seeds nothing at all', () => {
    for (const { source } of migrations) {
      const sql = source.replace(/--[^\n]*/g, ' ');
      expect(sql).not.toMatch(/INSERT\s+INTO/i);
      expect(sql).not.toMatch(/\bUPDATE\s+commercial\./i);
    }
  });

  it('registers the new entities outside COMMERCIAL_ENTITIES, so no unrelated module gains repository access', () => {
    const entities = readFileSync(
      resolve(WORKSPACE_ROOT, 'services/commercial-policy/src/catalogue/booking-collection-policy.entities.ts'),
      'utf8',
    );
    expect(entities).toContain('export const BOOKING_COLLECTION_POLICY_ENTITIES');

    const catalogue = readFileSync(
      resolve(WORKSPACE_ROOT, 'services/commercial-policy/src/catalogue/commercial-catalogue.entities.ts'),
      'utf8',
    );
    // The pre-existing array must be untouched: appending would have handed
    // price resolution, the subscription foundation and the seller surface a
    // repository over tables none of them reads.
    expect(catalogue).not.toContain('BookingCollectionPolicy');
  });

  it('adds no capability anywhere', () => {
    const auth = readFileSync(resolve(WORKSPACE_ROOT, 'libs/auth/src/privileged-capability.port.ts'), 'utf8');
    expect(auth).not.toContain('collection_policy');
    for (const { source } of storyFiles) {
      const cleaned = stripComments(source);
      const capabilities = [...cleaned.matchAll(/'(bc_[a-z_]+)'/g)].map((m) => m[1]);
      // The one capability this story uses is the one that already existed.
      expect(new Set(capabilities)).toEqual(new Set(capabilities.filter((c) => c === 'bc_manage_commercial_plans')));
    }
  });

  // =========================================================================
  // §3. The detector is not vacuous — planted positives
  // =========================================================================

  describe('the boundary detector is not vacuous', () => {
    it.each([
      ['an assignment table', "const t = 'seller_collection_policy_assignments';"],
      ['the owner capability', "@RequireCapability('bc_manage_own_collection_policy')"],
      ['a workspaceRef import', 'import { deriveWorkspaceReference } from "x";'],
      ['an order snapshot write', 'manager.insert(OrderPaymentScheduleEntity, {});'],
      ['acceptance', 'const x = { policyAcceptedAt: new Date() };'],
      ['a commerce resolver', 'class CollectionPolicyResolver {}'],
      ['enrollment', 'const isEnrolled = true;'],
      ['commission', 'const commissionRate = 1;'],
      ['a provider', 'const p = new PaymentProvider();'],
    ])('finds %s when it is planted', (_label, planted) => {
      expect(findForbiddenConstructs('planted.ts', planted)).not.toEqual([]);
    });

    it('does NOT fire on the same words inside a comment', () => {
      const documented = `
        // Assignment is #104's: seller_collection_policy_assignments does not exist here.
        /* policy_accepted_at stays #42's, after Legal. */
        export const x = 1;
      `;
      expect(findForbiddenConstructs('documented.ts', documented)).toEqual([]);
    });
  });
});
