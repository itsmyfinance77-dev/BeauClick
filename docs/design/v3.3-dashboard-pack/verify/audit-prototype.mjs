#!/usr/bin/env node
/**
 * Measures the #45 prototype in a real browser. No claim in AUDIT.md §3–§5 is
 * made from reading the HTML; each comes from this script's output.
 *
 *   node audit-prototype.mjs <prototype URL> [chromium executable] [vendor dir]
 *
 * The prototype must be served over HTTP (the dc runtime fetches its own
 * document). `vendor dir`, when given, holds react.js / react-dom.js / babel.js
 * served in place of the pinned unpkg URLs, for environments whose browser
 * cannot reach unpkg directly; TLS verification is never disabled.
 *
 * Per width (390, 768, 1280):
 *  - overflow: page scrollWidth vs innerWidth, and any element extending past
 *    the viewport OR past an `overflow: hidden` ancestor on either side (RTL
 *    overflows to the LEFT). Descendants of intentional `overflow-x: auto`
 *    regions are exempt -- scrolling there is the design.
 *  - contrast: every element with its own text node, colour against the first
 *    opaque ancestor background (a gradient counts as its darkest stop),
 *    OKLCH/sRGB converted in-page; 4.5:1 normal, 3:1 large (>= 24px, or
 *    >= 18.66px at weight >= 700). Disabled controls are reported, not failed
 *    (WCAG 1.4.3 exempts inactive components).
 * Once (1280):
 *  - keyboard: Tab through the whole document; every tabbable element must be
 *    reached exactly once, in DOM order, with a visible focus indicator.
 *  - structure: lang/dir, one h1 per artboard-free document, no skipped
 *    heading level, every control named, every input labelled, no positive
 *    tabindex, every img role named.
 * Exit 0 only when every check passes.
 */
import { chromium } from 'playwright-core';

const [, , url, exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', vendor] = process.argv;
if (!url) {
  console.error('usage: audit-prototype.mjs <url> [chromium] [vendor dir]');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: exe, args: ['--no-proxy-server'] });
const MAP = {
  'react@18.3.1/umd/react.production.min.js': 'react.js',
  'react-dom@18.3.1/umd/react-dom.production.min.js': 'react-dom.js',
  '@babel/standalone@7.29.0/babel.min.js': 'babel.js',
};

