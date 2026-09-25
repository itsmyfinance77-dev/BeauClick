import {
  assertSafeIdentifier,
  compareInventory,
  compareStructure,
  databaseNameOf,
  defaultBackupPath,
  ignoredErrorCount,
  libpqEnv,
  type SchemaStructure,
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

/**
 * The two halves of #314: the verdict, and what the verdict can see.
 *
 * `restore()` used to decide acceptability from `/warning|already exists/i`
 * against pg_restore's stderr. That pattern matched precisely the runs that
 * FAILED, because pg_restore ends such a run with `warning: errors ignored on
 * restore: N` and a clean run prints no warning at all. And the comparison it
 * deferred to -- row counts over `relkind = 'r'` -- is structurally unable to
 * see a lost index, constraint, view or sequence position.
 */
describe('#314 — a restore that failed must not read as one that worked', () => {
  describe('ignoredErrorCount', () => {
    it('reads pg_restore’s own count out of the line that announces it', () => {
      // The exact line that used to be RESCUED by the `/warning/i` test.
      expect(ignoredErrorCount('pg_restore: warning: errors ignored on restore: 7')).toBe(7);
    });

    it('reads a multi-line stderr, where the count is the last line', () => {
      const stderr = [
        'pg_restore: error: could not execute query: ERROR:  relation "commerce.orders" does not exist',
        'pg_restore: error: could not execute query: ERROR:  duplicate key value',
        'pg_restore: warning: errors ignored on restore: 2',
      ].join('\n');
      expect(ignoredErrorCount(stderr)).toBe(2);
    });

    it('returns null for a failure that is not "the restore had errors"', () => {
      // A missing file or a refused connection is "the restore did not
      // happen". Those must keep throwing rather than being counted as zero,
      // which is why null is distinct from 0 here.
      expect(ignoredErrorCount('pg_restore: error: could not open input file: No such file or directory')).toBeNull();
      expect(ignoredErrorCount('pg_restore: error: connection to server failed')).toBeNull();
    });

    it('does not mistake the word warning alone for an error count', () => {
      // The old guard passed on exactly this and on everything else.
      expect(ignoredErrorCount('pg_restore: warning: something harmless')).toBeNull();
    });
  });

  describe('compareStructure', () => {
    const base: SchemaStructure = {
      indexes: ['commerce.uq_orders_source', 'booking.ix_bookings_slot'],
      constraints: ['commerce.orders.ck_orders_source_type'],
      views: [],
      sequences: { 'public.audit_log_id_seq': 40_000 },
    };

    it('agrees with itself', () => {
      expect(compareStructure(base, base)).toEqual([]);
    });

    it('names a lost unique index — the case row counts cannot see', () => {
      // `uq_orders_source` is a UNIQUE INDEX, not a constraint: one of 47 in
      // this schema whose uniqueness has no backing constraint. A restore that
      // loses it leaves every row count identical and permits two orders for
      // one booking.
      const after = { ...base, indexes: ['booking.ix_bookings_slot'] };
      expect(compareStructure(base, after)).toEqual([
        { kind: 'index', name: 'commerce.uq_orders_source', detail: 'missing after restore' },
      ]);
    });

    it('names a lost constraint', () => {
      const after = { ...base, constraints: [] };
      expect(compareStructure(base, after)).toEqual([
        { kind: 'constraint', name: 'commerce.orders.ck_orders_source_type', detail: 'missing after restore' },
      ]);
    });

    it('catches a sequence that exists at the wrong position', () => {
      // The failure that looks most like a success: the sequence is present
      // and correctly named, and the next insert collides with an existing
      // primary key.
      const after = { ...base, sequences: { 'public.audit_log_id_seq': 1 } };
      expect(compareStructure(base, after)).toEqual([
        { kind: 'sequence', name: 'public.audit_log_id_seq', detail: 'last_value 40000 before, 1 after' },
      ]);
    });

    it('reports an object the restore invented, because the target was not clean', () => {
      const after = { ...base, views: ['public.leftover_view'] };
      expect(compareStructure(base, after)).toEqual([
        { kind: 'view', name: 'public.leftover_view', detail: 'present after restore but not in the dump' },
      ]);
    });

    it('reports every difference rather than stopping at the first', () => {
      const after: SchemaStructure = { indexes: [], constraints: [], views: [], sequences: {} };
      expect(compareStructure(base, after)).toHaveLength(4);
    });
  });
});
