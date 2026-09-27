#!/usr/bin/env node
// Starts the whole demo from the frozen artifact.
//
//   node demo/scripts/start.mjs --profile L
//   node demo/scripts/start.mjs --profile W --activate-wireguard   (ONLY after the owner's go-ahead)
//
// Order: infra -> preflight (fail-closed) -> artifact integrity -> inbox -> API ->
// web -> ingress. Infra comes first because the preflight's writer-role check needs the
// database (a cold start otherwise fails); it is only the loopback-bound bcdemo-*
// containers, and no application process starts unless the preflight passes. Everything binds 127.0.0.1; only with profile W AND
// --activate-wireguard do the ingress and the inbox viewer also bind 10.20.30.6.
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { hashTree } from './lib/hash-tree.mjs';
import { ARTIFACTS_DIR, CERTS_DIR, DEMO_ROOT, LOGS_DIR, PORTS, STATE_DIR, V3_ROOT, WIREGUARD, profile as resolveProfile } from './lib/demo-config.mjs';
import { listening, readState, startDetached, waitFor, writeState, isOurs } from './lib/procs.mjs';
import { apiEnv, baseProcessEnv, loadSecrets, webEnv } from './lib/runtime.mjs';
import { preflight } from './preflight.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const key = arg('--profile') ?? 'L';
const p = resolveProfile(key);
const activateWg = process.argv.includes('--activate-wireguard');

if (key === 'W' && !activateWg) throw new Error('Profile W binds the WireGuard address; pass --activate-wireguard only after the owner has approved remote team access.');
if (key !== 'W' && activateWg) throw new Error('--activate-wireguard is only valid with profile W.');
if (activateWg) {
  const hasAddr = Object.values(os.networkInterfaces()).flat().some((a) => a?.address === WIREGUARD.hostAddress);
  if (!hasAddr) throw new Error(`${WIREGUARD.hostAddress} is not assigned on this host (is the WireGuard tunnel up?). Use profile L.`);
}

const state = readState();
const running = Object.entries(state.processes ?? {}).filter(([, e]) => isOurs(e));
if (running.length) throw new Error(`Demo already running (${running.map(([n]) => n).join(', ')}); run stop.mjs first.`);

// 1. Infra (own containers only, loopback).
await import('./infra-up.mjs');

