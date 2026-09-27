// Seed/verification HTTP client. Talks to the demo ONLY through the public ingress
// (the same path a browser uses), with TLS verification ON: the private demo CA is
// passed explicitly to this process's requests — no global trust change, no bypass.
//
// Sign-in is the REAL flow: request-otp -> read the code the real OtpService
// generated from the demo inbox (as the demo owner) -> verify-otp. No dev-login.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

import { CERTS_DIR, HANDOUTS_DIR, PORTS, profile as resolveProfile } from '../../scripts/lib/demo-config.mjs';

const CA = fs.readFileSync(path.join(CERTS_DIR, 'demo-ca.crt'));

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method,
        ca: CA,
        agent: false,
        headers: {
          accept: 'application/json',
          ...(payload !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}),
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout ${method} ${url}`)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Unwraps the API envelope `{ data, meta, error }` when present. */
export const dataOf = (res) => (res.json && typeof res.json === 'object' && 'data' in res.json ? res.json.data : res.json);

export class ApiError extends Error {
  constructor(method, url, res) {
    const code = res.json?.error?.code ?? '';
    super(`${method} ${url} -> HTTP ${res.status} ${code} ${res.json?.error?.message ?? res.text.slice(0, 200)}`);
    this.status = res.status;
    this.code = code;
    this.body = res.json;
  }
}

export class DemoInbox {
  constructor() {
    this.base = `https://127.0.0.1:${PORTS.inboxViewer}`;
    this.cookie = null;
  }
  async loginAsOwner() {
    const sheet = fs.readFileSync(path.join(HANDOUTS_DIR, 'owner.txt'), 'utf8');
    const password = /Inbox password:\s+(\S+)/.exec(sheet)?.[1];
    if (!password) throw new Error('owner inbox password not found in the handout sheet');
    const res = await request(`${this.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user: 'owner', password }).toString(),
    });
    if (res.status !== 303) throw new Error(`inbox owner login failed (HTTP ${res.status})`);
    this.cookie = String(res.headers['set-cookie']?.[0] ?? '').split(';')[0];
  }
  async messages() {
    if (!this.cookie) await this.loginAsOwner();
    const res = await request(`${this.base}/api/messages`, { headers: { cookie: this.cookie } });
    if (res.status === 401) {
      this.cookie = null;
      return this.messages();
    }
    return res.json.messages;
  }
  /** Waits for a login code for `phone` received after `since` (ms epoch). The code is returned, never logged. */
  async waitForCode(phone, since, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = (await this.messages()).find((m) => m.to === phone && m.kind === 'otp' && Date.parse(m.receivedAt) >= since - 1000);
      if (hit) {
        const code = /(\d{6})/.exec(hit.text)?.[1];
        if (code) return code;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('no login code arrived in the demo inbox');
  }
}

export class Session {
  constructor(origin, label) {
    this.origin = origin;
    this.label = label;
    this.accessToken = null;
    this.user = null;
  }
  url(p) {
    return `${this.origin}/api${p}`;
  }
  async call(method, p, body, { expect } = {}) {
    const res = await request(this.url(p), {
      method,
      body,
      headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {},
    });
    const ok = expect ? [].concat(expect).includes(res.status) : res.status >= 200 && res.status < 300;
    if (!ok) throw new ApiError(method, p, res);
    return { status: res.status, data: dataOf(res), raw: res };
  }
  get(p, o) {
    return this.call('GET', p, undefined, o);
  }
  post(p, b, o) {
    return this.call('POST', p, b ?? {}, o);
  }
  put(p, b, o) {
    return this.call('PUT', p, b ?? {}, o);
  }
  patch(p, b, o) {
    return this.call('PATCH', p, b ?? {}, o);
  }
  del(p, o) {
    return this.call('DELETE', p, undefined, o);
  }
}

/** Real OTP sign-in through the ingress. */
export async function signIn(profileKey, phone, inbox, label = phone) {
  const origin = resolveProfile(profileKey).origin;
  const s = new Session(origin, label);
  const since = Date.now();
  const req = await request(s.url('/v1/auth/request-otp'), { method: 'POST', body: { phone, purpose: 'login' } });
  if (req.status !== 200) throw new ApiError('POST', '/v1/auth/request-otp', req);
  const code = await inbox.waitForCode(phone, since);
  const ver = await request(s.url('/v1/auth/verify-otp'), { method: 'POST', body: { phone, code, purpose: 'login' } });
  if (ver.status !== 200) throw new ApiError('POST', '/v1/auth/verify-otp', ver);
  const d = dataOf(ver);
  s.accessToken = d.accessToken;
  s.user = d.user;
  return s;
}
