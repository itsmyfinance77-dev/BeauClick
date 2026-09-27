#!/usr/bin/env node
// DEMO-DEC-001 B — real API + DB checks through the ingress with real sessions.
//   node demo/verify/b-replacement.mjs --profile L
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SECRETS_DIR, STATE_DIR, profile } from '../scripts/lib/demo-config.mjs';
import { checkout, publicSlots, tehranDate, tehranDay, tehranHour } from '../seed/lib/booking-flow.mjs';
import { Session, rawRequest } from '../seed/lib/client.mjs';

const i = process.argv.indexOf('--profile');
const origin = profile(i > 0 ? process.argv[i + 1] : 'L').origin;
const statePath = path.join(STATE_DIR, 'seed-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const tokensFile = path.join(SECRETS_DIR, 'seed-sessions.json');
const tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
const cache = new Map();
async function as(key) {
  if (cache.has(key)) return cache.get(key);
  const s = new Session(origin, key);
  s.refreshToken = tokens[key];
  await s.refresh();
  s.onRotate = (t) => {
    tokens[key] = t;
    fs.writeFileSync(tokensFile, JSON.stringify(tokens));
  };
  tokens[key] = s.refreshToken;
  fs.writeFileSync(tokensFile, JSON.stringify(tokens));
  cache.set(key, s);
  return s;
}
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => ({ headers: { 'Idempotency-Key': randomUUID() } });
const { pro1, pro2 } = state.ids;
const b = (state.ids.replacementChecks ??= {});
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

async function freeSlot(s, ids, serviceKey, day, fromHour, taken = new Set()) {
  const slots = await publicSlots(s, ids.providerId, ids.serviceIds[serviceKey]);
  const hit = slots.find((x) => tehranDay(x.startAt) === tehranDate(day) && tehranHour(x.startAt) >= fromHour && !taken.has(x.id));
  if (!hit) throw new Error(`no free slot day ${day} from ${fromHour}`);
  return hit.id;
}
async function offerOf(s, bookingId, expect = [200, 404]) {
  return s.get(`/v1/bookings/${bookingId}/replacement-offer`, { expect });
}
async function waitOffer(s, bookingId) {
  for (let n = 0; n < 40; n++) {
    const r = await offerOf(s, bookingId);
    if (r.status === 200) return r;
    await sleep(500);
  }
  return offerOf(s, bookingId);
}
async function pay(customer, redirectUrl, decision) {
  const u = new URL(redirectUrl, origin);
  const reference = u.searchParams.get('reference');
  const callback = u.searchParams.get('callback');
  await rawRequest(`${origin}/api/v1/sandbox-gateway/${encodeURIComponent(reference)}/decide`, { method: 'POST', body: { decision } });
  return rawRequest(`${callback}${callback.includes('?') ? '&' : '?'}reference=${encodeURIComponent(reference)}`);
}

const cust2 = await as('cust2');
const cust3 = await as('cust3');
const sPro1 = await as('pro1');

// S1 — a provider-side cancellation creates ONE durable offer; the refund continues.
if (!b.s1) {
  const slotId = await freeSlot(cust2, pro1, 'party', 4, 14);
  const booked = await checkout(cust2, { professionalId: pro1.providerId, serviceId: pro1.serviceIds.party, slotId, governed: true });
  await sPro1.post(`/v1/bookings/${booked.bookingId}/cancel`, { reason: 'لغو توسط متخصص — آزمون پیشنهاد جایگزینی (دمو)' });
  b.s1 = { original: booked.bookingId };
  save();
}
const s1 = await waitOffer(cust2, b.s1.original);
check('provider cancellation creates a durable, open offer', s1.status === 200 && s1.data.status === 'open', `HTTP ${s1.status} ${s1.data?.status}`);
check('the original refund continues independently (executed, full amount)', s1.data?.originalRefund?.executionStatus === 'executed', JSON.stringify(s1.data?.originalRefund));
check('the offer shows the CURRENT price and the same service/provider', s1.data?.service?.currentPriceToman === 1_800_000 && s1.data?.professionalId === pro1.providerId);

// S2 — ownership.
const foreign = await offerOf(cust3, b.s1.original, [200, 403, 404]);
check("another customer cannot see or use the offer", foreign.status === 404, `HTTP ${foreign.status}`);
const foreignUse = await cust3.post(`/v1/bookings/${b.s1.original}/replacement-offer/bookings`, { slotId: await freeSlot(cust3, pro1, 'party', 5, 12) }, { ...key(), expect: [201, 403, 404, 409] });
check('another customer cannot book against it', foreignUse.status === 404, `HTTP ${foreignUse.status}`);

// S3 — a CUSTOMER cancellation creates no offer.
if (!b.s3) {
  const slotId = await freeSlot(cust2, pro1, 'brow', 4, 16);
  const booked = await checkout(cust2, { professionalId: pro1.providerId, serviceId: pro1.serviceIds.brow, slotId, governed: true });
  await cust2.post(`/v1/bookings/${booked.bookingId}/cancel`, { reason: 'انصراف مشتری (آزمون)' });
  b.s3 = { original: booked.bookingId };
  save();
}
await sleep(2000);
check('a customer cancellation offers no replacement', (await offerOf(cust2, b.s3.original)).status === 404);

// S4/S5 — slot of another provider; missing idempotency key.
const otherSlot = await freeSlot(cust2, pro2, 'mani', 5, 11);
const wrong = await cust2.post(`/v1/bookings/${b.s1.original}/replacement-offer/bookings`, { slotId: otherSlot }, { ...key(), expect: [201, 409] });
check("a slot of another provider is refused", wrong.status === 409 && wrong.raw.json?.error?.code === 'REPLACEMENT_SLOT_NOT_ELIGIBLE', wrong.raw.json?.error?.code);
const nokey = await cust2.post(`/v1/bookings/${b.s1.original}/replacement-offer/bookings`, { slotId: otherSlot }, { expect: [400, 409] });
check('an attempt without an Idempotency-Key is refused', nokey.status === 400);

// S6 — terms: the replacement needs its OWN current acceptance.
const slotA = await freeSlot(cust2, pro1, 'party', 5, 10);
const noAccept = await cust2.post(`/v1/bookings/${b.s1.original}/replacement-offer/bookings`, { slotId: slotA }, { ...key(), expect: [201, 409] });
check('a replacement without acceptance of the current terms is refused', noAccept.status === 409, noAccept.raw.json?.error?.code);
check('...and the refused attempt consumed nothing (offer still open, no attempt)', (await offerOf(cust2, b.s1.original)).data.activeAttempt === null);

const disclose = async (slotId) =>
  (await cust2.get(`/v1/checkout/disclosure?professionalId=${pro1.providerId}&slotId=${slotId}&serviceId=${pro1.serviceIds.party}`)).data.acceptance;

// S7 — two concurrent attempts (different keys, different slots): exactly one wins.
const slotB = await freeSlot(cust2, pro1, 'party', 5, 15, new Set([slotA]));
const kA = randomUUID();
const kB = randomUUID();
const [ra, rb] = await Promise.all([
  cust2.post(`/v1/bookings/${b.s1.original}/replacement-offer/bookings`, { slotId: slotA, acceptedPolicy: await disclose(slotA) }, { headers: { 'Idempotency-Key': kA }, expect: [201, 409] }),
  cust2.post(`/v1/bookings/${b.s1.original}/replacement-offer/bookings`, { slotId: slotB, acceptedPolicy: await disclose(slotB) }, { headers: { 'Idempotency-Key': kB }, expect: [201, 409] }),
]);
const winners = [ra, rb].filter((r) => r.status === 201);
const loser = [ra, rb].find((r) => r.status === 409);
check('concurrent attempts: exactly one creates a booking', winners.length === 1, `${ra.status}/${rb.status}`);
check('...the other is told an attempt is in progress', loser?.raw.json?.error?.code === 'REPLACEMENT_ATTEMPT_IN_PROGRESS', loser?.raw.json?.error?.code);
const win = winners[0];
const winKey = win === ra ? kA : kB;
const winSlot = win === ra ? slotA : slotB;

// S8 — same-key replay converges on the same booking.
const replay = await cust2.post(`/v1/bookings/${b.s1.original}/replacement-offer/bookings`, { slotId: winSlot, acceptedPolicy: await disclose(winSlot) }, { headers: { 'Idempotency-Key': winKey }, expect: [201, 409] });
check('same-key replay returns the SAME booking (no second booking/charge)', replay.status === 201 && replay.data.booking?.id === win.data.booking.id, `${replay.status} ${replay.data?.booking?.id === win.data.booking.id}`);

// S9 — a DECLINED payment keeps the offer open; cancelling the pending attempt frees it.
const declined = await pay(cust2, win.data.payment.redirectUrl, 'failure');
const afterDecline = (await offerOf(cust2, b.s1.original)).data;
check('declined payment: offer stays open with the attempt still recoverable', afterDecline.status === 'open' && afterDecline.activeAttempt?.bookingId === win.data.booking.id, `callback ${declined.status}`);
await cust2.post(`/v1/bookings/${win.data.booking.id}/cancel`, { reason: 'انصراف از تلاش (آزمون)' });
const freed = (await offerOf(cust2, b.s1.original)).data;
check('cancelling the pending attempt frees the offer (not consumed)', freed.status === 'open' && freed.activeAttempt === null);

// S10 — a successful replacement uses the offer exactly once.
const slotC = await freeSlot(cust2, pro1, 'party', 6, 10);
const good = await cust2.post(`/v1/bookings/${b.s1.original}/replacement-offer/bookings`, { slotId: slotC, acceptedPolicy: await disclose(slotC) }, { ...key(), expect: [201] });
const paid = await pay(cust2, good.data.payment.redirectUrl, 'success');
check('replacement paid through the sandbox bank', /status=succeeded/.test(paid.headers.location ?? ''), paid.headers.location);
const used = (await offerOf(cust2, b.s1.original)).data;
check('offer is USED by exactly that booking', used.status === 'used' && used.replacementBookingId === good.data.booking.id);
const again = await cust2.post(`/v1/bookings/${b.s1.original}/replacement-offer/bookings`, { slotId: await freeSlot(cust2, pro1, 'party', 6, 15), acceptedPolicy: await disclose(slotC) }, { ...key(), expect: [201, 409] });
check('a second replacement is refused', again.status === 409 && again.raw.json?.error?.code === 'REPLACEMENT_OFFER_NOT_OPEN', again.raw.json?.error?.code);
const orig = (await cust2.get(`/v1/bookings/${b.s1.original}`)).data;
const repl = (await cust2.get(`/v1/bookings/${good.data.booking.id}`)).data;
check('original stays cancelled; replacement confirmed with no reschedule consumed', orig.status === 'cancelled' && repl.status === 'confirmed' && (repl.rescheduleCount ?? 0) === 0, `${orig.status}/${repl.status}/${repl.rescheduleCount}`);
const termsRepl = (await cust2.get(`/v1/bookings/${good.data.booking.id}/accepted-terms`)).data;
check("the replacement carries its OWN accepted terms", termsRepl.governed === true);
check('the original refund is still executed after the replacement', used.originalRefund?.executionStatus === 'executed');
b.s1.replacement = good.data.booking.id;
save();

// S11 — dismissal (a second provider cancellation).
if (!b.s11) {
  const slotId = await freeSlot(cust3, pro1, 'party', 4, 17);
  const booked = await checkout(cust3, { professionalId: pro1.providerId, serviceId: pro1.serviceIds.party, slotId, governed: true });
  await sPro1.post(`/v1/bookings/${booked.bookingId}/cancel`, { reason: 'لغو توسط متخصص — آزمون انصراف (دمو)' });
  b.s11 = { original: booked.bookingId };
  save();
}
await waitOffer(cust3, b.s11.original);
const dis = await cust3.post(`/v1/bookings/${b.s11.original}/replacement-offer/dismiss`, {}, { expect: [200, 201] });
const dis2 = await cust3.post(`/v1/bookings/${b.s11.original}/replacement-offer/dismiss`, {}, { expect: [200, 201] });
const dView = (await offerOf(cust3, b.s11.original)).data;
check('dismiss is recorded (and idempotent); refund unaffected', dis.data.status === 'dismissed' && dis2.data.status === 'dismissed' && dView.status === 'dismissed' && dView.originalRefund?.executionStatus === 'executed');
const afterDismiss = await cust3.post(`/v1/bookings/${b.s11.original}/replacement-offer/bookings`, { slotId: await freeSlot(cust3, pro1, 'party', 6, 17) }, { ...key(), expect: [201, 409] });
check('a dismissed offer cannot be used', afterDismiss.status === 409 && afterDismiss.raw.json?.error?.code === 'REPLACEMENT_OFFER_NOT_OPEN');

// S12 — inactive service: the offer stays open, attempts are refused, refund continues.
if (!b.s12) {
  const svc = (await sPro1.post(`/v1/providers/${pro1.providerId}/services`, { name: 'خدمت آزمون غیرفعال‌شدن (دمو)', durationMinutes: 30, priceToman: 300_000 })).data.id;
  const slots = await publicSlots(cust2, pro1.providerId, svc);
  const slotId = slots.find((x) => tehranDay(x.startAt) === tehranDate(6) && tehranHour(x.startAt) >= 19).id;
  const booked = await checkout(cust2, { professionalId: pro1.providerId, serviceId: svc, slotId, governed: true });
  await sPro1.post(`/v1/bookings/${booked.bookingId}/cancel`, { reason: 'لغو توسط متخصص — آزمون خدمت غیرفعال (دمو)' });
  await waitOffer(cust2, booked.bookingId);
  await sPro1.del(`/v1/providers/${pro1.providerId}/services/${svc}`);
  b.s12 = { original: booked.bookingId, service: svc };
  save();
}
const inactive = (await offerOf(cust2, b.s12.original)).data;
check('inactive service: offer open but not eligible, stated honestly', inactive.status === 'open' && inactive.eligible === false && inactive.ineligibleReason === 'service_inactive');
check('...and the refund was not withheld', inactive.originalRefund?.executionStatus === 'executed');

const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
