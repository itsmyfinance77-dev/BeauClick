#!/usr/bin/env node
// DEMO-DEC-001 A — real API + DB checks (through the ingress, real OTP sessions).
//   node demo/verify/a-acceptance.mjs --profile L
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from '../scripts/lib/demo-config.mjs';
import { checkout, publicSlots, tehranDate, tehranDay } from '../seed/lib/booking-flow.mjs';
import { personaSession } from './lib/persona-session.mjs';

const i = process.argv.indexOf('--profile');
const profileKey = i > 0 ? process.argv[i + 1] : 'L';
const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'seed-state.json'), 'utf8'));
const as = (key) => personaSession(profileKey, key);
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const { pro1, pro2 } = state.ids;
const cust4 = await as('cust4');
const cust2 = await as('cust2');

const slots = await publicSlots(cust4, pro1.providerId, pro1.serviceIds.brow);
const slot = slots.find((s) => tehranDay(s.startAt) === tehranDate(5));
const q = `professionalId=${pro1.providerId}&slotId=${slot.id}&serviceId=${pro1.serviceIds.brow}`;
const d = (await cust4.get(`/v1/checkout/disclosure?${q}`)).data;
check('governed seller: disclosure requires acceptance and discloses identifiers', d.acceptanceRequired === true && d.acceptance?.policyKey === state.ids.policies.outcome.key);

const base = { professionalId: pro1.providerId, slotId: slot.id, serviceId: pro1.serviceIds.brow };
const key = () => ({ headers: { 'Idempotency-Key': randomUUID() } });
const missing = await cust4.post('/v1/bookings', base, { ...key(), expect: [201, 409] });
check('missing acceptance is refused', missing.status === 409, `HTTP ${missing.status} ${missing.raw.json?.error?.code}`);
const stale = await cust4.post('/v1/bookings', { ...base, acceptedPolicy: { ...d.acceptance, policyVersion: d.acceptance.policyVersion + 1 } }, { ...key(), expect: [201, 409] });
check('stale/mismatched acceptance is refused', stale.status === 409, `HTTP ${stale.status}`);

const booked = await checkout(cust4, { ...base, governed: true, decision: 'success' });
check('exact acceptance books and pays through the sandbox bank', Boolean(booked.bookingId) && /status=succeeded/.test(booked.resultLocation ?? ''));

const terms = (await cust4.get(`/v1/bookings/${booked.bookingId}/accepted-terms`)).data;
check(
  'accepted terms are persisted with the booking (exact versions, copy text, acceptance instant)',
  terms.governed === true && terms.policy.policyVersion === d.acceptance.policyVersion && terms.copy.copyVersion === d.acceptance.copyVersion && terms.copy.body === d.outcome.copy.body && Boolean(terms.acceptedAt),
);
const foreign = await cust2.get(`/v1/bookings/${booked.bookingId}/accepted-terms`, { expect: [200, 403, 404] });
check("another customer cannot read this booking's terms", foreign.status === 404, `HTTP ${foreign.status}`);

const f1 = state.ids.bookings['F1-paid-pro2'];
const ungoverned = (await (await as(f1.customerKey)).get(`/v1/bookings/${f1.bookingId}/accepted-terms`)).data;
check('unenrolled booking: no terms are fabricated', ungoverned.governed === false);
const pSlots = await publicSlots(cust4, pro2.providerId, pro2.serviceIds.mani);
const ps = pSlots.find((s) => tehranDay(s.startAt) === tehranDate(6));
const pd = (await cust4.get(`/v1/checkout/disclosure?professionalId=${pro2.providerId}&slotId=${ps.id}&serviceId=${pro2.serviceIds.mani}`)).data;
check('unenrolled seller: disclosure requires nothing', pd.acceptanceRequired === false && pd.acceptance === null && pd.outcome === null);
const unexpected = await cust4.post('/v1/bookings', { professionalId: pro2.providerId, slotId: ps.id, serviceId: pro2.serviceIds.mani, acceptedPolicy: d.acceptance }, { ...key(), expect: [201, 409] });
check('an acceptance sent to an unenrolled seller is refused (never silently attached)', unexpected.status === 409, `HTTP ${unexpected.status}`);

const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
