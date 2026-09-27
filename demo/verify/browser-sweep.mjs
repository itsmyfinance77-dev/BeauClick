#!/usr/bin/env node
// Real-browser sweep of every demo role at desktop (1280) and phone (390) width.
//
//   node demo/verify/browser-sweep.mjs --profile L [--only cust1,admin]
//
// Drives a SEPARATE headless Microsoft Edge (own throw-away profile) over the DevTools
// protocol. TLS is validated by the browser against the Windows trust store: no
// --ignore-certificate-errors, no ignoreHTTPSErrors, no interstitial bypass; a
// certificate failure is recorded as a failure. Every persona signs in the real way
// (request code -> read it from the demo inbox as the owner -> enter it). No dev-login.
//
// Writes screenshots + report.json to E:\BeauClick-demo\evidence\browser-<stamp>\.
// The screenshots are labelled FALLBACK material, not a live run.
// Page loads are paced (the refresh throttle is per client IP, 20/min) and every 429
// is counted — that is the rehearsal measurement of the shared-ingress risk.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RUNTIME_ROOT, STATE_DIR, profile } from '../scripts/lib/demo-config.mjs';
import { DemoInbox } from '../seed/lib/client.mjs';
import { persona } from '../seed/personas.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
const origin = profile(arg('--profile') ?? 'L').origin;
const only = arg('--only')?.split(',');
// Minimum gap between full page loads; each full load makes one refresh call (per-IP 20/min).
const paceMs = Number(arg('--pace-ms') ?? 3200);
const onlyPaths = arg('--paths')?.split(',');
const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'seed-state.json'), 'utf8'));
const { pro1 } = state.ids;
const tourBooking = state.ids.replacementTour?.original;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(RUNTIME_ROOT, 'evidence', `browser-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'README.txt'),
  'FALLBACK SCREENSHOTS — captured from the demo in a real browser; NOT a live run.\nAll data is synthetic. Show only if the live demo fails, and say so.\n',
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pages per persona
const click = (text, scope = 'document') =>
  `[...(${scope}).querySelectorAll('button,[role=tab],a')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`;
const openBookingPanels = (id) => `(async () => {
  ${click('گذشته')}; await new Promise((r) => setTimeout(r, 1500));
  const card = document.querySelector('li[data-booking="${id}"]');
  if (!card) return 'tour booking not listed';
  for (const t of ['شرایط پذیرفته‌شده', 'بازپرداخت و جبران', 'پیشنهاد جایگزینی']) ${click('t', 'card').replace('"t"', 't')};
  await new Promise((r) => setTimeout(r, 2500));
  // A customer-cancelled booking has no offer: its panel must say so, not open empty.
  const none = document.querySelector('li[data-booking="${state.ids.bookings?.['F7-governed-paid-customer-cancels']?.bookingId}"]');
  if (none) ${click('پیشنهاد جایگزینی', 'none')};
  await new Promise((r) => setTimeout(r, 2000));
  card.scrollIntoView({ block: 'start' });
  return JSON.stringify({ tour: card.innerText.slice(0, 160), customerCancelled: none?.querySelector('[data-testid=replacement-none]')?.innerText ?? 'NO MESSAGE' });
})()`;
const pickSlot = `(async () => {
  const b = (t) => [...document.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith(t));
  b('میکاپ مجلسی')?.click(); await new Promise((r) => setTimeout(r, 1500));
  const times = [...document.querySelectorAll('button')].filter((x) => /^[۰-۹]{2}:[۰-۹]{2}$/.test(x.innerText.trim()));
  times.at(-1)?.click(); await new Promise((r) => setTimeout(r, 2500));
  const cb = document.querySelector('input[type=checkbox]');
  cb?.closest('section,div')?.scrollIntoView({ block: 'center' });
  const pay = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('ادامه به پرداخت'));
  return JSON.stringify({ termsShown: Boolean(cb), prechecked: cb?.checked ?? null, payDisabled: pay?.disabled ?? null });
})()`;

const P = [
  {
    key: 'cust1',
    pages: [
      ['/dashboard'],
      ['/bookings', tourBooking && openBookingPanels(tourBooking)],
      [`/providers/${pro1.providerId}`, pickSlot],
      ['/search'],
      ['/wishlist'],
      ['/loyalty'],
      ['/referral'],
      ['/journey'],
      ['/notifications'],
      ['/messages'],
      ['/assistant'],
      ['/account/privacy'],
      ['/waitlist'],
    ],
    forbidden: ['/admin', '/admin/users', '/pro/bookings', '/business', '/finance'],
  },
  {
    key: 'pro1',
    pages: [['/pro'], ['/pro/bookings'], ['/pro/availability'], ['/pro/services'], ['/pro/profile'], ['/pro/outcome-policy'], ['/pro/finance'], ['/pro/analytics'], ['/pro/messages']],
    forbidden: ['/admin', '/business'],
  },
  { key: 'bizOwner', pages: [['/business'], ['/business/messages'], ['/finance']], forbidden: ['/admin', '/pro/bookings'] },
  { key: 'bizManager', pages: [['/business'], ['/business/messages']], forbidden: ['/admin'] },
  { key: 'financeReader', pages: [['/business'], ['/finance']], forbidden: ['/admin'] },
  { key: 'moderator', pages: [['/admin'], ['/admin/reviews'], ['/admin/verification'], ['/admin/media'], ['/admin/chat-reports']], forbidden: ['/admin/users', '/admin/commercial/plans', '/admin/audit-log'] },
  {
    key: 'admin',
    pages: [
      ['/admin'],
      ['/admin/users'],
      ['/admin/audit-log'],
      ['/admin/commercial/commission-policies'],
      ['/admin/commercial/outcome-policy'],
      ['/admin/commercial/plans'],
      ['/admin/commercial/control-plane'],
      ['/admin/settlements'],
      ['/admin/search'],
      ['/admin/loyalty'],
      ['/admin/notifications'],
      ['/admin/phone-conflicts'],
      ['/admin/privacy'],
    ],
    forbidden: [],
  },
].filter((p) => !only || only.includes(p.key));

// ---------------------------------------------------------------- DevTools plumbing
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdemo-edge-'));
const edge = spawn(EDGE, ['--headless=new', `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', 'about:blank'], { stdio: 'ignore' });
let portFile;
for (let n = 0; n < 60 && !fs.existsSync((portFile = path.join(profileDir, 'DevToolsActivePort'))); n++) await sleep(250);
const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let seq = 0;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(`${m.error.message}`)) : resolve(m.result);
  } else if (m.method) for (const l of listeners) l(m);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

