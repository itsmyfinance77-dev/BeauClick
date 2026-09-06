import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The enforceable half of `V33-DEC-009`'s production-safety rule.
 *
 * > No allowance, including 200, may exist as a code constant, default,
 * > fallback or seed.
 *
 * Issue #40 asks for "a repository check [that] makes this enforceable rather
 * than aspirational", and this is it: it reads the commercial-policy
 * implementation, its contract package and its migration SQL off disk and
 * fails if any of them names an allowance.
 *
 * ## Why it is deliberately NARROW
 *
 * A broad grep for `200` finds an HTTP status in every controller test and a
 * sentence about V2's behaviour in every third docblock, and a check that cries
 * wolf gets deleted. So three things are excluded, and each exclusion is proved
 * by a control case below rather than assumed:
 *
 *  1. **Comments are stripped before scanning.** Historical prose — including
 *     this file's own quotation of the decision, and the migration's
 *     explanation of why zero is not an allowance — is documentation, not code.
 *  2. **String and template literals are stripped.** A Persian error message or
 *     a route path is not a value.
 *  3. **An HTTP status is not an allowance.** `toBe(200)`, `HttpStatus.OK` and a
 *     `status`-shaped identifier are not findings. §"controls" proves it.
 *
 * ## Why it is not vacuous
 *
 * Every rule below runs over PLANTED FIXTURES through the same functions the
 * real files go through, and each fixture is asserted to be FOUND. A detector
 * that cannot fail is not evidence — the same reasoning
 * `referral.pg-spec.ts`'s `recordLogging` docblock records — so "the plant was
 * found" is treated here as a precondition for trusting the real assertion.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../../..');

/**
 * Identifiers whose VALUE would be an allowance or a price.
 *
 * Deliberately not `quantity`: a purchasable-quantity bound is a
 * representational limit, and including it would have made the check fire on
 * `MAX_CATALOGUE_QUANTITY` and taught the next reader to widen the exemption
 * list instead of the vocabulary.
 */
const ALLOWANCE_IDENTIFIER = /(credit|allowance|quota|seat|includedlocation|included_location|unitprice|unit_price|pricetoman|price_toman)/i;

/**
 * The ONLY identifiers permitted to hold a non-zero number despite matching the
 * vocabulary above.
 *
 * An explicit ALLOW-LIST rather than a naming pattern, and that is the load-
 * bearing choice: a pattern like `^MAX_` would silently absolve a future
 * `MAX_INCLUDED_CREDITS = 200`, whereas adding a name here is a visible edit to
 * this file that a reviewer has to approve. Both entries are absolute bounds of
 * the STORAGE — the largest quantity a generated `int4range` can express, and
 * `@beauclick/money`'s own ceiling — and neither is ever assigned to a term.
 */
const EXEMPT_BOUND_CONSTANTS = ['MAX_CATALOGUE_QUANTITY', 'MAX_UNIT_PRICE_TOMAN'];

/** Columns whose value would be an allowance or a price. */
const ALLOWANCE_COLUMNS = [
  'included_booking_credits',
  'staff_seats',
  'included_locations',
  'unit_price_toman',
];

export interface AllowanceFinding {
  readonly file: string;
  readonly rule: string;
  readonly detail: string;
}

/** Removes `//` and block comments, then string and template literals. */
export function stripTypeScriptNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Removes `--` line comments. The commercial migrations use no block comments. */
export function stripSqlNoise(source: string): string {
  return source.replace(/--[^\n]*/g, ' ');
}

function isZeroLiteral(literal: string): boolean {
  return Number(literal.replace(/_/g, '')) === 0;
}

/**
 * RULE A — no non-zero number is assigned or initialised to an allowance-shaped
 * identifier.
 *
 * Matches `name: 200`, `name = 200`, and `name` followed by an optional `?`/type
 * annotation before `=`. Decorator arguments (`@Max(1000000)`) are NOT matched,
 * because a bound is not a value.
 */
