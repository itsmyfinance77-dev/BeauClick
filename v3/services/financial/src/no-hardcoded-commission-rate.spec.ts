import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The enforceable half of `#43a`'s "removal" acceptance criterion (ADR-052
 * §16, `V33-DEC-040` R1): *"`FinancialConfig`, `DEFAULT_COMMISSION_RATE_BP`,
 * `FINANCIAL_COMMISSION_RATE_BP` and `LedgerService.recordPayment` are
 * removed (code, `.env.example`, test factory, specs); a repository scan
 * with a planted-literal self-test proves no commission constant, env key,
 * default or seed survives."*
 *
 * Modelled directly on `services/commercial-policy/src/catalogue/no-hardcoded-allowance.spec.ts`
 * -- same reasoning, same shape: comments and string literals are stripped
 * before scanning (a docblock explaining WHY the rate was removed, this
 * file's own quotation of the decision, and `LEGACY_BASIS`'s comment
 * mentioning `FinancialConfig` by name for historical context, are
 * documentation, not code), and every rule is proved non-vacuous by a
 * planted fixture and a control case below.
 */

const WORKSPACE_ROOT = resolve(__dirname, '../../..');

/** Never legitimately reachable again -- `FinancialConfig` is deleted, not merely unused. */
const REMOVED_IDENTIFIERS = ['FinancialConfig', 'DEFAULT_COMMISSION_RATE_BP', 'FINANCIAL_COMMISSION_RATE_BP'];

/** Property/variable names whose VALUE would be a commission rate. */
const COMMISSION_RATE_IDENTIFIER = /(commissionratebp|commission_rate_bp|defaultcommissionrate)/i;

export interface CommissionFinding {
  readonly file: string;
  readonly rule: string;
  readonly detail: string;
}

/** Removes `//` and block comments, then string and template literals -- identical to `stripTypeScriptNoise` in the allowance scanner, copied rather than imported so this check does not depend on `commercial-policy` (ADR-011 module boundaries). */
export function stripTypeScriptNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

export function stripSqlNoise(source: string): string {
  return source.replace(/--[^\n]*/g, ' ');
}

/** Removes only `//` and block comments -- STRINGS are kept, unlike `stripTypeScriptNoise`. `FINANCIAL_COMMISSION_RATE_BP` is realistically reintroduced as a quoted `config.get('...')` argument, not a bare identifier, so Rule A must see inside string literals to catch the case that actually matters. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** RULE A -- none of the removed identifiers appears anywhere in code, INCLUDING inside a string (comments only are stripped first). */
export function findRemovedIdentifierUsage(file: string, source: string): CommissionFinding[] {
  const cleaned = stripComments(source);
  return REMOVED_IDENTIFIERS.filter((name) => new RegExp(`\\b${name}\\b`).test(cleaned)).map((name) => ({
    file,
    rule: 'removed-identifier',
    detail: `${name} still appears in code (not a comment)`,
  }));
}

/**
 * RULE B -- no numeric literal is assigned or defaulted to a commission-rate-
 * shaped identifier. Matches `name: 1500`, `name = 1500`, `name ?? 1500`,
 * `name || 1500` and a typed default parameter. Does NOT match `commissionRateBp:
 * rateBp` (the RHS is a variable, never a digit) -- which is how every
 * legitimate use in `LedgerService`/`FundJournalService` reads today: the
 * rate is always a value read off a specific row or computed, never a
 * literal.
 */
export function findCommissionRateLiterals(file: string, source: string): CommissionFinding[] {
  const findings: CommissionFinding[] = [];
  const cleaned = stripTypeScriptNoise(source);
  const assignment =
    /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\??\s*:\s*[A-Za-z0-9_$<>[\]| ]*)?\s*(?:[:=]|\?\?|\|\|)\s*(\d[\d_]*)(?![\d_.eE])/g;

  for (const match of cleaned.matchAll(assignment)) {
    const [, identifier, literal] = match;
    if (!COMMISSION_RATE_IDENTIFIER.test(identifier)) continue;
    if (Number(literal.replace(/_/g, '')) === 0) continue; // zero is the absence of a rate, not a choice of one (`zero` is a policy VALUE, not a code literal, per R1)
    findings.push({ file, rule: 'commission-rate-literal', detail: `${identifier} is assigned ${literal}` });
  }
  return findings;
}

/** RULE C -- no financial migration puts a non-zero DEFAULT on a commission-rate column. */
export function findCommissionRateColumnDefaults(file: string, sql: string): CommissionFinding[] {
  const findings: CommissionFinding[] = [];
  for (const line of stripSqlNoise(sql).split(/\r?\n/)) {
    const lowered = line.toLowerCase();
    if (!lowered.includes('commission_rate_bp')) continue;
    if (!/\bdefault\s+(?!0\b)\d/.test(lowered)) continue;
    findings.push({ file, rule: 'commission-rate-column-default', detail: line.trim() });
  }
  return findings;
}

function readProductionSources(...directories: string[]): Array<{ file: string; source: string }> {
  const collected: Array<{ file: string; source: string }> = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      // A spec plants forbidden values on purpose; scanning it would make
      // this check fire on its own fixtures.
      if (entry.name.endsWith('.spec.ts')) continue;
      collected.push({ file: path.slice(WORKSPACE_ROOT.length + 1), source: readFileSync(path, 'utf8') });
    }
  };

  for (const directory of directories) walk(resolve(WORKSPACE_ROOT, directory));
  return collected;
}

