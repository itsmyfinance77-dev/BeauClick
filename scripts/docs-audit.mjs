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
const V33_CLOSED_CARDS = 43;
assertDecisionSequence('docs/roadmap/v3.3/V3.3_DECISION_REGISTER.md', 'V33-DEC-', V33_CLOSED_CARDS);

// Unratified decision proposals live outside the register, in
// docs/roadmap/v3.3/proposals/, so they can never be counted as closed cards.
// Each one must say it is a PROPOSAL, must not claim ratification in its
// status line, must name an id beyond the closed sequence, and must not
// coexist with a register card of the same id: ratifying moves the card into
// the register and deletes the proposal in the same change.
const v33RegisterText = readFileSync(resolve(root, 'docs/roadmap/v3.3/V3.3_DECISION_REGISTER.md'), 'utf8');
const proposalDirectory = resolve(root, 'docs/roadmap/v3.3/proposals');
const proposalFiles = existsSync(proposalDirectory)
  ? readdirSync(proposalDirectory).filter((name) => extname(name).toLowerCase() === '.md')
  : [];
for (const name of proposalFiles) {
  const file = `docs/roadmap/v3.3/proposals/${name}`;
  const match = /^V33-DEC-(\d{3})-PROPOSAL-[a-z0-9-]+\.md$/.exec(name);
  if (!match) {
    failures.push(`${file}: a proposal must be named V33-DEC-NNN-PROPOSAL-<slug>.md`);
    continue;
  }
  const id = `V33-DEC-${match[1]}`;
  const status =
    readFileSync(resolve(proposalDirectory, name), 'utf8')
      .split(/\r?\n/)
      .find((line) => line.startsWith('**Status:**')) ?? '';
  if (!/\bPROPOSAL\b/.test(status)) failures.push(`${file}: status line must declare PROPOSAL`);
  if (/\b(?:RATIFIED|CLOSED|ACCEPTED)\b/.test(status.replace(/\bNOT (?:RATIFIED|CLOSED|ACCEPTED)\b/g, ''))) {
    failures.push(`${file}: a proposal must not claim ratification in its status line`);
  }
  if (Number(match[1]) <= V33_CLOSED_CARDS) failures.push(`${file}: ${id} is inside the closed V33 sequence`);
  if (new RegExp('^#{2,3} `' + id + '` —', 'm').test(v33RegisterText)) {
    failures.push(`${file}: ${id} is already a register card; delete the proposal when ratifying`);
  }
}

// An ADR whose status is PROPOSED must point at an existing decision proposal,
// so a proposed ADR cannot outlive, or silently precede, the decision it waits on.
for (const name of readdirSync(resolve(root, 'docs/roadmap/v3/adr')).filter((n) => /^ADR-\d{3}-.*\.md$/.test(n))) {
  const text = readFileSync(resolve(root, 'docs/roadmap/v3/adr', name), 'utf8');
  const status = text.split(/\r?\n/).find((line) => line.startsWith('**Status:**')) ?? '';
  if (!/\bPROPOSED\b/.test(status)) continue;
  const reference = /docs\/roadmap\/v3\.3\/proposals\/(V33-DEC-\d{3}-PROPOSAL-[a-z0-9-]+\.md)/.exec(text);
  if (!reference || !proposalFiles.includes(reference[1])) {
    failures.push(`docs/roadmap/v3/adr/${name}: a PROPOSED ADR must reference an existing docs/roadmap/v3.3/proposals/ file`);
  }
}

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

console.log(`Documentation audit passed: ${markdownFiles.length} Markdown files, ${checkedRelativeLinks} relative links, ${adrFiles.length} ADRs, V3.2/V3.3 decision sequences complete, ${proposalFiles.length} unratified V3.3 proposal(s).`);
