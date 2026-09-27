// A persona's session for the verify scripts: resumed from its stored refresh token
// when that still works, otherwise a REAL OTP sign-in through the demo inbox (the same
// path the seed uses — no dev-login). A restore deletes the stored tokens on purpose
// (they belong to the replaced database), so the fallback is the normal case after one.
// The token file is re-read before every write so concurrent personas do not clobber
// each other; never run two scripts that use the same persona at the same time
// (refresh-token replay detection would revoke the session).
import fs from 'node:fs';
import path from 'node:path';

import { SECRETS_DIR, profile } from '../../scripts/lib/demo-config.mjs';
import { DemoInbox, Session, signIn } from '../../seed/lib/client.mjs';
import { persona } from '../../seed/personas.mjs';

const TOKENS_FILE = path.join(SECRETS_DIR, 'seed-sessions.json');
const readTokens = () => (fs.existsSync(TOKENS_FILE) ? JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) : {});
const store = (key, token) => fs.writeFileSync(TOKENS_FILE, JSON.stringify({ ...readTokens(), [key]: token }));

let inbox;
export async function personaSession(profileKey, key) {
  let s = null;
  const stored = readTokens()[key];
  if (stored) {
    try {
      s = new Session(profile(profileKey).origin, key);
      s.refreshToken = stored;
      await s.refresh();
    } catch {
      s = null;
    }
  }
  if (!s) s = await signIn(profileKey, persona(key).phone, (inbox ??= new DemoInbox()), key);
  s.onRotate = (t) => store(key, t);
  store(key, s.refreshToken);
  return s;
}