async function newPage() {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  const log = { console: [], failed: [], throttled: 0, docSecurity: null };
  let inflight = 0;
  let lastNet = Date.now();
  listeners.add((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    if (m.method === 'Network.requestWillBeSent') (inflight++, (lastNet = Date.now()));
    if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') (inflight = Math.max(0, inflight - 1), (lastNet = Date.now()));
    if (m.method === 'Network.loadingFailed' && !p.canceled) log.failed.push({ error: p.errorText });
    if (m.method === 'Network.responseReceived') {
      if (p.type === 'Document' && p.response.securityDetails) {
        const d = p.response.securityDetails;
        log.docSecurity = { protocol: d.protocol, subject: d.subjectName, issuer: d.issuer, validTo: new Date(d.validTo * 1000).toISOString(), sans: d.sanList };
      }
      if (p.response.status === 429) log.throttled++;
      if (p.response.status >= 400) log.failed.push({ status: p.response.status, url: p.response.url.replace(origin, '') });
    }
    if (m.method === 'Runtime.exceptionThrown') log.console.push({ level: 'exception', text: p.exceptionDetails.exception?.description?.split('\n')[0] ?? p.exceptionDetails.text });
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) log.console.push({ level: p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200) });
    if (m.method === 'Log.entryAdded' && p.entry.level === 'error') log.console.push({ level: 'log', text: `${p.entry.text} ${p.entry.url?.replace(origin, '') ?? ''}`.slice(0, 200) });
  });
  await s('Page.enable');
  await s('Network.enable');
  await s('Runtime.enable');
  await s('Log.enable');
  const evaluate = async (expression) => (await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const idle = async (quietMs = 900, maxMs = 12_000) => {
    const end = Date.now() + maxMs;
    while (Date.now() < end && (inflight > 0 || Date.now() - lastNet < quietMs)) await sleep(150);
  };
  let lastLoad = 0;
  const goto = async (url) => {
    const wait = paceMs - (Date.now() - lastLoad);
    if (wait > 0) await sleep(wait);
    lastLoad = Date.now();
    const nav = await s('Page.navigate', { url });
    if (nav.errorText) return { errorText: nav.errorText };
    await idle();
    return {};
  };
  const viewport = (width, height) => s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  const shot = async (file) => fs.writeFileSync(file, Buffer.from((await s('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const type = async (selector, text) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await s('Input.insertText', { text });
  };
  return { s, log, evaluate, idle, goto, viewport, shot, type, close: () => send('Target.disposeBrowserContext', { browserContextId }) };
}

// ---------------------------------------------------------------- the sweep
const inbox = new DemoInbox();
// Reports the DEEPEST offending elements (no offending child) — the ones that force the width.
const overflow = `(() => { const W = document.documentElement.clientWidth;
  const wide = (e) => e.getBoundingClientRect().width > W + 1 && !e.closest('.bc-visually-hidden');
  const out = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > W + 1 || r.left < -1) && !e.closest('.bc-visually-hidden'); };
  // Prefer the deepest element WIDER than the screen (the cause); else the deepest one pushed out of it.
  const bad = [...document.querySelectorAll('body *')].some(wide) ? wide : out;
  const off = [...document.querySelectorAll('body *')].filter((e) => bad(e) && ![...e.children].some(bad))
    .slice(0, 5).map((e) => e.tagName + '.' + String(e.className?.baseVal ?? e.className ?? '').slice(0, 40) + ' w=' + Math.round(e.getBoundingClientRect().width) + ' "' + (e.innerText ?? '').slice(0, 60) + '"');
  return { scrollW: document.documentElement.scrollWidth, W, off }; })()`;
const snapshot = `(() => ({ path: location.pathname, dir: document.documentElement.dir, lang: document.documentElement.lang,
  banner: document.body.innerText.includes('نسخهٔ نمایشی'), h1: document.querySelector('h1')?.innerText ?? null,
  text: (document.querySelector('main') ?? document.body).innerText.replace(/\\s+/g, ' ').slice(0, 220) }))()`;

const report = { origin, startedAt: new Date().toISOString(), edge: EDGE, flags: 'headless=new, fresh profile, NO certificate-error flags', personas: [] };
const slug = (p) => p.replace(/^\//, '').replace(/[/?=&]/g, '_') || 'home';

for (const who of P) {
  const page = await newPage();
  const r = { key: who.key, pages: [], forbidden: [] };
  report.personas.push(r);
  await page.viewport(1280, 800);
  // Real sign-in.
  const phone = persona(who.key).phone;
  const nav = await page.goto(`${origin}/auth`);
  if (nav.errorText) {
    r.signIn = { ok: false, error: nav.errorText };
    await page.close();
    continue;
  }
  r.tls = page.log.docSecurity;
  const since = Date.now();
  await page.type('input[autocomplete=tel]', `0${phone.slice(3)}`);
  await page.evaluate(`[...document.querySelectorAll('button[type=submit]')][0].click()`);
  const code = await inbox.waitForCode(phone, since);
  for (let n = 0; n < 40 && !(await page.evaluate(`Boolean(document.querySelector('input[autocomplete=one-time-code]'))`)); n++) await sleep(250);
  await page.type('input[autocomplete=one-time-code]', code);
  await page.evaluate(`[...document.querySelectorAll('button[type=submit]')].find((b) => b.textContent.includes('تأیید'))?.click()`);
  for (let n = 0; n < 60 && (await page.evaluate('location.pathname')) === '/auth'; n++) await sleep(250);
  await page.idle();
  r.signIn = { ok: (await page.evaluate('location.pathname')) !== '/auth', landedOn: await page.evaluate('location.pathname') };
  if (!r.signIn.ok) {
    await page.close();
    continue;
  }

  for (const [p, action] of who.pages.filter(([x]) => !onlyPaths || onlyPaths.includes(x))) {
    const before = { console: page.log.console.length, failed: page.log.failed.length };
    await page.viewport(1280, 800);
    const g = await page.goto(`${origin}${p}`);
    const entry = { path: p };
    if (g.errorText) {
      entry.navError = g.errorText;
      r.pages.push(entry);
      continue;
    }
    if (action) entry.action = await page.evaluate(action);
    await page.idle();
    Object.assign(entry, await page.evaluate(snapshot));
    await page.shot(path.join(OUT, `${who.key}-${slug(p)}-1280.png`));
    await page.viewport(390, 844);
    await sleep(900);
    if (action && p.startsWith('/providers')) await page.evaluate(`document.querySelector('input[type=checkbox]')?.closest('section,div')?.scrollIntoView({ block: 'center' })`);
    if (action && p === '/bookings') await page.evaluate(`document.querySelector('li[data-booking="${tourBooking}"]')?.scrollIntoView({ block: 'start' })`);
    entry.phone390 = await page.evaluate(overflow);
    await page.shot(path.join(OUT, `${who.key}-${slug(p)}-390.png`));
    entry.console = page.log.console.slice(before.console);
    entry.failed = page.log.failed.slice(before.failed);
    r.pages.push(entry);
    console.log(`${who.key.padEnd(13)} ${p.padEnd(40)} -> ${entry.path}  ${entry.phone390.scrollW > entry.phone390.W ? 'OVERFLOW' : 'fits'}  console:${entry.console.length} http>=400:${entry.failed.length}`);
  }
  await page.viewport(1280, 800);
  for (const p of who.forbidden.filter((x) => !onlyPaths || onlyPaths.includes(x))) {
    const g = await page.goto(`${origin}${p}`);
    const snap = g.errorText ? { navError: g.errorText } : await page.evaluate(snapshot);
    r.forbidden.push({ tried: p, ...snap });
    console.log(`${who.key.padEnd(13)} FORBIDDEN ${p.padEnd(30)} -> ${snap.path}  ${snap.text?.slice(0, 90)}`);
  }
  r.throttled429 = page.log.throttled;
  await page.close();
}

report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
ws.close();
edge.kill();
await sleep(500);
fs.rmSync(profileDir, { recursive: true, force: true });
console.log(`report: ${path.join(OUT, 'report.json')}`);
