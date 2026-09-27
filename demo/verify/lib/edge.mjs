// A real Microsoft Edge driven over the DevTools protocol, for the demo's browser checks.
//
// - One Edge process per persona, each with its OWN profile directory under the runtime root, so a
//   signed-in session survives between runs (the per-number OTP limit is 5/hour) and personas never
//   share cookies. Profiles are throw-away: delete E:\BeauClick-demo\state\edge-profiles after the demo.
// - TLS is validated by Edge against the Windows trust store: no certificate flags of any kind.
// - Clicks are real mouse events at the element's on-screen centre (after scrolling it into view);
//   typing is real text input. The element hit is checked with elementFromPoint first.
// - Every full page load is paced globally (the refresh throttle is per client IP, 20/min).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RUNTIME_ROOT, profile } from '../../scripts/lib/demo-config.mjs';
import { DemoInbox } from '../../seed/lib/client.mjs';
import { persona } from '../../seed/personas.mjs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export const PROFILES_DIR = path.join(RUNTIME_ROOT, 'state', 'edge-profiles');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let paceMs = 4000;
let lastLoad = 0;
export const setPace = (ms) => (paceMs = ms);
async function pace() {
  const wait = paceMs - (Date.now() - lastLoad);
  if (wait > 0) await sleep(wait);
  lastLoad = Date.now();
}

