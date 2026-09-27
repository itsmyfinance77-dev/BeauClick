#!/usr/bin/env node
// Starts the demo inbox. Viewer binds: BCDEMO_INBOX_VIEWER_BINDS (comma list),
// default 127.0.0.1. The WireGuard address is added only when the owner activates
// remote team access (demo/scripts/start.mjs --profile W --activate-wireguard).
import fs from 'node:fs';
import path from 'node:path';

import { CERTS_DIR, MEMBERS_FILE, PORTS } from '../scripts/lib/demo-config.mjs';
import { loadSecrets } from '../scripts/lib/runtime.mjs';
import { SYNTHETIC_PHONES } from '../seed/personas.mjs';
import { assertIngestBind, assertViewerBind, createInbox } from './server.mjs';

const secrets = loadSecrets();
const { members } = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
const tls = {
  key: fs.readFileSync(path.join(CERTS_DIR, 'demo-leaf.key')),
  cert: fs.readFileSync(path.join(CERTS_DIR, 'demo-leaf-chain.crt')),
};
const log = (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));

const inbox = createInbox({ members, allowedPhones: SYNTHETIC_PHONES, ingestToken: secrets.inboxIngestToken, tls, log });

const viewerBinds = (process.env.BCDEMO_INBOX_VIEWER_BINDS ?? '127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean);
viewerBinds.forEach(assertViewerBind);
assertIngestBind('127.0.0.1');

inbox.ingest.listen(PORTS.inboxIngest, '127.0.0.1', () => log({ event: 'listening', listener: 'ingest', host: '127.0.0.1', port: PORTS.inboxIngest }));
// One server object cannot listen twice; extra binds get sibling servers sharing the same handler.
const [first, ...rest] = viewerBinds;
inbox.viewer.listen(PORTS.inboxViewer, first, () => log({ event: 'listening', listener: 'viewer', host: first, port: PORTS.inboxViewer }));
for (const host of rest) {
  const extra = (await import('node:https')).createServer({ ...tls, minVersion: 'TLSv1.2' }, (req, res) => inbox.viewer.emit('request', req, res));
  extra.listen(PORTS.inboxViewer, host, () => log({ event: 'listening', listener: 'viewer', host, port: PORTS.inboxViewer }));
}
