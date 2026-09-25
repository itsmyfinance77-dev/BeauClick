#!/usr/bin/env node
/**
 * Design-to-contract traceability check for the #45 dashboard pack.
 *
 *   node check-traceability.mjs <path-to-a-master-checkout>/v3 [--markdown]
 *   node check-traceability.mjs --self-test
 *
 * Reads traceability.json and, against the implementation tree given:
 *
 *  1. re-derives every HTTP route from the NestJS controllers (class prefix +
 *     method decorator) and fails if a cited (method, path) does not exist;
 *  2. fails if a cited wire field does not appear in any of the cited files;
 *  3. fails if a cited capability name is not in the capability map;
 *  4. fails if any recorded ABSENCE has become false (a dispute route, a
 *     reception role, a seller credit-balance read, `createdAt` on /v1/me) --
 *     so the pack is told when a gap it designs as "unavailable" has closed.
 *
 *  5. fails if a value slot (‹field›) in the prototype names a field no cited
 *     route renders -- so the drawing cannot show a number the API lacks.
 *
 * ## Paths are canonical POSIX, on every platform
 *
 * `path.relative` returns `\`-separated paths on Windows, while every path in
 * traceability.json (the `onlyIn` allowlist, cited files) is written with `/`.
 * Comparing the two raw made the allowlist silently miss on Windows, so a
 * known internal file was reported as a broken absence (Codex review of #323,
 * reproduced on Windows against master 2e3da4a). Every DERIVED path therefore
 * goes through `canonicalRelative` -- route rows, the absence comparison and
 * the generated markdown alike -- and a runtime invariant fails the run if a
 * backslash survives anywhere a canonical path is expected.
 *
 * `selfTest()` runs before every check (and alone with `--self-test`). It
 * simulates Windows with `path.win32` and proves both halves: the allowlisted
 * internal file is exempt, AND a non-allowlisted file containing the same text
 * is still reported. It also keeps a witness of the original defect: the raw,
 * un-normalised Windows path is NOT exempt, so the test cannot pass vacuously
 * if normalisation is removed.
 *
 * Exit code 0 only when every check passes. `--markdown` prints the route
 * matrix with handler file:line, which is how ROUTE_CONTRACT_MATRIX.md §2 is
 * produced. Nothing here reads a database or starts a server.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path, { join, posix, win32 } from 'node:path';

const spec = JSON.parse(readFileSync(new URL('./traceability.json', import.meta.url), 'utf8'));

/**
 * The one representation every derived path is compared and printed in:
 * relative to the implementation root, `/`-separated, whatever the platform.
 * `pathImpl` is injectable so the self-test can run Windows semantics on Linux.
 */
export function canonicalRelative(pathImpl, rootDir, file) {
  return pathImpl.relative(rootDir, file).split(pathImpl.sep).join('/');
}

/**
 * Files whose text matches an absence pattern and are NOT on its allowlist.
 * `entries` are `[canonicalPath, text]`; the allowlist is canonical by
 * construction (traceability.json), so the comparison is exact string equality.
 */
export function absenceHits(entries, absence) {
  const re = new RegExp(absence.grepAbsent);
  const allowed = new Set(absence.onlyIn ?? []);
  return entries.filter(([file, text]) => re.test(text) && !allowed.has(file)).map(([file]) => file);
}

