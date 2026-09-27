#!/usr/bin/env node
// Read-only extraction of incident evidence from a PRESERVED pre-restore database
// (restore.mjs keeps the replaced DB as beauclick_demo_prev_<n>). READ ONLY transaction.
//
//   node demo/verify/incident-evidence.mjs --db beauclick_demo_prev_<n> --out <dir>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { V3_ROOT } from '../scripts/lib/demo-config.mjs';
import { appUrl, loadSecrets } from '../scripts/lib/runtime.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
const db = arg('--db');
const out = arg('--out');
if (!/^beauclick_demo_prev_\d+$/.test(db ?? '')) throw new Error('--db must be a preserved beauclick_demo_prev_<n>');
const { Client } = createRequire(path.join(V3_ROOT, 'apps', 'api', 'package.json'))('pg');
const url = new URL(appUrl(loadSecrets()));
url.pathname = `/${db}`;
const c = new Client({ connectionString: url.toString() });
await c.connect();
const rows = async (sql) => (await c.query(sql)).rows;
try {
  await c.query('BEGIN TRANSACTION READ ONLY');
  const evidence = {
    database: db,
    extractedAt: new Date().toISOString(),
    commissionPolicies: await rows(`select * from commercial.commission_policies order by policy_key`),
    commissionPolicyVersions: await rows(`select * from commercial.commission_policy_versions order by policy_key, version`),
    adminAuditCommission: await rows(`select id, actor_user_id, action, target_type, target_id, before_state, after_state, reason, created_at from admin.admin_audit_log
      where (action ilike '%commission%' or target_type ilike '%commission%') and created_at > now() - interval '6 hours' order by created_at`),
    ordersAfterIncident: await rows(`select id, status, created_at from commerce.orders where created_at > '2026-09-27T15:12:18Z' order by created_at`),
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'incident-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ versions: evidence.commissionPolicyVersions.map((v) => ({ key: v.policy_key, v: v.version, state: v.lifecycle_state, published_by: v.published_by_user_id, retired_at: v.retired_at, retired_by: v.retired_by_user_id })), audit: evidence.adminAuditCommission.map((a) => ({ at: a.created_at, action: a.action, target: a.target_id, reason: a.reason })), ordersAfter: evidence.ordersAfterIncident.length }, null, 1));
} finally {
  await c.query('ROLLBACK').catch(() => {});
  await c.end();
}
