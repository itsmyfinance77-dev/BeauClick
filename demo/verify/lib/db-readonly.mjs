// Read-only queries against the demo DB for persistence checks: every query runs in a READ ONLY
// transaction as the application role, so a check can never write.
import { createRequire } from 'node:module';
import path from 'node:path';

import { V3_ROOT } from '../../scripts/lib/demo-config.mjs';
import { appUrl, loadSecrets } from '../../scripts/lib/runtime.mjs';

const { Client } = createRequire(path.join(V3_ROOT, 'apps', 'api', 'package.json'))('pg');

export async function q(sql, params = []) {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('read-only: SELECT/WITH only');
  const c = new Client({ connectionString: appUrl(loadSecrets()) });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    return (await c.query(sql, params)).rows;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}
