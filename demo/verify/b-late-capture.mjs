#!/usr/bin/env node
// DEMO-DEC-001 B — a replacement attempt whose payment is captured AFTER its hold
// lapsed must be auto-refunded by the existing checkout and must NOT use the offer.
// Real time: waits for the 15-minute hold plus the expiry sweep.
//   node demo/verify/b-late-capture.mjs --profile L
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SECRETS_DIR, STATE_DIR, profile } from '../scripts/lib/demo-config.mjs';
import { checkout, publicSlots, tehranDate, tehranDay, tehranHour } from '../seed/lib/booking-flow.mjs';
import { Session, rawRequest } from '../seed/lib/client.mjs';

const i = process.argv.indexOf('--profile');
const origin = profile(i > 0 ? process.argv[i + 1] : 'L').origin;
const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'seed-state.json'), 'utf8'));
const tokensFile = path.join(SECRETS_DIR, 'seed-sessions.json');
async function as(key) {
  const tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
  const s = new Session(origin, key);
  s.refreshToken = tokens[key];
  await s.refresh();
  s.onRotate = (t) => {
    const cur = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
    cur[key] = t;
    fs.writeFileSync(tokensFile, JSON.stringify(cur));
  };
  s.onRotate(s.refreshToken);
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { pro1 } = state.ids;
const cust4 = await as('cust4');
const sPro1 = await as('pro1');
const log = (...a) => console.log(new Date().toISOString(), ...a);

const slots = await publicSlots(cust4, pro1.providerId, pro1.serviceIds.party);
const s1 = slots.find((x) => tehranDay(x.startAt) === tehranDate(3) && tehranHour(x.startAt) >= 10);
const original = await checkout(cust4, { professionalId: pro1.providerId, serviceId: pro1.serviceIds.party, slotId: s1.id, governed: true });
await sPro1.post(`/v1/bookings/${original.bookingId}/cancel`, { reason: 'لغو توسط متخصص — آزمون پرداخت دیرهنگام (دمو)' });
for (let n = 0; n < 40 && (await cust4.get(`/v1/bookings/${original.bookingId}/replacement-offer`, { expect: [200, 404] })).status !== 200; n++) await sleep(500);
log('offer created for', original.bookingId);

const s2 = slots.find((x) => tehranDay(x.startAt) === tehranDate(3) && tehranHour(x.startAt) >= 12 && x.id !== s1.id);
const acceptance = (await cust4.get(`/v1/checkout/disclosure?professionalId=${pro1.providerId}&slotId=${s2.id}&serviceId=${pro1.serviceIds.party}`)).data.acceptance;
const attempt = await cust4.post(`/v1/bookings/${original.bookingId}/replacement-offer/bookings`, { slotId: s2.id, acceptedPolicy: acceptance }, { headers: { 'Idempotency-Key': randomUUID() } });
const hold = new Date(attempt.data.booking.holdExpiresAt).getTime();
log('attempt pending until', new Date(hold).toISOString(), '— NOT paying yet');

// Wait for the hold to lapse and the expiry sweep to mark it expired.
for (;;) {
  await sleep(30_000);
  const bk = (await cust4.get(`/v1/bookings/${attempt.data.booking.id}`)).data;
  if (bk.status !== 'pending') {
    log('attempt booking is now', bk.status);
    break;
  }
  if (Date.now() > hold + 10 * 60_000) throw new Error('hold did not lapse within 10 minutes of its expiry');
}
const view1 = (await cust4.get(`/v1/bookings/${original.bookingId}/replacement-offer`)).data;
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
check('a lapsed attempt frees the offer (open, no active attempt)', view1.status === 'open' && view1.activeAttempt === null);

// Now the customer "pays" the lapsed attempt at the simulated bank.
const u = new URL(attempt.data.payment.redirectUrl, origin);
const reference = u.searchParams.get('reference');
const callback = u.searchParams.get('callback');
await rawRequest(`${origin}/api/v1/sandbox-gateway/${encodeURIComponent(reference)}/decide`, { method: 'POST', body: { decision: 'success' } });
const back = await rawRequest(`${callback}${callback.includes('?') ? '&' : '?'}reference=${encodeURIComponent(reference)}`);
check('a capture after the lapse is refunded automatically, not confirmed', /status=refunded/.test(back.headers.location ?? ''), back.headers.location);
const view2 = (await cust4.get(`/v1/bookings/${original.bookingId}/replacement-offer`)).data;
check('the late capture did NOT use the offer', view2.status === 'open' && view2.replacementBookingId === null);
const bk2 = (await cust4.get(`/v1/bookings/${attempt.data.booking.id}`)).data;
check('the lapsed attempt booking stays unconfirmed', bk2.status !== 'confirmed', bk2.status);
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
