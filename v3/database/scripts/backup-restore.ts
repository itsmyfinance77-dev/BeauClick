/**
 * Backup and restore, as commands rather than a procedure (`OPS-02`).
 *
 * `V3_INFRASTRUCTURE_PLAN.md` §9 is unusually blunt about what counts:
 *
 *   > **a backup that has never been restored is not a verified backup**
 *
 * V2 had zero backup tooling of any kind, confirmed by direct inspection. V3
 * has had none either -- the plan describes daily snapshots and a written,
 * TESTED restore runbook, and neither the snapshot nor the runbook existed as
 * anything runnable.
 *
 * This is the runnable half. What it deliberately is NOT:
 *
 *  - **not a schedule.** Daily snapshots and WAL archiving are a property of
 *    the managed provider, and no provider has been selected (`HOSTING`).
 *    Choosing one here would be inventing a hosting decision.
 *  - **not the restore DRILL.** `restore-rehearsal.ts` runs this whole loop
 *    against a disposable database and proves the MECHANISM. The drill the
 *    plan requires is a real backup of real production data restored into a
 *    clean target and verified, and it cannot be performed before a host
 *    exists. The rehearsal says so in its own output rather than leaving a
 *    green check to imply otherwise.
 *
 * ## What makes the rehearsal worth running at all
 *
 * A restore that produces the rows and none of the GRANTS is not a restore of
 * this system. The ledger's append-only guarantee is a role contract
 * (ADR-009 / ADR-017), so a restored database where `beauclick_financial_writer`
 * has regained UPDATE is a database where the guarantee silently no longer
 * holds -- and every row would still be present, every count would still
 * match, and every smoke test would still pass.
 *
 * So the rehearsal re-runs the full role contract against the RESTORED
 * database. That is the object-storage rule in §9 -- "a restored file must not
 * become more publicly accessible than the original" -- applied to the
 * database, which is where this platform's actual security boundary lives.
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { Client } from 'pg';

/**
 * Everything a restore can drop while leaving every row count intact -- #314.
 *
 * Names rather than counts, because "seven constraints, seven constraints"
 * agrees while naming two different sets, and the whole question is whether
 * THIS constraint came back.
 *
 * Sequences carry their `last_value` as well as their name: a sequence that
 * restores at 1 instead of 40,000 exists, is named, and collides with an
 * existing primary key on the very next insert.
 */
export interface SchemaStructure {
  /** `schema.index_name`, sorted. */
  indexes: string[];
  /** `schema.table.constraint_name`, sorted. Primary, unique, foreign-key and check. */
  constraints: string[];
  /** `schema.view_name`, sorted. Ordinary and materialised. */
  views: string[];
  /** `schema.sequence_name` -> `last_value`, or -1 where the role may not read it. */
  sequences: Record<string, number>;
}

export interface BackupManifest {
  /** ISO-8601. Supplied by the caller so the value is explicit rather than ambient. */
  createdAt: string;
  /** The dump file, relative to the manifest. */
  file: string;
  bytes: number;
  sha256: string;
  /** `pg_dump --format=custom`. Recorded so a restore cannot guess wrong. */
  format: 'custom';
  serverVersion: string;
  /** Every migration filename applied at dump time -- the schema version, stated. */
  migrations: string[];
  /** `schema.table` -> row count, at dump time. What a restore is checked against. */
  inventory: Record<string, number>;
  /**
   * The schema objects a restore can lose WITHOUT moving a row -- #314.
   *
   * Row counts answer "did the data come back". They cannot answer "did the
   * rules come back": a failed `ADD CONSTRAINT`, `CREATE INDEX`, view or
   * sequence `setval` leaves every count identical. A database missing
   * `uq_orders_source` restores to a perfect inventory and permits two orders
   * for one booking.
   *
   * Optional because manifests written before #314 do not carry it. A restore
   * checked against one of those gets the old, weaker verdict and is told so,
   * rather than silently comparing against nothing.
   */
  structure?: SchemaStructure;
  /**
   * NEVER a connection string. A manifest sits next to a dump file, and both
   * end up in whatever storage the backups live in; a URL there hands out the
   * host, the role, and the password with the data.
   */
  source: { database: string };
}