export function findAllowanceLiterals(file: string, source: string): AllowanceFinding[] {
  const findings: AllowanceFinding[] = [];
  const cleaned = stripTypeScriptNoise(source);
  const assignment = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\??\s*:\s*[A-Za-z0-9_$<>[\]| ]*)?\s*[:=]\s*(\d[\d_]*)(?![\d_.eE])/g;

  for (const match of cleaned.matchAll(assignment)) {
    const [, identifier, literal] = match;
    if (!ALLOWANCE_IDENTIFIER.test(identifier)) continue;
    if (isZeroLiteral(literal)) continue;
    if (EXEMPT_BOUND_CONSTANTS.includes(identifier)) continue;
    findings.push({
      file,
      rule: 'allowance-literal',
      detail: `${identifier} is initialised to ${literal}`,
    });
  }

  return findings;
}

/** RULE B1 — no allowance or price column carries a DEFAULT. */
export function findAllowanceColumnDefaults(file: string, sql: string): AllowanceFinding[] {
  const findings: AllowanceFinding[] = [];
  for (const line of stripSqlNoise(sql).split(/\r?\n/)) {
    const lowered = line.toLowerCase();
    if (!ALLOWANCE_COLUMNS.some((column) => lowered.includes(column))) continue;
    if (!/\bdefault\b/.test(lowered)) continue;
    findings.push({ file, rule: 'allowance-column-default', detail: line.trim() });
  }
  return findings;
}

/**
 * RULE B2 — no INSERT into `commercial.*` carries a numeric literal other than
 * 0 or 1.
 *
 * The tightest honest statement about the seed: every number the migration
 * writes is a version number, a single-item quantity, or a zero. An allowance
 * of 200, a price of 500000, or a seat count of 5 all fail here — and so would
 * a "harmless" 2, which is the point of setting the bar at the values the seed
 * actually needs rather than at a list of forbidden ones.
 *
 * Quoted values (uuids, timestamps, keys, labels) are stripped first, so this
 * measures the seed's NUMBERS and not its text.
 */
export function findSeededNumbers(file: string, sql: string): AllowanceFinding[] {
  const findings: AllowanceFinding[] = [];
  const cleaned = stripSqlNoise(sql).replace(/'(?:[^']|'')*'/g, "''");
  const inserts = cleaned.matchAll(/INSERT\s+INTO\s+commercial\.[\s\S]*?;/gi);

  for (const insert of inserts) {
    const statement = insert[0];
    const valuesClause = /VALUES([\s\S]*)$/i.exec(statement);
    if (!valuesClause) continue;
    for (const number of valuesClause[1].matchAll(/(?<![A-Za-z0-9_])(\d+)(?![A-Za-z0-9_])/g)) {
      if (number[1] === '0' || number[1] === '1') continue;
      findings.push({
        file,
        rule: 'seeded-number',
        detail: `an INSERT into commercial.* writes the number ${number[1]}`,
      });
    }
  }

  return findings;
}

/**
 * RULE C -- the collection-policy family, added by V3.3 Story #83 (`#41d-1`).
 *
 * A SEPARATE vocabulary rather than a widening of `ALLOWANCE_IDENTIFIER`, and
 * that is deliberate. Adding `basispoints` to the existing pattern would have
 * fired on `providerCancellationRefundBasisPointsOfDeposit: 10_000` in
 * `BookingCommercialTermsV1` -- a TYPE annotation pinning a ratified structural
 * invariant (provider fault always refunds in full), not an unpublished value.
 * Destabilising a passing rule to reach a new one is how an exemption list
 * grows until it means nothing.
 *
 * `V33-DEC-028` R2 and `V33-DEC-029` R4: no deposit amount, rate, bound, mode
 * or percentage base may exist as a constant, default, fallback or seed.
 */