async function launch(profileDir) {
  fs.mkdirSync(profileDir, { recursive: true });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const proc = spawn(EDGE, ['--headless=new', `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  for (let n = 0; n < 80 && !fs.existsSync(portFile); n++) await sleep(250);
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
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { proc, ws, send, listeners };
}

/** A persona's browser: its own Edge + profile, one tab. `origin` is the demo origin. */
export async function personaBrowser(key, { profileKey = 'L', outDir, anonymous = false, profileName = null } = {}) {
  const origin = profile(profileKey).origin;
  // profileName: a second, independent device for the same persona (e.g. the devices/sessions check).
  const b = await launch(path.join(PROFILES_DIR, profileName ?? key));
  const { targetInfos } = await b.send('Target.getTargets');
  const target = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await b.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  const log = { console: [], http: [], throttled: 0, dialogs: [], docSecurity: null };
  let inflight = 0;
  let lastNet = Date.now();
  b.listeners.add((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    if (m.method === 'Network.requestWillBeSent') (inflight++, (lastNet = Date.now()));
    if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') (inflight = Math.max(0, inflight - 1), (lastNet = Date.now()));
    if (m.method === 'Network.responseReceived') {
      if (p.type === 'Document' && p.response.securityDetails) log.docSecurity = { protocol: p.response.securityDetails.protocol, issuer: p.response.securityDetails.issuer };
      if (p.response.status === 429) log.throttled++;
      if (p.response.status >= 400) log.http.push({ at: Date.now(), status: p.response.status, url: p.response.url.replace(origin, '') });
    }
    if (m.method === 'Runtime.exceptionThrown') log.console.push({ at: Date.now(), level: 'exception', text: (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split('\n')[0] });
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) log.console.push({ at: Date.now(), level: p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200) });
    if (m.method === 'Page.javascriptDialogOpening') {
      log.dialogs.push({ at: Date.now(), type: p.type, message: p.message });
      void s('Page.handleJavaScriptDialog', { accept: true });
    }
  });
  await s('Page.enable');
  await s('Network.enable');
  await s('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text}`);
    return r.result?.value;
  };
  const idle = async (quietMs = 900, maxMs = 15_000) => {
    const end = Date.now() + maxMs;
    while (Date.now() < end && (inflight > 0 || Date.now() - lastNet < quietMs)) await sleep(150);
  };
  const page = {
    key,
    origin,
    log,
    evaluate,
    idle,
    path: () => evaluate('location.pathname'),
    url: () => evaluate('location.href'),
    async goto(p) {
      await pace();
      const nav = await s('Page.navigate', { url: p.startsWith('http') ? p : `${origin}${p}` });
      if (nav.errorText) throw new Error(`navigation to ${p} failed: ${nav.errorText}`);
      await idle();
    },
    async reload() {
      await pace();
      await s('Page.reload', {});
      await sleep(300);
      await idle();
    },
    viewport: (width, height = width < 768 ? 844 : 800) => s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 }),
    async shot(name) {
      if (!outDir) return null;
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, Buffer.from((await s('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      return file;
    },
    text: () => evaluate(`(document.querySelector('main') ?? document.body).innerText`),
    has: async (str) => (await evaluate(`document.body.innerText`)).includes(str),
    async waitText(str, ms = 15_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await page.has(str)) return true;
        await sleep(300);
      }
      return false;
    },
    /**
     * Real mouse click on the control whose visible text equals `text` (or starts with it when
     * `prefix`), optionally inside the element matching `within` (a CSS selector).
     * Controls: button, a, [role=tab|button|radio|checkbox], label, summary.
     */
    async click(text, { within = null, prefix = false, nth = 0, selector = null } = {}) {
      const found = await evaluate(`(() => {
        const root = ${within ? `document.querySelector(${JSON.stringify(within)})` : 'document'};
        if (!root) return { error: 'scope not found: ' + ${JSON.stringify(within)} };
        const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
        const want = ${JSON.stringify(text)};
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const all = ${selector ? `[...root.querySelectorAll(${JSON.stringify(selector)})]` : `[...root.querySelectorAll('button, a, [role=tab], [role=button], [role=radio], [role=checkbox], label, summary')]`}
          .filter(vis).filter((e) => !want || (${prefix} ? norm(e.innerText).startsWith(want) : norm(e.innerText) === want) || norm(e.getAttribute('aria-label')) === want);
        const el = all[${nth}];
        if (!el) return { error: 'no visible control: ' + want, candidates: [...root.querySelectorAll('button')].filter(vis).map((b) => norm(b.innerText).slice(0, 40)).slice(0, 30) };
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { error: 'control is disabled: ' + want };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        window.__flowTarget = el;
        return { x, y, hitOk: Boolean(hit && (el === hit || el.contains(hit) || hit.contains(el))) };
      })()`);
      if (found.error) throw new Error(`${found.error}${found.candidates ? ` | buttons: ${found.candidates.join(' ¦ ')}` : ''}`);
      if (found.hitOk) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x: found.x, y: found.y, button: 'left', clickCount: 1 });
      } else {
        // Covered by an overlay at its centre (e.g. a sticky bar): record and use the element's own click.
        log.console.push({ at: Date.now(), level: 'driver', text: `click fell back to element.click(): ${text}` });
        await evaluate('window.__flowTarget.click()');
      }
      await sleep(250);
      await idle(700);
    },
    /** Focus the field labelled `label` (label text, aria-label or placeholder), clear it and type `value`. */
    async fill(label, value, { within = null, nth = 0 } = {}) {
      await idle(500);
      const kind = await evaluate(`(() => {
        const root = ${within ? `document.querySelector(${JSON.stringify(within)})` : 'document'};
        const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
        const want = ${JSON.stringify(label)};
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const el = [...root.querySelectorAll('input, textarea, select')].filter(vis).filter((f) =>
          norm(f.labels?.[0]?.innerText) === want || norm(f.getAttribute('aria-label')) === want || norm(f.placeholder) === want || norm(f.labels?.[0]?.innerText).startsWith(want))[${nth}];
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        el.focus();
        window.__flowField = el;
        return el.tagName === 'SELECT' ? 'select' : ['date', 'time', 'datetime-local', 'number'].includes(el.type) ? 'native' : 'text';
      })()`);
      if (!kind) {
        const seen = await evaluate("({ path: location.pathname, fields: [...document.querySelectorAll('input, textarea, select')].filter((e) => e.getBoundingClientRect().width > 0).map((f) => (f.labels?.[0]?.innerText || f.placeholder || f.type).trim().slice(0, 30)) })");
        throw new Error(`no visible field labelled: ${label} | at ${seen.path} | fields: ${seen.fields.join(' ¦ ')}`);
      }
      if (kind === 'text') {
        await evaluate(`(() => { const f = window.__flowField; f.select?.(); })()`);
        await s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
        await s('Input.insertText', { text: String(value) });
      } else {
        // <select>, date/time/number: set through the element's own value setter and fire the events a
        // user's choice fires (React listens to 'input'/'change').
        await evaluate(`(() => { const f = window.__flowField; const proto = Object.getPrototypeOf(f);
          const want = ${JSON.stringify(String(value))};
          // <select>: choose by the option's visible text (values are ids), else by value.
          const v = f.tagName === 'SELECT' ? ([...f.options].find((o) => o.text.trim() === want)?.value ?? want) : want;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(f, v);
          f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      }
      await sleep(200);
    },
    /** The browser's cookies for the demo origin (DevTools can read HttpOnly ones) — for replay checks. */
    cookies: async () => (await s('Network.getCookies', { urls: [origin] })).cookies,
    /** Measures the page at 390: whole-document horizontal overflow. */
    overflow: () => evaluate(`({ scrollW: document.documentElement.scrollWidth, W: document.documentElement.clientWidth })`),
    async close() {
      try {
        await b.send('Browser.close');
      } catch {
        b.proc.kill();
      }
      b.ws.close();
    },
  };

  // Sign in only when the stored session no longer works (a restore invalidates it).
  if (!anonymous) {
    try {
      await page.goto('/dashboard');
      // An expired session is sent to /auth client-side, a moment after load: let the path settle.
      for (let n = 0; n < 20 && (await page.path()) === '/dashboard' && !(await page.has('حساب من')); n++) await sleep(250);
      if ((await page.path()) === '/auth') await signIn(page, key);
    } catch (e) {
      await page.close(); // never leave an Edge holding this profile's lock
      throw e;
    }
  }
  return page;
}

let inbox;
/** The real sign-in: request a code, read it from the demo inbox (as the owner), enter it. */
export async function signIn(page, key) {
  const phone = persona(key).phone;
  if ((await page.path()) !== '/auth') await page.goto('/auth');
  for (let n = 0; n < 40 && !(await page.evaluate("Boolean(document.querySelector('input[autocomplete=tel]'))")); n++) await sleep(250);
  let since = Date.now();
  await page.fill('09123456789', `0${phone.slice(3)}`);
  await page.click('ارسال کد یک‌بارمصرف');
  let code;
  try {
    code = await (inbox ??= new DemoInbox()).waitForCode(phone, since);
  } catch {
    // The app refused the request (60 s resend cooldown after another sign-in of the same number).
    // Like a user: wait the cooldown out and ask once more. Never more than once; never a bypass.
    page.log.console.push({ at: Date.now(), level: 'driver', text: `${key}: code refused, waiting out the 60 s cooldown once` });
    await sleep(65_000);
    await page.goto('/auth');
    since = Date.now();
    await page.fill('09123456789', `0${phone.slice(3)}`);
    await page.click('ارسال کد یک‌بارمصرف');
    code = await inbox.waitForCode(phone, since);
  }
  await page.fill('کد یک‌بارمصرف', code);
  await page.click('تأیید و ورود');
  for (let n = 0; n < 60 && (await page.path()) === '/auth'; n++) await sleep(250);
  await page.idle();
  if ((await page.path()) === '/auth') throw new Error(`${key}: sign-in did not complete`);
}
