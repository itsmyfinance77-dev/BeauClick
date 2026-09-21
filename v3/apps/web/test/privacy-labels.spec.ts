import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ERASURE_STATUS_LABELS,
  EXPORT_STATUS_LABELS,
  MODULE_LABEL,
  UNKNOWN_MODULE_LABEL,
  UNKNOWN_STATUS_LABEL,
  moduleLabel,
  requestStatusView,
} from '@/lib/privacy-labels';

const ROOT = join(__dirname, '../../..');

function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !/\.(pg-)?spec\.ts$|\.test\.ts$/.test(name)) out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(join(ROOT, 'services'));
  walk(join(ROOT, 'libs'));
  return out;
}

/** The members of a server `export const NAME = [...] as const;` tuple. */
function serverList(file: string, name: string): string[] {
  const source = readFileSync(join(ROOT, 'services/privacy/src', file), 'utf8');
  const start = source.indexOf(`export const ${name} = [`);
  const end = start < 0 ? -1 : source.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found in ${file} — did the server list move?`);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

describe('request statuses', () => {
  const server = () => serverList('entities/data-request.entity.ts', 'DATA_REQUEST_STATUSES');

  it('name every status the server has, between the two kinds', () => {
    expect(server().length).toBeGreaterThanOrEqual(5); // guards an empty parse
    const named = new Set([...Object.keys(EXPORT_STATUS_LABELS), ...Object.keys(ERASURE_STATUS_LABELS)]);
    expect([...named].sort()).toEqual(server());
  });

  it('keeps `ready` to exports and `completed` to erasures, as the server does', () => {
    expect(EXPORT_STATUS_LABELS).toHaveProperty('ready');
    expect(EXPORT_STATUS_LABELS).not.toHaveProperty('completed');
    expect(ERASURE_STATUS_LABELS).toHaveProperty('completed');
    expect(ERASURE_STATUS_LABELS).not.toHaveProperty('ready');
  });

  it('shows `pending` and `processing` of an export as one thing — to a person waiting for a file they are the same', () => {
    expect(requestStatusView('export', 'pending').label).toBe(requestStatusView('export', 'processing').label);
  });

  it('shows a neutral word, never the raw key, for a status it has never heard of', () => {
    expect(requestStatusView('export', 'archived').label).toBe(UNKNOWN_STATUS_LABEL);
    expect(requestStatusView('erasure', 'ready').label).toBe(UNKNOWN_STATUS_LABEL); // ready is not an erasure state
  });
});

describe('module names', () => {
  const declared = () => {
    const found = new Set<string>();
    for (const text of serverSources()) for (const m of text.matchAll(/readonly moduleKey = '([a-z-]+)'/g)) found.add(m[1]);
    return [...found].sort();
  };

  it('name every module the server walks for an export or an erasure', () => {
    expect(declared().length).toBeGreaterThanOrEqual(20); // guards an empty scan
    expect(declared().filter((key) => !(key in MODULE_LABEL))).toEqual([]);
  });

  it('keep no name for a module the server no longer has', () => {
    expect(Object.keys(MODULE_LABEL).filter((key) => !declared().includes(key))).toEqual([]);
  });

  it('give an unknown module a neutral heading, never its raw key', () => {
    expect(moduleLabel('something-new')).toBe(UNKNOWN_MODULE_LABEL);
    expect(moduleLabel('financial')).toBe('سوابق مالی');
  });
});
