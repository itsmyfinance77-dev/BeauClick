#!/usr/bin/env node
// READ-ONLY diagnostic query against the demo DB. Runs inside a READ ONLY
// transaction as the application role, so it cannot write even by mistake.
//   node demo/verify/sql-readonly.mjs "<SELECT ...>"
import { createRequire } from 'node:module';
import path from 'node:path';

import { V3_ROOT } from '../scripts/lib/demo-config.mjs';
import { appUrl, loadSecrets } from '../scripts/lib/runtime.mjs';

const sql = process.argv[2];
if (!sql || !/^\s*(select|with)\b/i.test(sql)) throw new Error('read-only: SELECT/WITH only');
const { Client } = createRequire(path.join(V3_ROOT, 'apps', 'api', 'package.json'))('pg');
const c = new Client({ connectionString: appUrl(loadSecrets()) });
await c.connect();
try {
  await c.query('BEGIN TRANSACTION READ ONLY');
  const r = await c.query(sql);
  console.table(r.rows);
} finally {
  await c.query('ROLLBACK').catch(() => {});
  await c.end();
}
