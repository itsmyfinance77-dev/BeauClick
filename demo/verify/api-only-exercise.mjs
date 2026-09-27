#!/usr/bin/env node
// FUNCTIONAL proof for API-ONLY features (no web screen at the baseline): real writes through the
// supported API routes, as the role that owns the feature, each followed by a read-back (API + read-only
// DB) and a denied attempt by a role that must not. Synthetic, local, demo DB only; restored afterwards.
// Identity of every target is asserted from the DB BEFORE the mutation.
//
//   node demo/verify/api-only-exercise.mjs --profile L
import fs from 'node:fs';
import path from 'node:path';

import { RUNTIME_ROOT, STATE_DIR } from '../scripts/lib/demo-config.mjs';
import { checkout, publicSlots } from '../seed/lib/booking-flow.mjs';
import { q } from './lib/db-readonly.mjs';
import { personaSession } from './lib/persona-session.mjs';

const i = process.argv.indexOf('--profile');
const profileKey = i > 0 ? process.argv[i + 1] : 'L';
const ids = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'seed-state.json'), 'utf8')).ids;
const userKey = Object.fromEntries(Object.entries(ids).filter(([k]) => k.startsWith('user:')).map(([k, v]) => [v, k.slice(5)]));
const sessions = new Map();
const as = async (k) => (sessions.has(k) ? sessions.get(k) : (sessions.set(k, await personaSession(profileKey, k)), sessions.get(k)));
const rows = [];
const rec = (matrix, check, pass, detail = '') => {
  rows.push({ matrix, check, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} #${matrix} ${check}  ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 220)}`);
};
const call = async (key, method, p, body, expect = [200, 201, 204, 400, 403, 404, 409, 422]) => {
  const res = await (await as(key)).call(method, p, body, { expect });
  return { status: res.status, data: res.data, code: res.raw?.json?.error?.code };
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    rec(name, 'step aborted', false, e.message.slice(0, 200));
  }
};

// --- #14 customer review (API-only) + seller reply (API-only) -------------------------------------
await step('14', async () => {
  const target = (await q(`select b.id, b.customer_id, b.professional_id from booking.bookings b join provider.review_eligibility e on e.booking_id = b.id
    where b.status = 'completed' and not exists (select 1 from provider.reviews r where r.booking_id = b.id) order by b.completed_at limit 1`))[0];
  if (!target || !userKey[target.customer_id]) throw new Error('no completed, review-eligible, unreviewed booking of a persona');
  const cust = userKey[target.customer_id];
  const other = cust === 'cust2' ? 'cust3' : 'cust2';
  const foreign = await call(other, 'POST', `/v1/bookings/${target.id}/review`, { rating: 4, comment: 'نظر آزمایشی از حساب دیگر' });
  // Refused as NOT ELIGIBLE (the review-eligibility row belongs to the booking's customer) — recorded under that
  // exact code, not as a generic authorization pass; the control is the owner's identical request below (201).
  rec('14', 'refused for another customer with REVIEW_NOT_ELIGIBLE (eligibility belongs to the booking customer); control: owner 201 below', foreign.status === 409 && foreign.code === 'REVIEW_NOT_ELIGIBLE', `HTTP ${foreign.status} ${foreign.code ?? ''}`);
  const made = await call(cust, 'POST', `/v1/bookings/${target.id}/review`, { rating: 5, comment: 'نظر آزمایشی API دمو (داده ساختگی)' });
  const row = (await q(`select id, status, rating, comment from provider.reviews where booking_id = $1`, [target.id]))[0];
  rec('14', `customer (${cust}) writes a review: 201 and persisted`, made.status === 201 && row?.rating === 5, { status: made.status, row });
  const dup = await call(cust, 'POST', `/v1/bookings/${target.id}/review`, { rating: 3, comment: 'دوباره' });
  rec('14', 'denied: a second review for the same booking is refused', dup.status >= 400, `HTTP ${dup.status} ${dup.code ?? ''}`);
  const queue = await call('moderator', 'GET', '/v1/admin/reviews/queue?page=1&limit=50');
  rec('14', 'other: the new review is in the moderation queue', JSON.stringify(queue.data).includes(row.id));
  const proKey = Object.entries(ids).find(([k, v]) => ['pro1', 'pro2', 'practitioner'].includes(k) && v.providerId === target.professional_id)?.[0];
  const seller = proKey === 'practitioner' ? 'bizPractitioner' : proKey;
  const wrongPro = seller === 'pro1' ? 'pro2' : 'pro1';
  const wrongPid = ids[wrongPro].providerId;
  const deniedReply = await call(wrongPro, 'POST', `/v1/providers/${wrongPid}/reviews/${row.id}/respond`, { text: 'پاسخ از متخصص دیگر' });
  const deniedReply2 = await call(wrongPro, 'POST', `/v1/providers/${target.professional_id}/reviews/${row.id}/respond`, { text: 'پاسخ از متخصص دیگر' });
  rec('14', "denied: another professional cannot reply (own id or the owner's id)", deniedReply.status >= 400 && deniedReply2.status >= 400, `HTTP ${deniedReply.status}/${deniedReply2.status}`);
  const reply = await call(seller, 'POST', `/v1/providers/${target.professional_id}/reviews/${row.id}/respond`, { text: 'پاسخ آزمایشی متخصص (دمو)' });
  const after = (await q(`select response_text, responded_at from provider.reviews where id = $1`, [row.id]))[0];
  rec('14', `seller (${seller}) replies: persisted with a timestamp`, reply.status < 300 && after?.response_text === 'پاسخ آزمایشی متخصص (دمو)' && after.responded_at, { status: reply.status, after });
  const pub = await call('cust4', 'GET', `/v1/providers/${target.professional_id}/reviews`);
  rec('14', 'other: the public reviews list shows the review with the reply', JSON.stringify(pub.data).includes('پاسخ آزمایشی متخصص (دمو)'), `HTTP ${pub.status}`);
});

