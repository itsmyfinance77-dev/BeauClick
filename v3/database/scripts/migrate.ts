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

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const schemaDirs = readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    let appliedCount = 0;
    let skippedCount = 0;

    for (const schemaDir of schemaDirs) {
      const files = readdirSync(join(MIGRATIONS_ROOT, schemaDir))
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const key = `${schemaDir}/${file}`;
        const already = await client.query('SELECT 1 FROM public.schema_migrations WHERE filename = $1', [key]);

        if (already.rowCount && already.rowCount > 0) {
          console.log(`SKIP  (already applied): ${key}`);
          skippedCount += 1;
          continue;
        }

        const sql = readFileSync(join(MIGRATIONS_ROOT, schemaDir, file), 'utf-8');
        console.log(`APPLY: ${key}`);

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [key]);
          await client.query('COMMIT');
          appliedCount += 1;
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration failed, rolled back: ${key}\n${(err as Error).message}`);
        }
      }
    }

    console.log(`\nDone. Applied: ${appliedCount}, skipped (already applied): ${skippedCount}.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
