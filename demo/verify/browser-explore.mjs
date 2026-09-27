#!/usr/bin/env node
// Authoring aid: open a page as a persona in the real browser, optionally click through a few
// controls, and print what is visible (buttons, fields, dialog text). Read-only unless the clicks
// themselves write — only click write controls deliberately.
//
//   MSYS_NO_PATHCONV=1 node demo/verify/browser-explore.mjs --as moderator --path /admin/reviews [--fill "label=value|..."] [--click "بررسی|..."] [--width 390]
import { personaBrowser, sleep } from './lib/edge.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
const key = arg('--as');
const p = await personaBrowser(key, { profileKey: arg('--profile') ?? 'L', anonymous: key === 'anon' });
try {
  await p.viewport(Number(arg('--width') ?? 1280));
  await p.goto(arg('--path'));
  // --fill 'label=value|label2=value2' before the clicks
  for (const f of (arg('--fill') ?? '').split('|').filter(Boolean)) {
    const [label, ...v] = f.split('=');
    await p.fill(label, v.join('='));
  }
  for (const c of (arg('--click') ?? '').split('|').filter(Boolean)) {
    // 'text#n@css' — nth match, optionally only among elements matching css
    const [head, css] = c.split('@');
    const [text, nth] = head.split('#');
    await p.click(text, { nth: Number(nth ?? 0), selector: css ?? null });
    await sleep(1200);
  }
  const out = await p.evaluate(`(() => { const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
    const lab = (e) => norm(e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.placeholder || e.name).slice(0, 60);
    const dlg = [...document.querySelectorAll('[role=dialog], dialog[open]')].filter(vis).map((d) => norm(d.innerText).slice(0, 600));
    return { path: location.pathname, dialogs: dlg,
      buttons: [...new Set([...document.querySelectorAll('button, [role=tab]')].filter(vis).map((b) => norm(b.innerText || b.getAttribute('aria-label')).slice(0, 50) + (b.disabled ? ' [disabled]' : '')))],
      fields: [...document.querySelectorAll('input, textarea, select')].filter(vis).map((f) => f.tagName.toLowerCase() + '[' + (f.type || '') + '] ' + lab(f) + (f.tagName === 'SELECT' ? ' {' + [...f.options].map((o) => o.text).join(' / ') + '}' : '')),
      text: norm((document.querySelector('main') ?? document.body).innerText).slice(0, 900) }; })()`);
  console.log(JSON.stringify(out, null, 1));
} finally {
  await p.close();
}