export function selfTest() {
  const errors = [];
  const expect = (ok, what) => ok || errors.push(what);
  // A FIXED fixture, deliberately independent of traceability.json: the
  // self-test proves the comparison mechanics, so a mutated or broken spec
  // file must not be able to crash it or change what it proves. The same
  // pure functions it exercises are the ones the real run uses below.
  const allowlisted = 'services/commercial-policy/src/subscription/booking-credit-accounting.service.ts';
  const absence = { grepAbsent: 'balanceFor\\(', onlyIn: [allowlisted] };
  const internalText = 'async balanceFor(manager, party) {}';

  for (const [label, impl, rootDir] of [
    ['win32', win32, 'E:\\BeauClick\\v3'],
    ['win32, forward-slash root', win32, 'E:/BeauClick/v3'],
    ['posix', posix, '/home/user/BeauClick/v3'],
  ]) {
    const abs = (rel) => impl.join(rootDir, ...rel.split('/'));
    const internal = canonicalRelative(impl, rootDir, abs(allowlisted));
    const leak = canonicalRelative(impl, rootDir, abs('services/commercial-policy/src/seller-surface/seller-subscription-surface.controller.ts'));
    expect(internal === allowlisted, `${label}: canonical path equals the allowlist entry (got ${internal})`);
    expect(!internal.includes('\\') && !leak.includes('\\'), `${label}: no backslash survives canonicalisation`);
    const hits = absenceHits([[internal, internalText], [leak, 'return { balance: await this.accounting.balanceFor(m, p) };']], absence);
    expect(hits.length === 1 && hits[0] === leak, `${label}: allowlisted file exempt AND a seller-facing use still reported (got ${JSON.stringify(hits)})`);
    expect(absenceHits([[internal, 'nothing relevant']], absence).length === 0, `${label}: no hit without the pattern`);
  }

  // Witness of the original defect: the raw Windows path must NOT match the
  // allowlist. If this ever passes, the fixture no longer exercises the bug.
  const raw = win32.relative('E:\\BeauClick\\v3', win32.join('E:\\BeauClick\\v3', ...allowlisted.split('/')));
  expect(raw !== allowlisted && absenceHits([[raw, internalText]], absence).length === 1, 'witness: the un-normalised Windows path is reported, as the defect did');
  return errors;
}

