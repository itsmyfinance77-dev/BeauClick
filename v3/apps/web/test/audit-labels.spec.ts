import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_LABELS, UNKNOWN_ACTION_LABEL, UNKNOWN_TARGET_LABEL, actionLabel, targetLabel } from '@/lib/audit-labels';

const ROOT = join(__dirname, '../../..');

/** Every non-test TypeScript source under the services and libs, read once. */
function serverSources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !/\.(pg-)?spec\.ts$|\.test\.ts$/.test(name)) out.push({ path: full, text: readFileSync(full, 'utf8') });
    }
  };
  walk(join(ROOT, 'services'));
  walk(join(ROOT, 'libs'));
  return out;
}

const SOURCES = serverSources();
const ALL_TEXT = SOURCES.map((s) => s.text).join('\n');

/** Every action the server DECLARES: `@AuditAction('…')`, and the values of the `*_AUDIT_ACTIONS` objects. */
function declaredActions(): string[] {
  const found = new Set<string>();
  for (const m of ALL_TEXT.matchAll(/@AuditAction\(\s*'([a-z_]+\.[a-z_.]+)'/g)) found.add(m[1]);
  for (const { text } of SOURCES) {
    for (const block of text.matchAll(/export const [A-Z_]+_AUDIT_ACTIONS = \{([\s\S]*?)\} as const;/g)) {
      for (const m of block[1].matchAll(/'([a-z_]+\.[a-z_.]+)'/g)) found.add(m[1]);
    }
  }
  // The audit-enforcement fixtures declare throwaway actions to test the boot assertion.
  return [...found].filter((a) => !a.startsWith('test.')).sort();
}

describe('audit action labels', () => {
  const declared = declaredActions();

  it('found the server’s declared actions (guards an empty scan)', () => {
    expect(declared.length).toBeGreaterThanOrEqual(50);
    expect(declared).toContain('identity.role_granted');
    expect(declared).toContain('commercial.subscription_assigned');
  });

  it('names every action the server declares — none reaches an operator as a raw English key', () => {
    const missing = declared.filter((a) => !(a in ACTION_LABELS));
    expect(missing).toEqual([]);
  });

  it('keeps no label for an action the server can no longer write', () => {
    const phantoms = Object.keys(ACTION_LABELS).filter((a) => !ALL_TEXT.includes(`'${a}'`));
    expect(phantoms).toEqual([]);
  });

  it('shows a neutral title, never the dotted key, for an action it has never heard of', () => {
    expect(actionLabel('commerce.something_new')).toBe(UNKNOWN_ACTION_LABEL);
    expect(actionLabel('commerce.something_new')).not.toContain('commerce');
    expect(actionLabel('identity.role_granted')).toBe('اعطای نقش');
  });

  it('gives every label a distinct wording, so two different actions never read the same', () => {
    const labels = Object.values(ACTION_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('audit target labels', () => {
  it('shows a neutral word for a target type it has never heard of', () => {
    expect(targetLabel('professional')).toBe('متخصص');
    expect(targetLabel('subscription')).toBe(UNKNOWN_TARGET_LABEL);
  });
});
