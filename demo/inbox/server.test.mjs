// node --test demo/inbox/server.test.mjs
// Access-control, retention, logging and bind-policy tests for the demo inbox.
// Self-contained: a throwaway certificate is generated per run; TLS verification is
// ON (the client trusts only that certificate), never disabled.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  LOCKOUT_FAILURES,
  RETENTION_MS,
  assertIngestBind,
  assertViewerBind,
  createInbox,
} from './server.mjs';

const PHONE_A = '+989120000401';
const PHONE_B = '+989120000402';
const PHONE_OWNER_ONLY = '+989120000403';
const NOT_ALLOWED = '+989129999999';
const TOKEN = 't'.repeat(8) + randomBytes(24).toString('hex');

function member(id, role, phones, password) {
  const salt = randomBytes(16);
  return {
    id,
    role,
    phones,
    salt: salt.toString('base64'),
    hash: scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64'),
  };
}

let dir;
let tls;
let now = Date.UTC(2026, 8, 27, 8, 0, 0);
const logs = [];
let inbox;
let ingestPort;
let viewerPort;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdemo-inbox-test-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', crt,
    '-days', '1', '-subj', '/CN=inbox-test', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  tls = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  inbox = createInbox({
    members: [
      member('alice', 'member', [PHONE_A], 'alice-password-1'),
      member('bob', 'member', [PHONE_B], 'bob-password-1'),
      member('owner', 'owner', [], 'owner-password-1'),
    ],
    allowedPhones: [PHONE_A, PHONE_B, PHONE_OWNER_ONLY],
    ingestToken: TOKEN,
    tls,
    clock: () => now,
    log: (e) => logs.push(JSON.stringify(e)),
  });
  await new Promise((r) => inbox.ingest.listen(0, '127.0.0.1', r));
  await new Promise((r) => inbox.viewer.listen(0, '127.0.0.1', r));
  ingestPort = inbox.ingest.address().port;
  viewerPort = inbox.viewer.address().port;
});

after(() => {
  inbox.close();
  inbox.ingest.close();
  inbox.viewer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, method, path: p, headers, ca: tls.cert, agent: false },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const ingest = (to, text, token = TOKEN, kind = 'otp') =>
  request(ingestPort, {
    method: 'POST',
    path: '/ingest',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ to, text, kind }),
  });

async function login(user, password, extraHeaders = {}) {
  const res = await request(viewerPort, {
    method: 'POST',
    path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams({ user, password }).toString(),
  });
  const cookie = (res.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? null;
  return { res, cookie };
}
const messagesAs = async (cookie) =>
  JSON.parse((await request(viewerPort, { path: '/api/messages', headers: { cookie } })).body);

test('TLS verification stays on: a client that does not trust the certificate is refused', async () => {
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: viewerPort, path: '/', agent: false }, resolve);
      req.on('error', reject);
      req.end();
    }),
  );
});

test('ingest refuses a missing or wrong bearer token', async () => {
  assert.equal((await ingest(PHONE_A, 'x', null)).status, 401);
  assert.equal((await ingest(PHONE_A, 'x', 'w'.repeat(TOKEN.length))).status, 401);
  assert.equal(inbox.store.messages.length, 0);
});

test('ingest refuses and discards a recipient outside the synthetic allow-list', async () => {
  const res = await ingest(NOT_ALLOWED, 'کد ورود: 111111');
  assert.equal(res.status, 403);
  assert.equal(inbox.store.messages.length, 0);
});

test('unauthenticated viewers get a login form and no data', async () => {
  const home = await request(viewerPort, { path: '/' });
  assert.equal(home.status, 200);
  assert.match(home.body, /name="password"/);
  assert.equal((await request(viewerPort, { path: '/api/messages' })).status, 401);
  assert.equal(home.headers['cache-control'], 'no-store');
});

