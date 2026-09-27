#!/usr/bin/env node
// Builds the pinned demo artifact for one origin profile and records its identity.
//
//   node demo/scripts/build-artifact.mjs --profile L     (loopback; testing + fallback)
//   node demo/scripts/build-artifact.mjs --profile W     (WireGuard; presentation)
//
// One build at a time (host memory); refuses while our web server is running
// (a build overwrites .next under a live server). The previous artifact for the
// profile is kept as <profile>.prev for rollback.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ARTIFACTS_DIR, PORTS, V3_ROOT, profile as resolveProfile } from './lib/demo-config.mjs';
import { hashTree } from './lib/hash-tree.mjs';
import { readSourceSha, webEnv } from './lib/runtime.mjs';

const i = process.argv.indexOf('--profile');
const key = i > 0 ? process.argv[i + 1] : null;
const p = resolveProfile(key);

const WEB = path.join(V3_ROOT, 'apps', 'web');
const DIST = path.join(V3_ROOT, 'dist');

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
}
/**
 * Mirrors Dockerfile.api's runtime step: each workspace package's node_modules is
 * linked into the matching position under dist/, so Node resolves every compiled
 * package's dependencies exactly as it does from the source tree (pnpm does not
 * hoist them to the workspace root). Junctions on Windows; excluded from hashing
 * and from the artifact copy.
 */
export function linkDistNodeModules() {
  const groups = [['apps', ['api']], ['libs'], ['services'], ['packages']];
  let linked = 0;
  for (const [top, only] of groups) {
    const names = only ?? fs.readdirSync(path.join(V3_ROOT, top));
    for (const name of names) {
      const src = path.join(V3_ROOT, top, name, 'node_modules');
      if (!fs.existsSync(src)) continue;
      const dstDir = path.join(DIST, top, name);
      fs.mkdirSync(dstDir, { recursive: true });
      const dst = path.join(dstDir, 'node_modules');
      fs.rmSync(dst, { recursive: true, force: true });
      fs.symlinkSync(src, dst, 'junction');
      linked++;
    }
  }
  if (!fs.existsSync(path.join(DIST, 'apps', 'api', 'node_modules', 'reflect-metadata'))) {
    throw new Error('dist node_modules links did not resolve reflect-metadata');
  }
  console.log(`linked ${linked} package node_modules into dist/`);
}

const fileSha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// --- guards -----------------------------------------------------------------
const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
if (status) throw new Error(`Refusing to build: the worktree is not clean.\n${status}`);
if (fs.existsSync(path.join(WEB, '.env.local')) || fs.existsSync(path.join(WEB, '.env.production.local'))) {
  throw new Error('Refusing to build: apps/web has a local .env file that would leak into the bundle.');
}
try {
  execFileSync('powershell', ['-NoProfile', '-Command', `if (Get-NetTCPConnection -State Listen -LocalPort ${PORTS.web} -ErrorAction SilentlyContinue) { exit 3 }`], { stdio: 'ignore' });
} catch {
  throw new Error(`Refusing to build: something is listening on :${PORTS.web} (stop the demo web server first).`);
}

const sha = readSourceSha();
const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
console.log(`building profile ${key} (${p.origin}) from ${sha}`);

// --- API (profile-independent compiled output) ---------------------------------
fs.rmSync(DIST, { recursive: true, force: true });
run('npx', ['nx', 'run', 'api:build', '--skip-nx-cache'], { cwd: V3_ROOT });
linkDistNodeModules();

// --- Web (production build; origin baked in) ----------------------------------
fs.rmSync(path.join(WEB, '.next'), { recursive: true, force: true });
run('npx', ['next', 'build'], { cwd: WEB, env: { ...webEnv(key), NEXT_PUBLIC_DEMO_LABEL: '1' } });

// --- record + keep ------------------------------------------------------------
const outDir = path.join(ARTIFACTS_DIR, key);
if (fs.existsSync(outDir)) {
  fs.rmSync(`${outDir}.prev`, { recursive: true, force: true });
  fs.renameSync(outDir, `${outDir}.prev`);
}
fs.mkdirSync(outDir, { recursive: true });
fs.cpSync(path.join(WEB, '.next'), path.join(outDir, 'web-next'), { recursive: true });
fs.cpSync(DIST, path.join(outDir, 'api-dist'), { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' });

const manifest = {
  profile: key,
  origin: p.origin,
  sourceSha: sha,
  sourceTree: tree,
  v3Tree: execFileSync('git', ['rev-parse', 'HEAD:v3'], { encoding: 'utf8' }).trim(),
  baselineSha: 'b2477a30de93ccec22233f5c117db653f2b9ece1',
  lockfileSha256: fileSha(path.join(V3_ROOT, 'pnpm-lock.yaml')),
  builtAt: new Date().toISOString(),
  node: process.version,
  pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim(),
  next: JSON.parse(fs.readFileSync(path.join(WEB, 'node_modules', 'next', 'package.json'), 'utf8')).version,
  webBuildId: fs.readFileSync(path.join(WEB, '.next', 'BUILD_ID'), 'utf8').trim(),
  // cache/ holds build-time caches that change between identical builds.
  webNext: hashTree(path.join(outDir, 'web-next'), { exclude: ['cache', 'trace'] }),
  apiDist: hashTree(path.join(outDir, 'api-dist')),
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
