#!/usr/bin/env node
// Rebuilds the derived search data through the administrator's real admin routes
// (the product's own recovery path): rebuild the search projection from the
// source-of-truth tables, then reindex OpenSearch. Real OTP sign-in.
//   node demo/seed/reindex.mjs --profile L
import { profile } from '../scripts/lib/demo-config.mjs';
import { DemoInbox, signIn } from './lib/client.mjs';
import { persona } from './personas.mjs';

const i = process.argv.indexOf('--profile');
const key = i > 0 ? process.argv[i + 1] : 'L';
void profile(key);
const admin = await signIn(key, persona('admin').phone, new DemoInbox(), 'admin');
const rebuilt = await admin.post('/v1/admin/search/rebuild-projection', {}, { expect: [200, 201, 202] });
const reindexed = await admin.post('/v1/admin/search/reindex', {}, { expect: [200, 201, 202] });
const status = await admin.get('/v1/admin/search/status');
console.log(`search: projection HTTP ${rebuilt.status}, reindex HTTP ${reindexed.status}; status ${JSON.stringify(status.data).slice(0, 300)}`);
