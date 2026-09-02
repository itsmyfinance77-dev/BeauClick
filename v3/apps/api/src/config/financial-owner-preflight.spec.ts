import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { financialOwnerUrl, requireFinancialOwnerUrl, resetFinancial } from '../../test/pg-test-app.factory';

/**
 * The financial owner connection cannot be reached by accident.
 *
 * ## The defect this locks shut
 *
 * `financial-outbox-consumer.pg-spec.ts` gated itself on `requiredPgEnv()`,
 * which reads `TEST_DATABASE_URL` and `TEST_FINANCIAL_WRITER_URL` and knows
 * nothing about the OWNER connection the suite also needs. It then wrote
 * `resetFinancial(OWNER_URL as string)`, and that assertion is the whole
 * mechanism: it is the only reason the compiler did not object to a
 * `string | undefined` arriving where a `string` was declared.
 *
 * The consequence was not a clean failure. `pg` does not throw on an undefined
 * connection string -- it falls back to libpq's defaults (`localhost:5432`, a
 * database named after the OS user, a null password), so the suite's
 * `TRUNCATE financial.*` was aimed at whatever server holds the default port,
 * which on a machine running this project's own dev cluster on 5433 is a
 * different one. It failed only because that server demanded SCRAM.
 *
 * ## Why a repository check and not just the fix
 *
 * The fix is four lines across two suites, and four lines are exactly what gets
 * copied back. The sibling suite already showed how: `financial-integrity`
 * fixed its GATE months earlier and kept its CAST, so the unsafe line survived
 * in the file a reader would naturally copy from.
 *
 * So this asserts the property rather than the patch: no financial suite reads
 * the variable directly, none casts it, both gate on it, and `resetFinancial`
 * refuses an absent value regardless of who calls it.
 *
 * ## Where this file lives, and why that matters
 *
 * In `apps/api/src`, not `apps/api/test`. `apps/api/tsconfig.json` includes
 * `src/**` only, so `pnpm typecheck` never sees the pg-spec files -- their types
 * are checked by ts-jest, and only for suites a run actually loads. A check
 * placed beside the suites it guards would inherit that blind spot; here it runs
 * in the fast suite on every build.
 */

const TEST_DIR = resolve(__dirname, '../../test');

const FINANCIAL_SUITES = ['financial-outbox-consumer.pg-spec.ts', 'financial-integrity.pg-spec.ts'];

function read(name: string): string {
  return readFileSync(resolve(TEST_DIR, name), 'utf8');
}

/** Comments are stripped: the docblocks below deliberately quote the unsafe line. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');
}

describe('the financial owner credential cannot reach pg unproven', () => {
  it('reads the real suites, so the assertions below are about real files', () => {
    for (const name of FINANCIAL_SUITES) {
      const source = read(name);
      expect(source.length).toBeGreaterThan(1000);
      expect(source).toContain('resetFinancial');
    }
  });

  it.each(FINANCIAL_SUITES)('%s gates on the owner URL, not on requiredPgEnv alone', (name) => {
    const code = stripComments(read(name));
    // The gate must mention BOTH. `requiredPgEnv()` alone is the original bug.
    expect(code).toMatch(/const describeIfPg = requiredPgEnv\(\) && OWNER_URL \? describe : describe\.skip;/);
  });

  it.each(FINANCIAL_SUITES)('%s reads the variable through the helper rather than process.env', (name) => {
    const code = stripComments(read(name));
    expect(code).toContain('financialOwnerUrl()');
    // One reader, in the factory. A second one is how the two suites drifted
    // apart in the first place.
    expect(code).not.toContain('process.env.TEST_FINANCIAL_OWNER_URL');
  });

  it.each(FINANCIAL_SUITES)('%s asserts nothing about the owner URL on the way to resetFinancial', (name) => {
    const code = stripComments(read(name));
    expect(code).not.toMatch(/resetFinancial\(\s*[A-Za-z_$][\w$]*\s+as\s+string\s*\)/);
    expect(code).not.toMatch(/resetFinancial\(\s*[A-Za-z_$][\w$]*!\s*\)/);
    expect(code).toContain('resetFinancial(requireFinancialOwnerUrl())');
  });

  describe('the helpers themselves', () => {
    const original = process.env.TEST_FINANCIAL_OWNER_URL;

    afterEach(() => {
      if (original === undefined) delete process.env.TEST_FINANCIAL_OWNER_URL;
      else process.env.TEST_FINANCIAL_OWNER_URL = original;
    });

    it('report the credential as absent rather than as an empty string', () => {
      delete process.env.TEST_FINANCIAL_OWNER_URL;
      expect(financialOwnerUrl()).toBeNull();

      // An empty variable is absent too: `''` would sail through a truthiness
      // gate written as `!== undefined` and reach `pg` as a falsy connection
      // string, which is the same libqp fallback by another route.
      process.env.TEST_FINANCIAL_OWNER_URL = '';
      expect(financialOwnerUrl()).toBeNull();
    });

    it('refuse to produce a value when the credential is absent', () => {
      delete process.env.TEST_FINANCIAL_OWNER_URL;
      expect(() => requireFinancialOwnerUrl()).toThrow(/TEST_FINANCIAL_OWNER_URL is not set/);
    });

    it('return the configured value unchanged when it is present', () => {
      // Not a credential: a syntactically valid URL with no password, used only
      // to prove the helper passes its input through rather than rewriting it.
      process.env.TEST_FINANCIAL_OWNER_URL = 'postgres://owner@127.0.0.1:1/db';
      expect(financialOwnerUrl()).toBe('postgres://owner@127.0.0.1:1/db');
      expect(requireFinancialOwnerUrl()).toBe('postgres://owner@127.0.0.1:1/db');
    });
  });

  describe('resetFinancial refuses an absent URL before opening a connection', () => {
    /**
     * The guarantee requirement F asks for, proved by BEHAVIOUR rather than by
     * reading the source: whatever a future caller passes, `undefined` and `''`
     * do not become a connection.
     *
     * The assertion is on the message, not merely on "it threw": a throw from
     * inside `pg` would also satisfy `.rejects`, and that is the failure this
     * exists to distinguish itself from.
     */
    it.each([
      ['undefined', undefined],
      ['an empty string', ''],
    ])('refuses %s', async (_label, value) => {
      await expect(resetFinancial(value as unknown as string)).rejects.toThrow(
        /resetFinancial requires the financial owner connection/,
      );
    });

    it('does not reach the driver, so nothing is truncated anywhere', async () => {
      // If the guard were removed, `pg` would connect to the DEFAULT port with a
      // null password and attempt the TRUNCATE. Proving the rejection is not a
      // pg error is what separates "refused" from "failed to connect".
      await expect(resetFinancial(undefined as unknown as string)).rejects.not.toThrow(/SASL|SCRAM|ECONNREFUSED/);
    });
  });
});
