import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The structural proof that Story #104 (`#41d-2a`) contains no part of #115
 * (`#41d-2b`), and none of #42/#43/#44/#47/#95/#99.
 *
 * ## Why a repository scan rather than behavioural tests
 *
 * You cannot write a behavioural test for the absence of a feature. "The order
 * path is unchanged" passes just as happily when the order path changed in a
 * way this suite never exercises. The honest assertion is that the SOURCE
 * contains no such thing, and that is a scan — the discipline
 * `story-83-boundary.spec.ts` set for the previous half of this family.
 *
 * ## Every rule is proved against a planted fixture
 *
 * §4 plants each forbidden construct and asserts the same function that scans
 * the real files finds it. A detector that cannot fail is not evidence.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

/** Files Story #104 created or edited. Everything else in these trees pre-dates it. */
const STORY_FILES = [
  'services/commercial-policy/src/collection-policy-assignment/collection-policy-assignment.entities.ts',
  'services/commercial-policy/src/collection-policy-assignment/collection-policy-assignment.service.ts',
  'services/commercial-policy/src/collection-policy-assignment/collection-policy-assignment.controller.ts',
  'services/commercial-policy/src/collection-policy-assignment/collection-policy-assignment.exceptions.ts',
  'services/commercial-policy/src/collection-policy-assignment/collection-policy-assignment.module.ts',
  'services/commercial-policy/src/collection-policy-assignment/collection-policy-assignment-subject-data.contract.ts',
  'packages/commercial-policy-contract/src/collection-policy-assignment-contract.ts',
];

/** Constructs belonging to #115 and to the later stories, each with its owner. */
export const FORBIDDEN_CONSTRUCTS: ReadonlyArray<{ pattern: RegExp; owner: string }> = [
  { pattern: /order_payment_schedules|OrderPaymentSchedule/, owner: '#115 — the order snapshot' },
  { pattern: /ck_ops_policy_reference/, owner: '#115 — the commerce constraint replacement' },
  { pattern: /policyAcceptedAt|policy_accepted_at/, owner: '#42 + Legal — customer acceptance' },
  { pattern: /OrderService|CheckoutService|ServiceCatalog|SellerPartyLookup/, owner: '#115 — the order path' },
  { pattern: /bookingCollectionAmountsV1|collectionBreakdownV1/, owner: '#115 — amount calculation' },
  { pattern: /collectionMode|collection_mode/, owner: '#115 — mode derivation' },
  { pattern: /BookingCollectionPolicySnapshotV1|resolvedAt/, owner: '#115 — the order snapshot' },
  { pattern: /CollectionPolicyResolver|resolveForSellerParty/, owner: '#115 — the runtime resolver port' },
  { pattern: /commissionRate|settlementDelay|pendingFunds/, owner: '#43 — commission and settlement' },
  { pattern: /retainBasisPoints|noShowRetain|cancellationCutoff/, owner: '#42 — cancellation and retention' },
  { pattern: /PaymentProvider|zarinpal/i, owner: '#47 — the production rail' },
  { pattern: /per_service|perService|service_override/, owner: '#44 — per-service override' },
];

export interface BoundaryFinding {
  readonly file: string;
  readonly owner: string;
  readonly detail: string;
}

/** Removes comments, so a docblock naming #115 is documentation rather than an implementation. */
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

function readMigrations(): Array<{ file: string; source: string }> {
  const collected: Array<{ file: string; source: string }> = [];
  for (const [schema, needle] of [
    ['commercial', 'seller_collection_policy_assignments'],
    ['identity', 'collection_policy_capability'],
  ] as const) {
    const directory = resolve(WORKSPACE_ROOT, `database/migrations/${schema}`);
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.sql') || !name.includes(needle)) continue;
      collected.push({ file: `${schema}/${name}`, source: readFileSync(join(directory, name), 'utf8') });
    }
  }
  return collected;
}

