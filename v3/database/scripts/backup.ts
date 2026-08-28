/**
 * Takes a backup, with a manifest beside it.
 *
 * The library is in `backup-restore.ts`; this is the command around it, kept
 * separate for the reason `verify-roles.ts` records -- an entry point in its
 * own file needs no `require.main` guard, and this workspace's ts-node may
 * load a script as either CommonJS or ESM.
 *
 * Usage:
 *   BACKUP_SOURCE_URL=postgres://... BACKUP_DIR=/var/backups/beauclick pnpm backup
 *
 * Deliberately NOT a schedule. Daily snapshots and WAL archiving are a
 * property of the managed provider, and no provider has been selected
 * (`HOSTING`); wiring a cron here would be inventing that decision. What this
 * removes is the excuse that taking one is manual work.
 */
import { backup, defaultBackupPath } from './backup-restore';

async function main(): Promise<void> {
  const sourceUrl = process.env.BACKUP_SOURCE_URL ?? process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error('BACKUP_SOURCE_URL (or DATABASE_URL) is required');

  const directory = process.env.BACKUP_DIR ?? 'backups';
  const createdAt = new Date().toISOString();
  const manifest = await backup({ sourceUrl, outFile: defaultBackupPath(directory, createdAt), createdAt });

  // eslint-disable-next-line no-console
  console.log(
    [
      `Backup written: ${manifest.file}`,
      `  ${manifest.bytes} bytes, sha256 ${manifest.sha256}`,
      `  PostgreSQL ${manifest.serverVersion}, ${manifest.migrations.length} migrations applied`,
      `  ${Object.keys(manifest.inventory).length} tables inventoried`,
      '',
      'A backup that has never been restored is not a verified backup',
      '(V3_INFRASTRUCTURE_PLAN.md §9). Rehearse it: pnpm restore:rehearse',
    ].join('\n'),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