function readFinancialMigrations(): Array<{ file: string; source: string }> {
  const directory = resolve(WORKSPACE_ROOT, 'database/migrations/financial');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ file: `database/migrations/financial/${name}`, source: readFileSync(join(directory, name), 'utf8') }));
}

describe('no hard-coded commission rate exists anywhere in the codebase (#43a, ADR-052 §16)', () => {
  const sources = readProductionSources('services/financial/src', 'apps/api/src', 'libs/event-contracts/src', 'libs/money/src');
  const migrations = readFinancialMigrations();
  const envExample = readFileSync(resolve(WORKSPACE_ROOT, 'apps/api/.env.example'), 'utf8');
  const hermeticEnvSource = readFileSync(resolve(WORKSPACE_ROOT, 'apps/api/test/pg-test-app.factory.ts'), 'utf8');

  it('reads real files, so an empty finding list means something', () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining([expect.stringContaining('ledger.service.ts')]));
  });

  it('FinancialConfig no longer EXISTS as a file', () => {
    expect(existsSync(resolve(WORKSPACE_ROOT, 'services/financial/src/financial.config.ts'))).toBe(false);
    expect(existsSync(resolve(WORKSPACE_ROOT, 'services/financial/src/financial.config.spec.ts'))).toBe(false);
  });

  it('none of FinancialConfig / DEFAULT_COMMISSION_RATE_BP / FINANCIAL_COMMISSION_RATE_BP appears in any production source', () => {
    const findings = sources.flatMap(({ file, source }) => findRemovedIdentifierUsage(file, source));
    expect(findings).toEqual([]);
  });

  it('assigns no non-zero numeric literal to any commission-rate-shaped identifier', () => {
    const findings = sources.flatMap(({ file, source }) => findCommissionRateLiterals(file, source));
    expect(findings).toEqual([]);
  });

  it('puts no non-zero DEFAULT on a commission_rate_bp column in any financial migration', () => {
    const findings = migrations.flatMap(({ file, source }) => findCommissionRateColumnDefaults(file, source));
    expect(findings).toEqual([]);
  });

  it('.env.example carries no FINANCIAL_COMMISSION_RATE_BP key', () => {
    expect(envExample).not.toMatch(/FINANCIAL_COMMISSION_RATE_BP/);
  });

  it('the real-Postgres test factory seeds no FINANCIAL_COMMISSION_RATE_BP into the hermetic environment', () => {
    // The identifier may appear in a COMMENT explaining its absence (this
    // file does exactly that); it must never appear as an assigned env key.
    expect(hermeticEnvSource).not.toMatch(/FINANCIAL_COMMISSION_RATE_BP\s*:\s*['"]/);
  });

  // ---------------------------------------------------------------------
  // Non-vacuity: planted positives, and controls that must NOT fire
  // ---------------------------------------------------------------------

  describe('the scanner is not vacuous -- planted positives', () => {
    it.each([
      ['a removed class name', 'export class FinancialConfig {}', findRemovedIdentifierUsage],
      ['a removed constant name', 'const DEFAULT_COMMISSION_RATE_BP = 1500;', findRemovedIdentifierUsage],
      ['a removed env key literal', "config.get('FINANCIAL_COMMISSION_RATE_BP')", findRemovedIdentifierUsage],
      ['a module constant', 'const commissionRateBp = 1500;', findCommissionRateLiterals],
      ['an object property', 'const x = { commissionRateBp: 1500 };', findCommissionRateLiterals],
      ['a nullish-coalesced default', 'const rate = input.commissionRateBp ?? 1500;', findCommissionRateLiterals],
      ['a typed default parameter', 'function f(commissionRateBp: number = 1500) {}', findCommissionRateLiterals],
    ])('catches: %s', (_label, snippet, scanner) => {
      expect((scanner as (file: string, source: string) => CommissionFinding[])('planted.ts', snippet)).not.toEqual([]);
    });

    it('catches a non-zero DEFAULT on a commission_rate_bp column', () => {
      expect(
        findCommissionRateColumnDefaults('planted.sql', 'commission_rate_bp INT NOT NULL DEFAULT 1500,'),
      ).not.toEqual([]);
    });
  });

  describe('the scanner does not cry wolf -- controls', () => {
    it('does not flag a rate read off a specific row (the real, legitimate shape everywhere in this codebase)', () => {
      expect(findCommissionRateLiterals('control.ts', 'const rateBp = originalCommission.commissionRateBp;')).toEqual([]);
      expect(findCommissionRateLiterals('control.ts', 'commissionRateBp: rateBp,')).toEqual([]);
    });

    it('does not flag a comment that merely explains the removal', () => {
      const prose = '// FinancialConfig and FINANCIAL_COMMISSION_RATE_BP were removed by #43a';
      expect(findRemovedIdentifierUsage('control.ts', prose)).toEqual([]);
    });

    it('does not flag zero -- the explicit, owner-endorsed published value (R1), not a code default', () => {
      expect(findCommissionRateLiterals('control.ts', 'const commissionRateBp = 0;')).toEqual([]);
    });

    it('does not flag an unrelated identifier that merely contains a similar substring', () => {
      expect(findCommissionRateLiterals('control.ts', 'const basisPointsDenominator = 10000;')).toEqual([]);
    });

    it('does not flag a zero DEFAULT on the column', () => {
      expect(findCommissionRateColumnDefaults('control.sql', 'commission_rate_bp INT NOT NULL DEFAULT 0,')).toEqual([]);
    });
  });
});