const COLLECTION_VALUE_IDENTIFIER =
  /(depositamount|deposit_amount|depositbasispoints|deposit_basis_points|depositminimum|deposit_minimum|depositmaximum|deposit_maximum|percentagebase|percentage_base|collectionmode|collection_mode|depositkind|deposit_kind)/i;

/** Columns whose value would be a deposit rule or a collection mode. */
const COLLECTION_VALUE_COLUMNS = [
  'collection_mode',
  'deposit_kind',
  'deposit_amount_toman',
  'deposit_basis_points',
  'deposit_minimum_toman',
  'deposit_maximum_toman',
  'percentage_base',
];

/**
 * C1 -- no non-zero number is assigned to a collection-value identifier.
 *
 * Zero is exempt for the same reason it is in Rule A: it is the absence of a
 * value, not a choice of one. In practice nothing here should even reach zero.
 */
export function findCollectionValueLiterals(file: string, source: string): AllowanceFinding[] {
  const findings: AllowanceFinding[] = [];
  const cleaned = stripTypeScriptNoise(source);
  const assignment = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\??\s*:\s*[A-Za-z0-9_$<>[\]| ]*)?\s*[:=]\s*(\d[\d_]*)(?![\d_.eE])/g;

  for (const match of cleaned.matchAll(assignment)) {
    const [, identifier, literal] = match;
    if (!COLLECTION_VALUE_IDENTIFIER.test(identifier)) continue;
    if (isZeroLiteral(literal)) continue;
    findings.push({
      file,
      rule: 'collection-value-literal',
      detail: `${identifier} is initialised to ${literal}`,
    });
  }

  return findings;
}

/**
 * C2 -- no STRING literal is assigned to a mode, kind or base identifier.
 *
 * The dangerous default in this family is not a number. `collectionMode:
 * 'full_payment_online'` or `percentageBase: 'service_total'` in the
 * commercial-policy implementation would be engineering choosing the value
 * `V33-DEC-029` R4 explicitly leaves to an administrator.
 *
 * `stripTypeScriptNoise` has already replaced every string literal with an
 * empty one, so this looks for `identifier: ''` -- assignment of ANY string
 * literal, whatever it held. A comparison (`=== ''`) is not an assignment and
 * is not matched, which is what lets the contract's own `mode === 'x'` branches
 * pass.
 */
export function findCollectionValueStrings(file: string, source: string): AllowanceFinding[] {
  const findings: AllowanceFinding[] = [];
  const cleaned = stripTypeScriptNoise(source);
  const assignment = /(?<![=!<>])([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=](?!=)\s*(''|"")/g;

  for (const match of cleaned.matchAll(assignment)) {
    const identifier = match[1];
    if (!COLLECTION_VALUE_IDENTIFIER.test(identifier)) continue;
    findings.push({
      file,
      rule: 'collection-value-string',
      detail: `${identifier} is assigned a string literal`,
    });
  }

  return findings;
}

/** C3 -- no collection-value column carries a DEFAULT. */
export function findCollectionColumnDefaults(file: string, sql: string): AllowanceFinding[] {
  const findings: AllowanceFinding[] = [];
  for (const line of stripSqlNoise(sql).split(/\r?\n/)) {
    const lowered = line.toLowerCase();
    if (!COLLECTION_VALUE_COLUMNS.some((column) => lowered.includes(column))) continue;
    if (!/\bdefault\b/.test(lowered)) continue;
    findings.push({ file, rule: 'collection-column-default', detail: line.trim() });
  }
  return findings;
}

function readTypeScriptSources(...directories: string[]): Array<{ file: string; source: string }> {
  const collected: Array<{ file: string; source: string }> = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      // A spec plants forbidden values on purpose; scanning it would make this
      // check fire on its own fixtures.
      if (entry.name.endsWith('.spec.ts')) continue;
      collected.push({ file: path.slice(WORKSPACE_ROOT.length + 1), source: readFileSync(path, 'utf8') });
    }
  };

  for (const directory of directories) walk(resolve(WORKSPACE_ROOT, directory));
  return collected;
}

