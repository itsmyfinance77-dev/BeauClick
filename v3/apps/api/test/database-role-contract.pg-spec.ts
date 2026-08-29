import { spawn } from 'child_process';
import { resolve } from 'path';

import { requiredPgEnv } from './pg-test-app.factory';

/**
 * The role-verification COMMAND, run by CI exactly as an operator will run it
 * against the real host (`HOSTING_GRANTS`, `PHASE4-03`).
 *
 * ## Why this shells out instead of importing the checks
 *
 * Two reasons, and the second is the one that matters.
 *
 * `database/scripts` is not an Nx project, and importing it from here by
 * relative path is what `@nx/enforce-module-boundaries` exists to refuse
 * (ADR-011). Suppressing that to reach a script would be trading a real
 * architectural rule for convenience.
 *
 * More importantly: what needs verifying is **the command**, not the function
 * inside it. The plumbing is where this actually broke during development --
 * this workspace has no root `tsconfig.json`, so ts-node chose ES-module
 * output, and the script failed at `ERR_MODULE_NOT_FOUND` on its own sibling
 * import while every function it contained was perfectly correct. A test that
 * imported `verifyRoleContract` directly would have passed throughout. The one
 * day this command matters is the day it is pointed at a production host by
 * someone who cannot iterate on it, so the thing under test is the whole
 * command: entry point, module resolution, connection, output, exit code.
 *
 * ## What a green run here does NOT mean
 *
 * **`HOSTING_GRANTS` stays open.** It asks for the contract proven on the real
 * target host, and no host has been selected -- CI's container is a container.
 * What this closes is the "one script, one afternoon" half: the afternoon is
 * now one command, and the command is exercised on every build.
 */
interface RoleCheckResult {
  id: string;
  description: string;
  passed: boolean;
  detail: string | null;
}

const env = requiredPgEnv();
const describeIfPg = env ? describe : describe.skip;

/** The v3 workspace root, which is where the script's tsconfig and paths resolve from. */
const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..');