/** Runs a command, failing loudly with its stderr. Never logs the environment it was given. */
async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (err) => reject(new Error(`${command} could not be started: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      // `pg_dump`'s stderr names the host and database but never the password
      // (libpq reads that from PGPASSWORD, which is never echoed).
      else reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/**
 * Splits a connection string into libpq environment variables.
 *
 * `pg_dump` accepts a URL directly, but passing one puts the password in the
 * process ARGUMENTS -- visible in `ps` output to every other process on the
 * host, and captured by any process listing a monitoring agent collects. The
 * environment is not a perfect hiding place either, but it is not world
 * readable on a modern kernel, and it is what libpq documents for this.
 */
export function libpqEnv(connectionString: string): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  const env: NodeJS.ProcessEnv = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGUSER: decodeURIComponent(url.username),
  };
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  return env;
}

export function databaseNameOf(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve());
  });
  return hash.digest('hex');
}

/**
 * Row counts per table, for every schema this platform owns.
 *
 * `COUNT(*)` rather than the planner's `reltuples` estimate: an estimate is
 * free and would make this check meaningless, since the whole question is
 * whether the exact rows came back.
 *
 * Tables the connecting role cannot read are recorded as `-1` rather than
 * skipped. That distinction matters: `financial.*` is unreadable by the
 * application role BY DESIGN, and a comparison that silently omitted it would
 * report a matching inventory for a restore that lost the entire ledger.
 */
export async function inventory(client: Client): Promise<Record<string, number>> {
  const { rows } = await client.query<{ schema: string; table: string }>(
    `SELECT n.nspname AS schema, c.relname AS "table"
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1, 2`,
  );

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.schema}.${row.table}`;
    try {
      const { rows: counted } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${row.schema}"."${row.table}"`,
      );
      counts[key] = Number(counted[0].count);
    } catch {
      counts[key] = -1;
    }
  }
  return counts;
}

/**
 * The schema objects `inventory()` is structurally unable to see -- #314.
 *
 * `inventory()` selects `relkind = 'r'` and counts rows, which is the right
 * question for "did the data come back" and no question at all about whether
 * the rules came back. A `pg_restore` that failed to create an index, add a
 * constraint, define a view or advance a sequence leaves every row count
 * identical, so the rehearsal used to print "Row counts match" and exit 0 over
 * a database that had lost its uniqueness guarantees.
 *
 * System schemas are excluded the same way `inventory()` excludes them, and
 * index/constraint names implied by a constraint appear in both lists -- which
 * is intended: losing a unique CONSTRAINT and losing the INDEX that enforces it
 * are different failures with the same consequence, and neither should be able
 * to hide inside the other's absence.
 */
