// Runtime helpers shared by the demo scripts: secret loading, env assembly,
// child-process execution that never echoes secret values.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

import {
  CERTS_DIR,
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  DB_NAME,
  MEDIA_DIR,
  PG_ROLES,
  PORTS,
  SECRETS_FILE,
  pgUrl,
  profile as resolveProfile,
} from './demo-config.mjs';
import { SYNTHETIC_PHONES } from '../../seed/personas.mjs';
import path from 'node:path';

export function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) {
    throw new Error(`Demo secrets missing (${SECRETS_FILE}). Run: node demo/scripts/init-secrets.mjs`);
  }
  return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
}

/** Environment for `docker compose` (infra only). */
export function composeEnv(secrets) {
  return {
    ...process.env,
    BCDEMO_PG_SUPERUSER_PASSWORD: secrets.postgresSuperuserPassword,
  };
}

export function compose(args, secrets, opts = {}) {
  return spawnSync('docker', ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, ...args], {
    env: composeEnv(secrets),
    stdio: opts.stdio ?? 'inherit',
    encoding: 'utf8',
  });
}

export const superuserUrl = (s, db = DB_NAME) => pgUrl('postgres', s.postgresSuperuserPassword, db);
export const appUrl = (s) => pgUrl(PG_ROLES.app, s.appPassword);
export const writerUrl = (s) => pgUrl(PG_ROLES.financialWriter, s.financialWriterPassword);

/**
 * The API process environment for a profile. Everything that could reach a real
 * provider is either absent or pointed at loopback simulators; preflight.mjs
 * re-checks the assembled result and refuses to start on any violation.
 */
export function apiEnv(secrets, profileKey) {
  const p = resolveProfile(profileKey);
  const origin = p.origin;
  const inboxIngest = `https://127.0.0.1:${PORTS.inboxIngest}/ingest`;
  return {
    // Minimal inherited environment: PATH/SystemRoot etc., but NO inherited
    // provider variables -- the parent shell's env is filtered below.
    ...baseProcessEnv(),
    // The sandbox payment gateway and the development media/search fallbacks are
    // structurally disabled under NODE_ENV=production with no override (EXC-001).
    // The artifacts are production builds; the API process runs as development.
    NODE_ENV: 'development',
    PORT: String(PORTS.api),
    // Loopback only (demo seam in main.ts); the ingress is the only way in.
    BIND_HOST: '127.0.0.1',
    LOG_FORMAT: 'json',
    RELEASE_VERSION: `demo-${readSourceSha().slice(0, 12)}`,
    DATABASE_URL: appUrl(secrets),
    FINANCIAL_DATABASE_URL: writerUrl(secrets),
    JWT_ACCESS_SECRET: secrets.jwtAccessSecret,
    OTP_HMAC_SECRET: secrets.otpHmacSecret,
    WORKSPACE_REFERENCE_HMAC_SECRET: secrets.workspaceReferenceHmacSecret,
    MEDIA_UPLOAD_TOKEN_SECRET: secrets.mediaUploadTokenSecret,
    MEDIA_DOWNLOAD_TOKEN_SECRET: secrets.mediaDownloadTokenSecret,
    PUBLIC_API_BASE_URL: `${origin}/api`,
    PUBLIC_WEB_BASE_URL: origin,
    CORS_ALLOWED_ORIGINS: origin,
    AUTH_COOKIE_SECURE: 'true',
    AUTH_COOKIE_SAMESITE: 'lax',
    OPENSEARCH_URL: `http://127.0.0.1:${PORTS.os}`,
    // Development-only local driver: uploads (token-signed PUT) and public reads
    // both go through the API on the one ingress origin; nothing else is exposed.
    MEDIA_STORAGE_DRIVER: 'local',
    MEDIA_LOCAL_ROOT: MEDIA_DIR,
    PAYMENT_ENVIRONMENT: 'sandbox',
    PAYMENT_DEFAULT_PROVIDER: 'sandbox',
    // One ingress address for the whole team (no trust proxy) + seeding from
    // loopback: the per-IP OTP window would otherwise be team-wide. Every other
    // OTP control keeps its default. Recorded in DEMO_PROGRESS.md.
    OTP_MAX_PER_IP_PER_HOUR: '60',
    // SMS notifications -> local inbox simulator (https + bearer, loopback only).
    SMS_HTTP_ENDPOINT: inboxIngest,
    SMS_HTTP_AUTH_HEADER: 'Authorization',
    SMS_HTTP_AUTH_VALUE: `Bearer ${secrets.inboxIngestToken}`,
    SMS_HTTP_BODY_TEMPLATE: '{"to":"{{to}}","text":"{{text}}","kind":"notification"}',
    SMS_HTTP_CONTENT_TYPE: 'application/json',
    // OTP code delivery -> the same inbox (demo adapter, opt-in, fail-closed).
    DEMO_OTP_INBOX: '1',
    DEMO_OTP_INBOX_URL: inboxIngest,
    DEMO_OTP_INBOX_TOKEN: secrets.inboxIngestToken,
    DEMO_SYNTHETIC_PHONES: SYNTHETIC_PHONES.join(','),
    // Trust the private demo CA for this process's OWN outbound calls to the
    // loopback inbox only. Nothing is installed in any system trust store.
    NODE_EXTRA_CA_CERTS: path.join(CERTS_DIR, 'demo-ca.crt'),
  };
}

export function webEnv(profileKey) {
  const p = resolveProfile(profileKey);
  return {
    ...baseProcessEnv(),
    NODE_ENV: 'production',
    NEXT_PUBLIC_API_BASE_URL: `${p.origin}/api`,
    NEXT_PUBLIC_SITE_URL: p.origin,
    NEXT_TELEMETRY_DISABLED: '1',
    // SSR fetches go through the https ingress; trust the demo CA for this process only.
    NODE_EXTRA_CA_CERTS: path.join(CERTS_DIR, 'demo-ca.crt'),
  };
}

const PASS_THROUGH = [
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'COMSPEC', 'ComSpec',
  'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'TZ',
];

/** A clean base environment: only OS plumbing, never the parent's app/provider variables. */
export function baseProcessEnv() {
  const env = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export function readSourceSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export { DB_NAME, MEDIA_DIR, PG_ROLES, PORTS };