function runVerifyRoles(
  databaseUrl: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        // ts-node's own CLI, resolved rather than assumed to be on PATH --
        // `npx` would need a shell, and a shell would need quoting rules that
        // differ between the CI runner and a developer's Windows machine.
        require.resolve('ts-node/dist/bin.js'),
        '--project',
        'database/scripts/tsconfig.json',
        'database/scripts/verify-roles.ts',
        '--json',
      ],
      {
        cwd: WORKSPACE_ROOT,
        env: { ...process.env, DATABASE_URL: databaseUrl, ...extraEnv },
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describeIfPg('database/scripts/verify-roles.ts against real PostgreSQL', () => {
  let checks: RoleCheckResult[];
  let exitCode: number;

  beforeAll(async () => {
    // Run with the ORDINARY APPLICATION ROLE, deliberately. A managed provider
    // may never hand out a superuser, so a verification script that needs one
    // is a script that cannot be run where it is needed. It also exercises the
    // reason every check addresses tables by OID rather than by name: the name
    // form needs schema USAGE from the caller, which this role does not have
    // on `financial` -- which is the contract.
    const result = await runVerifyRoles(env!.database);
    exitCode = result.code;
    if (!result.stdout.trim()) {
      throw new Error(`verify-roles.ts produced no output. stderr:\n${result.stderr}`);
    }
    checks = (JSON.parse(result.stdout) as { checks: RoleCheckResult[] }).checks;
  }, 60_000);

  it('runs as the application role, with no superuser and no shell', () => {
    expect(checks.length).toBeGreaterThan(20);
  });

  it('exits zero and passes every check on a correctly provisioned database', () => {
    const failed = checks.filter((c) => !c.passed);
    // The failing checks in the message, not just a count: this output is what
    // an operator will read on a host nobody can attach a debugger to.
    expect(failed.map((c) => `${c.id}: ${c.detail ?? 'failed'}`)).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it('asserts the ledger is append-only for the writer role', () => {
    // The specific checks GAP-01 is about. Named individually so a
    // reorganisation of the script cannot quietly drop them while still
    // passing the blanket assertion above.
    for (const id of [
      'ledger.writer.insert',
      'ledger.writer.select',
      'ledger.writer.no_update',
      'ledger.writer.no_delete',
      'ledger.writer.no_truncate',
    ]) {
      expect(checks.find((c) => c.id === id)).toEqual(expect.objectContaining({ id, passed: true }));
    }
  });

  it('asserts the application role cannot reach the ledger at all', () => {
    // What makes the second DataSource (ADR-017) a boundary rather than a
    // convention: if the shared pool could read the ledger, isolating the
    // writer would decorate nothing.
    for (const id of [
      'ledger.app.no_select',
      'ledger.app.no_insert',
      'ledger.app.no_update',
      'schema.financial.app_no_usage',
    ]) {
      expect(checks.find((c) => c.id === id)).toEqual(expect.objectContaining({ id, passed: true }));
    }
  });

  it('asserts the audit log is append-only for the application role', () => {
    const auditChecks = checks.filter((c) => c.id.startsWith('audit.'));
    expect(auditChecks.length).toBeGreaterThan(0);
    expect(auditChecks.filter((c) => !c.passed)).toEqual([]);
    // An owner can always grant itself back UPDATE, so the application must
    // not be able to own anything in this schema either.
    expect(checks.find((c) => c.id === 'schema.admin.app_no_create')).toEqual(expect.objectContaining({ passed: true }));
  });

  it('asserts PHASE4-03: the application role may create in the public schema', () => {
    // PostgreSQL 15+ stopped granting this to PUBLIC, and database-level ALL
    // does not include it. Without it `migrate.ts` cannot create
    // `public.schema_migrations`, and the FIRST migration on a fresh host
    // fails -- which is exactly what happened the first time CI got far enough
    // to reach it.
    expect(checks.find((c) => c.id === 'schema.public.app_create')).toEqual(expect.objectContaining({ passed: true }));
  });

  it('gives every check a stable, unique id and a real description, so a failure is citable', () => {
    for (const check of checks) {
      expect(check.id).toMatch(/^[a-z][a-z0-9_.]*$/);
      expect(check.description.length).toBeGreaterThan(10);
    }
    const ids = checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves the detail null for anything that passed', () => {
    expect(checks.filter((c) => c.passed && c.detail !== null)).toEqual([]);
  });

  it('reports a NON-ZERO exit code when the contract is not satisfied', async () => {
    // Without this the script is decorative: a deployment gate that always
    // exits zero gates nothing.
    //
    // The negative case is produced by telling the script that the FINANCIAL
    // WRITER is the application role. Every query still runs -- so this
    // exercises the failure path rather than an error path -- and the checks
    // that must fail do: that role can read the ledger and holds USAGE on the
    // financial schema, which is exactly what the application role must not.
    // No fixture, no privileged setup, and it doubles as proof that the
    // application-role assertions are not vacuously true.
    const result = await runVerifyRoles(env!.database, { VERIFY_APP_ROLE: 'beauclick_financial_writer' });

    expect(result.stdout.trim()).not.toBe('');
    const checked = (JSON.parse(result.stdout) as { checks: RoleCheckResult[] }).checks;
    const failed = checked.filter((c) => !c.passed).map((c) => c.id);

    expect(failed).toContain('ledger.app.no_select');
    expect(failed).toContain('schema.financial.app_no_usage');
    expect(result.code).not.toBe(0);
  }, 60_000);

  it('exits non-zero, with a message, when it cannot reach the database at all', async () => {
    // Distinct from a failed check, and it must not be silently zero either:
    // a gate that treats "could not connect" as success is worse than no gate.
    const unreachable = env!.database.replace(/@([^/]+)\//, '@127.0.0.1:1/');
    const result = await runVerifyRoles(unreachable);
    expect(result.code).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
  }, 60_000);
});