function readCommercialMigrations(): Array<{ file: string; source: string }> {
  const directory = resolve(WORKSPACE_ROOT, 'database/migrations/commercial');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({
      file: `database/migrations/commercial/${name}`,
      source: readFileSync(join(directory, name), 'utf8'),
    }));
}

describe('no hard-coded allowance exists in the commercial-policy implementation', () => {
  const sources = readTypeScriptSources('services/commercial-policy/src', 'packages/commercial-policy-contract/src');
  const migrations = readCommercialMigrations();

  it('reads real files, so an empty finding list means something', () => {
    // The discovery half of the check. An earlier version of a scanner like
    // this one passed while walking an empty directory, which reads exactly
    // like a clean result.
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining([expect.stringContaining('commercial-catalogue.service.ts')]),
    );
  });

  it('assigns no non-zero number to any allowance-shaped identifier', () => {
    const findings = sources.flatMap(({ file, source }) => findAllowanceLiterals(file, source));
    expect(findings).toEqual([]);
  });

  it('puts no DEFAULT on an allowance or price column', () => {
    const findings = migrations.flatMap(({ file, source }) => findAllowanceColumnDefaults(file, source));
    expect(findings).toEqual([]);
  });

  it('seeds no number other than 0 or 1 into the commercial schema', () => {
    const findings = migrations.flatMap(({ file, source }) => findSeededNumbers(file, source));
    expect(findings).toEqual([]);
  });

  it('exempts exactly two bound constants, so widening the exemption is a visible edit', () => {
    expect(EXEMPT_BOUND_CONSTANTS).toEqual(['MAX_CATALOGUE_QUANTITY', 'MAX_UNIT_PRICE_TOMAN']);
  });

  // -------------------------------------------------------------------------
  // V3.3 Story #83 (`#41d-1`) -- the collection-policy family
  // -------------------------------------------------------------------------

  it('assigns no non-zero number to any deposit amount, rate or bound', () => {
    const findings = sources.flatMap(({ file, source }) => findCollectionValueLiterals(file, source));
    expect(findings).toEqual([]);
  });

  it('assigns no string literal to a collection mode, deposit kind or percentage base', () => {
    const findings = sources.flatMap(({ file, source }) => findCollectionValueStrings(file, source));
    expect(findings).toEqual([]);
  });

  it('puts no DEFAULT on a collection mode, deposit or percentage-base column', () => {
    const findings = migrations.flatMap(({ file, source }) => findCollectionColumnDefaults(file, source));
    expect(findings).toEqual([]);
  });

  it('scans the collection-policy files that Story #83 actually added', () => {
    // The discovery half again: these rules would pass vacuously if the new
    // files were outside the walked directories.
    const scanned = sources.map((s) => s.file);
    expect(scanned).toEqual(
      expect.arrayContaining([
        expect.stringContaining('booking-collection-policy.service.ts'),
        expect.stringContaining('booking-collection-policy-contract.ts'),
      ]),
    );
    expect(migrations.map((m) => m.file)).toEqual(
      expect.arrayContaining([expect.stringContaining('booking_collection_policies')]),
    );
  });
});

