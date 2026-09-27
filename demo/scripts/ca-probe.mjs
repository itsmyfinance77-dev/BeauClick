#!/usr/bin/env node
// Negative/positive name-constraint probes for a demo CA (RFC 5280 §4.2.1.10).
// Issues DISPOSABLE leaf certificates in a temp dir, verifies each with OpenSSL
// against the CA as the only trust anchor, prints the verdicts, and deletes every
// probe key and certificate. Nothing is ever served or installed.
//   node demo/scripts/ca-probe.mjs <caCert> <caKey>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [caCrt, caKey] = process.argv.slice(2);
if (!caCrt || !caKey) throw new Error('usage: ca-probe.mjs <caCert> <caKey>');

// [SAN, expected] — expected 'accept' only for the two demo IP addresses.
export const PROBES = [
  ['IP:127.0.0.1', 'accept'],
  ['IP:10.20.30.6', 'accept'],
  ['IP:127.0.0.1, IP:10.20.30.6', 'accept'],
  ['IP:10.0.0.1', 'reject'],
  ['IP:10.20.30.7', 'reject'],
  ['IP:::1', 'reject'],
  ['DNS:example.test', 'reject'],
  ['DNS:localhost', 'reject'],
  ['DNS:www.google.com', 'reject'],
  ['DNS:invalid', 'reject'],
  ['DNS:x.invalid', 'reject'],
  ['email:someone@example.test', 'reject'],
  ['URI:https://example.test/', 'reject'],
  ['IP:127.0.0.1, DNS:example.test', 'reject'],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcdemo-ca-probe-'));
const ossl = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
let failures = 0;
try {
  const key = path.join(dir, 'k.pem');
  const csr = path.join(dir, 'r.csr');
  ossl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
  ossl(['req', '-new', '-key', key, '-subj', '/CN=bcdemo-probe', '-out', csr]);
  PROBES.forEach(([san, expected], i) => {
    const ext = path.join(dir, `e${i}.cnf`);
    const crt = path.join(dir, `p${i}.crt`);
    fs.writeFileSync(ext, `[v]\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
    ossl(['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-set_serial', String(1000 + i), '-days', '1', '-extfile', ext, '-extensions', 'v', '-out', crt]);
    let verdict;
    let detail = '';
    try {
      ossl(['verify', '-x509_strict', '-CAfile', caCrt, crt]);
      verdict = 'accept';
    } catch (e) {
      verdict = 'reject';
      detail = String(e.stdout || e.stderr).split('\n').find((l) => /error \d+/.test(l)) ?? '';
    }
    const ok = verdict === expected;
    if (!ok) failures++;
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${san.padEnd(34)} expected ${expected.padEnd(6)} got ${verdict}${detail ? `  (${detail.trim()})` : ''}`);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fs.existsSync(dir) ? 'WARNING: probe dir not deleted' : 'probe keys/certificates deleted');
}
process.exit(failures ? 1 : 0);
