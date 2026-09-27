#!/usr/bin/env node
// Provisions the DEMO database exactly as CI's "Provision roles" + "Migrate" steps
// do, then loads the repository's reference-data seed. Idempotent: roles that exist
// are left alone, migrations report "Applied: 0" on a second run.
//
// Refuses to touch anything but bcdemo-pg on 127.0.0.1:55432 / beauclick_demo.
// Role passwords reach psql through STDIN (\set), never argv, so they do not appear
// in the process list; PGPASSWORD is set only in the child's environment.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CONTAINERS, DB_NAME, PG_ROLES, PORTS, V3_ROOT, pgUrl } from './lib/demo-config.mjs';
import { baseProcessEnv, loadSecrets } from './lib/runtime.mjs';

const PSQL = 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe';
const s = loadSecrets();

function assertDemoTarget() {
  const out = execFileSync('docker', ['inspect', '-f', '{{.Name}} {{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostIp}}:{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', CONTAINERS.pg], { encoding: 'utf8' }).trim();
  if (out !== `/${CONTAINERS.pg} 127.0.0.1:${PORTS.pg}`) {
    throw new Error(`Refusing: expected ${CONTAINERS.pg} on 127.0.0.1:${PORTS.pg}, found "${out}".`);
  }
}

function psql(sql, { db = DB_NAME, allowFail = false } = {}) {
  // Options FIRST, connection last (Windows psql drops trailing options).
  const r = spawnSync(PSQL, ['-v', 'ON_ERROR_STOP=1', '-q', '-X', '-h', '127.0.0.1', '-p', String(PORTS.pg), '-U', 'postgres', '-d', db], {
    input: sql,
    env: { ...baseProcessEnv(), PGPASSWORD: s.postgresSuperuserPassword },
    encoding: 'utf8',
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`psql failed (exit ${r.status}): ${String(r.stderr).split('\n').slice(0, 5).join(' | ')}`);
  }
  return r.stdout;
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

assertDemoTarget();

// 1. Application role (CI step, verbatim semantics).
const appExists = psql(`SELECT 1 FROM pg_roles WHERE rolname = ${q(PG_ROLES.app)};`).includes('1');
if (!appExists) {
  psql(
    [
      `CREATE ROLE ${PG_ROLES.app} LOGIN PASSWORD ${q(s.appPassword)};`,
      `GRANT ALL ON DATABASE ${DB_NAME} TO ${PG_ROLES.app};`,
      `GRANT CREATE ON SCHEMA public TO ${PG_ROLES.app};`,
    ].join('\n'),
  );
  console.log('roles: created application role');
} else {
  console.log('roles: application role exists');
}

// 2. Financial and admin-audit roles via the repository's own scripts.
const finExists = psql(`SELECT 1 FROM pg_roles WHERE rolname = ${q(PG_ROLES.financialOwner)};`).includes('1');
if (!finExists) {
  const script = fs.readFileSync(path.join(V3_ROOT, 'database', 'scripts', 'financial-roles.sql'), 'utf8');
  psql(
    [
      `\\set owner_password ${q(s.financialOwnerPassword)}`,
      `\\set writer_password ${q(s.financialWriterPassword)}`,
      `\\set reader_password ${q(s.financialReaderPassword)}`,
      `\\set db_name ${DB_NAME}`,
      `\\set app_role ${PG_ROLES.app}`,
      script,
    ].join('\n'),
  );
  console.log('roles: provisioned financial roles');
} else {
  console.log('roles: financial roles exist');
}
const auditExists = psql(`SELECT 1 FROM pg_roles WHERE rolname = ${q(PG_ROLES.auditOwner)};`).includes('1');
if (!auditExists) {
  const script = fs.readFileSync(path.join(V3_ROOT, 'database', 'scripts', 'admin-audit-roles.sql'), 'utf8');
  psql(
    [
      `\\set owner_password ${q(s.auditOwnerPassword)}`,
      `\\set db_name ${DB_NAME}`,
      `\\set app_role ${PG_ROLES.app}`,
      script,
    ].join('\n'),
  );
  console.log('roles: provisioned admin-audit owner role');
} else {
  console.log('roles: admin-audit owner role exists');
}

// 3. Migrations, as CI runs them (real owner roles for financial/admin).
const migrateEnv = {
  ...baseProcessEnv(),
  DATABASE_URL: pgUrl(PG_ROLES.app, s.appPassword),
  MIGRATION_URL_FINANCIAL: pgUrl(PG_ROLES.financialOwner, s.financialOwnerPassword),
  MIGRATION_URL_ADMIN: pgUrl(PG_ROLES.auditOwner, s.auditOwnerPassword),
};
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const mig = spawnSync(pnpm, ['--silent', 'migrate'], { cwd: V3_ROOT, env: migrateEnv, encoding: 'utf8', shell: true });
const migOut = `${mig.stdout ?? ''}${mig.stderr ?? ''}`;
const summary = migOut.split('\n').filter((l) => /Applied:|error|Error/.test(l)).join('\n');
console.log(`migrate: ${summary || '(no summary line)'}`);
if (mig.status !== 0) throw new Error('migrate failed');

// 4. Reference data (cities, specialties): the repository's own seed function.
const seed = spawnSync(
  pnpm,
  ['exec', 'ts-node', '--transpile-only', '--project', 'database/scripts/tsconfig.json', '../demo/seed/reference-data.run.ts'],
  {
    cwd: V3_ROOT,
    env: { ...migrateEnv, NODE_PATH: path.join(V3_ROOT, 'apps', 'api', 'node_modules') },
    encoding: 'utf8',
    shell: true,
  },
);
console.log(`reference seed: ${(seed.stdout || seed.stderr || '').trim().split('\n').slice(-2).join(' | ')}`);
if (seed.status !== 0) throw new Error('reference seed failed');

// 5. The PostgreSQL role contract, exactly as CI verifies it.
const roles = spawnSync(pnpm, ['--silent', 'verify:roles'], {
  cwd: V3_ROOT,
  env: { ...baseProcessEnv(), DATABASE_URL: pgUrl(PG_ROLES.app, s.appPassword) },
  encoding: 'utf8',
  shell: true,
});
const rolesOut = `${roles.stdout ?? ''}${roles.stderr ?? ''}`.trim().split('\n');
console.log(`verify:roles: ${rolesOut.slice(-3).join(' | ')}`);
if (roles.status !== 0) throw new Error('role contract verification failed');
