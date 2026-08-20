/**
 * Minimal, real SQL migration runner -- V3_DATABASE_BLUEPRINT.md §3 mandates
 * real migrations with a version-tracking table per schema; Phase 1's
 * automated tests used TypeORM's `synchronize: true` for dev/test
 * convenience only (explicitly flagged as not the real deployment
 * mechanism). This script is that real mechanism: applies the actual .sql
 * files under database/migrations/{schema}/ in filename order, tracks what
 * has already run in a `public.schema_migrations` table, and is safe to
 * re-run -- an already-applied file is skipped, not re-executed.
 *
 * Usage: DATABASE_URL=postgres://user:pass@host:port/db ts-node database/scripts/migrate.ts
 */
import { Client } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Resolved relative to process.cwd() rather than __dirname/import.meta.url --
// this script is invoked from the v3 workspace root (see the npm script in
// package.json), and avoiding both Node-module-system-specific globals
// keeps it runnable under ts-node regardless of which module mode it picks.
const MIGRATIONS_ROOT = join(process.cwd(), 'database', 'migrations');

/**
 * Per-schema connection override.
 *
 * V3_DATABASE_BLUEPRINT.md §3 mandates per-schema ownership: "only the module
 * that owns a schema may author migrations against it". For most schemas the
 * default application role is the owner and this is a formality. For
 * `financial` it is load-bearing: those tables must be owned by
 * `beauclick_financial_owner`, NOT by the application role -- an owner can
 * always grant itself UPDATE, so if the application role owned the ledger the
 * append-only guarantee would be one statement away from being revoked
 * (ADR-009 / ADR-017).
 *
 * Set MIGRATION_URL_FINANCIAL to the owner role's connection string. Falls
 * back to DATABASE_URL when unset.
 */
function connectionUrlFor(schemaDir: string, fallback: string): string {
  const override = process.env[`MIGRATION_URL_${schemaDir.toUpperCase()}`];
  return override && override.length > 0 ? override : fallback;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  // One reusable client per distinct connection string, so a run that
  // touches several schemas does not open a fresh connection per file.
  const clientsByUrl = new Map<string, Client>([[databaseUrl, client]]);
  async function clientFor(url: string): Promise<Client> {
    let existing = clientsByUrl.get(url);
    if (!existing) {
      existing = new Client({ connectionString: url });
      await existing.connect();
      clientsByUrl.set(url, existing);
    }
    return existing;
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const schemaDirs = readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    // Ordered by each migration file's own timestamp prefix ACROSS schemas,
    // not schema-directory-first.
    //
    // The original version iterated directories alphabetically and only
    // sorted within each one, so adding a `booking/` schema in Phase 2 would
    // have applied every booking migration before every identity migration
    // purely because 'b' < 'i' -- silently reordering the deployment history
    // the timestamp prefixes exist to define. Harmless today (there are no
    // cross-schema FKs, by convention), but it is a latent ordering bug that
    // would first surface the moment two schemas genuinely depend on each
    // other, which is the worst possible time to find it.
    const pending = schemaDirs
      .flatMap((schemaDir) =>
        readdirSync(join(MIGRATIONS_ROOT, schemaDir))
          .filter((f) => f.endsWith('.sql'))
          .map((file) => ({ schemaDir, file, key: `${schemaDir}/${file}` })),
      )
      .sort((a, b) => (a.file === b.file ? a.schemaDir.localeCompare(b.schemaDir) : a.file.localeCompare(b.file)));

    let appliedCount = 0;
    let skippedCount = 0;

    for (const { schemaDir, file, key } of pending) {
      const already = await client.query('SELECT 1 FROM public.schema_migrations WHERE filename = $1', [key]);

      if (already.rowCount && already.rowCount > 0) {
        console.log(`SKIP  (already applied): ${key}`);
        skippedCount += 1;
        continue;
      }

      const url = connectionUrlFor(schemaDir, databaseUrl);
      const runner = await clientFor(url);
      const sql = readFileSync(join(MIGRATIONS_ROOT, schemaDir, file), 'utf-8');
      console.log(`APPLY: ${key}${url === databaseUrl ? '' : ` (as ${maskUser(url)})`}`);

      // DDL and its bookkeeping row commit together on the SAME connection.
      // Recording the migration through the default client instead would
      // leave a window where a crash means the schema changed but nothing
      // says so -- and the re-run then fails on "already exists".
      await runner.query('BEGIN');
      try {
        await runner.query(sql);
        await runner.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [key]);
        await runner.query('COMMIT');
        appliedCount += 1;
      } catch (err) {
        await runner.query('ROLLBACK');
        throw new Error(`Migration failed, rolled back: ${key}
${(err as Error).message}`);
      }
    }

    console.log(`\nDone. Applied: ${appliedCount}, skipped (already applied): ${skippedCount}.`);
  } finally {
    for (const open of clientsByUrl.values()) {
      await open.end().catch(() => undefined);
    }
  }
}

/** Username only -- never echo a password into a deploy log. */
function maskUser(url: string): string {
  try {
    return new URL(url).username || 'unknown';
  } catch {
    return 'unknown';
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
