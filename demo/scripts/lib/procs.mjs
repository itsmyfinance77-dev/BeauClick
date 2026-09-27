// Detached process management for the demo, Windows-safe. A PID is only ever
// killed after its live command line is re-read and matches what we started, so a
// recycled PID belonging to someone else is never touched.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { LOGS_DIR, STATE_DIR } from './demo-config.mjs';

const STATE_FILE = path.join(STATE_DIR, 'processes.json');

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { profile: null, processes: {} };
  }
}
export function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function startDetached(name, cmd, args, { cwd, env, marker }) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const out = fs.openSync(path.join(LOGS_DIR, `${name}.log`), 'a');
  const child = spawn(cmd, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
  return { pid: child.pid, marker, startedAt: new Date().toISOString() };
}

export function commandLineOf(pid) {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return '';
  }
}

export function isOurs(entry) {
  if (!entry?.pid) return false;
  const cl = commandLineOf(entry.pid);
  return cl !== '' && cl.includes(entry.marker);
}

export function stopProcess(name, entry, log = console.log) {
  if (!entry) return;
  if (!isOurs(entry)) {
    log(`${name}: pid ${entry.pid} is not running our command (already stopped or recycled) — not touching it`);
    return;
  }
  execFileSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { stdio: 'ignore' });
  log(`${name}: stopped pid ${entry.pid}`);
}

export async function waitFor(check, { timeoutMs = 120_000, intervalMs = 1000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

export function listening(port) {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress) -join ','`],
      { encoding: 'utf8' },
    ).trim();
    return out ? out.split(',') : [];
  } catch {
    return [];
  }
}
