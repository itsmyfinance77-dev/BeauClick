import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The structural half of Story #115 (`#41d-2b`) — ADR-048 R3 and R4.
 *
 * ## Why a source scan rather than behaviour
 *
 * Three of this story's guarantees are shapes, not outcomes, and each is
 * invisible to a behavioural test:
 *
 *   * **Commerce imports no Commercial Policy implementation.** A test that
 *     exercised the order path would pass just as happily if `order.service.ts`
 *     imported `CollectionPolicyResolutionService` directly — it would still
 *     resolve the right policy. What it would have destroyed is the boundary
 *     `scope:commerce` may depend only on `scope:shared`, and nothing about the
 *     answer would look different.
 *   * **No injected-repository read survives on the transactional order path.**
 *     A leftover repository read returns the same rows on a healthy database.
 *     It differs only under concurrency, which is precisely when nobody is
 *     looking.
 *   * **The seller party is selected once.** "It was not read a second time" is
 *     a statement about code that ran, and the second read would be
 *     indistinguishable from the first in its result.
 *
 * §4 plants each violation and asserts the same detector finds it, so an empty
 * finding list means something.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

/** Files Story #115 created or edited inside `services/commerce`. */
const COMMERCE_FILES = [
  'services/commerce/src/ports.ts',
  'services/commerce/src/order/order.service.ts',
  'services/commerce/src/entities/order-payment-schedule.entity.ts',
];

/**
 * Imports Commerce must never carry.
 *
 * `@beauclick/commercial-policy-contract` is deliberately absent from this
 * list: it is a browser-safe `scope:shared` package of types and pure
 * functions, with no ORM entity and no service, and the schedule entity already
 * imported `BookingCollectionMode` from it before this story existed.
 */
export const FORBIDDEN_COMMERCE_IMPORTS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /from '@beauclick\/commercial-policy'/, why: 'the Commercial Policy implementation package' },
  { pattern: /CollectionPolicyResolutionService/, why: "the resolver's concrete class" },
  { pattern: /CollectionPolicyAssignmentService/, why: "the seller's assignment writer" },
  { pattern: /BookingCollectionPolicyService/, why: 'the privileged administrator writer' },
  { pattern: /SellerCollectionPolicyAssignmentEntity|seller_collection_policy_assignments/, why: 'an ORM entity or table owned by Commercial Policy' },
  { pattern: /booking_collection_policy_versions/, why: 'the catalogue table' },
  { pattern: /from '@beauclick\/(provider|business|identity|booking|payment|financial)'/, why: 'another domain service' },
];

export function findForbiddenImports(file: string, source: string): string[] {
  const cleaned = stripComments(source);
  return FORBIDDEN_COMMERCE_IMPORTS.filter(({ pattern }) => pattern.test(cleaned)).map(
    ({ pattern, why }) => `${file} matches ${pattern} (${why})`,
  );
}

