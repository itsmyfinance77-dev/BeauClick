// Content hash of a directory tree (sorted relative paths + bytes). node_modules
// links are skipped: they are the installed dependency store, pinned by the lockfile.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function hashTree(root, { exclude = [] } = {}) {
  const h = createHash('sha256');
  let files = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (name === 'node_modules') continue;
      if (exclude.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        h.update(rel).update('\0').update(fs.readFileSync(full)).update('\0');
        files++;
      }
    }
  };
  walk(root);
  return { sha256: h.digest('hex'), files };
}
