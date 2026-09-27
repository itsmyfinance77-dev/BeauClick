/**
 * Demo DB backup/restore through the REPOSITORY'S OWN library
 * (v3/database/scripts/backup-restore.ts — the mechanism CI's "Rehearse a backup
 * restore" step exercises). Nothing here reimplements dump/restore.
 *
 *   backup  <outDir>                 -> custom-format dump + manifest (sha256, inventory, structure)
 *   restore <dumpFile> <newDbName>   -> restores into a NEW database, then verifies
 *                                       inventory + structure against the manifest
 *
 * Invoked by demo/scripts/backup.mjs / restore.mjs with DEMO_ADMIN_URL (superuser on
 * the DEMO cluster only) and DEMO_SOURCE_URL. Refuses any other host/port.
 */
import { Client } from 'pg';

import {
  backup,
  compareInventory,
  compareStructure,
  defaultBackupPath,
  inventory,
  readManifest,
  restore,
  structure,
} from '../../../v3/database/scripts/backup-restore';

function demoOnly(url: string): string {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '55432') throw new Error('Refusing: not the demo cluster (127.0.0.1:55432).');
  return url;
}

async function main(): Promise<void> {
  const [mode, a, b] = process.argv.slice(2);
  const admin = demoOnly(process.env.DEMO_ADMIN_URL ?? '');

  if (mode === 'backup') {
    const source = demoOnly(process.env.DEMO_SOURCE_URL ?? '');
    const createdAt = new Date().toISOString();
    const m = await backup({ sourceUrl: source, outFile: defaultBackupPath(a, createdAt), createdAt });
    console.log(JSON.stringify({ file: m.file, bytes: m.bytes, sha256: m.sha256, migrations: m.migrations.length, tables: Object.keys(m.inventory).length, rows: Object.values(m.inventory).reduce((x, y) => x + Math.max(0, y), 0) }));
    return;
  }

  if (mode === 'restore') {
    if (!/^beauclick_demo_restore_[0-9]+$/.test(b)) throw new Error('Refusing: restore target must be a new beauclick_demo_restore_<n> database.');
    const outcome = await restore({ dumpFile: a, adminUrl: admin, targetDatabase: b });
    const manifest = await readManifest(a);
    const target = new URL(admin);
    target.pathname = `/${b}`;
    const c = new Client({ connectionString: target.toString() });
    await c.connect();
    try {
      const inv = compareInventory(manifest.inventory, await inventory(c));
      const str = manifest.structure ? compareStructure(manifest.structure, await structure(c)) : [];
      console.log(JSON.stringify({ ignoredErrors: outcome.ignoredErrors, inventoryDifferences: inv.length, structureDifferences: str.length, detail: [...inv, ...str].slice(0, 5) }));
      if (outcome.ignoredErrors !== 0 || inv.length || str.length) process.exit(2);
    } finally {
      await c.end();
    }
    return;
  }
  throw new Error('usage: backup <outDir> | restore <dumpFile> <beauclick_demo_restore_N>');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
