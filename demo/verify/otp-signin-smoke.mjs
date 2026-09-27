#!/usr/bin/env node
// Smoke: real OTP sign-in through the ingress + the demo inbox, and the controls
// that must fail. Usage: node demo/verify/otp-signin-smoke.mjs [--profile L]
import { DemoInbox, Session, signIn } from '../seed/lib/client.mjs';
import { profile } from '../scripts/lib/demo-config.mjs';

const i = process.argv.indexOf('--profile');
const key = i > 0 ? process.argv[i + 1] : 'L';
const origin = profile(key).origin;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const inbox = new DemoInbox();
const s = await signIn(key, '+989120000401', inbox);
const me = await s.get('/v1/me');
check('real OTP sign-in yields a session that reads /v1/me', me.status === 200);

const anon = new Session(origin, 'anon');
const wrong = await anon.post('/v1/auth/verify-otp', { phone: '+989120000402', code: '000000', purpose: 'login' }, { expect: [400, 401, 403, 404, 422, 429] });
check('a wrong/never-requested code is refused', wrong.status >= 400, `HTTP ${wrong.status}`);

const dev = await anon.post('/v1/auth/dev-login', { phone: '+989120000401' }, { expect: [404] });
check('dev-login is unavailable through the ingress', dev.status === 404);

const unauth = await anon.get('/v1/me', { expect: [401] });
check('no session -> /v1/me is 401', unauth.status === 401);

const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
