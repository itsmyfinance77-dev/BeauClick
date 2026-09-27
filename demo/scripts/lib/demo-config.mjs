// Shared, NON-SECRET demo configuration. Secret values never live here: they are
// generated into the runtime root (outside git) by init-secrets.mjs.
//
// Every resource this demo owns is named here, once, so the guarded reset and the
// fail-closed preflight can refuse anything that is not on this list.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const V3_ROOT = path.join(REPO_ROOT, 'v3');
export const DEMO_ROOT = path.join(REPO_ROOT, 'demo');

/** Runtime root: env, secrets, certificates, logs, backups. Outside git, never committed. */
export const RUNTIME_ROOT = process.env.BCDEMO_RUNTIME_ROOT ?? 'E:\\BeauClick-demo';
export const SECRETS_DIR = path.join(RUNTIME_ROOT, 'secrets');
export const CERTS_DIR = path.join(RUNTIME_ROOT, 'certs');
export const LOGS_DIR = path.join(RUNTIME_ROOT, 'logs');
export const BACKUPS_DIR = path.join(RUNTIME_ROOT, 'backups');
export const STATE_DIR = path.join(RUNTIME_ROOT, 'state');
export const ARTIFACTS_DIR = path.join(RUNTIME_ROOT, 'artifacts');
export const SECRETS_FILE = path.join(SECRETS_DIR, 'demo-secrets.json');
export const MEMBERS_FILE = path.join(SECRETS_DIR, 'inbox-members.json');
export const HANDOUTS_DIR = path.join(SECRETS_DIR, 'handouts');

export const COMPOSE_PROJECT = 'bcdemo';
export const COMPOSE_FILE = path.join(DEMO_ROOT, 'compose.yml');

export const CONTAINERS = Object.freeze({
  pg: 'bcdemo-pg',
  os: 'bcdemo-os',
  ingress: 'bcdemo-ingress',
});
export const VOLUMES = Object.freeze(['bcdemo-pg-data', 'bcdemo-os-data']);

export const DB_NAME = 'beauclick_demo';
export const MEDIA_DIR = path.join(RUNTIME_ROOT, 'state', 'media');

/** Loopback ports. Only the ingress and the inbox viewer may ever bind a WireGuard address. */
export const PORTS = Object.freeze({
  pg: 55432,
  os: 59200,
  api: 53199,
  web: 53100,
  ingress: 58443,
  inboxViewer: 58444,
  inboxIngest: 58445,
});

export const WIREGUARD = Object.freeze({ hostAddress: '10.20.30.6', network: '10.20.30.0', prefix: 24 });

/**
 * Build/origin profiles. One canonical origin per build (the API builds its payment
 * callback from one PUBLIC_API_BASE_URL and the web bakes NEXT_PUBLIC_API_BASE_URL).
 */
export const PROFILES = Object.freeze({
  L: { name: 'loopback', origin: `https://127.0.0.1:${PORTS.ingress}`, ingressBinds: ['127.0.0.1'] },
  W: {
    name: 'wireguard',
    origin: `https://${WIREGUARD.hostAddress}:${PORTS.ingress}`,
    ingressBinds: ['127.0.0.1', WIREGUARD.hostAddress],
  },
});

export function profile(key) {
  const p = PROFILES[key];
  if (!p) throw new Error(`Unknown demo profile "${key}". Valid: ${Object.keys(PROFILES).join(', ')}`);
  return { key, ...p };
}

/** Postgres roles, as CI provisions them. */
export const PG_ROLES = Object.freeze({
  app: 'beauclick_app',
  financialOwner: 'beauclick_financial_owner',
  financialWriter: 'beauclick_financial_writer',
  financialReader: 'beauclick_financial_reader',
  auditOwner: 'beauclick_admin_audit_owner',
});

export function pgUrl(user, password, db = DB_NAME) {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${PORTS.pg}/${db}`;
}
