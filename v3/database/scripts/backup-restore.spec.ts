import {
  assertSafeIdentifier,
  compareInventory,
  databaseNameOf,
  defaultBackupPath,
  libpqEnv,
} from './backup-restore';

/**
 * The pure logic behind backup and restore.
 *
 * The end-to-end loop is exercised by `pnpm restore:rehearse`, which really
 * dumps, really restores, and really re-checks the role contract against a
 * disposable database. What is pinned here is the part that decides whether
 * that loop is SAFE -- above all that a credential never reaches a process
 * argument, and that a restore cannot be pointed at something real.
 */
describe('backup/restore helpers', () => {
  describe('libpqEnv', () => {
    it('moves the credential into the environment, never into an argument', () => {
      // `pg_dump` accepts a URL directly, and passing one puts the password in
      // the process arguments -- readable in `ps` by every other process on
      // the host and captured by any monitoring agent that collects a process
      // listing.
      const env = libpqEnv('postgres://app:9Kd2mQx7@db.internal:5433/beauclick');
      expect(env).toEqual({
        PGHOST: 'db.internal',
        PGPORT: '5433',
        PGDATABASE: 'beauclick',
        PGUSER: 'app',
        PGPASSWORD: '9Kd2mQx7',
      });
    });

    it('defaults the port rather than emitting an empty one', () => {
      expect(libpqEnv('postgres://app@db.internal/beauclick').PGPORT).toBe('5432');
    });

    it('decodes a percent-encoded password, which is how a special character survives a URL', () => {
      // A password containing `@` or `/` must be encoded in the URL, and
      // passing the encoded form to libpq would authenticate with the wrong
      // string -- a failure that looks like a wrong password.
      expect(libpqEnv('postgres://app:p%40ss%2Fword@db/x').PGPASSWORD).toBe('p@ss/word');
    });

    it('omits PGPASSWORD entirely when there is none, rather than setting it empty', () => {
      // An empty PGPASSWORD suppresses libpq's other credential sources
      // (.pgpass, a service file), so setting it blank breaks the very setups
      // that do not put a password in the URL.
      expect(libpqEnv('postgres://app@db/x')).not.toHaveProperty('PGPASSWORD');
    });
  });

  describe('assertSafeIdentifier', () => {
    it('accepts ordinary database names', () => {
      expect(() => assertSafeIdentifier('beauclick_restore_rehearsal')).not.toThrow();
      expect(() => assertSafeIdentifier('_scratch1')).not.toThrow();
    });

    it('refuses anything that would need quoting or could carry SQL', () => {
      // `CREATE DATABASE` and `DROP DATABASE` take no parameters, so the name
      // is interpolated. A whitelist is easier to be sure of than quoting.
      for (const hostile of [
        'beauclick"; DROP DATABASE beauclick_v3_dev; --',
        'Beauclick',
        'beau-click',
        'beau click',
        '1beauclick',
        '',
        'x'.repeat(64),
      ]) {
        expect(() => assertSafeIdentifier(hostile)).toThrow(/not a safe PostgreSQL identifier/);
      }
    });
  });

  describe('compareInventory', () => {
    it('reports nothing when every count matches', () => {
      expect(compareInventory({ 'booking.bookings': 12 }, { 'booking.bookings': 12 })).toEqual([]);
    });

    it('reports a table that lost rows', () => {
      expect(compareInventory({ 'booking.bookings': 12 }, { 'booking.bookings': 11 })).toEqual([
        { table: 'booking.bookings', expected: 12, actual: 11 },
      ]);
    });

    it('reports a table that did not come back at all', () => {
      expect(compareInventory({ 'financial.ledger_entries': 40 }, {})).toEqual([
        { table: 'financial.ledger_entries', expected: 40, actual: undefined },
      ]);
    });

    it('reports a table the restore invented', () => {
      expect(compareInventory({}, { 'public.leftovers': 3 })).toEqual([
        { table: 'public.leftovers', expected: 0, actual: 3 },
      ]);
    });

    it('treats an UNREADABLE table becoming readable as a difference', () => {
      // The subtle one, and the reason unreadable tables are recorded as `-1`
      // rather than skipped. `financial.*` is unreadable by the application
      // role BY DESIGN; a restored database where it has become readable has
      // lost the grant that makes the ledger's isolation real -- while every
      // row is present and every other check passes.
      expect(compareInventory({ 'financial.ledger_entries': -1 }, { 'financial.ledger_entries': 40 })).toEqual([
        { table: 'financial.ledger_entries', expected: -1, actual: 40 },
      ]);
    });

    it('accepts an unreadable table that is still unreadable', () => {
      expect(compareInventory({ 'financial.ledger_entries': -1 }, { 'financial.ledger_entries': -1 })).toEqual([]);
    });
  });

  describe('databaseNameOf', () => {
    it('extracts the database from a connection string', () => {
      expect(databaseNameOf('postgres://app:p@db.internal:5432/beauclick_v3_dev')).toBe('beauclick_v3_dev');
    });
  });

  describe('defaultBackupPath', () => {
    it('produces a filename that is legal on every platform', () => {
      // An ISO timestamp contains colons, which are illegal in a Windows
      // filename and awkward in a shell everywhere else.
      const path = defaultBackupPath('backups', '2026-08-29T10:20:30.400Z');
      expect(path).not.toContain(':');
      expect(path).toContain('2026-08-29T10-20-30-400Z');
      expect(path.endsWith('.dump')).toBe(true);
    });
  });
});
