#!/usr/bin/env node
// Seeds the demo THROUGH THE REAL APPLICATION: every write is an ordinary API call
// made by the persona who would make it, after a real OTP sign-in. The only
// non-HTTP step is the documented one-time privileged bootstrap
// (v3/database/scripts/grant-platform-operator.ts), which is how the platform's
// first operator/administrator is created by design.
//
//   node demo/seed/seed.mjs --profile L [--stage <name> ...]
//
// Stages run in order and record what they created in state/seed-state.json, so a
// failed run resumes. No SQL writes to domain tables; no backdating; no dev-login.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SECRETS_DIR, STATE_DIR, V3_ROOT, profile as resolveProfile } from '../scripts/lib/demo-config.mjs';
import { appUrl, baseProcessEnv, loadSecrets } from '../scripts/lib/runtime.mjs';
import { DemoInbox, Session, signIn } from './lib/client.mjs';
import { PERSONAS, persona } from './personas.mjs';
import { STAGES } from './stages/index.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
const profileKey = arg('--profile') ?? 'L';
const only = process.argv.flatMap((a, i, all) => (a === '--stage' ? [all[i + 1]] : []));

const STATE_FILE = path.join(STATE_DIR, 'seed-state.json');
// Refresh tokens of SYNTHETIC accounts, kept only so a resumed run need not spend
// OTP requests (5/phone/hour). Secrets dir, outside git; deleted by reset.
const SESSIONS_FILE = path.join(SECRETS_DIR, 'seed-sessions.json');

const loadJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const state = loadJson(STATE_FILE, { profile: profileKey, done: {}, ids: {} });
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const tokens = loadJson(SESSIONS_FILE, {});

const inbox = new DemoInbox();
const sessions = new Map();

/** The persona's session: resumed by refresh-token rotation when possible, else a real OTP sign-in. */
async function as(key) {
  if (sessions.has(key)) return sessions.get(key);
  const p = persona(key);
  let s = null;
  if (tokens[key]) {
    try {
      s = new Session(resolveProfile(profileKey).origin, key);
      s.refreshToken = tokens[key];
      await s.refresh();
    } catch {
      s = null;
    }
  }
  if (!s) s = await signIn(profileKey, p.phone, inbox, key);
  s.onRotate = (t) => {
    tokens[key] = t;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(tokens));
  };
  const me = await s.get('/v1/me');
  s.userId = me.data.id ?? me.data.user?.id;
  s.roles = me.data.roles ?? me.data.user?.roles ?? [];
  sessions.set(key, s);
  tokens[key] = s.refreshToken;
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(tokens));
  return s;
}
/** Re-issues the persona's token so newly granted roles/capabilities take effect (real rotation). */
async function refreshed(key) {
  const s = await as(key);
  await s.refresh();
  tokens[key] = s.refreshToken;
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(tokens));
  const me = await s.get('/v1/me');
  s.roles = me.data.roles ?? me.data.user?.roles ?? [];
  return s;
}

function bootstrapPrivileged(phone, role, reason) {
  const args = ['exec', 'ts-node', '--project', 'database/scripts/tsconfig.json', 'database/scripts/grant-platform-operator.ts', '--phone', phone, '--role', role, '--reason', `"${reason}"`];
  if (role === 'administrator') args.push('--force');
  const r = spawnSync('pnpm', args, {
    cwd: V3_ROOT,
    env: { ...baseProcessEnv(), DATABASE_URL: appUrl(loadSecrets()) },
    encoding: 'utf8',
    shell: true,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter((l) => !/DEP0190|trace-deprecation/.test(l));
  if (r.status !== 0) throw new Error(`bootstrap ${role} failed: ${out.slice(-3).join(' | ')}`);
  return out.slice(-1)[0];
}

// `save` persists progress mid-stage, so a failed long stage resumes instead of re-planning.
const ctx = { profileKey, state, as, refreshed, bootstrapPrivileged, inbox, PERSONAS, save: saveState, log: (...a) => console.log('  ', ...a) };

for (const stage of STAGES) {
  if (only.length && !only.includes(stage.name)) continue;
  if (state.done[stage.name] && !only.includes(stage.name)) {
    console.log(`= ${stage.name}: already done`);
    continue;
  }
  console.log(`> ${stage.name}`);
  const started = Date.now();
  await stage.run(ctx);
  state.done[stage.name] = new Date().toISOString();
  saveState();
  console.log(`✓ ${stage.name} (${Math.round((Date.now() - started) / 1000)} s)`);
}
console.log('seed complete for requested stages');
