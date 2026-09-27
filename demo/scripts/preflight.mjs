#!/usr/bin/env node
// Fail-closed demo preflight. Run by start.mjs before anything starts; exits 1 on
// any violation. Also usable standalone: node demo/scripts/preflight.mjs --profile L
//
// Checks (see DEMO_PROGRESS.md "NODE_ENV audit"):
//  1. no real-provider / bypass configuration anywhere — neither in the assembled
//     API env nor inherited from the parent shell;
//  2. the app's OWN production validator over the exact demo env yields only the
//     enumerated sandbox divergences (everything else — secret strength, reuse,
//     https URLs, dev-seam presence — must pass);
//  3. every outbound simulator endpoint is https on loopback;
//  4. the financial writer role is not privileged (the check production runs at boot);
//  5. the running source is the frozen artifact's SHA with a clean tracked tree.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ARTIFACTS_DIR, V3_ROOT, profile as resolveProfile } from './lib/demo-config.mjs';
import { apiEnv, loadSecrets, readSourceSha, writerUrl } from './lib/runtime.mjs';

export async function preflight(profileKey, { requireArtifact = true, log = console.log } = {}) {
  const problems = [];
  const p = resolveProfile(profileKey);
  const secrets = loadSecrets();
  const env = apiEnv(secrets, profileKey);

  // 1. Real-provider / bypass configuration.
  const FORBIDDEN = [
    'DEV_QA_LOGIN', 'DEV_QA_LOGIN_PHONES', 'ERROR_REPORTER_ENDPOINT', 'ERROR_REPORTER_AUTH_VALUE',
    'FINANCIAL_COMMISSION_RATE_BP', 'DISABLE_BACKGROUND_SWEEPS', 'AI_DEFAULT_PROVIDER',
    'MEDIA_ALLOW_LOCAL_DRIVER_IN_PRODUCTION', 'MEDIA_S3_ENDPOINT', 'MEDIA_S3_ACCESS_KEY_ID',
  ];
  for (const k of FORBIDDEN) if (env[k] !== undefined) problems.push(`assembled API env carries forbidden ${k}`);
  // The API's env is assembled from scratch (baseProcessEnv passes OS plumbing only),
  // so nothing inherited can reach it. This still refuses to start when the parent
  // shell carries a provider/bypass variable THE APP READS: someone configured a real
  // provider here, and the fail-closed answer is to stop and ask, not to guess.
  const APP_READ_PREFIXES = ['SMS_HTTP_', 'PAYMENT_', 'ERROR_REPORTER_', 'AI_DEFAULT_PROVIDER', 'AI_PROVIDER_', 'DEV_QA_LOGIN', 'MEDIA_S3_', 'METRICS_AUTH_TOKEN', 'DEMO_OTP_INBOX'];
  const inherited = Object.keys(process.env).filter((k) => APP_READ_PREFIXES.some((pre) => k.toUpperCase().startsWith(pre)));
  if (inherited.length) problems.push(`parent shell carries provider/bypass variables (${inherited.join(', ')}); refusing rather than guessing which is real`);
  if (env.PAYMENT_ENVIRONMENT !== 'sandbox' || env.PAYMENT_DEFAULT_PROVIDER !== 'sandbox') problems.push('payment must be the sandbox');
  if (env.NODE_ENV !== 'development') problems.push('API sandbox runtime must be NODE_ENV=development (sandbox gateway contract)');
  if (env.AUTH_COOKIE_SECURE !== 'true') problems.push('AUTH_COOKIE_SECURE must be true');
  if (!env.OPENSEARCH_URL) problems.push('OPENSEARCH_URL must be set (no in-memory search)');
  if (env.LOG_FORMAT !== 'json') problems.push('LOG_FORMAT must be json');
  if (env.BIND_HOST !== '127.0.0.1') problems.push('BIND_HOST must be 127.0.0.1 (the API must not listen on other interfaces)');

  // 3. Simulator endpoints: https + loopback.
  for (const k of ['SMS_HTTP_ENDPOINT', 'DEMO_OTP_INBOX_URL']) {
    try {
      const u = new URL(env[k]);
      if (u.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) problems.push(`${k} must be https on loopback`);
    } catch {
      problems.push(`${k} is not a URL`);
    }
  }
  for (const k of ['OPENSEARCH_URL', 'DATABASE_URL', 'FINANCIAL_DATABASE_URL']) {
    if (!new URL(env[k]).hostname.startsWith('127.0.0.1')) problems.push(`${k} must be loopback`);
  }
  for (const k of ['PUBLIC_API_BASE_URL', 'PUBLIC_WEB_BASE_URL', 'CORS_ALLOWED_ORIGINS']) {
    if (!String(env[k]).startsWith(p.origin)) problems.push(`${k} must be the profile origin ${p.origin}`);
  }

  // 2. The app's own production validator over the exact demo env.
  const validatorPath = path.join(V3_ROOT, 'dist', 'apps', 'api', 'src', 'config', 'env.validation.js');
  if (!fs.existsSync(validatorPath)) {
    problems.push('compiled API not found (build the artifact first)');
  } else {
    const { productionConfigurationErrors } = createRequire(import.meta.url)(validatorPath);
    const expected = [
      /^PAYMENT_ENVIRONMENT must be "production"/,
      /^PAYMENT_DEFAULT_PROVIDER=sandbox is refused in production/,
      /^MEDIA_STORAGE_DRIVER=local is refused in production/,
      ...(profileKey === 'L' ? [/^CORS_ALLOWED_ORIGINS contains the loopback origin/] : []),
    ];
    const errors = productionConfigurationErrors(env);
    const unexpected = errors.filter((e) => !expected.some((re) => re.test(e)));
    const matched = expected.filter((re) => errors.some((e) => re.test(e)));
    for (const e of unexpected) problems.push(`production validator: ${e}`);
    log(`preflight: production validator → ${errors.length} finding(s), ${matched.length} enumerated sandbox divergence(s), ${unexpected.length} unexpected`);
  }

  // 4. Writer role not privileged (the production boot check, run as the writer).
  try {
    const require = createRequire(path.join(V3_ROOT, 'apps', 'api', 'package.json'));
    const { Client } = require('pg');
    const c = new Client({ connectionString: writerUrl(secrets) });
    await c.connect();
    const su = await c.query('SELECT usesuper FROM pg_user WHERE usename = current_user');
    const upd = await c.query("SELECT has_table_privilege('financial.ledger_entries', 'UPDATE') AS has");
    await c.end();
    if (su.rows[0]?.usesuper !== false) problems.push('financial writer role is a superuser');
    if (upd.rows[0]?.has !== false) problems.push('financial writer role can UPDATE the ledger');
  } catch (e) {
    problems.push(`writer-role check could not run (${e instanceof Error ? e.message.split('\n')[0] : 'error'})`);
  }

  // 5. Frozen artifact identity.
  const sha = readSourceSha();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (dirty) problems.push('tracked files are modified; the running source would not be the recorded SHA');
  if (requireArtifact) {
    const manifestFile = path.join(ARTIFACTS_DIR, profileKey, 'manifest.json');
    if (!fs.existsSync(manifestFile)) problems.push(`no artifact manifest for profile ${profileKey}`);
    else {
      const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      // The application bytes come only from v3/. A later commit that touches only
      // demo/ tooling leaves them identical; anything under v3/ must match exactly.
      // (The freeze rebuilds at the final exact SHA regardless.)
      const v3Now = execFileSync('git', ['rev-parse', 'HEAD:v3'], { encoding: 'utf8' }).trim();
      const v3Then = execFileSync('git', ['rev-parse', `${m.sourceSha}:v3`], { encoding: 'utf8' }).trim();
      if (v3Now !== v3Then) problems.push(`artifact ${profileKey} was built from ${m.sourceSha.slice(0, 12)} whose v3/ differs from HEAD's; rebuild`);
      else if (m.sourceSha !== sha) log(`preflight: artifact built at ${m.sourceSha.slice(0, 12)}; HEAD ${sha.slice(0, 12)} differs only outside v3/ (application source identical)`);
    }
  }

  return { ok: problems.length === 0, problems, sha };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('preflight.mjs')) {
  const i = process.argv.indexOf('--profile');
  const key = i > 0 ? process.argv[i + 1] : 'L';
  const res = await preflight(key, { requireArtifact: !process.argv.includes('--no-artifact') });
  if (!res.ok) {
    console.error(`preflight FAILED (${res.problems.length}):\n  - ${res.problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`preflight OK for profile ${key} at ${res.sha}`);
}
