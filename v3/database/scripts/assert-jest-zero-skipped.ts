import { readFileSync } from 'node:fs';

type JestCountKey = 'failed' | 'skipped' | 'passed' | 'todo' | 'total';
type JestCounts = Readonly<Record<JestCountKey, number>>;

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function parseCounts(body: string, label: string): JestCounts {
  const counts: Record<JestCountKey, number> = {
    failed: 0,
    skipped: 0,
    passed: 0,
    todo: 0,
    total: 0,
  };
  const seen = new Set<JestCountKey>();
  for (const match of body.matchAll(/(\d+)\s+(failed|skipped|passed|todo|total)\b/g)) {
    const key = match[2] as JestCountKey;
    if (seen.has(key)) throw new Error(`${label} summary repeats ${key}.`);
    seen.add(key);
    counts[key] = Number(match[1]);
  }
  if (!seen.has('total') || !seen.has('passed') || counts.total < 1) {
    throw new Error(`${label} summary is missing, empty, or unparsable.`);
  }
  return counts;
}

function oneSummary(output: string, label: 'Test Suites' | 'Tests'): JestCounts {
  const clean = output.replace(ANSI_ESCAPE, '');
  const matches = [...clean.matchAll(new RegExp(`^${label}:\\s*(.+)$`, 'gm'))];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} summary, found ${matches.length}.`);
  }
  return parseCounts(matches[0][1], label);
}

export function assertJestZeroSkipped(output: string): void {
  for (const label of ['Test Suites', 'Tests'] as const) {
    const counts = oneSummary(output, label);
    if (counts.failed !== 0 || counts.skipped !== 0 || counts.todo !== 0 || counts.passed !== counts.total) {
      throw new Error(
        `${label} did not fully execute: ${counts.passed} passed, ${counts.failed} failed, ` +
          `${counts.skipped} skipped, ${counts.todo} todo, ${counts.total} total.`,
      );
    }
  }
}

if (require.main === module) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: assert-jest-zero-skipped.ts <captured-jest-output>');
  assertJestZeroSkipped(readFileSync(path, 'utf8'));
  process.stdout.write('Jest summary verified: every suite and test executed.\n');
}