const argv = process.argv.slice(2);
const markdown = argv.includes('--markdown');
const selfErrors = selfTest();
if (selfErrors.length) {
  console.error('SELF-TEST FAIL\n' + selfErrors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
if (argv.includes('--self-test')) {
  console.error('SELF-TEST PASS (win32, win32 with forward-slash root, posix; allowlist exempt, detector still fires, defect witness held)');
  process.exit(0);
}
const root = argv.find((a) => !a.startsWith('--'));
if (!root) {
  console.error('usage: check-traceability.mjs <implementation v3 dir> [--markdown] | --self-test');
  process.exit(2);
}
const rel = (file) => canonicalRelative(path, root, file);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const sources = walk(join(root, 'services')).concat(walk(join(root, 'libs')), walk(join(root, 'apps/api/src')));
const routes = [];
for (const file of sources.filter((f) => f.endsWith('.controller.ts'))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let prefix = null;
  lines.forEach((line, i) => {
    const c = line.match(/@Controller\(\s*'([^']*)'/);
    if (c) prefix = c[1];
    const h = line.match(/^\s*@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?/);
    if (h && prefix !== null) {
      routes.push({
        method: h[1].toUpperCase(),
        path: '/' + prefix + (h[2] ? '/' + h[2] : ''),
        file: rel(file),
        line: i + 1,
      });
    }
  });
}

const failures = [];
const rows = [];
for (const r of spec.routes) {
  const found = routes.filter((x) => x.method === r.method && x.path === r.path);
  if (found.length === 0) failures.push(`route missing: ${r.method} ${r.path}`);
  const texts = r.files.map((f) => {
    try {
      return readFileSync(join(root, f), 'utf8');
    } catch {
      failures.push(`cited file missing: ${f} (${r.id})`);
      return '';
    }
  });
  for (const field of r.fields) {
    if (!texts.some((t) => t.includes(field))) failures.push(`field not found: ${field} in ${r.files.join(', ')} (${r.id})`);
  }
  rows.push({ ...r, at: found.map((x) => `${x.file}:${x.line}`).join('<br>') || '**MISSING**' });
}

const capText = readFileSync(join(root, spec.capabilities.file), 'utf8');
for (const cap of spec.capabilities.names) {
  if (!capText.includes(`'${cap}'`)) failures.push(`capability not in map: ${cap}`);
}

const allText = sources.map((f) => [rel(f), readFileSync(f, 'utf8')]);
// Invariant: nothing derived may still carry a platform separator.
for (const p of [...routes.map((x) => x.file), ...allText.map(([f]) => f)]) {
  if (p.includes('\\')) failures.push(`non-canonical derived path: ${p}`);
}
// Windows replay over the REAL tree: re-derive every source path the way
// Node on Windows would (drive-letter root, `\` separators) and require the
// same canonical path and the same absence verdicts as this platform. It lets
// any run exercise Windows path semantics; it does not replace a run on Windows.
const WIN_ROOT = 'E:\\BeauClick\\v3';
const winText = allText.map(([f, t]) => [canonicalRelative(win32, WIN_ROOT, win32.join(WIN_ROOT, ...f.split('/'))), t]);
winText.forEach(([w], i) => w !== allText[i][0] && failures.push(`windows replay: ${allText[i][0]} derived as ${w}`));
for (const a of spec.absences.filter((x) => x.grepAbsent)) {
  const here = absenceHits(allText, a).join('|'), there = absenceHits(winText, a).join('|');
  if (here !== there) failures.push(`windows replay: absence "${a.claim}" differs (${here} vs ${there})`);
}
const windowsReplayed = winText.length;

for (const a of spec.absences) {
  for (const entry of a.onlyIn ?? []) {
    if (entry.includes('\\') || entry.startsWith('/') || entry.startsWith('./')) failures.push(`non-canonical allowlist entry in traceability.json: ${entry}`);
  }
  if (a.grepAbsent) {
    const hits = absenceHits(allText, a);
    if (hits.length) failures.push(`absence no longer holds (${a.claim}): ${hits.join(', ')}`);
  }
  if (a.routeAbsentPattern) {
    const re = new RegExp(a.routeAbsentPattern, 'i');
    const hits = routes.filter((x) => re.test(x.path));
    if (hits.length) failures.push(`absence no longer holds (${a.claim}): ${hits.map((x) => x.path).join(', ')}`);
  }
  if (a.fileLacks) {
    const t = readFileSync(join(root, a.fileLacks.file), 'utf8');
    if (t.includes(a.fileLacks.text)) failures.push(`absence no longer holds (${a.claim})`);
  }
}

// 5. Every value slot in the prototype must be a field some cited route renders.
const cited = new Set(spec.routes.flatMap((r) => r.fields));
const proto = readFileSync(new URL('../Prototype - Workspace Shell and Dashboards.dc.html', import.meta.url), 'utf8');
const slots = [...new Set([...proto.matchAll(/‹([A-Za-z.]+)›/g)].map((m) => m[1]))];
for (const s of slots) {
  const parts = s.split('.');
  if (!parts.every((p) => cited.has(p) || p === 'length')) failures.push(`prototype slot not traceable: ${s}`);
}

if (markdown) {
  console.log('| # | Method | Path | Authority | Handler | Fields the design renders | Used by |');
  console.log('|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    const fields = r.fields.length ? r.fields.map((f) => '`' + f + '`').join(', ') : '— (presence/navigation only)';
    console.log(`| ${i + 1} | ${r.method} | \`${r.path}\` | ${r.authority} | \`${r.at}\` | ${fields} | ${r.screens.join(', ')} |`);
  });
}

console.error(
  `routes derived: ${routes.length} · cited: ${spec.routes.length} · fields checked: ${spec.routes.reduce((n, r) => n + r.fields.length, 0)} · capabilities: ${spec.capabilities.names.length} · absences: ${spec.absences.length} · prototype slots: ${slots.length} · windows replay: ${windowsReplayed} paths`,
);
if (failures.length) {
  console.error('FAIL\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.error('PASS');