export async function structure(client: Client): Promise<SchemaStructure> {
  const notSystem = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;

  const { rows: indexes } = await client.query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('i', 'I') AND ${notSystem}
      ORDER BY 1`,
  );

  const { rows: constraints } = await client.query<{ name: string }>(
    `SELECT n.nspname || '.' || t.relname || '.' || con.conname AS name
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE con.contype IN ('p', 'u', 'f', 'c') AND ${notSystem}
      ORDER BY 1`,
  );

  const { rows: views } = await client.query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v', 'm') AND ${notSystem}
      ORDER BY 1`,
  );

  const { rows: sequenceRows } = await client.query<{ schema: string; name: string }>(
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND ${notSystem}
      ORDER BY 1, 2`,
  );

  const sequences: Record<string, number> = {};
  for (const row of sequenceRows) {
    const key = `${row.schema}.${row.name}`;
    try {
      // `pg_sequences` rather than `SELECT last_value FROM <seq>`: the view
      // answers for a sequence the role may describe but not read, and reading
      // the relation directly requires SELECT on it. `last_value` is null
      // until the sequence has been used at least once, which is a real state
      // and not an error -- 0 says "never advanced", -1 says "could not tell".
      const { rows } = await client.query<{ last_value: string | null }>(
        `SELECT last_value FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`,
        [row.schema, row.name],
      );
      sequences[key] = rows[0]?.last_value == null ? 0 : Number(rows[0].last_value);
    } catch {
      sequences[key] = -1;
    }
  }

  return {
    indexes: indexes.map((r) => r.name),
    constraints: constraints.map((r) => r.name),
    views: views.map((r) => r.name),
    sequences,
  };
}

export async function appliedMigrations(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ filename: string }>(
    `SELECT filename FROM public.schema_migrations ORDER BY filename`,
  );
  return rows.map((r) => r.filename);
}

export interface BackupOptions {
  sourceUrl: string;
  /** Where the dump goes. The manifest is written beside it as `<outFile>.manifest.json`. */
  outFile: string;
  /** ISO-8601, supplied by the caller. */
  createdAt: string;
}

export async function backup(options: BackupOptions): Promise<BackupManifest> {
  const env = libpqEnv(options.sourceUrl);
  await mkdir(dirname(options.outFile), { recursive: true });

  const client = new Client({ connectionString: options.sourceUrl });
  await client.connect();
  let serverVersion: string;
  let migrations: string[];
  let counts: Record<string, number>;
  let schema: SchemaStructure;
  try {
    const { rows } = await client.query<{ version: string }>(`SELECT current_setting('server_version') AS version`);
    serverVersion = rows[0].version;
    migrations = await appliedMigrations(client);
    counts = await inventory(client);
    schema = await structure(client);
  } finally {
    await client.end();
  }

  await run(
    'pg_dump',
    [
      // Custom format: compressed, and restorable selectively. Also the only
      // format `pg_restore` reads, which is what makes the restore path
      // scriptable rather than a `psql <` that stops at the first error.
      '--format=custom',
      // Ownership and privileges are INCLUDED. That is pg_dump's default, and
      // it is stated here because it is the property this whole file exists to
      // preserve: a dump taken with `--no-owner --no-privileges` restores
      // every row and none of the security model, and every row count would
      // still match afterwards. See the file header.
      '--quote-all-identifiers',
      `--file=${options.outFile}`,
    ],
    env,
  );

  const { size } = await stat(options.outFile);
  const manifest: BackupManifest = {
    createdAt: options.createdAt,
    file: options.outFile,
    bytes: size,
    sha256: await sha256Of(options.outFile),
    format: 'custom',
    serverVersion,
    migrations,
    inventory: counts,
    structure: schema,
    source: { database: databaseNameOf(options.sourceUrl) },
  };

  await writeFile(`${options.outFile}.manifest.json`, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

export async function readManifest(dumpFile: string): Promise<BackupManifest> {
  return JSON.parse(await readFile(`${dumpFile}.manifest.json`, 'utf8')) as BackupManifest;
}

/**
 * Confirms the dump on disk is the one the manifest describes.
 *
 * Checked BEFORE a restore rather than after, because a truncated or partially
 * written dump restores a partial database perfectly happily -- `pg_restore`
 * reports success for whatever it managed to read. A silent partial restore is
 * strictly worse than a failed one.
 */
export async function verifyManifest(dumpFile: string): Promise<{ ok: boolean; detail: string | null }> {
  const manifest = await readManifest(dumpFile);
  const { size } = await stat(dumpFile);
  if (size !== manifest.bytes) return { ok: false, detail: `dump is ${size} bytes; the manifest records ${manifest.bytes}` };
  const digest = await sha256Of(dumpFile);
  if (digest !== manifest.sha256) return { ok: false, detail: 'sha256 does not match the manifest' };
  return { ok: true, detail: null };
}

export interface RestoreOutcome {
  /**
   * `pg_restore`'s own count from `errors ignored on restore: N`. Zero when it
   * exited cleanly. This is evidence, not a verdict -- see `restore`.
   */
  ignoredErrors: number;
  /** Whatever `pg_restore` said, empty on a clean run. Kept so a caller can report WHICH errors. */
  stderr: string;
}

export interface RestoreOptions {
  dumpFile: string;
  /** A connection with CREATEDB rights, pointed at any existing database (usually `postgres`). */
  adminUrl: string;
  /** The database to create and restore into. Must not already exist. */
  targetDatabase: string;
}

/**
 * Restores into a NEW database.
 *
 * It refuses to restore over an existing one, and that refusal is the most
 * important line in this file. A restore is the operation people reach for
 * when something has already gone wrong, under time pressure, and
 * `pg_restore --clean` into the wrong database destroys the data somebody was
 * about to recover. Creating the target makes "which database am I about to
 * overwrite" un-askable.
 *
 * Returns `pg_restore`'s own error accounting rather than deciding from it
 * (#314). Whether a restore with N ignored errors is acceptable is a policy
 * question, and the rehearsal is the caller entitled to answer it.
 */
export async function restore(options: RestoreOptions): Promise<RestoreOutcome> {
  const verification = await verifyManifest(options.dumpFile);
  if (!verification.ok) throw new Error(`Refusing to restore: ${verification.detail}`);

  const admin = new Client({ connectionString: options.adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [options.targetDatabase]);
    if (rows.length > 0) {
      throw new Error(
        `Database "${options.targetDatabase}" already exists. This restores into a NEW database only — drop the target deliberately, or choose another name.`,
      );
    }
    // Identifier interpolation, because CREATE DATABASE takes no parameters.
    // The name is validated rather than escaped: a database name is not user
    // input here, and a whitelist is easier to be sure of than quoting.
    assertSafeIdentifier(options.targetDatabase);
    await admin.query(`CREATE DATABASE "${options.targetDatabase}"`);
  } finally {
    await admin.end();
  }

  const env = { ...libpqEnv(options.adminUrl), PGDATABASE: options.targetDatabase };
  let ignoredErrors: number | null = 0;
  let stderr = '';
  await run(
    'pg_restore',
    [
      `--dbname=${options.targetDatabase}`,
      // Deliberately NOT `--exit-on-error`. Stopping at the first error would
      // abandon a restore halfway and leave a half-populated target, which is
      // worse than finishing and reporting. Finishing is only safe because the
      // caller now gets the error COUNT and a structural comparison; it was
      // not safe when the count was discarded.
      options.dumpFile,
    ],
    env,
  ).catch((err: Error) => {
    // #314. This used to be `if (!/warning|already exists/i.test(err.message))
    // throw err` -- and that pattern matched precisely the runs that FAILED.
    // `pg_restore` ends a run that hit errors with
    //
    //   pg_restore: warning: errors ignored on restore: 7
    //
    // so the guard rescued every message that announced errors, while a
    // genuinely clean restore prints no warning at all and never reaches this
    // catch. The test was inverted, not merely loose.
    //
    // The number in that line is pg_restore's own accounting, so it is what
    // decides now. Zero ignored errors is a pass. Anything else is reported
    // upward as a count, and the CALLER decides -- the rehearsal treats it as
    // a failure, which is what a rehearsal is for.
    ignoredErrors = ignoredErrorCount(err.message);
    stderr = err.message;
    if (ignoredErrors === null) throw err;
  });

  return { ignoredErrors: ignoredErrors ?? 0, stderr };
}