test('each member sees only their own synthetic account; the owner sees all', async () => {
  assert.equal((await ingest(PHONE_A, 'کد ورود بیوکلیک: 123456')).status, 202);
  assert.equal((await ingest(PHONE_B, 'کد ورود بیوکلیک: 654321')).status, 202);
  assert.equal((await ingest(PHONE_OWNER_ONLY, 'کد ورود بیوکلیک: 777777')).status, 202);

  const alice = await login('alice', 'alice-password-1');
  assert.equal(alice.res.status, 303);
  assert.equal(alice.res.headers.location, '/'); // no code, no id, no query in any URL
  assert.match(alice.res.headers['set-cookie'][0], /HttpOnly/);
  assert.match(alice.res.headers['set-cookie'][0], /SameSite=Strict/);
  assert.match(alice.res.headers['set-cookie'][0], /Secure/);
  const bob = await login('bob', 'bob-password-1');
  const owner = await login('owner', 'owner-password-1');

  const a = await messagesAs(alice.cookie);
  const b = await messagesAs(bob.cookie);
  const o = await messagesAs(owner.cookie);
  assert.deepEqual(a.messages.map((m) => m.to), [PHONE_A]);
  assert.deepEqual(b.messages.map((m) => m.to), [PHONE_B]);
  assert.equal(o.messages.length, 3);
  assert.ok(!JSON.stringify(a).includes('654321'), 'alice must not see bob\'s code');
  assert.ok(!JSON.stringify(b).includes('123456'), 'bob must not see alice\'s code');

  const aliceHtml = await request(viewerPort, { path: '/', headers: { cookie: alice.cookie } });
  assert.match(aliceHtml.body, /123456/);
  assert.doesNotMatch(aliceHtml.body, /654321|777777/);
});

test('a forged or foreign session cookie is not a session', async () => {
  const res = await request(viewerPort, { path: '/api/messages', headers: { cookie: '__Host-bcdemo_inbox=forged' } });
  assert.equal(res.status, 401);
});

test('wrong passwords are refused and lock the account after the threshold', async () => {
  const bad = await login('bob', 'nope');
  assert.equal(bad.res.status, 401);
  assert.equal(bad.cookie, null);
  for (let i = 1; i < LOCKOUT_FAILURES; i++) await login('bob', `nope-${i}`);
  const locked = await login('bob', 'bob-password-1');
  assert.equal(locked.res.status, 429, 'the right password is refused while locked');
  assert.equal(locked.cookie, null);
});

test("one account's lockout does not lock other members on the same source address", async () => {
  const alice = await login('alice', 'alice-password-1');
  assert.equal(alice.res.status, 303);
});

test('a cross-origin POST is refused', async () => {
  const res = await login('alice', 'alice-password-1', { origin: 'https://evil.example' });
  assert.equal(res.res.status, 403);
});

test('logout ends the session server-side', async () => {
  const alice = await login('alice', 'alice-password-1');
  await request(viewerPort, { method: 'POST', path: '/logout', headers: { cookie: alice.cookie } });
  assert.equal((await request(viewerPort, { path: '/api/messages', headers: { cookie: alice.cookie } })).status, 401);
});

test('messages are dropped after the retention window', async () => {
  const owner = await login('owner', 'owner-password-1');
  assert.ok((await messagesAs(owner.cookie)).messages.length > 0);
  now += RETENTION_MS + 1;
  assert.equal((await messagesAs(owner.cookie)).messages.length, 0);
});

test('no log line carries a phone number or a message body', () => {
  const all = logs.join('\n');
  for (const needle of [PHONE_A, PHONE_B, PHONE_OWNER_ONLY, NOT_ALLOWED, '123456', '654321', '777777', '111111']) {
    assert.ok(!all.includes(needle), `log leaked ${needle}`);
  }
  assert.ok(logs.some((l) => l.includes('ingest.accepted')));
});

test('bind policy: viewer only loopback or 10.20.30.0/24; ingest only loopback', () => {
  assertViewerBind('127.0.0.1');
  assertViewerBind('10.20.30.6');
  assert.throws(() => assertViewerBind('0.0.0.0'));
  assert.throws(() => assertViewerBind('192.168.100.100'));
  assert.throws(() => assertViewerBind('10.20.31.6'));
  assertIngestBind('127.0.0.1');
  assert.throws(() => assertIngestBind('10.20.30.6'));
  assert.throws(() => assertIngestBind('0.0.0.0'));
});