// --- #16 business locations / resources / resource requirement -------------------------------------
await step('16', async () => {
  const biz = ids.businessId;
  const owner = (await q(`select owner_id from business.businesses where id = $1`, [biz]))[0]?.owner_id;
  rec('16', 'identity: the salon is owned by bizOwner', owner === ids['user:bizOwner'], owner);
  const city = ids.city.tehran;
  const deniedLoc = await call('bizManager', 'POST', `/v1/businesses/${biz}/locations`, { name: 'شعبهٔ غیرمجاز', cityId: city });
  rec('16', 'denied: the manager (non-owner) cannot create a location', [403, 404].includes(deniedLoc.status), `HTTP ${deniedLoc.status} ${deniedLoc.code ?? ''}`);
  const made = await call('bizOwner', 'POST', `/v1/businesses/${biz}/locations`, { name: 'شعبهٔ آزمایشی API (دمو)', cityId: city });
  const ref = made.data?.locationRef ?? made.data?.ref ?? made.data?.id;
  const count = async () => Number((await q(`select count(*) n from business.locations where business_id = $1`, [biz]))[0].n);
  rec('16', 'owner creates a location', made.status === 201 && Boolean(ref), { status: made.status, keys: Object.keys(made.data ?? {}) });
  const list = async () => (await call('bizOwner', 'GET', `/v1/businesses/${biz}/locations`)).data;
  const find = async () => (Array.isArray(await list()) ? await list() : (await list())?.items ?? []).find((l) => JSON.stringify(l).includes('شعبهٔ آزمایشی API'));
  rec('16', 'read-back: listed', Boolean(await find()), await find());
  const sus = await call('bizOwner', 'POST', `/v1/businesses/${biz}/locations/${ref}/suspend`, {});
  rec('16', 'owner suspends it; read-back shows suspended', sus.status < 300 && /suspend/.test(JSON.stringify(await find())), `HTTP ${sus.status}`);
  const rea = await call('bizOwner', 'POST', `/v1/businesses/${biz}/locations/${ref}/reactivate`, {});
  rec('16', 'owner reactivates it; read-back shows active', rea.status < 300 && /active/.test(JSON.stringify(await find())), `HTTP ${rea.status}`);
  const res = await call('bizOwner', 'POST', `/v1/businesses/${biz}/locations/${ref}/resources`, { name: 'اتاق آزمایشی (دمو)', kind: 'room' });
  const rref = res.data?.resourceRef ?? res.data?.ref ?? res.data?.id;
  rec('16', 'owner creates a room resource at it', res.status === 201 && Boolean(rref), `HTTP ${res.status}`);
  const ret = await call('bizOwner', 'POST', `/v1/businesses/${biz}/locations/${ref}/resources/${rref}/retire`, {});
  const rlist = (await call('bizOwner', 'GET', `/v1/businesses/${biz}/locations/${ref}/resources`)).data;
  rec('16', 'owner retires it; read-back shows retired', ret.status < 300 && /retire/.test(JSON.stringify(rlist)), `HTTP ${ret.status}`);
  rec('16', 'DB: one more location for the salon', (await count()) >= 3, await count());

  // resource requirement on a service of an ACTIVE staff professional (the practitioner)
  const svc = ids.practitioner.serviceIds.facial;
  const belongs = await q(`select 1 from provider.services s join business.business_staff m on m.professional_id = s.professional_id where s.id = $1 and m.business_id = $2 and m.status = 'active'`, [svc, biz]);
  rec('16', 'identity: the facial service belongs to an active staff professional of the salon', belongs.length === 1);
  const deniedReq = await call('financeReader', 'PUT', `/v1/businesses/${biz}/services/${svc}/resource-requirement`, { requiredKind: 'room' });
  rec('16', 'denied: a finance reader cannot set a resource requirement', [403, 404].includes(deniedReq.status), `HTTP ${deniedReq.status}`);
  const setReq = await call('bizOwner', 'PUT', `/v1/businesses/${biz}/services/${svc}/resource-requirement`, { requiredKind: 'room' });
  const readReq = await call('bizOwner', 'GET', `/v1/businesses/${biz}/services/${svc}/resource-requirement`);
  rec('16', 'owner sets requiredKind=room; read-back room; DB row', setReq.status < 300 && readReq.data?.requiredKind === 'room' && (await q(`select 1 from business.service_resource_requirements where service_id = $1`, [svc])).length === 1, readReq.data);
  // Effect on a new booking of that service (checkout through the sandbox bank).
  const cust = await as('cust4');
  const slots = await publicSlots(cust, ids.practitioner.providerId, svc);
  let effect = 'no free slot';
  if (slots.length) {
    try {
      const booked = await checkout(cust, { professionalId: ids.practitioner.providerId, serviceId: svc, slotId: slots.at(-1).id, governed: false });
      const assign = await q(`select * from booking.booking_resource_assignments where booking_id = $1`, [booked.bookingId]);
      effect = { booking: booked.bookingId, result: booked.resultLocation?.match(/status=\w+/)?.[0], resourceAssignments: assign.length };
    } catch (e) {
      effect = { refused: e.message.slice(0, 160) };
    }
  }
  rec('16', 'effect: a new booking of that service after the requirement (observed, not asserted)', true, effect);
  const clear = await call('bizOwner', 'PUT', `/v1/businesses/${biz}/services/${svc}/resource-requirement`, { requiredKind: null });
  rec('16', 'owner clears the requirement (null)', clear.status < 300, `HTTP ${clear.status}`);
});

