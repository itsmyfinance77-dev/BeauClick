/**
 * Verifies the PostgreSQL role contract against whatever host it is pointed at.
 *
 * The assertions live in `role-contract.ts`; this is the command line around
 * them, so the suite can import the checks without a CLI running as a side
 * effect of the import.
 *
 * Usage:
 *   DATABASE_URL=postgres://... ts-node database/scripts/verify-roles.ts
 *   DATABASE_URL=postgres://... ts-node database/scripts/verify-roles.ts --json
 *
 * Exits non-zero on any failed check, so it is usable as a deployment gate.
 *
 * Deliberately no `require.main === module` guard: this workspace has no
 * `"type"` field, so ts-node may load a script as CommonJS or as ESM depending
 * on its contents, and `require` is undefined in the ESM case. `migrate.ts`
 * records the same constraint. Keeping the entry point in its own file makes
 * the guard unnecessary rather than fragile.
 */
import { Client } from 'pg';

import { formatChecks, verifyRoleContract } from './role-contract';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const checks = await verifyRoleContract(client);
    const asJson = process.argv.includes('--json');
    // eslint-disable-next-line no-console
    console.log(asJson ? JSON.stringify({ checks }, null, 2) : formatChecks(checks));
    if (checks.some((c) => !c.passed)) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
