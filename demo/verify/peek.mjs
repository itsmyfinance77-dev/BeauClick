#!/usr/bin/env node
// Read-only inspection helper: GET a path as a seeded persona and print the JSON.
//   node demo/verify/peek.mjs <personaKey> <path> [--profile L]
// Uses the persona's stored session (refresh-token rotation) or a real OTP sign-in, never dev-login.
import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from '../scripts/lib/demo-config.mjs';
import { personaSession } from './lib/persona-session.mjs';

const [key, rawPath] = process.argv.slice(2);
// `{F5-...}` placeholders resolve to seeded booking ids from state/seed-state.json.
const seedState = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'seed-state.json'), 'utf8'));
const p = rawPath.replace(/{([^}]+)}/g, (_, n) => seedState.ids.bookings?.[n]?.bookingId ?? seedState.ids[n] ?? n);
const i = process.argv.indexOf('--profile');
const s = await personaSession(i > 0 ? process.argv[i + 1] : 'L', key);
const res = await s.get(p, { expect: [200, 201, 400, 401, 403, 404, 409, 422] });
console.log(`HTTP ${res.status}  GET ${p}`);
if (res.status >= 400 && !res.raw.json) console.log(res.raw.text.slice(0, 300));
console.log(JSON.stringify(res.status >= 400 ? res.raw.json : res.data, null, 1).slice(0, 4000));
