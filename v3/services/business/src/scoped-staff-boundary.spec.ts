import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * V3.3 Story #109 (`#44c`) -- the structural proofs that need no database.
 *
 * Three separate claims live here, and each one is a security property the
 * story would otherwise be trusting a reviewer to keep true for ever:
 *
 *  1. `business` still crosses into `identity`, `provider`, `booking` and
 *     `commerce` through PORTS, never an import or a raw cross-schema query.
 *     #109 added an invitation that resolves a phone to an account and a chat
 *     authority checked against bookings -- exactly the two places where
 *     reaching across would have been easiest.
 *  2. **No phone derivative reaches persistence, a log, a metric or a queue**
 *     from anywhere in this module (`V33-DEC-033` R3). Not the raw number, not a
 *     hash, not an encrypted form, not a lookup token. A deterministic hash is
 *     pseudonymous personal data that still asserts a specific person was
 *     invited, so hashing is not a mitigation here -- it is the defect with an
 *     extra step.
 *  3. Nothing writes a global identity role or mints a token capability. #109
 *     adds scoped authority only, and `identity.user_roles` is not its table.
 *
 * The lint rule (`@nx/enforce-module-boundaries`) already forbids the imports.
 * This adds the finer-grained checks it cannot express, and every scan below is
 * paired with a planted-offender case so a scan that has quietly stopped
 * matching anything fails instead of passing.
 *
 * Modelled on `business-location-boundary.spec.ts` (#108), deliberately: one
 * shape for "the boundary is still there", not a second one to learn.
 */

const SRC = __dirname;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/**
 * Whole-line `//` comments and block comments removed.
 *
 * Load-bearing rather than tidy: the docblocks in this story legitimately NAME
 * what the code must not do -- "no raw phone, no phone hash, no encrypted
 * phone" is the sentence a reviewer needs, and it is exactly the string a naive
 * whole-file scan would flag. Stripping first is what keeps the assertions
 * about code.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

interface SourceFile {
  readonly path: string;
  readonly code: string;
}

const businessSources: SourceFile[] = walk(SRC)
  .map((path) => ({ path: relative(SRC, path).split(sep).join('/'), code: stripComments(readFileSync(path, 'utf8')) }))
  .filter((file) => !file.path.endsWith('.spec.ts'));

/** The packages `business` may not import, and the entities that would betray one. */
const FORBIDDEN_IMPORT_TOKENS = [
  "'@beauclick/identity'",
  '"@beauclick/identity"',
  "'@beauclick/provider'",
  '"@beauclick/provider"',
  "'@beauclick/booking'",
  '"@beauclick/booking"',
  "'@beauclick/commerce'",
  '"@beauclick/commerce"',
  'UserEntity',
  'ProfessionalEntity',
  'canonicalizePhone',
];

/** A raw query against a schema `business` does not own. */
const FOREIGN_SCHEMA_QUERY = /\b(from|join|into|update)\s+(identity|provider|booking|commerce|payment|financial)\./i;

describe('scoped staff authority — module boundaries (#109)', () => {
  it('the scan sees the real business module, including this story’s own files', () => {
    // The discovery half. Without it every refusal below would pass vacuously
    // against an empty file list.
    expect(businessSources.length).toBeGreaterThan(15);
    expect(businessSources.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'staff.service.ts',
        'staff-grant.service.ts',
        'scoped-staff-authorizer.service.ts',
        'staff-invite.clock.ts',
        'ports.ts',
      ]),
    );
  });

  it('no business source imports identity, provider, booking or commerce', () => {
    const offenders = businessSources
      .map((file) => ({ path: file.path, hits: FORBIDDEN_IMPORT_TOKENS.filter((token) => file.code.includes(token)) }))
      .filter((entry) => entry.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it('no business source runs a raw query against a schema it does not own', () => {
    // The authorizer joins `business.businesses`, `business.business_staff` and
    // `business.staff_role_grants` and nothing else. The booking and order reads
    // that make `practitioner_chat` practitioner-specific live in the
    // composition root, which is the only tier permitted to compose domains.
    const offenders = businessSources.filter((file) => FOREIGN_SCHEMA_QUERY.test(file.code)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('the invitation reaches identity only through STAFF_INVITE_IDENTITY_RESOLVER', () => {
    const service = businessSources.find((file) => file.path === 'staff.service.ts');
    expect(service).toBeDefined();
    expect(service!.code).toContain('STAFF_INVITE_IDENTITY_RESOLVER');
    expect(service!.code).toContain('resolveInvitableIdentity');
  });

  describe('no phone derivative is persisted, logged, queued or measured', () => {
    /**
     * A phone reaching any durable or queued sink.
     *
     * `V33-DEC-033` R3 extends ADR-049 section 4.6 to transient records
     * explicitly: "a queue does not stop being persistence because its row is
     * deleted later". So an outbox payload and a log line are as forbidden as a
     * column.
     */
    const PHONE_SINK = /(phone_hash|phoneHash|hashedPhone|encryptedPhone|phone_token|phoneToken|phone_digest)/i;
    const HASHING = /(createHash|createHmac|scrypt|pbkdf2|bcrypt)/i;
    /** A phone appearing inside a SQL string -- a column, a value or a predicate. */
    const PHONE_IN_SQL = /(INSERT|UPDATE|SELECT|VALUES|WHERE)[^;`]*\bphone\b/i;

    it('declares no phone-derivative name anywhere in the module', () => {
      const offenders = businessSources.filter((file) => PHONE_SINK.test(file.code)).map((file) => file.path);
      expect(offenders).toEqual([]);
    });

    it('hashes nothing — a deterministic phone hash would still assert who was invited', () => {
      const offenders = businessSources.filter((file) => HASHING.test(file.code)).map((file) => file.path);
      expect(offenders).toEqual([]);
    });

    it('names `phone` in no SQL statement — it is never a column, a value or a predicate here', () => {
      const offenders = businessSources.filter((file) => PHONE_IN_SQL.test(file.code)).map((file) => file.path);
      expect(offenders).toEqual([]);
    });

    it('logs and audits no phone: the invitation’s own log line carries none', () => {
      const service = businessSources.find((file) => file.path === 'staff.service.ts')!;
      // Every `auditLog.log({...})` and `audit.record({...})` call in the file,
      // captured whole and checked for the one token that must never be inside.
      const emissions = service.code.match(/(auditLog\.log|audit\.record)\([\s\S]*?\}\)/g) ?? [];
      expect(emissions.length).toBeGreaterThan(0);
      for (const emission of emissions) {
        expect(emission).not.toMatch(/\bphone\b/i);
      }
    });

    it('emits no outbox event carrying a phone', () => {
      const service = businessSources.find((file) => file.path === 'staff.service.ts')!;
      const emissions = service.code.match(/emitEvent\([\s\S]*?\}\)/g) ?? [];
      expect(emissions.length).toBeGreaterThan(0);
      for (const emission of emissions) {
        expect(emission).not.toMatch(/\bphone\b/i);
      }
    });

    describe('the phone scans are non-vacuous — each is caught when planted', () => {
      it.each([
        ['a hashed-phone column', 'const row = { phoneHash: h };', PHONE_SINK],
        ['a hashing call', "const h = createHash('sha256').update(phone).digest('hex');", HASHING],
        ['a phone in SQL', 'await m.query(`INSERT INTO business.pending (phone) VALUES ($1)`, [phone]);', PHONE_IN_SQL],
      ])('catches %s', (_label, planted, pattern) => {
        expect((pattern as RegExp).test(stripComments(planted as string))).toBe(true);
      });

      it('does NOT flag the legitimate shapes this story actually uses', () => {
        // Passing the caller's phone to the resolver port is the whole design:
        // it is a read, in memory, that writes nothing.
        const legitimate = stripComments('await this.identities.resolveInvitableIdentity(manager, dto.phone);');
        expect(PHONE_SINK.test(legitimate)).toBe(false);
        expect(HASHING.test(legitimate)).toBe(false);
        expect(PHONE_IN_SQL.test(legitimate)).toBe(false);
      });
    });
  });

  describe('no global identity role and no token capability', () => {
    /**
     * `V33-DEC-033` R1 and the story's own non-goals: scoped authority is a row
     * in `business.staff_role_grants` and nothing else. Writing
     * `identity.user_roles` or adding a `PRIVILEGED_CAPABILITIES` member would
     * turn a business-scoped, revocable grant into a platform-wide one that
     * survives in an already-issued token -- the exact opposite of "every scoped
     * check is live".
     */
    const IDENTITY_ROLE_WRITE = /(user_roles|PRIVILEGED_CAPABILITIES|capabilities\s*:)/i;

    it('no business source writes an identity role or mints a capability', () => {
      const offenders = businessSources.filter((file) => IDENTITY_ROLE_WRITE.test(file.code)).map((file) => file.path);
      expect(offenders).toEqual([]);
    });

    it('the scan is non-vacuous', () => {
      expect(IDENTITY_ROLE_WRITE.test('await m.query(`INSERT INTO identity.user_roles ...`)')).toBe(true);
      expect(IDENTITY_ROLE_WRITE.test("const t = { capabilities: ['business:manage'] };")).toBe(true);
      expect(IDENTITY_ROLE_WRITE.test('const roles = await this.liveRoles(manager, membership);')).toBe(false);
    });
  });

  describe('the scoped authorizer caches nothing and holds no connection of its own', () => {
    const authorizer = () => businessSources.find((file) => file.path === 'scoped-staff-authorizer.service.ts')!;

    it('takes the caller’s EntityManager on every method and holds no repository or DataSource', () => {
      const code = authorizer().code;
      // Every public method's first parameter is the caller's manager, so the
      // read joins the caller's transaction on the caller's connection.
      expect(code).toContain('manager: EntityManager');
      expect(code).not.toContain('InjectRepository');
      expect(code).not.toContain('DataSource');
      // No constructor at all: there is nothing it could be holding.
      expect(code).not.toMatch(/constructor\s*\(/);
    });

    it('memoises nothing — a cached answer would outlive a revocation', () => {
      const code = authorizer().code;
      for (const forbidden of ['cache', 'Cache', 'memo', 'Memo', 'new Map(', 'setTimeout']) {
        expect(code).not.toContain(forbidden);
      }
    });

    it('re-reads all four live conditions in one statement', () => {
      const code = authorizer().code;
      // The predicate is shared by all three reads so they cannot drift apart;
      // these are the four conditions `ScopedStaffAuthorizerPort` promises.
      expect(code).toContain('g.revoked_at IS NULL');
      expect(code).toContain("s.status = 'active'");
      expect(code).toContain('s.professional_id IS NOT NULL');
      expect(code).toContain('b.deleted_at IS NULL');
    });
  });

  describe('this story touches no frontend, finance, calendar or resource surface', () => {
    /**
     * The non-goals, asserted rather than remembered. `#44d` (resources),
     * `#44e` (finance), the deferred reception-mutation story and #123 (the web
     * invite form) each own the surfaces named here, and a #109 source reaching
     * one of them would be this story quietly growing past its decision.
     */
    const OUT_OF_SCOPE = /(financial\.|ledger|payout|commission|invoice|availability_slots|calendar|resources|workspaceRef|locationRef)/i;

    /**
     * Scoped to THIS story's own sources, and that is the honest scope.
     *
     * `business-location.*` legitimately names locations and their references —
     * that is #108's shipped surface, not a #109 leak. Scanning the whole module
     * would assert that #108 does not exist, which is neither true nor this
     * story's business. What #109 must prove is that IT did not grow into
     * `#44d`, `#44e`, the deferred reception-mutation story or #123.
     */
    const STORY_109_SOURCES = [
      'staff.service.ts',
      'staff-grant.service.ts',
      'scoped-staff-authorizer.service.ts',
      'staff-invite.clock.ts',
      'staff-authority.audit.ts',
      'entities/staff-role-grant.entity.ts',
      'dto/staff.dto.ts',
    ];

    it('every #109 source is present to be scanned', () => {
      const paths = businessSources.map((file) => file.path);
      for (const source of STORY_109_SOURCES) expect(paths).toContain(source);
    });

    it('no #109 source names an out-of-scope surface', () => {
      const offenders = businessSources
        .filter((file) => STORY_109_SOURCES.includes(file.path))
        .filter((file) => OUT_OF_SCOPE.test(file.code))
        .map((file) => file.path);
      expect(offenders).toEqual([]);
    });

    it('the scan is non-vacuous', () => {
      expect(OUT_OF_SCOPE.test('await m.query(`SELECT 1 FROM financial.ledger_entries`)')).toBe(true);
      expect(OUT_OF_SCOPE.test('const ref = deriveWorkspaceReference(secret, id);')).toBe(true);
      expect(OUT_OF_SCOPE.test("const roles = ['practitioner_chat'];")).toBe(false);
    });
  });
});
