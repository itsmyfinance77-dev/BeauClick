import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const ignoredLinkSources = new Set([
  normalize('docs/archive/README-v2-wordpress.md'), // byte-preserved historical artifact
]);

function walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'output', 'tmp'].includes(entry.name)) return [];
      return walk(path);
    }
    return extname(entry.name).toLowerCase() === '.md' ? [path] : [];
  });
}

const markdownFiles = [resolve(root, 'README.md'), resolve(root, 'CONTRIBUTING.md'), ...walk(resolve(root, 'docs'))];
const failures = [];
let checkedRelativeLinks = 0;

if (markdownFiles.length < 100) failures.push(`documentation discovery is vacuous: found only ${markdownFiles.length} Markdown files`);

function repoPath(path) {
  return normalize(relative(root, path));
}

// Relative Markdown links must resolve. URL/anchor links and the byte-preserved V2
// archive are deliberately outside this check.
const linkPattern = /!?(?:\[[^\]]*\])\(([^)]+)\)/g;
for (const file of markdownFiles) {
  if (ignoredLinkSources.has(repoPath(file))) continue;
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+["']/)[0].split('#')[0];
    if (!target || /^(?:https?:|mailto:|tel:|#)/i.test(target)) continue;
    checkedRelativeLinks += 1;
    try {
      target = decodeURIComponent(target);
    } catch {
      failures.push(`${repoPath(file)}: malformed URL encoding in ${match[1]}`);
      continue;
    }
    const resolved = target.startsWith('/') ? resolve(root, `.${target}`) : resolve(dirname(file), target);
    if (!existsSync(resolved)) failures.push(`${repoPath(file)}: missing link target ${match[1]}`);
  }
}

function assertDecisionSequence(file, prefix, expected) {
  const text = readFileSync(resolve(root, file), 'utf8');
  const pattern = new RegExp('^#{2,3} `' + prefix + '(\\d{3})` —', 'gm');
  const ids = [...text.matchAll(pattern)].map((match) => Number(match[1]));
  const counts = new Map(ids.map((id) => [id, ids.filter((candidate) => candidate === id).length]));
  for (let id = 1; id <= expected; id += 1) {
    if (!counts.has(id)) failures.push(`${file}: missing ${prefix}${String(id).padStart(3, '0')} card`);
    if ((counts.get(id) ?? 0) > 1) failures.push(`${file}: duplicate ${prefix}${String(id).padStart(3, '0')} card`);
  }
  for (const id of counts.keys()) {
    if (id < 1 || id > expected) failures.push(`${file}: unexpected ${prefix}${String(id).padStart(3, '0')} card`);
  }
}

assertDecisionSequence('docs/roadmap/v3.2/V3.2_DECISION_REGISTER.md', 'V32-DEC-', 36);
assertDecisionSequence('docs/roadmap/v3.3/V3.3_DECISION_REGISTER.md', 'V33-DEC-', 20);

const adrFiles = readdirSync(resolve(root, 'docs/roadmap/v3/adr'))
  .map((name) => /^ADR-(\d{3})-.*\.md$/.exec(name))
  .filter(Boolean)
  .map((match) => Number(match[1]))
  .sort((a, b) => a - b);
if (adrFiles.length < 40) failures.push(`ADR discovery is incomplete: found only ${adrFiles.length} ADRs`);
for (let index = 0; index < adrFiles.length; index += 1) {
  if (adrFiles[index] !== index + 1) failures.push(`ADR sequence: expected ${index + 1}, found ${adrFiles[index]}`);
}

if (checkedRelativeLinks < 50) failures.push(`relative-link check is vacuous: inspected only ${checkedRelativeLinks} links`);

for (const file of markdownFiles) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('github.com/marabi766/BeauClick')) failures.push(`${repoPath(file)}: stale previous-owner GitHub URL`);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trailing = line.match(/[ \t]+$/)?.[0];
    // Exactly two spaces are Markdown's explicit hard-break syntax, not accidental
    // whitespace. Tabs, a single space, or 3+ spaces remain failures.
    if (trailing && trailing !== '  ') failures.push(`${repoPath(file)}:${index + 1}: trailing whitespace`);
  });
}

if (failures.length > 0) {
  console.error(`Documentation audit failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Documentation audit passed: ${markdownFiles.length} Markdown files, ${checkedRelativeLinks} relative links, ${adrFiles.length} ADRs, V3.2/V3.3 decision sequences complete.`);