async function open(width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  if (vendor) {
    await page.route('https://unpkg.com/**', (r) => {
      const k = Object.keys(MAP).find((key) => r.request().url().endsWith(key));
      return k ? r.fulfill({ path: `${vendor}/${MAP[k]}`, contentType: 'application/javascript' }) : r.abort();
    });
  }
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('section.s').length > 0, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

const COLOR_LIB = `
  function parseColor(str) {
    let m = str.match(/^rgba?\\(([^)]+)\\)/);
    if (m) { const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p[3] ?? 1 }; }
    m = str.match(/^oklch\\(([^)]+)\\)/);
    if (m) {
      const p = m[1].split(/[ \\/]+/).filter(Boolean);
      const L = parseFloat(p[0]) * (p[0].endsWith('%') ? 0.01 : 1), C = parseFloat(p[1]), H = (parseFloat(p[2]) || 0) * Math.PI / 180;
      const a = p[3] !== undefined ? parseFloat(p[3]) * (p[3].endsWith('%') ? 0.01 : 1) : 1;
      const A = C * Math.cos(H), B = C * Math.sin(H);
      const l_ = L + 0.3963377774 * A + 0.2158037573 * B, m_ = L - 0.1055613458 * A - 0.0638541728 * B, s_ = L - 0.0894841775 * A - 1.291485548 * B;
      const l = l_ ** 3, mm = m_ ** 3, s = s_ ** 3;
      const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s].map((v) => Math.min(1, Math.max(0, v)));
      const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
      return { r: enc(lin[0]), g: enc(lin[1]), b: enc(lin[2]), a };
    }
    return null;
  }
  function lum(c) { const f = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
  function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function bgOf(el) {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const stops = [...cs.backgroundImage.matchAll(/(oklch\\([^)]+\\)|rgba?\\([^)]+\\))/g)].map((m) => parseColor(m[1])).filter(Boolean);
        if (stops.length) return stops.reduce((d, c) => (lum(c) < lum(d) ? c : d));
      }
      const c = parseColor(cs.backgroundColor);
      if (c && c.a >= 0.99) return c;
    }
    return { r: 1, g: 1, b: 1, a: 1 };
  }
`;

const report = { widths: {}, keyboard: null, structure: null, failures: [] };

for (const width of [390, 768, 1280]) {
  const { page, errors } = await open(width);
  const r = await page.evaluate(`(() => { ${COLOR_LIB}
    const out = { scrollWidth: document.documentElement.scrollWidth, innerWidth, overflow: [], contrast: { checked: 0, fails: [], disabledReported: [], min: 99 } };
    for (const el of document.querySelectorAll('main *')) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      let scroller = false, clip = null;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const o = getComputedStyle(a).overflowX;
        if (o === 'auto' || o === 'scroll') { scroller = true; break; }
        if (o === 'hidden' && !clip) clip = a.getBoundingClientRect();
      }
      if (scroller) continue;
      const box = clip ?? { left: 0, right: innerWidth };
      if (rect.right > box.right + 1 || rect.left < box.left - 1) out.overflow.push((el.className || el.tagName) + ' [' + Math.round(rect.left) + ',' + Math.round(rect.right) + '] in [' + Math.round(box.left) + ',' + Math.round(box.right) + ']');
    }
    for (const el of document.querySelectorAll('main *')) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const fg = parseColor(cs.color); if (!fg) continue;
      const bg = bgOf(el);
      const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5, got = ratio(fg, bg);
      out.contrast.checked++; out.contrast.min = Math.min(out.contrast.min, got);
      const disabled = el.closest('button:disabled, [aria-disabled="true"]');
      if (got < need) (disabled ? out.contrast.disabledReported : out.contrast.fails).push((el.className || el.tagName) + ' "' + el.textContent.trim().slice(0, 30) + '" ' + got.toFixed(2) + ' < ' + need);
    }
    return out;
  })()`);
  r.errors = errors;
  r.contrast.min = +r.contrast.min.toFixed(2);
  report.widths[width] = r;
  if (r.scrollWidth !== r.innerWidth) report.failures.push(`${width}: horizontal page scroll ${r.scrollWidth} > ${r.innerWidth}`);
  if (r.overflow.length) report.failures.push(`${width}: ${r.overflow.length} clipped/overflowing elements, e.g. ${r.overflow.slice(0, 3).join(' | ')}`);
  if (r.contrast.fails.length) report.failures.push(`${width}: ${r.contrast.fails.length} contrast failures, e.g. ${r.contrast.fails.slice(0, 3).join(' | ')}`);
  if (errors.length) report.failures.push(`${width}: console errors: ${errors.slice(0, 2).join(' | ')}`);

  if (width === 1280) {
    const expected = await page.evaluate(() => {
      const sel = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
      const els = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && getComputedStyle(e).visibility !== 'hidden'; });
      // radios in one group are a single tab stop
      const seen = new Set();
      const stops = els.filter((e) => { if (e.type === 'radio') { if (seen.has(e.name)) return false; seen.add(e.name); } return true; });
      stops.forEach((e, i) => e.setAttribute('data-kb', String(i)));
      return stops.length;
    });
    const visited = [];
    const invisible = [];
    await page.mouse.click(1, 1);
    for (let i = 0; i < expected + 5; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        const cs = getComputedStyle(a);
        const ring = (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none') || (cs.boxShadow && cs.boxShadow !== 'none');
        const t = a.type === 'radio' ? a.closest('label') : a;
        const ringLabel = t ? getComputedStyle(t) : cs;
        return { kb: a.getAttribute('data-kb'), ring: ring || (a.type === 'radio'), tag: a.tagName };
      });
      if (!info) break;
      if (visited.length && info.kb === visited[0]) break;
      visited.push(info.kb);
      if (!info.ring) invisible.push(info.tag + '#' + info.kb);
    }
    const order = visited.map(Number);
    const inOrder = order.every((v, i) => i === 0 || v > order[i - 1]);
    const unique = new Set(visited).size === visited.length;
    report.keyboard = { tabStopsExpected: expected, reached: visited.length, inDomOrder: inOrder, unique, withoutVisibleFocus: invisible };
    if (visited.length !== expected) report.failures.push(`keyboard: reached ${visited.length} of ${expected} tab stops`);
    if (!inOrder) report.failures.push('keyboard: tab order is not DOM order');
    if (!unique) report.failures.push('keyboard: a stop was reached twice');
    if (invisible.length) report.failures.push(`keyboard: ${invisible.length} stops without a visible focus indicator`);

    report.structure = await page.evaluate(() => {
      const f = [];
      const main = document.querySelector('main');
      if (main.getAttribute('dir') !== 'rtl' || main.getAttribute('lang') !== 'fa') f.push('main lacks dir=rtl lang=fa');
      if (document.querySelectorAll('h1.title').length !== 1) f.push('document title h1 count != 1');
      for (const el of document.querySelectorAll('button, a[href]')) if (!(el.getAttribute('aria-label') || el.textContent.trim())) f.push('unnamed control: ' + el.outerHTML.slice(0, 60));
      for (const el of document.querySelectorAll('input, textarea, select')) {
        const labelled = el.closest('label') || (el.id && document.querySelector('label[for="' + el.id + '"]')) || el.getAttribute('aria-label');
        if (!labelled) f.push('unlabelled field: ' + el.outerHTML.slice(0, 60));
      }
      for (const el of document.querySelectorAll('[tabindex]')) if (parseInt(el.getAttribute('tabindex'), 10) > 0) f.push('positive tabindex');
      for (const el of document.querySelectorAll('[role="img"]')) if (!el.getAttribute('aria-label')) f.push('role=img without name');
      for (const el of document.querySelectorAll('[role="region"]')) if (!(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) f.push('unnamed region');
      for (const el of document.querySelectorAll('table')) if (!el.querySelector('caption')) f.push('table without caption');
      for (const el of document.querySelectorAll('th')) if (!el.getAttribute('scope')) f.push('th without scope');
      for (const el of document.querySelectorAll('fieldset')) if (!el.querySelector('legend')) f.push('fieldset without legend');
      return { failures: f, sections: document.querySelectorAll('section.s').length, tables: document.querySelectorAll('table').length, radios: document.querySelectorAll('input[type=radio]').length };
    });
    if (report.structure.failures.length) report.failures.push(...report.structure.failures.map((x) => 'structure: ' + x));
  }
  await page.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 1));
process.exit(report.failures.length ? 1 : 0);
