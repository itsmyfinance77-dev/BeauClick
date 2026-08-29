/**
 * A restore rehearsal against a DISPOSABLE, NON-PRODUCTION database.
 *
 * ## Read this before quoting a green run anywhere
 *
 * **This is not the restore drill.** `V3_INFRASTRUCTURE_PLAN.md` §9 requires a
 * real backup restored into a clean target and the restored system verified,
 * before real user-facing data exists in production. That drill needs a
 * production host, and no host has been selected (`HOSTING`). It stays open.
 *
 * What this proves is the MECHANISM: that the backup command produces a dump
 * this codebase can restore, that the restore lands the same rows, and -- the
 * part that actually justifies running it -- that the restored database still
 * refuses the writes the original refused.
 *
 * That last check is the reason this exists rather than a shell one-liner. The
 * ledger's append-only guarantee is a ROLE CONTRACT, not a column constraint
 * (ADR-009 / ADR-017). A restore that returns every row and drops the grants
 * produces a database where `beauclick_financial_writer` can UPDATE ledger
 * entries -- and every row count matches, every query works, and every smoke
 * test passes. The failure is invisible to anything that only counts rows, and
 * it is exactly the failure V2's `GAP-01` describes, arriving through a
 * restore instead of through a missing grant.
 *
 * So the rehearsal ends by running the full role contract against the RESTORED
 * database, as the ordinary application role.
 *
 * Usage:
 *   REHEARSAL_ADMIN_URL=postgres://postgres:...@host:5432/postgres \
 *   REHEARSAL_SOURCE_URL=postgres://postgres:...@host:5432/beauclick_v3_dev \
 *   REHEARSAL_APP_URL=postgres://beauclick_app:...@host:5432/beauclick_v3_dev \
 *   pnpm restore:rehearse
 *
 * `REHEARSAL_ADMIN_URL` needs CREATEDB. The rehearsal database is created and
 * dropped by this script and must never be one anybody cares about; the name
 * is fixed rather than configurable so it cannot be pointed somewhere real.
 */
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from 'pg';

import {
  appliedMigrations,
  backup,
  compareInventory,
  databaseNameOf,
  defaultBackupPath,
  dropDatabase,
  inventory,
  restore,
  verifyManifest,
} from './backup-restore';
import { formatChecks, verifyRoleContract } from './role-contract';

/**
 * Fixed, and deliberately not configurable.
 *
 * This script DROPS this database twice -- once before restoring, to make the
 * run repeatable, and once after. An environment variable here would be one
 * typo away from dropping something real, and the convenience it buys is
 * nothing.
 */
const REHEARSAL_DATABASE = 'beauclick_restore_rehearsal';

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. See the usage note in restore-rehearsal.ts.`);
  return value;
}

async function main(): Promise<void> {
  const adminUrl = required('REHEARSAL_ADMIN_URL');
  const sourceUrl = required('REHEARSAL_SOURCE_URL');
  // Optional: without it the role contract is not re-checked, and the run says
  // so rather than quietly reporting a weaker rehearsal as a complete one.
  const appUrl = process.env.REHEARSAL_APP_URL ?? null;

  if (databaseNameOf(sourceUrl) === REHEARSAL_DATABASE) {
    throw new Error(`REHEARSAL_SOURCE_URL points at ${REHEARSAL_DATABASE}, which this script drops.`);
  }

  const createdAt = new Date().toISOString();
  const workingDirectory = join(tmpdir(), 'beauclick-restore-rehearsal');
  const dumpFile = defaultBackupPath(workingDirectory, createdAt);
  const failures: string[] = [];

  const log = (message: string): void => {
    // eslint-disable-next-line no-console
    console.log(message);
  };

  try {
    log(`Backing up ${databaseNameOf(sourceUrl)} …`);
    const manifest = await backup({ sourceUrl, outFile: dumpFile, createdAt });
    log(`  ${manifest.bytes} bytes, ${manifest.migrations.length} migrations applied, PostgreSQL ${manifest.serverVersion}`);

    // Checked before restoring, not after: a truncated dump restores a partial
    // database perfectly happily, and a silent partial restore is worse than a
    // failed one.
    const integrity = await verifyManifest(dumpFile);
    if (!integrity.ok) throw new Error(`Dump integrity check failed: ${integrity.detail}`);
    log('  Dump matches its manifest (sha256, byte length).');

    log(`Restoring into the disposable database ${REHEARSAL_DATABASE} …`);
    await dropDatabase(adminUrl, REHEARSAL_DATABASE);
    await restore({ dumpFile, adminUrl, targetDatabase: REHEARSAL_DATABASE });

    const restoredAdminUrl = withDatabase(adminUrl, REHEARSAL_DATABASE);
    const restored = new Client({ connectionString: restoredAdminUrl });
    await restored.connect();
    try {
      const restoredInventory = await inventory(restored);
      const differences = compareInventory(manifest.inventory, restoredInventory);
      if (differences.length > 0) {
        failures.push(
          `Row counts differ after restore:\n${differences
            .map((d) => `    ${d.table}: expected ${d.expected}, found ${d.actual ?? 'the table is missing'}`)
            .join('\n')}`,
        );
      } else {
        log(`  Row counts match across ${Object.keys(manifest.inventory).length} tables.`);
      }

      const restoredMigrations = await appliedMigrations(restored);
      if (restoredMigrations.join('|') !== manifest.migrations.join('|')) {
        failures.push(
          `Schema version differs after restore: ${manifest.migrations.length} migrations recorded, ${restoredMigrations.length} restored.`,
        );
      } else {
        log('  Schema version matches.');
      }
    } finally {
      await restored.end();
    }

    if (appUrl) {
      // The check this rehearsal exists for. See the file header.
      log('Re-checking the role contract against the RESTORED database …');
      const appOnRestored = new Client({ connectionString: withDatabase(appUrl, REHEARSAL_DATABASE) });
      await appOnRestored.connect();
      try {
        const checks = await verifyRoleContract(appOnRestored);
        const failed = checks.filter((c) => !c.passed);
        if (failed.length > 0) {
          failures.push(
            `The restored database does not satisfy the role contract:\n${formatChecks(checks)
              .split('\n')
              .filter((line) => line.includes('FAIL'))
              .join('\n')}`,
          );
        } else {
          log(`  ${checks.length}/${checks.length} role-contract checks pass on the restored database.`);
        }
      } finally {
        await appOnRestored.end();
      }
    } else {
      log('  REHEARSAL_APP_URL is unset, so the role contract was NOT re-checked on the restored database.');
      log('  That is the most important check here — see this file\'s header. Set it.');
    }
  } finally {
    // Both the disposable database and the dump are removed even on failure:
    // the dump is a copy of real data, and leaving copies of real data in a
    // temp directory is how a backup becomes an incident.
    await dropDatabase(adminUrl, REHEARSAL_DATABASE).catch(() => undefined);
    await rm(join(tmpdir(), 'beauclick-restore-rehearsal'), { recursive: true, force: true }).catch(() => undefined);
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      failures.length === 0 ? 'RESTORE REHEARSAL PASSED (non-production).' : 'RESTORE REHEARSAL FAILED.',
      ...failures.map((f) => `  ${f}`),
      '',
      'This is NOT the restore drill V3_INFRASTRUCTURE_PLAN.md §9 requires.',
      'It proves the mechanism against a disposable database. The drill requires a real',
      'backup of production data restored into a clean target on the real host, and it',
      'remains open pending the HOSTING decision.',
    ].join('\n'),
  );

  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
