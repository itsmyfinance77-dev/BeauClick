#!/usr/bin/env node
// Read-only status: processes (verified by live command line), bound addresses,
// containers, health, and the running artifact identity.
import { execFileSync } from 'node:child_process';

import { PORTS } from './lib/demo-config.mjs';
import { isOurs, listening, readState } from './lib/procs.mjs';

const state = readState();
console.log(`profile: ${state.profile ?? '-'}  source: ${state.sha ?? '-'}  wireguard: ${state.wireguard ? 'ACTIVE' : 'off'}  started: ${state.startedAt ?? '-'}`);
for (const [name, entry] of Object.entries(state.processes ?? {})) {
  console.log(`  ${name.padEnd(8)} pid ${String(entry.pid).padEnd(7)} ${isOurs(entry) ? 'running' : 'NOT running'}`);
}
for (const [name, port] of Object.entries(PORTS)) {
  const addrs = listening(port);
  console.log(`  :${String(port).padEnd(6)} ${name.padEnd(12)} ${addrs.length ? addrs.join(', ') : '-'}`);
}
try {
  console.log(execFileSync('docker', ['ps', '-a', '--filter', 'name=bcdemo-', '--format', '  {{.Names}}\t{{.Status}}\t{{.Ports}}'], { encoding: 'utf8' }).trimEnd());
} catch {
  console.log('  docker: unavailable');
}
try {
  const r = await fetch(`http://127.0.0.1:${PORTS.api}/api/health`);
  console.log(`  api health: HTTP ${r.status}`);
} catch {
  console.log('  api health: unreachable');
}
