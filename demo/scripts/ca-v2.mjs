#!/usr/bin/env node
// Demo PKI v2 — replaces the v1 CA after the Codex review finding (v1 constrained
// only iPAddress, so DNS/email/URI leaves validated; RFC 5280 §4.2.1.10 applies
// constraints per name form).
//
// Design:
//  1. ROOT (the only certificate anyone may choose to trust): CA, pathlen:1, name
//     constraints on every name form (IPs = the two demo addresses; DNS/email/URI
//     = only the reserved non-resolvable TLD "invalid", RFC 6761).
//  2. INTERMEDIATE: CA, pathlen:0, the SAME constraints. It is not a trust anchor,
//     so every RFC 5280 path validator must enforce its constraints — unlike
//     constraints on a root, which some verifiers do not apply to anchors.
//  3. LEAF: serverAuth, SAN IP:127.0.0.1, IP:10.20.30.6 only.
//  4. Probes BEFORE key destruction (OpenSSL, root as the only anchor):
//     every out-of-scope name form must be rejected at the intermediate layer, and
//     — with a deliberately UNCONSTRAINED probe intermediate — at the root layer.
//  5. The ROOT and INTERMEDIATE private keys are destroyed. The root can then only
//     ever validate chains through this one intermediate, which can only ever have
//     issued what exists now. Only the leaf key remains (the servers need it).
//  6. Browser-enforcement probes (leaf certs for DNS:localhost and IP:127.0.0.2,
//     issued by the intermediate before its key is destroyed) are kept QUARANTINED
//     in certs/quarantine-probes/ — never served except in an owner-approved test.
//
// Staged in certs-v2-staging/ and only moved into certs/ when every check passed.
//   node demo/scripts/ca-v2.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CERTS_DIR, RUNTIME_ROOT, WIREGUARD } from './lib/demo-config.mjs';

const STAGE = path.join(RUNTIME_ROOT, 'certs-v2-staging');
const ossl = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const f = (n) => path.join(STAGE, n);

const NC = [
  `permitted;IP:${WIREGUARD.hostAddress}/255.255.255.255`,
  'permitted;IP:127.0.0.1/255.255.255.255',
  'permitted;DNS:invalid',
  'permitted;email:invalid',
  'permitted;URI:invalid',
].join(', ');

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'quarantine-probes'), { recursive: true });

fs.writeFileSync(
  f('v2.cnf'),
  `[req]
distinguished_name = dn
prompt = no
[dn]
CN = BeauClick DEMO ONLY root v2 (2026-09-28, not for production)
O = BeauClick demo (synthetic)
[root]
basicConstraints = critical, CA:TRUE, pathlen:1
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, ${NC}
[inter]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
nameConstraints = critical, ${NC}
[probe_inter]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1, IP:${WIREGUARD.hostAddress}
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`,
);
const key = (n) => ossl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', f(n)]);
const csr = (k, cn, out) => ossl(['req', '-new', '-key', f(k), '-subj', `/CN=${cn}`, '-out', f(out), '-config', f('v2.cnf')]);
const sign = (csrN, caCrt, caKey, ext, days, out, serial) =>
  ossl(['x509', '-req', '-in', f(csrN), '-CA', f(caCrt), '-CAkey', f(caKey), '-set_serial', String(serial), '-days', String(days), '-sha256', '-extfile', f('v2.cnf'), '-extensions', ext, '-out', f(out)]);

// 1-3. Root, intermediate, leaf.
key('root.key');
ossl(['req', '-new', '-x509', '-key', f('root.key'), '-out', f('demo-ca.crt'), '-days', '21', '-sha256', '-config', f('v2.cnf'), '-extensions', 'root']);
key('inter.key');
csr('inter.key', 'BeauClick DEMO ONLY intermediate v2 (constrained)', 'inter.csr');
sign('inter.csr', 'demo-ca.crt', 'root.key', 'inter', 20, 'demo-intermediate.crt', 2);
key('demo-leaf.key');
csr('demo-leaf.key', 'BeauClick demo (synthetic data)', 'leaf.csr');
sign('leaf.csr', 'demo-intermediate.crt', 'inter.key', 'leaf', 14, 'demo-leaf.crt', 3);
fs.writeFileSync(f('demo-leaf-chain.crt'), fs.readFileSync(f('demo-leaf.crt'), 'utf8') + fs.readFileSync(f('demo-intermediate.crt'), 'utf8'));