describe('the allowance detector is not vacuous — planted positives', () => {
  it.each([
    ['a module constant', 'const includedBookingCredits = 200;'],
    ['an object property', 'const terms = { includedBookingCredits: 200, staffSeats: 0 };'],
    ['a default parameter', 'function make(bookingCredits = 200) { return bookingCredits; }'],
    ['a class field', 'class Plan { includedBookingCredits = 200; }'],
    ['a seat count', 'const staffSeats = 5;'],
    ['a location count', 'const includedLocations = 3;'],
    ['a unit price', 'const unitPriceToman = 490000;'],
    ['a snake-cased column value', 'const row = { unit_price_toman: 490000 };'],
    ['a typed declaration', 'let allowance: number = 200;'],
  ])('catches %s', (_label, planted) => {
    expect(findAllowanceLiterals('planted.ts', planted)).not.toEqual([]);
  });

  it('catches an allowance hidden behind a renamed but still allowance-shaped identifier', () => {
    expect(findAllowanceLiterals('planted.ts', 'const defaultMonthlyCreditAllowance = 200;')).not.toEqual([]);
  });

  it('catches a DEFAULT on an allowance column', () => {
    const planted = 'included_booking_credits INTEGER NOT NULL DEFAULT 200,';
    expect(findAllowanceColumnDefaults('planted.sql', planted)).not.toEqual([]);
  });

  it('catches a DEFAULT on a price column', () => {
    const planted = 'unit_price_toman BIGINT NOT NULL DEFAULT 490000,';
    expect(findAllowanceColumnDefaults('planted.sql', planted)).not.toEqual([]);
  });

  it('catches a seeded allowance in an INSERT', () => {
    const planted = "INSERT INTO commercial.plan_versions (plan_key, included_booking_credits) VALUES ('D-7', 200);";
    const findings = findSeededNumbers('planted.sql', planted);
    expect(findings).not.toEqual([]);
    expect(findings[0].detail).toContain('200');
  });

  it('catches a seeded production price in an INSERT', () => {
    const planted = "INSERT INTO commercial.price_tiers (id, unit_price_toman) VALUES ('x', 490000);";
    expect(findSeededNumbers('planted.sql', planted)).not.toEqual([]);
  });
});

describe('the allowance detector does not cry wolf — controls', () => {
  it('does not flag an HTTP status assertion', () => {
    const control = 'expect(response.status).toBe(200);\nconst status = 200;\nreturn { status: 200 };';
    expect(findAllowanceLiterals('control.ts', control)).toEqual([]);
  });

  it('does not flag HttpStatus.OK or a status-shaped identifier', () => {
    const control = 'const statusCode = 200; const httpStatus: number = 200; const okStatus = 200;';
    expect(findAllowanceLiterals('control.ts', control)).toEqual([]);
  });

  it('does not flag historical prose about an allowance in a comment', () => {
    const control = [
      '// V2 granted 200 bookings per month by default, which is exactly what',
      '/* this platform must not do: a 200-credit allowance was a code constant. */',
      'const includedBookingCredits = 0;',
    ].join('\n');
    expect(findAllowanceLiterals('control.ts', control)).toEqual([]);
  });

  it('does not flag an allowance value inside a string literal', () => {
    const control = "const message = 'the plan includes 200 credits'; const includedBookingCredits = 0;";
    expect(findAllowanceLiterals('control.ts', control)).toEqual([]);
  });

  it('does not flag a validation BOUND expressed as a decorator argument', () => {
    const control = '@Max(1000000)\nstaffSeats!: number;\n@Min(0)\nincludedBookingCredits!: number;';
    expect(findAllowanceLiterals('control.ts', control)).toEqual([]);
  });

  it('does not flag zero, which is the absence of an allowance rather than one', () => {
    const control = 'const includedBookingCredits = 0; const staffSeats = 0; const unitPriceToman = 0;';
    expect(findAllowanceLiterals('control.ts', control)).toEqual([]);
  });

  it('does not flag a column with no DEFAULT at all', () => {
    expect(findAllowanceColumnDefaults('control.sql', 'included_booking_credits INTEGER NOT NULL,')).toEqual([]);
  });

  it('does not flag a lifecycle DEFAULT on a non-allowance column', () => {
    const control = "lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'draft',";
    expect(findAllowanceColumnDefaults('control.sql', control)).toEqual([]);
  });

  it('does not flag a zero seeded into the commercial schema', () => {
    const control =
      "INSERT INTO commercial.plan_versions (plan_key, version, included_booking_credits) VALUES ('D-7', 1, 0);";
    expect(findSeededNumbers('control.sql', control)).toEqual([]);
  });

  it('does not flag an INSERT into another schema', () => {
    const control = "INSERT INTO identity.capabilities (slug, weight) VALUES ('bc_x', 200);";
    expect(findSeededNumbers('control.sql', control)).toEqual([]);
  });
});