/** Removes comments, so a docblock naming a forbidden thing is documentation. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function read(relativePath: string): string {
  return readFileSync(resolve(WORKSPACE_ROOT, relativePath), 'utf8');
}

describe('Story #115 keeps Commerce inside its own scope', () => {
  const files = COMMERCE_FILES.map((file) => ({ file, source: read(file) }));

  it('reads real files, so an empty finding list means something', () => {
    expect(files).toHaveLength(COMMERCE_FILES.length);
    for (const { source } of files) expect(source.length).toBeGreaterThan(200);
  });

  it('imports no Commercial Policy implementation or entity anywhere in Commerce', () => {
    const findings = files.flatMap(({ file, source }) => findForbiddenImports(file, source));
    expect(findings).toEqual([]);
  });

  it('declares the resolver as a Commerce-owned port with a mandatory manager', () => {
    const ports = stripComments(read('services/commerce/src/ports.ts'));
    expect(ports).toContain('BOOKING_COLLECTION_POLICY_RESOLVER');
    // The manager is the first parameter and is not optional.
    expect(ports).toMatch(/resolveForSellerParty\(\s*manager: EntityManager,/);
    expect(ports).not.toMatch(/manager\?: EntityManager/);
    // The port cannot be asked on behalf of an identity or for a named policy.
    for (const forbidden of ['userId', 'workspaceRef', 'policyKey:', 'policyVersion:', 'actorUserId']) {
      expect(ports.slice(ports.indexOf('BookingCollectionPolicyResolver'))).not.toContain(forbidden);
    }
  });

  it('requires the caller manager on the catalogue port too', () => {
    const ports = stripComments(read('services/commerce/src/ports.ts'));
    expect(ports).toMatch(/findServiceOffering\(manager: EntityManager, serviceId: string\)/);
  });

  // =========================================================================
  // §2. One selection, no re-read, on the transactional path
  // =========================================================================

  describe('the seller party is selected once', () => {
    const service = () => stripComments(read('services/commerce/src/order/order.service.ts'));

    it('passes the caller manager into the catalogue read', () => {
      expect(service()).toMatch(/this\.catalog\.findServiceOffering\(manager,/);
    });

    it('names the selected party once and reuses it', () => {
      const source = service();
      // Selected into a single value...
      expect(source).toMatch(/const sellerParty: OrderSellerParty = \{/);
      // ...and the raw offering fields are never used for the seller again.
      expect(source).not.toMatch(/sellerPartyType: offering\.sellerPartyType/);
      expect(source).not.toMatch(/sellerPartyId: offering\.sellerPartyId/);
    });

    it('never consults an affiliation lookup itself', () => {
      const source = service();
      expect(source).not.toMatch(/SellerPartyLookup|forProfessional|business_staff/);
    });

    it('resolves the policy BEFORE the first write', () => {
      const source = service();
      const resolveAt = source.indexOf('this.resolveCollection(');
      const insertAt = source.indexOf('manager.insert(OrderEntity');
      expect(resolveAt).toBeGreaterThan(-1);
      expect(insertAt).toBeGreaterThan(-1);
      // A failure after the order row exists would leave a refused booking's
      // order behind, which is exactly what fail-closed forbids.
      expect(resolveAt).toBeLessThan(insertAt);
    });
  });

  // =========================================================================
  // §3. The mode is derived, and the adapters kept no fallback
  // =========================================================================

  describe('the derivation and the adapters', () => {
    it('derives the mode from amounts and never copies the terms mode', () => {
      const source = stripComments(read('services/commerce/src/order/order.service.ts'));
      expect(source).toMatch(/function modeForAmounts\(/);
      expect(source).toMatch(/modeForAmounts\(amounts\.platformCollectibleToman, amounts\.serviceTotalToman\)/);
      // The mutation this exists to stop.
      expect(source).not.toMatch(/collectionMode:\s*[\w.]*terms\.collectionMode/);
      expect(source).not.toMatch(/collectionMode:\s*collection\.snapshot\.terms\.collectionMode/);
    });

    it('calls the shipped helper with BOTH amounts rather than reimplementing it', () => {
      const source = stripComments(read('services/commerce/src/order/order.service.ts'));
      expect(source).toMatch(
        /bookingCollectionAmountsV1\(priced\.subtotalToman, priced\.totalToman, collection\.snapshot\.terms\)/,
      );
      // No second copy of the arithmetic.
      expect(source).not.toMatch(/BigInt\(/);
      expect(source).not.toMatch(/10_000n/);
    });

    it('leaves no injected repository on either order-path adapter', () => {
      const adapters = stripComments(read('apps/api/src/composition/port-adapters.ts'));
      const lookup = adapters.slice(adapters.indexOf('class SellerPartyLookup'), adapters.indexOf('class ProviderBackedServiceCatalog'));
      // The whole class body carries no injected repository at all.
      expect(lookup).not.toMatch(/InjectRepository/);
      expect(lookup).toMatch(/forProfessional\(manager: EntityManager, professionalId: string\)/);

      const catalog = adapters.slice(adapters.indexOf('class ProviderBackedServiceCatalog'));
      const constructorEnd = catalog.indexOf('async findServiceOffering');
      expect(catalog.slice(0, constructorEnd)).not.toMatch(/InjectRepository/);
      expect(catalog).toMatch(/manager\.findOne\(ServiceOfferingEntity/);
      expect(catalog).toMatch(/this\.sellerParty\.forProfessional\(manager,/);
    });

    it('passes the caller manager through the resolver adapter verbatim', () => {
      /*
       * The resolver itself takes a manager and uses it (asserted in §3b), and
       * a probe that moved the ADAPTER onto `manager.connection.manager` still
       * satisfied that -- the resolver was innocent; the adapter handed it the
       * wrong connection. Caught behaviourally by the lock-duration case, and
       * here as well so the shape is pinned at both ends.
       */
      const adapters = stripComments(read('apps/api/src/composition/port-adapters.ts'));
      const from = adapters.indexOf('class CommercialPolicyBackedCollectionResolver');
      expect(from).toBeGreaterThan(-1);
      // Bounded to THIS class. An unbounded slice runs to end of file and
      // sweeps in every later adapter, several of which legitimately hold a
      // DataSource -- the assertion would then fail on correct source.
      const nextClass = adapters.indexOf('export class ', from + 1);
      const resolver = adapters.slice(from, nextClass === -1 ? undefined : nextClass);

      expect(resolver).toMatch(
        /this\.resolution\.resolveForParty\(manager, sellerParty\.partyType, sellerParty\.partyId\)/,
      );
      expect(resolver).not.toMatch(/connection\.manager|dataSource|createQueryRunner/);
    });

    it('binds the resolver exactly once, at the composition root', () => {
      const module = stripComments(read('apps/api/src/composition/domain-ports.module.ts'));
      const bindings = module.match(/provide: BOOKING_COLLECTION_POLICY_RESOLVER/g) ?? [];
      expect(bindings).toHaveLength(1);
      expect(module).toMatch(/useExisting: CommercialPolicyBackedCollectionResolver/);
    });
  });

  // =========================================================================
  // §3b. The resolver reads through the caller and asks PostgreSQL for the time
  // =========================================================================

  describe('the resolver stays inside the caller transaction and on the database clock', () => {
    const resolver = (): string =>
      stripComments(
        read(
          'services/commercial-policy/src/collection-policy-assignment/collection-policy-resolution.service.ts',
        ),
      );

    it('runs every statement on the caller manager', () => {
      const source = resolver();
      // Two reads, both on `manager`.
      expect((source.match(/await manager\.query\(/g) ?? []).length).toBe(2);
      // Never a repository, a DataSource, or a second manager.
      expect(source).not.toMatch(/InjectRepository|private readonly dataSource|this\.dataSource/);
      expect(source).not.toMatch(/connection\.manager|\.manager\.query/);
    });

    it('locks both rows with FOR SHARE', () => {
      const source = resolver();
      expect((source.match(/FOR SHARE/g) ?? []).length).toBe(2);
      expect(source).toMatch(/seller_collection_policy_assignments[\s\S]{0,300}?FOR SHARE/);
      expect(source).toMatch(/booking_collection_policy_versions[\s\S]{0,600}?FOR SHARE/);
    });

    it('decides the activation window with the database clock only', () => {
      const source = resolver();
      // The window is compared against `now()`, three times: start, and both
      // halves of the open-ended end bound.
      expect(source).toMatch(/activation_starts_at <= now\(\)/);
      expect(source).toMatch(/now\(\) < v\.activation_ends_at/);
      // And the instant recorded comes from the row, never from JavaScript.
      expect(source).toMatch(/now\(\) AS resolved_at/);
      expect(source).toMatch(/resolvedAt: versions\[0\]\.resolved_at\.toISOString\(\)/);
      expect(source).not.toMatch(/new Date\(\)/);
    });

    it('writes nothing at all', () => {
      const source = resolver();
      for (const mutation of ['INSERT', 'UPDATE', 'DELETE', 'audit', 'actorUserId', 'reason']) {
        expect(source).not.toMatch(new RegExp(mutation));
      }
    });
  });

  // =========================================================================
  // §4. The detector is not vacuous — planted violations
  // =========================================================================

  describe('the detector is not vacuous', () => {
    it.each([
      ['the implementation package', "import { X } from '@beauclick/commercial-policy';"],
      ['the resolver class', 'class A { constructor(private readonly r: CollectionPolicyResolutionService) {} }'],
      ['the assignment writer', 'const s = new CollectionPolicyAssignmentService();'],
      ['the admin writer', 'const s = new BookingCollectionPolicyService();'],
      ['an assignment table read', "await m.query('SELECT 1 FROM seller_collection_policy_assignments');"],
      ['the catalogue table', "await m.query('SELECT 1 FROM booking_collection_policy_versions');"],
      ['another domain service', "import { ProfessionalEntity } from '@beauclick/provider';"],
    ])('finds %s when it is planted', (_label, planted) => {
      expect(findForbiddenImports('planted.ts', planted)).not.toEqual([]);
    });

    it('does NOT fire on the same names inside a comment', () => {
      const documented = `
        // CollectionPolicyResolutionService answers this, bound in apps/api.
        /* seller_collection_policy_assignments is #104's table, never read here. */
        export const x = 1;
      `;
      expect(findForbiddenImports('documented.ts', documented)).toEqual([]);
    });

    it('permits the browser-safe shared contract, which is not an implementation', () => {
      const allowed = "import type { BookingCollectionPolicySnapshotV1 } from '@beauclick/commercial-policy-contract';";
      expect(findForbiddenImports('allowed.ts', allowed)).toEqual([]);
    });
  });

  // =========================================================================
  // §5. The migration touched only what it was allowed to
  // =========================================================================

  describe('the migration', () => {
    const migrationSource = (): string => {
      const directory = resolve(WORKSPACE_ROOT, 'database/migrations/commerce');
      const name = readdirSync(directory).find((f) => f.includes('replace_order_payment_schedule_policy_reference'));
      expect(name).toBeDefined();
      return readFileSync(join(directory, name as string), 'utf8');
    };

    it('writes no row', () => {
      const sql = migrationSource().replace(/--[^\n]*/g, ' ');
      expect(sql).not.toMatch(/\bUPDATE\b/i);
      expect(sql).not.toMatch(/\bINSERT\b/i);
      expect(sql).not.toMatch(/\bDELETE\b/i);
    });

    it('touches only ck_ops_policy_reference', () => {
      const sql = migrationSource().replace(/--[^\n]*/g, ' ');
      expect(sql).toMatch(/DROP CONSTRAINT ck_ops_policy_reference/);
      expect(sql).toMatch(/ADD CONSTRAINT ck_ops_policy_reference/);
      for (const untouched of [
        'ck_ops_sum',
        'ck_ops_mode_consistent',
        'ck_ops_policy_version_positive',
        'ck_ops_contract_version',
        'tg_order_payment_schedules_immutable',
        'order_payment_schedules_pkey',
      ]) {
        expect(sql).not.toMatch(new RegExp(`(DROP|ALTER)[^;]*${untouched}`, 'i'));
      }
    });

    it('leaves acceptance out of the constraint entirely', () => {
      const sql = migrationSource();
      const check = /ADD CONSTRAINT ck_ops_policy_reference CHECK \(([\s\S]*?)\);/.exec(sql);
      expect(check).not.toBeNull();
      expect(check![1]).not.toContain('policy_accepted_at');
      expect(check![1]).toContain('policy_key');
      expect(check![1]).toContain('policy_version');
    });
  });
});