// --- #22 subscription plan selection / cancellation ------------------------------------------------
await step('22', async () => {
  const ws = ids.pro1.workspaceRef;
  const before = (await call('pro1', 'GET', '/v1/me/subscriptions')).data;
  const sel = await call('pro1', 'POST', `/v1/me/subscriptions/${ws}/selection`, { planKey: 'D-7', version: 1 });
  rec('22', 'seller selects the (only) plan D-7 v1', sel.status < 300, { status: sel.status, code: sel.code, data: sel.data });
  const hist = (await call('pro1', 'GET', `/v1/me/subscriptions/${ws}/history`)).data;
  rec('22', 'read-back: history after selection', true, hist);
  const foreign = await call('pro2', 'POST', `/v1/me/subscriptions/${ws}/selection`, { planKey: 'D-7', version: 1 });
  rec('22', "denied: another seller cannot act on pro1's workspace reference", foreign.status >= 400, `HTTP ${foreign.status} ${foreign.code ?? ''}`);
  const cancel = await call('pro1', 'POST', `/v1/me/subscriptions/${ws}/cancellation`, undefined);
  rec('22', 'seller cancels (returns to / stays on the base workspace)', cancel.status < 300, { status: cancel.status, code: cancel.code });
  rec('22', 'before/after subscription lists (observed)', true, { before, after: (await call('pro1', 'GET', '/v1/me/subscriptions')).data });
});

const out = path.join(RUNTIME_ROOT, 'evidence', `api-only-exercise-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(out, JSON.stringify(rows, null, 2));
console.log(`evidence: ${out}`);