/**
 * V3.3 Story #83 (`#41d-1`) -- the collection-policy rules, planted and
 * controlled exactly as Rules A and B are above.
 */
describe('the collection-value detector is not vacuous -- planted positives', () => {
  it.each([
    ['a fixed deposit amount', 'const depositAmountToman = 100000;'],
    ['a deposit rate', 'const config = { depositBasisPoints: 2000 };'],
    ['a deposit minimum', 'depositMinimumToman = 50000;'],
    ['a deposit maximum', 'class C { depositMaximumToman: number = 5000000; }'],
    ['a snake-cased column value', 'const row = { deposit_basis_points: 2500 };'],
    ['a deposit rate hidden behind a typed declaration', 'const depositBasisPoints: number = 1500;'],
  ])('C1 catches %s', (_label, planted) => {
    expect(findCollectionValueLiterals('planted.ts', planted)).not.toEqual([]);
  });

  it.each([
    ['a default collection mode', "const collectionMode = 'full_payment_online';"],
    ['a default percentage base', "const x = { percentageBase: 'service_total' };"],
    ['a default deposit kind', "depositKind = 'percentage';"],
    ['a snake-cased default', "const row = { collection_mode: 'pay_at_venue' };"],
  ])('C2 catches %s', (_label, planted) => {
    expect(findCollectionValueStrings('planted.ts', planted)).not.toEqual([]);
  });

  it('C3 catches a DEFAULT on a collection-value column', () => {
    const planted = "    collection_mode VARCHAR(40) NOT NULL DEFAULT 'full_payment_online',";
    expect(findCollectionColumnDefaults('planted.sql', planted)).not.toEqual([]);
    const planted2 = '    deposit_basis_points INTEGER DEFAULT 2000,';
    expect(findCollectionColumnDefaults('planted.sql', planted2)).not.toEqual([]);
  });
});

describe('the collection-value detector does not cry wolf -- controls', () => {
  it('does not flag a COMPARISON against a mode, which is how the contract branches', () => {
    const control = "if (terms.collectionMode === 'full_payment_online') { return 1; }";
    expect(findCollectionValueStrings('control.ts', control)).toEqual([]);
    const control2 = "const isDeposit = deposit.kind !== 'none';";
    expect(findCollectionValueStrings('control.ts', control2)).toEqual([]);
  });

  it('does not flag a value READ from an administrator-supplied input', () => {
    const control = 'const row = { collectionMode: dto.collectionMode, depositBasisPoints: deposit.basisPoints };';
    expect(findCollectionValueLiterals('control.ts', control)).toEqual([]);
    expect(findCollectionValueStrings('control.ts', control)).toEqual([]);
  });

  it('does not flag a null assignment, which is the absence of a rule', () => {
    const control = 'const row = { depositAmountToman: null, percentageBase: null };';
    expect(findCollectionValueLiterals('control.ts', control)).toEqual([]);
    expect(findCollectionValueStrings('control.ts', control)).toEqual([]);
  });

  it('does not flag a validation BOUND expressed as a decorator argument', () => {
    const control = '@Max(10000)\n  basisPoints?: number;';
    expect(findCollectionValueLiterals('control.ts', control)).toEqual([]);
  });

  it('does not flag the lifecycle DEFAULT, which cannot choose a commercial outcome', () => {
    const control = "    lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'draft',";
    expect(findCollectionColumnDefaults('control.sql', control)).toEqual([]);
  });

  it('does not flag a mode named only inside a comment', () => {
    const control = '// full_payment_online is what the legacy path writes; see #104.';
    expect(findCollectionValueStrings('control.ts', control)).toEqual([]);
  });
});
