#!/usr/bin/env node
/**
 * Design-to-contract traceability check for the #45 dashboard pack.
 *
 *   node check-traceability.mjs <path-to-a-master-checkout>/v3 [--markdown]
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
 * Exit code 0 only when every check passes. `--markdown` prints the route
 * matrix with handler file:line, which is how ROUTE_CONTRACT_MATRIX.md §2 is
 * produced. Nothing here reads a database or starts a server.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2];
const markdown = process.argv.includes('--markdown');
if (!root) {
  console.error('usage: check-traceability.mjs <implementation v3 dir> [--markdown]');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(new URL('./traceability.json', import.meta.url), 'utf8'));

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
        file: relative(root, file),
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

const allText = sources.map((f) => [relative(root, f), readFileSync(f, 'utf8')]);
for (const a of spec.absences) {
  if (a.grepAbsent) {
    const re = new RegExp(a.grepAbsent);
    const hits = allText.filter(([f, t]) => re.test(t) && !(a.onlyIn ?? []).includes(f)).map(([f]) => f);
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
  `routes derived: ${routes.length} · cited: ${spec.routes.length} · fields checked: ${spec.routes.reduce((n, r) => n + r.fields.length, 0)} · capabilities: ${spec.capabilities.names.length} · absences: ${spec.absences.length} · prototype slots: ${slots.length}`,
);
if (failures.length) {
  console.error('FAIL\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.error('PASS');
