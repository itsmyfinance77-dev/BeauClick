#!/usr/bin/env node
// Guarded demo restore (also the pre-show "reset to golden"):
//   node demo/scripts/restore.mjs --backup <dir|latest-golden> --profile L --yes-restore-demo
//
// 1. restores the dump into a NEW database (beauclick_demo_restore_<n>) with the
//    product's own restore(), and verifies inventory + structure against the manifest;
// 2. re-applies the database-level grants provisioning made (pg_dump does not carry them);
// 3. stops the app, renames beauclick_demo -> beauclick_demo_prev_<n> (kept for
//    rollback) and the restored DB -> beauclick_demo, restores media + seed map;
// 4. starts the demo, verifies the role contract, and rebuilds the derived search
//    index through the administrator's real API (search is derived data).
// Touches nothing outside bcdemo-pg (127.0.0.1:55432) and the runtime root.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { BACKUPS_DIR, CONTAINERS, DB_NAME, MEDIA_DIR, PG_ROLES, PORTS, SECRETS_DIR, STATE_DIR, V3_ROOT, DEMO_ROOT } from './lib/demo-config.mjs';
import { appUrl, baseProcessEnv, loadSecrets, superuserUrl } from './lib/runtime.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
if (!process.argv.includes('--yes-restore-demo')) throw new Error('Refusing: pass --yes-restore-demo to confirm replacing the DEMO database.');
const profileKey = arg('--profile') ?? 'L';
let dir = arg('--backup');
if (!dir || dir === 'latest-golden') {
  // Labels like `golden`, `golden-a0`, `golden-b`; the folder name starts with the ISO timestamp, so sort = time.
  const golden = fs.readdirSync(BACKUPS_DIR).filter((d) => /-golden(-[a-z0-9]+)?$/i.test(d)).sort();
  if (!golden.length) throw new Error('no *-golden backup found');
  dir = path.join(BACKUPS_DIR, golden[golden.length - 1]);
}
dir = path.resolve(dir);
if (!dir.startsWith(path.resolve(BACKUPS_DIR))) throw new Error('Refusing: backups are restored only from the demo runtime root.');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'demo-backup.json'), 'utf8'));
const dump = manifest.db.file;
console.log(`restoring ${path.basename(dir)} (${manifest.createdAt}, source ${manifest.sourceSha.slice(0, 12)})`);

// Guard: the container really is the loopback demo cluster.
const binding = execFileSync('docker', ['port', CONTAINERS.pg, '5432/tcp'], { encoding: 'utf8' }).trim();
if (binding !== `127.0.0.1:${PORTS.pg}`) throw new Error(`Refusing: ${CONTAINERS.pg} is bound to "${binding}"`);

const s = loadSecrets();
const PSQL = 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
const psql = (sql, db = 'postgres') => {
  const r = spawnSync(PSQL, ['-v', 'ON_ERROR_STOP=1', '-q', '-X', '-tA', '-h', '127.0.0.1', '-p', String(PORTS.pg), '-U', 'postgres', '-d', db], {
    input: sql,
    env: { ...baseProcessEnv(), PGPASSWORD: s.postgresSuperuserPassword },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.split('\n')[0]}`);
  return r.stdout.trim();
};
const node = (script, args = []) => {
  const r = spawnSync(process.execPath, [path.join(DEMO_ROOT, 'scripts', script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${script} failed`);
};

// 1. Restore into a new database and verify.
const n = Date.now();
const target = `beauclick_demo_restore_${n}`;
const r = spawnSync(
  'pnpm',
  ['exec', 'ts-node', '--transpile-only', '--project', 'database/scripts/tsconfig.json', '../demo/scripts/db/backup-restore.run.ts', 'restore', `"${dump}"`, target],
  {
    cwd: V3_ROOT,
    env: { ...baseProcessEnv(), NODE_PATH: path.join(V3_ROOT, 'apps', 'api', 'node_modules'), PATH: `C:\\Program Files\\PostgreSQL\\16\\bin;${process.env.PATH}`, DEMO_ADMIN_URL: superuserUrl(s, 'postgres') },
    encoding: 'utf8',
    shell: true,
  },
);
const out = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.startsWith('{') || /error|Refusing/i.test(l));
console.log(`restore verification: ${out.join(' | ')}`);
if (r.status !== 0) {
  psql(`DROP DATABASE IF EXISTS "${target}";`);
  throw new Error('restore verification failed; the live demo database was NOT touched');
}

// 2. Database-level grants exactly as provisioning made them.
psql(
  [
    `GRANT ALL ON DATABASE "${target}" TO ${PG_ROLES.app};`,
    `GRANT CREATE ON DATABASE "${target}" TO ${PG_ROLES.financialOwner};`,
    `GRANT CONNECT ON DATABASE "${target}" TO ${PG_ROLES.auditOwner};`,
    `GRANT CREATE ON DATABASE "${target}" TO ${PG_ROLES.auditOwner};`,
  ].join('\n'),
);

// 3. Swap (the previous database is kept for rollback).
node('stop.mjs', ['--keep-infra']);
const prev = `beauclick_demo_prev_${n}`;
psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('${DB_NAME}', '${target}') AND pid <> pg_backend_pid();`);
psql(`ALTER DATABASE "${DB_NAME}" RENAME TO "${prev}";`);
psql(`ALTER DATABASE "${target}" RENAME TO "${DB_NAME}";`);
console.log(`swapped: ${DB_NAME} restored; previous kept as ${prev}`);

if (fs.existsSync(MEDIA_DIR)) fs.renameSync(MEDIA_DIR, `${MEDIA_DIR}.prev-${n}`);
if (fs.existsSync(path.join(dir, 'media'))) fs.cpSync(path.join(dir, 'media'), MEDIA_DIR, { recursive: true });
if (fs.existsSync(path.join(dir, 'seed-state.json'))) fs.copyFileSync(path.join(dir, 'seed-state.json'), path.join(STATE_DIR, 'seed-state.json'));
// Refresh tokens rotated after the backup do not exist in the restored database.
fs.rmSync(path.join(SECRETS_DIR, 'seed-sessions.json'), { force: true });

// 4. Start, verify, rebuild derived search data.
const roles = spawnSync('pnpm', ['--silent', 'verify:roles'], { cwd: V3_ROOT, env: { ...baseProcessEnv(), DATABASE_URL: appUrl(s) }, encoding: 'utf8', shell: true });
console.log(`verify:roles: ${`${roles.stdout}${roles.stderr}`.trim().split('\n').slice(-1)[0]}`);
if (roles.status !== 0) throw new Error('role contract failed on the restored database');
node('start.mjs', ['--profile', profileKey, ...(process.argv.includes('--activate-wireguard') ? ['--activate-wireguard'] : [])]);
node(path.join('..', 'seed', 'reindex.mjs'), ['--profile', profileKey]);
console.log(`RESTORE COMPLETE from ${path.basename(dir)}`);