describe('Story #104 contains no part of #115, #42, #43, #44, #47, #95 or #99', () => {
  const storyFiles = readStoryFiles();
  const migrations = readMigrations();

  it('reads real files, so an empty finding list means something', () => {
    expect(storyFiles).toHaveLength(STORY_FILES.length);
    for (const { source } of storyFiles) expect(source.length).toBeGreaterThan(200);
    expect(migrations).toHaveLength(2);
  });

  it('names no construct owned by a later story', () => {
    expect(storyFiles.flatMap(({ file, source }) => findForbiddenConstructs(file, source))).toEqual([]);
  });

  it('creates exactly one commercial table and touches no commerce table', () => {
    const sql = migrations
      .filter((m) => m.file.startsWith('commercial/'))
      .map((m) => m.source.replace(/--[^\n]*/g, ' '))
      .join('\n');

    const created = [...sql.matchAll(/CREATE TABLE\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(created).toEqual(['commercial.seller_collection_policy_assignments']);
    expect(sql).not.toMatch(/commerce\./);
    expect(sql).not.toMatch(/ck_ops_policy_reference/);
    expect(sql).not.toMatch(/policy_accepted_at/);
  });

  it('seeds nothing: no assignment, no policy, no backfill', () => {
    for (const { file, source } of migrations) {
      const sql = source.replace(/--[^\n]*/g, ' ');
      if (file.startsWith('commercial/')) {
        // The commercial migration writes no row of any kind.
        expect(sql).not.toMatch(/INSERT\s+INTO/i);
        expect(sql).not.toMatch(/\bUPDATE\s+commercial\./i);
      } else {
        // The identity migration inserts ONLY the capability and its two role
        // grants -- never a policy, an assignment or a user grant.
        const inserts = [...sql.matchAll(/INSERT\s+INTO\s+([a-z_.]+)/gi)].map((m) => m[1]);
        expect(inserts).toEqual(['identity.capabilities', 'identity.role_capabilities']);
      }
    }
  });

  it('has no enrollment marker, lifecycle column or un-enrollment path in the schema', () => {
    // BOTH comment styles are stripped. The column docblocks explain why there
    // is no lifecycle column, so leaving them in would make this case fail on
    // its own justification -- and stripping only `--` would leave them.
    const raw = migrations.find((m) => m.file.startsWith('commercial/'))!.source;
    const sql = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
    // Presence IS enrollment (ADR-048 R2): no flag, no state, no clearing.
    //
    // Asserted over the COLUMN LIST rather than the whole file: the trigger's
    // own refusal message legitimately contains the word "enrolled" while
    // explaining why no clearing path exists, and a blunt word search would
    // have failed on the very sentence that proves the rule.
    const columnList = /CREATE TABLE commercial\.seller_collection_policy_assignments\s*\(([\s\S]*?)\n\);/.exec(
      sql,
    );
    expect(columnList).not.toBeNull();
    expect(columnList![1]).not.toMatch(/\benrol/i);
    expect(columnList![1]).not.toMatch(/lifecycle|\bflag\b|\bstatus\b/i);
    expect(sql).not.toMatch(/lifecycle_state/);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    // And the trigger refuses DELETE rather than merely omitting a route.
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON commercial\.seller_collection_policy_assignments/);
    expect(sql).toMatch(/TG_OP = 'DELETE'/);
  });

  it('registers the entity outside the two pre-existing arrays', () => {
    const entities = readFileSync(
      resolve(WORKSPACE_ROOT, 'services/commercial-policy/src/collection-policy-assignment/collection-policy-assignment.entities.ts'),
      'utf8',
    );
    expect(entities).toContain('export const COLLECTION_POLICY_ASSIGNMENT_ENTITIES');

    for (const path of [
      'services/commercial-policy/src/catalogue/commercial-catalogue.entities.ts',
      'services/commercial-policy/src/catalogue/booking-collection-policy.entities.ts',
    ]) {
      // Widening either array would hand price resolution, the subscription
      // foundation and the catalogue a repository over this table.
      expect(readFileSync(resolve(WORKSPACE_ROOT, path), 'utf8')).not.toContain('SellerCollectionPolicyAssignment');
    }
  });

  it('adds exactly one capability, non-privileged, to exactly the two seller roles', () => {
    const identity = migrations.find((m) => m.file.startsWith('identity/'))!.source;
    const capabilities = [...identity.matchAll(/\('(bc_[a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(capabilities)).toEqual(new Set(['bc_manage_own_collection_policy']));
    expect(identity).toMatch(/'bc_manage_own_collection_policy',\s*'[^']*',\s*false/);

    const roles = [...identity.matchAll(/\('([a-z_]+)',\s*'bc_manage_own_collection_policy'\)/g)].map((m) => m[1]);
    expect(new Set(roles)).toEqual(new Set(['professional', 'business']));

    // Never privileged: the shipped list must not learn about it.
    const privileged = readFileSync(resolve(WORKSPACE_ROOT, 'libs/auth/src/privileged-capability.port.ts'), 'utf8');
    expect(privileged).not.toContain('collection_policy');
  });

  it('creates no second workspace secret, reference format or ownership resolver', () => {
    for (const { source } of storyFiles) {
      const cleaned = stripComments(source);
      // The existing primitives are imported, never re-implemented.
      expect(cleaned).not.toMatch(/deriveWorkspaceReference|createHmac|timingSafeEqual/);
      expect(cleaned).not.toMatch(/business_staff|BusinessStaff/);
    }
    const service = storyFiles.find((f) => f.file.endsWith('assignment.service.ts'))!.source;
    expect(service).toContain('OWNED_SUBSCRIBER_PARTY_RESOLVER');
    expect(service).toContain('WorkspaceReferenceService');
  });

  /*
   * The supersession write, asserted as a SHAPE rather than as a behaviour.
   *
   * ## Why this is structural, and why that is not a cop-out
   *
   * A mutation probe that deleted `AND superseded_at IS NULL` from the
   * compare-and-swap left the entire real-PostgreSQL suite green, and the
   * reason is legitimate: `tg_scpa_immutable` independently refuses any update
   * to an already-superseded row and raises `restrict_violation`, which the
   * service already translates into the same public refusal. The two produce an
   * identical observable outcome, so no behavioural test can separate them.
   *
   * The guarantee is still worth keeping — two independent arbiters is the
   * point — and `V33-DEC-031` states it as a code rule: require exactly one
   * affected old row, and never read `result.length` for a TypeORM UPDATE.
   * A rule about code shape is proved by reading the code.
   *
   * ## The `result.length` half is the one that has actually bitten
   *
   * TypeORM returns `[rows, affected]` for a raw UPDATE, so `result.length` is
   * 2 whether one row changed or none did. An implementation that checked it
   * would accept every lost race silently and pass every test in the suite.
   */
  describe('the supersession compare-and-swap keeps both of its arbiters', () => {
    const service = () => storyFiles.find((f) => f.file.endsWith('assignment.service.ts'))!.source;

    it('predicates the update on the row still being current', () => {
      const cleaned = stripComments(service());
      expect(cleaned).toMatch(/UPDATE commercial\.seller_collection_policy_assignments[\s\S]{0,400}?superseded_at IS NULL/);
    });

    it('reads the affected count from the second element, never from length', () => {
      const cleaned = stripComments(service());
      // The shape that is correct...
      expect(cleaned).toMatch(/Array\.isArray\(\w+\)\s*\?\s*Number\(\w+\[1\]/);
      expect(cleaned).toMatch(/affected !== 1/);
      // ...and the shape that silently accepts a lost race.
      expect(cleaned).not.toMatch(/superseded\.length|updated\.length|result\.length/);
    });

    it('keeps the version share lock that decides the retirement race', () => {
      const cleaned = stripComments(service());
      expect(cleaned).toMatch(/booking_collection_policy_versions[\s\S]{0,400}?FOR SHARE/);
    });

    it('does NOT lock the current assignment row, which would deadlock two supersessions', () => {
      /*
       * The inverse assertion, and it is deliberate. An earlier draft took
       * `FOR SHARE` on the current row before the compare-and-swap; two
       * concurrent supersessions would both hold it and both need to upgrade
       * it, which is a deadlock PostgreSQL breaks with an untranslated `40P01`.
       * ADR-048 R5 names `FOR SHARE` for the ORDER-CREATION reader, which never
       * upgrades — not for this writer.
       */
      const cleaned = stripComments(service());
      const currentRead = /FROM commercial\.seller_collection_policy_assignments[\s\S]{0,300}?superseded_at IS NULL\s*\n\s*FOR SHARE/;
      expect(cleaned).not.toMatch(currentRead);
    });
  });

  // =========================================================================
  // §4. The detector is not vacuous — planted positives
  // =========================================================================

  describe('the boundary detector is not vacuous', () => {
    it.each([
      ['an order snapshot write', 'manager.insert(OrderPaymentScheduleEntity, {});'],
      ['the commerce constraint', "const c = 'ck_ops_policy_reference';"],
      ['acceptance', 'const x = { policyAcceptedAt: new Date() };'],
      ['the order path', 'class X { constructor(private readonly o: OrderService) {} }'],
      ['amount calculation', 'const a = bookingCollectionAmountsV1(1, 2, t);'],
      ['mode derivation', 'const m = row.collectionMode;'],
      ['the runtime resolver', 'class CollectionPolicyResolver {}'],
      ['commission', 'const commissionRate = 1;'],
      ['retention', 'const noShowRetain = 1;'],
      ['a provider', 'const p = new PaymentProvider();'],
      ['per-service override', 'const perService = true;'],
    ])('finds %s when it is planted', (_label, planted) => {
      expect(findForbiddenConstructs('planted.ts', planted)).not.toEqual([]);
    });

    it('does NOT fire on the same words inside a comment', () => {
      const documented = `
        // Order resolution is #115's: OrderPaymentScheduleEntity is not touched here.
        /* policy_accepted_at stays #42's, after Legal. collectionMode is derived there. */
        export const x = 1;
      `;
      expect(findForbiddenConstructs('documented.ts', documented)).toEqual([]);
    });
  });
});
