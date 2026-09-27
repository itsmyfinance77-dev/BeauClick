#!/usr/bin/env node
// Stops the demo: ingress, web, API, inbox (each only if its live command line is
// ours), then stops -- never removes -- the bcdemo containers. Data volumes stay.
//   node demo/scripts/stop.mjs [--keep-infra]
import { CONTAINERS } from './lib/demo-config.mjs';
import { readState, stopProcess, writeState } from './lib/procs.mjs';
import { compose, loadSecrets } from './lib/runtime.mjs';

const state = readState();
for (const name of ['ingress', 'web', 'api', 'inbox']) stopProcess(name, state.processes?.[name]);
writeState({ ...state, processes: {}, stoppedAt: new Date().toISOString() });

if (!process.argv.includes('--keep-infra')) {
  const r = compose(['stop', 'pg', 'os'], loadSecrets());
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`stopped ${CONTAINERS.pg}, ${CONTAINERS.os} (volumes kept)`);
}
