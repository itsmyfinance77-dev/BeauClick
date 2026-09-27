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
//  - the demo PKI is v2 (ca-v2.mjs): every name form constrained at a non-anchor
//    intermediate and at the root, and both CA keys destroyed after issuance;
//  - nothing here installs trust anywhere. Importing the CA root is each viewer's
//    own manual decision (demo/README.md).
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
// 2. Demo PKI (v2): constrained root + constrained intermediate + leaf, root and
//    intermediate keys destroyed after issuance. See ca-v2.mjs. (v1 — a single CA
//    constraining only iPAddress — was withdrawn after review; never regenerated.)
// ---------------------------------------------------------------------------
fs.mkdirSync(CERTS_DIR, { recursive: true });
const caCrt = path.join(CERTS_DIR, 'demo-ca.crt');
const fingerprintsFile = path.join(CERTS_DIR, 'fingerprints.json');
if (fs.existsSync(caCrt) && fs.existsSync(fingerprintsFile)) {
  console.log(`certs: kept existing v2 PKI in ${CERTS_DIR}`);
} else {
  if (fs.existsSync(caCrt)) throw new Error(`${CERTS_DIR} holds a pre-v2 CA; retire it first (see DEMO_PROGRESS.md), never reuse it.`);
  execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'ca-v2.mjs')], { stdio: 'inherit' });
  const staging = path.join(path.dirname(CERTS_DIR), 'certs-v2-staging');
  fs.rmSync(CERTS_DIR, { recursive: true, force: true });
  fs.renameSync(staging, CERTS_DIR);
  console.log(`certs: v2 PKI promoted into ${CERTS_DIR}`);
}
const caFingerprint = JSON.parse(fs.readFileSync(fingerprintsFile, 'utf8')).rootSha256;

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