// 4. Probes (all verification: root is the ONLY anchor; the intermediate is untrusted input).
const verify = (leafCrt, interCrt) => {
  try {
    ossl(['verify', '-x509_strict', '-CAfile', f('demo-ca.crt'), '-untrusted', f(interCrt), f(leafCrt)]);
    return 'accept';
  } catch (e) {
    return `reject (${(String(e.stdout || e.stderr).split('\n').find((l) => /error \d+/.test(l)) ?? '').trim()})`;
  }
};
const results = [];
const expect = (label, got, want) => {
  const ok = want === 'accept' ? got === 'accept' : got.startsWith('reject');
  results.push({ label, got, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(58)} ${got}`);
};
expect('real leaf (IP:127.0.0.1, IP:10.20.30.6) via intermediate', verify('demo-leaf.crt', 'demo-intermediate.crt'), 'accept');

key('probe.key');
csr('probe.key', 'bcdemo-probe', 'probe.csr');
const SANS = [
  ['IP:10.20.30.7', 'reject'],
  ['IP:::1', 'reject'],
  ['DNS:example.test', 'reject'],
  ['DNS:localhost', 'reject'],
  ['DNS:www.google.com', 'reject'],
  ['email:someone@example.test', 'reject'],
  ['URI:https://example.test/', 'reject'],
  ['IP:127.0.0.1, DNS:example.test', 'reject'],
];
let serial = 100;
for (const [san, want] of SANS) {
  fs.writeFileSync(f('p.cnf'), `[v]\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
  ossl(['x509', '-req', '-in', f('probe.csr'), '-CA', f('demo-intermediate.crt'), '-CAkey', f('inter.key'), '-set_serial', String(serial++), '-days', '14', '-extfile', f('p.cnf'), '-extensions', 'v', '-out', f('p.crt')]);
  expect(`intermediate layer: ${san}`, verify('p.crt', 'demo-intermediate.crt'), want);
}
// Root layer: an UNCONSTRAINED intermediate signed by the root must still be unable to vouch for DNS/other IPs.
key('pinter.key');
csr('pinter.key', 'bcdemo unconstrained probe intermediate', 'pinter.csr');
sign('pinter.csr', 'demo-ca.crt', 'root.key', 'probe_inter', 1, 'pinter.crt', 200);
for (const [san] of SANS) {
  fs.writeFileSync(f('p.cnf'), `[v]\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
  ossl(['x509', '-req', '-in', f('probe.csr'), '-CA', f('pinter.crt'), '-CAkey', f('pinter.key'), '-set_serial', String(serial++), '-days', '1', '-extfile', f('p.cnf'), '-extensions', 'v', '-out', f('p.crt')]);
  expect(`root layer (unconstrained probe intermediate): ${san}`, verify('p.crt', 'pinter.crt'), 'reject');
}

// 6. Quarantined browser-enforcement probes (issued by the real intermediate).
for (const [name, san] of [['dns-localhost', 'DNS:localhost'], ['ip-127-0-0-2', 'IP:127.0.0.2']]) {
  const q = path.join(STAGE, 'quarantine-probes');
  fs.writeFileSync(f('p.cnf'), `[v]\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
  ossl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', path.join(q, `${name}.key`)]);
  ossl(['req', '-new', '-key', path.join(q, `${name}.key`), '-subj', `/CN=bcdemo browser-enforcement probe ${name}`, '-out', f('q.csr')]);
  ossl(['x509', '-req', '-in', f('q.csr'), '-CA', f('demo-intermediate.crt'), '-CAkey', f('inter.key'), '-set_serial', String(serial++), '-days', '3', '-extfile', f('p.cnf'), '-extensions', 'v', '-out', path.join(q, `${name}.crt`)]);
  fs.writeFileSync(path.join(q, `${name}-chain.crt`), fs.readFileSync(path.join(q, `${name}.crt`), 'utf8') + fs.readFileSync(f('demo-intermediate.crt'), 'utf8'));
}
fs.writeFileSync(path.join(STAGE, 'quarantine-probes', 'README.txt'), 'QUARANTINED browser name-constraint probes. Never serve except in an owner-approved enforcement test; delete after.\n');

// 5. Destroy the root and intermediate keys, and every probe CA/leaf key used above.
for (const n of ['root.key', 'inter.key', 'pinter.key', 'pinter.crt', 'probe.key', 'probe.csr', 'p.crt', 'p.cnf', 'q.csr', 'inter.csr', 'leaf.csr', 'pinter.csr']) {
  fs.rmSync(f(n), { force: true });
}
const leftoverKeys = fs.readdirSync(STAGE).filter((n) => n.endsWith('.key'));
console.log(`private keys remaining in staging: ${leftoverKeys.join(', ')} (leaf only expected)`);

const failed = results.filter((r) => !r.ok).length;
if (failed || leftoverKeys.join() !== 'demo-leaf.key') {
  console.error(`v2 FAILED (${failed} probe failure(s)); staging left for inspection, live certs untouched`);
  process.exit(1);
}
const fp = (crt) => ossl(['x509', '-in', f(crt), '-noout', '-fingerprint', '-sha256']).trim().replace(/^.*=/, '');
const tp = (crt) => ossl(['x509', '-in', f(crt), '-noout', '-fingerprint', '-sha1']).trim().replace(/^.*=/, '').replace(/:/g, '');
fs.writeFileSync(
  path.join(STAGE, 'fingerprints.json'),
  JSON.stringify({ rootSha256: fp('demo-ca.crt'), rootSha1Thumbprint: tp('demo-ca.crt'), intermediateSha256: fp('demo-intermediate.crt'), leafSha256: fp('demo-leaf.crt') }, null, 2),
);
console.log(`v2 staged OK in ${STAGE}; ${results.length} probe checks passed`);
void CERTS_DIR;
