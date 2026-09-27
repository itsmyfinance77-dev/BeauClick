// BeauClick DEMO message inbox — the local stand-in for an SMS gateway.
//
// SIMULATION: nothing sent here ever leaves this machine. It receives (a) the
// one-time login codes the real OtpService generated, delivered by the demo-only
// OTP adapter, and (b) SMS notifications from the real SmsChannel/HttpSmsProvider.
//
// Owner requirements this file implements (DEMO_PROGRESS.md, Milestone 1b):
//  - its OWN authentication (per-member password, scrypt), independent of the app
//    and of WireGuard presence;
//  - server-side ownership: a member sees only messages addressed to the synthetic
//    phone(s) assigned to them; the demo owner sees all; no message is addressable
//    by id, so there is nothing to enumerate;
//  - synthetic allow-list at ingest; everything else is refused and discarded;
//  - memory-only retention, each message dropped after RETENTION_MS;
//  - no code or phone number in any URL or log line;
//  - ingest listener is loopback-only; the viewer binds only loopback or the
//    WireGuard subnet, never 0.0.0.0 and never a public address.
//
// Node built-ins only: no dependency is added to the repository.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export const RETENTION_MS = 180_000;
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
export const LOCKOUT_FAILURES = 5;
/** Per source address: higher, because several members may share one source (NAT, loopback). */
export const LOCKOUT_SOURCE_FAILURES = 20;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MAX_MESSAGES = 500;
const MAX_BODY_BYTES = 4096;
const COOKIE = '__Host-bcdemo_inbox';

