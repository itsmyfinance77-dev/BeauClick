#!/usr/bin/env node
// Evidence for the API-ONLY matrix rows (backend features with no web screen at the baseline).
// Each row: a read through the real API as the role that owns it (status + what came back), plus a
// read-only DB count of what the seed wrote THROUGH THE API. Nothing here is browser evidence and
// nothing is presented as a screen.
//
//   node demo/verify/api-only-evidence.mjs --profile L
import fs from 'node:fs';
import path from 'node:path';

import { RUNTIME_ROOT, STATE_DIR } from '../scripts/lib/demo-config.mjs';
import { q } from './lib/db-readonly.mjs';
import { personaSession } from './lib/persona-session.mjs';

const i = process.argv.indexOf('--profile');
const profileKey = i > 0 ? process.argv[i + 1] : 'L';
const ids = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'seed-state.json'), 'utf8')).ids;
const sessions = new Map();
const as = async (k) => (sessions.has(k) ? sessions.get(k) : (sessions.set(k, await personaSession(profileKey, k)), sessions.get(k)));
const rows = [];
const size = (d) => (Array.isArray(d) ? d.length : Array.isArray(d?.items) ? d.items.length : d && typeof d === 'object' ? Object.keys(d).length : d == null ? 0 : 1);

async function row(matrix, feature, persona, route, dbSql = null, params = []) {
  let status;
  let shape;
  if (!route) status = 'no read route exercised (DB count only)';
  else try {
    const res = await (await as(persona)).get(route, { expect: [200, 201, 204, 400, 403, 404, 409] });
    status = res.status;
    shape = { items: size(res.data), keys: res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? Object.keys(res.data).slice(0, 8) : undefined };
  } catch (e) {
    status = `error: ${e.message.slice(0, 120)}`;
  }
  const db = dbSql ? (await q(dbSql, params))[0] : null;
  rows.push({ matrix, feature, persona, route, status, shape, db });
  console.log(`#${String(matrix).padEnd(3)} ${feature.padEnd(46)} ${persona.padEnd(9)} GET ${route ?? '—'}  -> ${status}  ${JSON.stringify(shape ?? {})}  ${db ? `DB ${JSON.stringify(db)}` : ''}`);
}

const biz = ids.businessId;
const loc = ids.locations?.main;
await row(16, 'business locations', 'bizOwner', `/v1/businesses/${biz}/locations`, `select count(*) n from business.locations where business_id = $1`, [biz]);
await row(16, 'location resources', 'bizOwner', `/v1/businesses/${biz}/locations/${loc}/resources`, `select count(*) n from business.location_resources`);
await row(16, 'service resource requirements (seed via API)', 'bizOwner', null, `select count(*) n from business.service_resource_requirements`);
await row(22, 'seller subscription (workspace)', 'pro1', `/v1/me/subscriptions/${ids.pro1.workspaceRef}`);
await row(22, 'credit purchases', 'pro1', `/v1/me/subscriptions/${ids.pro1.workspaceRef}/credit-purchases`, `select count(*) n from commercial.credit_purchases`);
await row(22, 'collection policies (seller view)', 'pro1', `/v1/me/collection-policies`, `select count(*) n from commercial.booking_collection_policies`);
await row(22, 'collection-policy assignments', 'pro1', `/v1/me/collection-policy-assignments`);
await row(23, 'settlement schedules (admin)', 'admin', `/v1/admin/commercial/settlement-schedules`);
await row(23, 'seller risk classes (admin)', 'admin', `/v1/admin/commercial/seller-risk-classes`);
await row(23, 'legal evidence registry (admin)', 'admin', `/v1/admin/commercial/legal-evidence`);
await row(37, 'my orders (customer)', 'cust1', `/v1/me/orders`, `select count(*) n from commerce.orders where customer_id = $1`, [ids['user:cust1']]);
await row(37, 'my reviews (customer)', 'cust1', `/v1/me/reviews`, `select count(*) n from provider.reviews where customer_id = $1`, [ids['user:cust1']]);
await row(14, 'seller reply to a review (written by seed via API)', 'pro1', `/v1/providers/${ids.pro1.providerId}/reviews`, `select count(*) filter (where response_text is not null) replied, count(*) total from provider.reviews where professional_id = $1`, [ids.pro1.providerId]);
await row(28, 'loyalty tiers', 'cust1', `/v1/me/loyalty/tiers`, `select count(*) n from loyalty.tiers`);
await row(28, 'loyalty membership plans', 'cust1', `/v1/me/loyalty/membership/plans`, `select count(*) n from loyalty.memberships`);

const out = path.join(RUNTIME_ROOT, 'evidence', `api-only-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rows, null, 2));
console.log(`evidence: ${out}`);