// 2. Preflight.
const pf = await preflight(key);
if (!pf.ok) {
  console.error(`preflight FAILED:\n  - ${pf.problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`preflight OK (${key}) at ${pf.sha}`);

// 3. Artifact integrity: the running bytes are the recorded bytes.
const artifact = path.join(ARTIFACTS_DIR, key);
const manifest = JSON.parse(fs.readFileSync(path.join(artifact, 'manifest.json'), 'utf8'));
const webNextDir = path.join(V3_ROOT, 'apps', 'web', '.next');
const distDir = path.join(V3_ROOT, 'dist');
const webNow = fs.existsSync(webNextDir) ? hashTree(webNextDir, { exclude: ['cache', 'trace'] }).sha256 : null;
if (webNow !== manifest.webNext.sha256) {
  console.log('web .next differs from the artifact; restoring the recorded build');
  fs.rmSync(webNextDir, { recursive: true, force: true });
  fs.cpSync(path.join(artifact, 'web-next'), webNextDir, { recursive: true });
}
const distNow = fs.existsSync(distDir) ? hashTree(distDir).sha256 : null;
if (distNow !== manifest.apiDist.sha256) {
  throw new Error('API dist differs from the recorded artifact. Rebuild with build-artifact.mjs (or restore it) before starting.');
}
if (hashTree(webNextDir, { exclude: ['cache', 'trace'] }).sha256 !== manifest.webNext.sha256) throw new Error('web artifact restore failed integrity check');
console.log(`artifact OK: web BUILD_ID ${manifest.webBuildId}, api dist ${manifest.apiDist.sha256.slice(0, 12)}`);

const secrets = loadSecrets();
const procs = {};
const save = () => writeState({ profile: key, sha: pf.sha, wireguard: activateWg, startedAt: new Date().toISOString(), processes: procs });
const ca = fs.readFileSync(path.join(CERTS_DIR, 'demo-ca.crt'));
const httpsOk = (port, pathName = '/') =>
  new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port, path: pathName, ca, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode > 0 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => req.destroy());
  });

for (const port of [PORTS.inboxViewer, PORTS.inboxIngest, PORTS.api, PORTS.web, PORTS.ingress]) {
  if (listening(port).length) throw new Error(`port ${port} is already in use; refusing to start`);
}

// 4. Inbox.
const inboxEnv = { ...baseProcessEnv(), BCDEMO_INBOX_VIEWER_BINDS: activateWg ? `127.0.0.1,${WIREGUARD.hostAddress}` : '127.0.0.1' };
procs.inbox = startDetached('inbox', process.execPath, [path.join(DEMO_ROOT, 'inbox', 'main.mjs')], { cwd: DEMO_ROOT, env: inboxEnv, marker: path.join('demo', 'inbox', 'main.mjs') });
save();
await waitFor(() => httpsOk(PORTS.inboxViewer), { what: 'inbox viewer', timeoutMs: 30_000 });
console.log(`inbox: up (pid ${procs.inbox.pid})`);

// 5. API (compiled dist, sandbox runtime).
procs.api = startDetached(
  'api',
  process.execPath,
  ['-r', path.join(V3_ROOT, 'apps', 'api', 'node_modules', 'tsconfig-paths', 'register.js'), path.join('dist', 'apps', 'api', 'src', 'main.js')],
  { cwd: V3_ROOT, env: { ...apiEnv(secrets, key), TS_NODE_PROJECT: path.join(V3_ROOT, 'infra', 'docker', 'tsconfig.runtime.json') }, marker: path.join('dist', 'apps', 'api', 'src', 'main.js') },
);
save();
await waitFor(async () => (await fetch(`http://127.0.0.1:${PORTS.api}/api/health`)).ok, { what: 'API health', timeoutMs: 180_000, intervalMs: 2000 });
console.log(`api: up (pid ${procs.api.pid})`);

// 6. Web (production next start).
const webDir = path.join(V3_ROOT, 'apps', 'web');
procs.web = startDetached(
  'web',
  process.execPath,
  [path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORTS.web), '-H', '127.0.0.1'],
  { cwd: webDir, env: { ...webEnv(key), NEXT_PUBLIC_DEMO_LABEL: '1' }, marker: `start -p ${PORTS.web}` },
);
save();
await waitFor(async () => (await fetch(`http://127.0.0.1:${PORTS.web}/`)).status < 500, { what: 'web', timeoutMs: 120_000, intervalMs: 2000 });
console.log(`web: up (pid ${procs.web.pid})`);

// 7. Ingress (a separate Caddy instance: admin API off, no automatic HTTPS, no :80).
const binds = activateWg ? `127.0.0.1 ${WIREGUARD.hostAddress}` : '127.0.0.1';
const caddyfile = path.join(STATE_DIR, 'Caddyfile');
const fwd = (s) => s.replace(/\\/g, '/');
fs.writeFileSync(
  caddyfile,
  `{
\tadmin off
\tauto_https off
\tpersist_config off
\tservers {
\t\tprotocols h1 h2
\t}
}

:${PORTS.ingress} {
\tbind ${binds}
\ttls ${fwd(path.join(CERTS_DIR, 'demo-leaf-chain.crt'))} ${fwd(path.join(CERTS_DIR, 'demo-leaf.key'))}
\t# Never reachable through the ingress: the dev-login seam (also disabled in the
\t# API), metrics, and the readiness detail. No access log (URLs can carry tokens).
\t# \`route\` runs its directives in the order written. (Without it Caddy sorts
\t# \`handle\` before \`respond\`, and the block below would never fire -- found by
\t# the smoke test when /api/health/ready answered 200.)
\t@blocked path /api/v1/auth/dev-login /api/v1/auth/dev-login/* /api/metrics /api/metrics/* /api/health/ready
\theader {
\t\t-Server
\t\tStrict-Transport-Security "max-age=600"
\t}
\troute {
\t\trespond @blocked 404
\t\trequest_body {
\t\t\tmax_size 12MB
\t\t}
\t\treverse_proxy /api/* 127.0.0.1:${PORTS.api}
\t\treverse_proxy 127.0.0.1:${PORTS.web}
\t}
}
`,
);
procs.ingress = startDetached('ingress', 'caddy', ['run', '--config', caddyfile, '--adapter', 'caddyfile'], {
  cwd: STATE_DIR,
  env: { ...baseProcessEnv(), XDG_DATA_HOME: path.join(STATE_DIR, 'caddy-data'), XDG_CONFIG_HOME: path.join(STATE_DIR, 'caddy-config') },
  marker: caddyfile,
});
save();
await waitFor(() => httpsOk(PORTS.ingress, '/api/health'), { what: 'ingress', timeoutMs: 30_000 });
const bound = listening(PORTS.ingress);
console.log(`ingress: up (pid ${procs.ingress.pid}) bound on ${bound.join(', ')}`);
const allowed = activateWg ? ['127.0.0.1', WIREGUARD.hostAddress] : ['127.0.0.1'];
if (bound.some((a) => !allowed.includes(a))) throw new Error(`ingress bound unexpectedly on ${bound.join(', ')}`);
// Every other demo port must be loopback-only (the inbox viewer may add the WireGuard address).
const exposure = [];
for (const [name, port] of Object.entries(PORTS)) {
  if (name === 'ingress') continue;
  const ok = name === 'inboxViewer' ? allowed : ['127.0.0.1'];
  for (const a of listening(port)) if (!ok.includes(a)) exposure.push(`${name}:${port} on ${a}`);
}
if (exposure.length) {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [path.join(DEMO_ROOT, 'scripts', 'stop.mjs'), '--keep-infra'], { stdio: 'inherit' });
  throw new Error(`EXPOSURE: ${exposure.join('; ')} — app stopped`);
}
console.log('bind check: every demo port is loopback-only' + (activateWg ? ' (ingress and inbox viewer also on WireGuard)' : ''));

console.log(`\nDEMO READY — profile ${key} — ${p.origin}  (source ${pf.sha.slice(0, 12)}; logs in ${LOGS_DIR})`);