/**
 * The `errors ignored on restore: N` count from `pg_restore`'s stderr, or null
 * when the failure is not that shape at all -- a missing file, a refused
 * connection, a dump it cannot read. Those are not "the restore had errors",
 * they are "the restore did not happen", and they must keep throwing.
 */
export function ignoredErrorCount(stderr: string): number | null {
  const match = /errors ignored on restore:\s*(\d+)/i.exec(stderr);
  return match ? Number(match[1]) : null;
}

export function assertSafeIdentifier(name: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`"${name}" is not a safe PostgreSQL identifier (lower_snake_case, 63 characters maximum).`);
  }
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  assertSafeIdentifier(name);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

export interface InventoryDifference {
  table: string;
  expected: number;
  actual: number | undefined;
}

/**
 * Compares a restored database against the manifest.
 *
 * Tables recorded as `-1` (unreadable by the connecting role) must STILL be
 * `-1` afterwards. That is not a skipped comparison -- it is an assertion that
 * the restored database is still refusing the same reads, which is a grant
 * check wearing an inventory check's clothes.
 */
export function compareInventory(
  expected: Record<string, number>,
  actual: Record<string, number>,
): InventoryDifference[] {
  const differences: InventoryDifference[] = [];
  for (const [table, count] of Object.entries(expected)) {
    if (actual[table] !== count) differences.push({ table, expected: count, actual: actual[table] });
  }
  for (const table of Object.keys(actual)) {
    if (!(table in expected)) differences.push({ table, expected: 0, actual: actual[table] });
  }
  return differences;
}

export interface StructureDifference {
  kind: 'index' | 'constraint' | 'view' | 'sequence';
  name: string;
  detail: string;
}

/**
 * Compares the schema objects a row count cannot see -- #314.
 *
 * MISSING is the failure this exists for: an object the dump had and the
 * restore does not. EXTRA is reported too, because an object the restore
 * invented is a target that was not clean, and a rehearsal that restored over
 * something is not the rehearsal anyone thinks they ran.
 *
 * Sequences compare by VALUE as well as presence. A sequence restored at 1
 * instead of 40,000 is present, correctly named, and collides with an existing
 * primary key on the next insert.
 */
export function compareStructure(expected: SchemaStructure, actual: SchemaStructure): StructureDifference[] {
  const differences: StructureDifference[] = [];

  const lists: [StructureDifference['kind'], string[], string[]][] = [
    ['index', expected.indexes, actual.indexes],
    ['constraint', expected.constraints, actual.constraints],
    ['view', expected.views, actual.views],
  ];
  for (const [kind, before, after] of lists) {
    const have = new Set(after);
    const had = new Set(before);
    for (const name of before) if (!have.has(name)) differences.push({ kind, name, detail: 'missing after restore' });
    for (const name of after) if (!had.has(name)) differences.push({ kind, name, detail: 'present after restore but not in the dump' });
  }

  for (const [name, value] of Object.entries(expected.sequences)) {
    if (!(name in actual.sequences)) {
      differences.push({ kind: 'sequence', name, detail: 'missing after restore' });
    } else if (actual.sequences[name] !== value) {
      // Not folded into the presence check above: a sequence that exists at
      // the wrong position is the failure that looks like a success.
      differences.push({ kind: 'sequence', name, detail: `last_value ${value} before, ${actual.sequences[name]} after` });
    }
  }
  for (const name of Object.keys(actual.sequences)) {
    if (!(name in expected.sequences)) {
      differences.push({ kind: 'sequence', name, detail: 'present after restore but not in the dump' });
    }
  }

  return differences;
}

export function defaultBackupPath(root: string, createdAt: string): string {
  // Colons are illegal in a Windows filename and awkward everywhere else.
  return join(root, `beauclick-${createdAt.replace(/[:.]/g, '-')}.dump`);
}
