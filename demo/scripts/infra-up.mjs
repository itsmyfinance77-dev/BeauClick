#!/usr/bin/env node
// Starts the demo backing services (bcdemo-pg, bcdemo-os) and waits until healthy.
// Touches nothing else: project name, container names and volumes are all bcdemo-*.
import { execFileSync } from 'node:child_process';

import { CONTAINERS } from './lib/demo-config.mjs';
import { compose, loadSecrets } from './lib/runtime.mjs';

const s = loadSecrets();
const up = compose(['up', '-d', 'pg', 'os'], s);
if (up.status !== 0) process.exit(up.status ?? 1);

const deadline = Date.now() + 180_000;
for (const name of [CONTAINERS.pg, CONTAINERS.os]) {
  for (;;) {
    const health = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', name], { encoding: 'utf8' }).trim();
    if (health === 'healthy') {
      console.log(`${name}: healthy`);
      break;
    }
    if (Date.now() > deadline) throw new Error(`${name} not healthy after 180 s (last: ${health})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
