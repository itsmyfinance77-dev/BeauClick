#!/usr/bin/env node
// Demo backup: DB (product's own backup library, superuser on the demo cluster so
// financial/admin schemas are included), media files, and the seed-state map.
//   node demo/scripts/backup.mjs --label golden
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { BACKUPS_DIR, MEDIA_DIR, STATE_DIR, V3_ROOT } from './lib/demo-config.mjs';
import { baseProcessEnv, loadSecrets, readSourceSha, superuserUrl } from './lib/runtime.mjs';

const i = process.argv.indexOf('--label');
const label = (i > 0 ? process.argv[i + 1] : 'manual').replace(/[^a-z0-9-]/gi, '');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(BACKUPS_DIR, `${stamp}-${label}`);
fs.mkdirSync(dir, { recursive: true });

const s = loadSecrets();
const r = spawnSync(
  'pnpm',
  ['exec', 'ts-node', '--transpile-only', '--project', 'database/scripts/tsconfig.json', '../demo/scripts/db/backup-restore.run.ts', 'backup', `"${dir}"`],
  {
    cwd: V3_ROOT,
    env: {
      ...baseProcessEnv(),
      NODE_PATH: path.join(V3_ROOT, 'apps', 'api', 'node_modules'),
      PATH: `C:\\Program Files\\PostgreSQL\\16\\bin;${process.env.PATH}`,
      DEMO_ADMIN_URL: superuserUrl(s, 'postgres'),
      DEMO_SOURCE_URL: superuserUrl(s),
    },
    encoding: 'utf8',
    shell: true,
  },
);
const lines = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.trim() && !/DEP0190|trace-deprecation/.test(l));
if (r.status !== 0) {
  console.error(`backup failed:\n${lines.slice(-5).join('\n')}`);
  process.exit(1);
}
const db = JSON.parse(lines.find((l) => l.startsWith('{')));

let mediaFiles = 0;
if (fs.existsSync(MEDIA_DIR)) {
  fs.cpSync(MEDIA_DIR, path.join(dir, 'media'), { recursive: true });
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : mediaFiles++));
  walk(path.join(dir, 'media'));
}
const seedState = path.join(STATE_DIR, 'seed-state.json');
if (fs.existsSync(seedState)) fs.copyFileSync(seedState, path.join(dir, 'seed-state.json'));

const manifest = { label, createdAt: new Date().toISOString(), sourceSha: readSourceSha(), db, mediaFiles };
fs.writeFileSync(path.join(dir, 'demo-backup.json'), JSON.stringify(manifest, null, 2));
console.log(`backup OK: ${dir}\n  db ${db.bytes} bytes sha256 ${db.sha256.slice(0, 16)}… ${db.tables} tables ${db.rows} rows; media ${mediaFiles} file(s)`);
export { dir as backupDir };