// ---------------------------------------------------------------------------
// Bind-address policy
// ---------------------------------------------------------------------------
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
export function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1';
}
export function inWireGuardSubnet(host, network = '10.20.30.0', prefix = 24) {
  if (!net.isIPv4(host)) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipv4ToInt(host) & mask) === (ipv4ToInt(network) & mask);
}
export function assertViewerBind(host) {
  if (!(isLoopback(host) || inWireGuardSubnet(host))) {
    throw new Error(`Refusing to bind the inbox viewer on "${host}": only loopback or the WireGuard subnet 10.20.30.0/24 is allowed.`);
  }
}
export function assertIngestBind(host) {
  if (!isLoopback(host)) throw new Error(`Refusing to bind the inbox ingest on "${host}": loopback only.`);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export class MessageStore {
  constructor({ clock = () => Date.now(), retentionMs = RETENTION_MS } = {}) {
    this.clock = clock;
    this.retentionMs = retentionMs;
    this.messages = [];
    this.seq = 0;
  }
  add(to, text, kind) {
    const now = this.clock();
    const msg = { id: ++this.seq, to, text, kind, receivedAt: now, expiresAt: now + this.retentionMs };
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    return msg;
  }
  purge() {
    const now = this.clock();
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.expiresAt > now);
    return before - this.messages.length;
  }
  /** The ONLY read path: filtered server-side by the caller's member record. */
  visibleTo(member) {
    this.purge();
    const mine = member.role === 'owner' ? this.messages : this.messages.filter((m) => member.phones.includes(m.to));
    return mine.slice().reverse();
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const DUMMY_SALT = randomBytes(16);
const DUMMY_HASH = Buffer.alloc(64);

export class Authenticator {
  constructor(members, { clock = () => Date.now() } = {}) {
    this.members = new Map(members.map((m) => [m.id, m]));
    this.clock = clock;
    this.failures = new Map(); // key -> [timestamps]
    this.sessions = new Map(); // sid -> { memberId, lastSeen }
  }
  locked(key, threshold) {
    const now = this.clock();
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < LOCKOUT_WINDOW_MS);
    this.failures.set(key, list);
    return list.length >= threshold;
  }
  fail(key) {
    const list = this.failures.get(key) ?? [];
    list.push(this.clock());
    this.failures.set(key, list);
  }
  async login(userId, password, source) {
    const userKey = `u:${userId}`;
    const srcKey = `s:${source}`;
    if (this.locked(userKey, LOCKOUT_FAILURES) || this.locked(srcKey, LOCKOUT_SOURCE_FAILURES)) return { ok: false, reason: 'locked' };
    const member = this.members.get(String(userId ?? ''));
    // Always pay the scrypt cost so an unknown user is not distinguishable by time.
    const salt = member ? Buffer.from(member.salt, 'base64') : DUMMY_SALT;
    const expected = member ? Buffer.from(member.hash, 'base64') : DUMMY_HASH;
    const actual = await scrypt(String(password ?? ''), salt, 64, { N: 16384, r: 8, p: 1 });
    const match = member !== undefined && timingSafeEqual(actual, expected);
    if (!match) {
      this.fail(userKey);
      this.fail(srcKey);
      return { ok: false, reason: 'invalid' };
    }
    this.failures.delete(userKey);
    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sid, { memberId: member.id, lastSeen: this.clock() });
    return { ok: true, sid, member };
  }
  session(sid) {
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    const now = this.clock();
    if (now - s.lastSeen > SESSION_IDLE_MS) {
      this.sessions.delete(sid);
      return null;
    }
    s.lastSeen = now;
    return this.members.get(s.memberId) ?? null;
  }
  logout(sid) {
    this.sessions.delete(sid);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function cookieValue(req, name) {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STYLE = `body{font-family:Tahoma,Arial,sans-serif;margin:0;background:#f6f4f1;color:#222}
main{max-width:720px;margin:0 auto;padding:16px}
.banner{background:#7a1f3d;color:#fff;padding:10px 16px;font-size:14px}
.card{background:#fff;border-radius:10px;padding:14px 16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.meta{color:#666;font-size:12px}.text{font-size:18px;margin-top:6px;white-space:pre-wrap;word-break:break-word}
label{display:block;margin:10px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;font-size:16px}
button{margin-top:14px;padding:10px 18px;font-size:16px;border:0;border-radius:8px;background:#7a1f3d;color:#fff;cursor:pointer}
.err{color:#b00020}.row{display:flex;justify-content:space-between;align-items:center;gap:8px}`;
const STYLE_HASH = `sha256-${createHash('sha256').update(STYLE).digest('base64')}`;

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src '${STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=600');
}
function page(res, status, title, body, { refresh = false } = {}) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="5">' : ''}
<title>${esc(title)}</title><style>${STYLE}</style></head><body>
<div class="banner">صندوق پیامک آزمایشی دمو — شبیه‌سازی؛ هیچ پیامکی واقعاً ارسال نمی‌شود.</div>
<main>${body}</main></body></html>`);
}
function json(res, status, obj) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** POSTs must come from this origin (or carry no Origin, e.g. a non-browser client). */
function sameOriginPost(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------
export function createInbox({ members, allowedPhones, ingestToken, tls, clock, retentionMs, log = () => {} }) {
  if (!ingestToken || ingestToken.length < 32) throw new Error('ingest token must be at least 32 characters');
  const allow = new Set(allowedPhones);
  for (const m of members) {
    for (const p of m.phones) if (!allow.has(p)) throw new Error(`member ${m.id} is assigned a phone outside the synthetic allow-list`);
  }
  const store = new MessageStore({ clock, retentionMs });
  const auth = new Authenticator(members, { clock });
  const tokenBuf = Buffer.from(`Bearer ${ingestToken}`);

  const ingest = https.createServer({ ...tls, minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/ingest') return json(res, 404, { error: 'not_found' });
      const presented = Buffer.from(String(req.headers.authorization ?? ''));
      if (presented.length !== tokenBuf.length || !timingSafeEqual(presented, tokenBuf)) {
        log({ event: 'ingest.refused', reason: 'auth' });
        return json(res, 401, { error: 'unauthorized' });
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return json(res, e.status ?? 400, { error: 'bad_request' });
      }
      const to = typeof body?.to === 'string' ? body.to.trim() : '';
      const text = typeof body?.text === 'string' ? body.text : '';
      const kind = body?.kind === 'otp' ? 'otp' : 'notification';
      if (!allow.has(to)) {
        // Discarded, and the number is not logged.
        log({ event: 'ingest.refused', reason: 'not_allow_listed' });
        return json(res, 403, { error: 'recipient_not_allow_listed' });
      }
      if (!text || text.length > 1000) return json(res, 400, { error: 'bad_request' });
      const msg = store.add(to, text, kind);
      const owners = members.filter((m) => m.role !== 'owner' && m.phones.includes(to)).map((m) => m.id);
      log({ event: 'ingest.accepted', id: msg.id, kind, members: owners.length ? owners : ['owner-only'] });
      return json(res, 202, { accepted: true, id: `inbox-${msg.id}` });
    } catch {
      return json(res, 500, { error: 'internal' });
    }
  });

  const viewer = https.createServer({ ...tls, minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      const url = new URL(req.url, 'https://inbox.invalid');
      const sid = cookieValue(req, COOKIE);
      const member = auth.session(sid);

      if (req.method === 'POST' && !sameOriginPost(req)) return page(res, 403, 'ممنوع', '<p class="err">درخواست نامعتبر.</p>');

      if (req.method === 'POST' && url.pathname === '/login') {
        let form;
        try {
          form = new URLSearchParams(await readBody(req));
        } catch (e) {
          return page(res, e.status ?? 400, 'خطا', '<p class="err">درخواست نامعتبر.</p>');
        }
        const result = await auth.login(form.get('user'), form.get('password'), req.socket.remoteAddress ?? 'unknown');
        log({ event: 'login', user: String(form.get('user') ?? '').slice(0, 64), outcome: result.ok ? 'ok' : result.reason });
        if (!result.ok) {
          const msg = result.reason === 'locked' ? 'به‌دلیل تلاش‌های ناموفق، ورود موقتاً قفل است.' : 'نام کاربری یا گذرواژه نادرست است.';
          return page(res, result.reason === 'locked' ? 429 : 401, 'ورود', loginForm(msg));
        }
        securityHeaders(res);
        res.writeHead(303, {
          Location: '/',
          'Set-Cookie': `${COOKIE}=${result.sid}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_IDLE_MS / 1000}`,
        });
        return res.end();
      }

      if (req.method === 'POST' && url.pathname === '/logout') {
        if (sid) auth.logout(sid);
        securityHeaders(res);
        res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
        return res.end();
      }

      if (req.method === 'GET' && url.pathname === '/api/messages') {
        if (!member) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, {
          member: member.id,
          messages: store.visibleTo(member).map((m) => ({
            to: m.to,
            text: m.text,
            kind: m.kind,
            receivedAt: new Date(m.receivedAt).toISOString(),
            expiresAt: new Date(m.expiresAt).toISOString(),
          })),
        });
      }

      if (req.method === 'GET' && url.pathname === '/') {
        if (!member) return page(res, 200, 'ورود به صندوق پیامک دمو', loginForm());
        const list = store.visibleTo(member);
        const scope =
          member.role === 'owner'
            ? 'همهٔ حساب‌های ساختگی (مالک دمو)'
            : member.phones.map((p) => `<bdi>${esc(p)}</bdi>`).join('، ');
        const items = list.length
          ? list
              .map(
                (m) => `<div class="card"><div class="meta"><bdi>${esc(m.to)}</bdi> · ${m.kind === 'otp' ? 'کد ورود' : 'اعلان'} · ${esc(
                  new Date(m.receivedAt).toLocaleTimeString('fa-IR', { timeZone: 'Asia/Tehran' }),
                )}</div><div class="text">${esc(m.text)}</div></div>`,
              )
              .join('')
          : '<div class="card">پیامی نیست. پیام‌ها فقط ۳ دقیقه نگه داشته می‌شوند.</div>';
        return page(
          res,
          200,
          'صندوق پیامک دمو',
          `<div class="row"><div><strong>${esc(member.id)}</strong><div class="meta">دامنهٔ دید: ${scope}</div></div>
<form method="post" action="/logout"><button type="submit">خروج</button></form></div>${items}`,
          { refresh: true },
        );
      }

      return page(res, 404, 'یافت نشد', '<p>یافت نشد.</p>');
    } catch {
      return page(res, 500, 'خطا', '<p class="err">خطای داخلی.</p>');
    }
  });

  const purgeTimer = setInterval(() => store.purge(), 5000);
  purgeTimer.unref();

  return { ingest, viewer, store, auth, close: () => clearInterval(purgeTimer) };
}

function loginForm(error) {
  return `<div class="card"><h1>ورود به صندوق پیامک دمو</h1>
<p class="meta">فقط برای اعضای تیم. هر عضو فقط پیام‌های حساب ساختگی خودش را می‌بیند.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/login" autocomplete="off">
<label for="user">نام کاربری</label><input id="user" name="user" required dir="ltr">
<label for="password">گذرواژه</label><input id="password" name="password" type="password" required dir="ltr">
<button type="submit">ورود</button></form></div>`;
}
