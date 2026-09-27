#!/usr/bin/env node
// Generates every demo-only secret, the private demo CA + TLS leaf, and the inbox
// member credentials, into the runtime root (outside git).
//
//   node demo/scripts/init-secrets.mjs            # create what is missing; never overwrites
//   node demo/scripts/init-secrets.mjs --rotate-members   # new inbox passwords + handouts only
//
// Guarantees:
//  - no value is printed to stdout/stderr, only file paths and counts;
//  - existing secrets are never overwritten (a rotation of DB role passwords would
//    strand the running cluster -- roles are cluster-global);
//  - the CA is name-constrained to the demo IPs, so even a viewer who chooses to
//    trust it cannot be served a certificate for any other name by it;
//  - nothing here installs trust anywhere. Importing the CA root is each viewer's
//    own manual decision (demo/README.md).
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CERTS_DIR,
  HANDOUTS_DIR,
  MEMBERS_FILE,
  PORTS,
  PROFILES,
  SECRETS_DIR,
  SECRETS_FILE,
  WIREGUARD,
} from './lib/demo-config.mjs';
import { INBOX_MEMBER_SLOTS, persona } from '../seed/personas.mjs';

const rotateMembers = process.argv.includes('--rotate-members');

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
// Alphanumeric-only for values that end up in URLs or psql variables.
const alnum = (len) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// 1. Application and infrastructure secrets
// ---------------------------------------------------------------------------
fs.mkdirSync(SECRETS_DIR, { recursive: true });
if (fs.existsSync(SECRETS_FILE)) {
  console.log(`secrets: kept existing ${SECRETS_FILE}`);
} else {
  const secrets = {
    generatedAt: new Date().toISOString(),
    postgresSuperuserPassword: alnum(32),
    appPassword: alnum(32),
    financialOwnerPassword: alnum(32),
    financialWriterPassword: alnum(32),
    financialReaderPassword: alnum(32),
    auditOwnerPassword: alnum(32),
    jwtAccessSecret: secret(48),
    otpHmacSecret: secret(48),
    workspaceReferenceHmacSecret: secret(48),
    mediaUploadTokenSecret: secret(48),
    mediaDownloadTokenSecret: secret(48),
    inboxIngestToken: secret(48),
  };
  writePrivate(SECRETS_FILE, JSON.stringify(secrets, null, 2));
  console.log(`secrets: wrote ${Object.keys(secrets).length - 1} values to ${SECRETS_FILE}`);
}

// ---------------------------------------------------------------------------
// 2. Private demo CA (name-constrained) and the TLS leaf for ingress + inbox
// ---------------------------------------------------------------------------
fs.mkdirSync(CERTS_DIR, { recursive: true });
const caKey = path.join(CERTS_DIR, 'demo-ca.key');
const caCrt = path.join(CERTS_DIR, 'demo-ca.crt');
const leafKey = path.join(CERTS_DIR, 'demo-leaf.key');
const leafCrt = path.join(CERTS_DIR, 'demo-leaf.crt');
const leafChain = path.join(CERTS_DIR, 'demo-leaf-chain.crt');

const openssl = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

if (fs.existsSync(caCrt) && fs.existsSync(leafCrt)) {
  console.log(`certs: kept existing CA and leaf in ${CERTS_DIR}`);
} else {
  const caConf = path.join(CERTS_DIR, 'ca.cnf');
  fs.writeFileSync(
    caConf,
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      'x509_extensions = v3_ca',
      '[dn]',
      'CN = BeauClick DEMO ONLY private CA (2026-09-28, not for production)',
      'O = BeauClick demo (synthetic)',
      '[v3_ca]',
      'basicConstraints = critical, CA:TRUE, pathlen:0',
      'keyUsage = critical, keyCertSign, cRLSign',
      'subjectKeyIdentifier = hash',
      // Name constraints: the CA can only ever vouch for the two demo addresses.
      `nameConstraints = critical, permitted;IP:${WIREGUARD.hostAddress}/255.255.255.255, permitted;IP:127.0.0.1/255.255.255.255`,
      '',
    ].join('\n'),
  );
  openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', caKey]);
  openssl(['req', '-new', '-x509', '-key', caKey, '-out', caCrt, '-days', '21', '-config', caConf, '-sha256']);

  const leafConf = path.join(CERTS_DIR, 'leaf.cnf');
  fs.writeFileSync(
    leafConf,
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      '[dn]',
      'CN = BeauClick demo (synthetic data)',
      '[v3_leaf]',
      'basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = IP:127.0.0.1, IP:${WIREGUARD.hostAddress}`,
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid',
      '',
    ].join('\n'),
  );
  const csr = path.join(CERTS_DIR, 'demo-leaf.csr');
  openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', leafKey]);
  openssl(['req', '-new', '-key', leafKey, '-out', csr, '-config', leafConf]);
  openssl([
    'x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial',
    '-out', leafCrt, '-days', '14', '-sha256', '-extfile', leafConf, '-extensions', 'v3_leaf',
  ]);
  fs.writeFileSync(leafChain, fs.readFileSync(leafCrt, 'utf8') + fs.readFileSync(caCrt, 'utf8'));
  fs.rmSync(csr, { force: true });
  console.log(`certs: created name-constrained demo CA and leaf in ${CERTS_DIR}`);
}
const caFingerprint = openssl(['x509', '-in', caCrt, '-noout', '-fingerprint', '-sha256'])
  .toString()
  .trim()
  .replace(/^.*=/, '');

// ---------------------------------------------------------------------------
// 3. Inbox members (scrypt hashes) and per-member handouts
// ---------------------------------------------------------------------------
if (fs.existsSync(MEMBERS_FILE) && !rotateMembers) {
  console.log(`inbox: kept existing members file ${MEMBERS_FILE}`);
} else {
  fs.rmSync(HANDOUTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(HANDOUTS_DIR, { recursive: true });
  const members = [];
  for (const slot of INBOX_MEMBER_SLOTS) {
    const password = alnum(20);
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    const phones = slot.personas.map((k) => persona(k).phone);
    members.push({
      id: slot.id,
      role: slot.role,
      phones,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
    });
    const accounts = slot.personas.map((k) => persona(k));
    const lines = [
      'BeauClick team demo — personal access sheet (CONFIDENTIAL, internal team only)',
      '',
      `Inbox user:      ${slot.id}`,
      `Inbox password:  ${password}`,
      `Inbox address:   ${PROFILES.W.origin.replace(String(PORTS.ingress), String(PORTS.inboxViewer))}  (over WireGuard; not on the Internet)`,
      `Demo app:        ${PROFILES.W.origin}`,
      '',
      slot.role === 'owner'
        ? 'Scope: demo owner — sees every synthetic account\'s messages.'
        : 'Your synthetic account (sign in with its number, then read your code in the inbox):',
      ...accounts.map((a) => `  ${a.phone}   ${a.displayName}   role: ${a.intendedRole}`),
      '',
      'Certificate: the demo uses a private demo CA. Before trusting anything, compare this',
      `SHA-256 fingerprint with the one the owner shows you:  ${caFingerprint}`,
      'Importing the CA is your own choice; otherwise your browser will show a warning.',
      '',
      'Rules: synthetic data only; do not enter real personal data; do not share this sheet.',
      'The inbox keeps a code for 3 minutes and only in memory.',
      '',
    ];
    writePrivate(path.join(HANDOUTS_DIR, `${slot.id}.txt`), lines.join('\n'));
  }
  writePrivate(MEMBERS_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), members }, null, 2));
  console.log(`inbox: wrote ${members.length} members and handouts to ${HANDOUTS_DIR}`);
}
