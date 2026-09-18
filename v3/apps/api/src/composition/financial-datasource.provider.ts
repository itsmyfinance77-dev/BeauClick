import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { FINANCIAL_DATA_SOURCE, FINANCIAL_ENTITIES } from '@beauclick/financial';

/**
 * financial-service's own database connection.
 *
 * **This is the mechanism behind ADR-009's append-only guarantee, and it is
 * the reason the guarantee is real rather than aspirational.** The
 * connection string here points at `beauclick_financial_writer` -- a
 * PostgreSQL role holding INSERT + SELECT on the `financial` schema and
 * nothing else. Meanwhile the main application role has been REVOKEd
 * everything on that schema, so the pool every controller, guard, and
 * background job shares cannot so much as read the ledger.
 *
 * That is a deliberate, documented refinement of what
 * `V3_DATABASE_BLUEPRINT.md` §1 proposed. The blueprint asked for a
 * physically separate DATABASE for financial and payment. A separate
 * database would also prevent the main pool from touching the ledger, but it
 * would additionally make the booking+order transaction impossible (two
 * databases, no shared transaction) and force a distributed-transaction or
 * saga design onto a consistency problem that has a perfectly good ACID
 * answer. A separate ROLE and CONNECTION delivers the isolation the
 * blueprint actually wanted -- verified empirically, not assumed -- while
 * leaving cross-schema transactions available where they genuinely help.
 * Recorded as ADR-017.
 *
 * Fail-fast: without `FINANCIAL_DATABASE_URL` the application refuses to
 * boot in production. Silently falling back to the main connection would
 * quietly hand the application role ledger access and destroy the whole
 * guarantee -- the one failure mode most worth being loud about.
 */
export const financialDataSourceProvider: Provider = {
  provide: FINANCIAL_DATA_SOURCE,
  inject: [ConfigService],
  useFactory: async (config: ConfigService): Promise<DataSource> => {
    const url = config.get<string>('FINANCIAL_DATABASE_URL');
    const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';

    if (!url) {
      throw new Error(
        'FINANCIAL_DATABASE_URL is required. financial-service must connect as its own ' +
          'INSERT-only role (ADR-009/ADR-017); reusing the application connection would give the ' +
          'main pool write access to the ledger and void the append-only guarantee.',
      );
    }

    const dataSource = new DataSource({
      type: 'postgres',
      url,
      entities: [...FINANCIAL_ENTITIES],
      // Never synchronize, in any environment. This role has no DDL rights
      // by design; the financial schema is owned by a separate role and
      // changed only by a reviewed migration.
      synchronize: false,
      namingStrategy: new SnakeNamingStrategy(),
      // A small, separate pool. Financial writes are low-volume and must not
      // be able to exhaust the connections the request path depends on.
      extra: { max: 5 },
    });

    await dataSource.initialize();
    Logger.log(`financial-service connected as ${maskUser(url)} (append-only role)`, 'FinancialDataSource');

    if (nodeEnv === 'production') {
      await assertRoleIsNotPrivileged(dataSource);
    }

    return dataSource;
  },
};

/**
 * Boot-time proof that the connection really is restricted.
 *
 * A superuser connection string would make every immutability guarantee
 * silently false while every test still passed, so production refuses to
 * start on one. This is the same discipline the role-contract spec uses
 * (`usesuper = false` asserted explicitly), applied to the running system
 * rather than only to the test suite.
 */
async function assertRoleIsNotPrivileged(dataSource: DataSource): Promise<void> {
  const [row]: { usesuper: boolean }[] = await dataSource.query(
    'SELECT usesuper FROM pg_user WHERE usename = current_user',
  );
  if (row?.usesuper) {
    throw new Error(
      'FINANCIAL_DATABASE_URL connects as a SUPERUSER. That silently voids the append-only ' +
        'ledger guarantee (ADR-009): a superuser bypasses every table grant. Use the ' +
        'beauclick_financial_writer role.',
    );
  }

  const [grant]: { has: boolean }[] = await dataSource.query(
    "SELECT has_table_privilege('financial.ledger_entries', 'UPDATE') AS has",
  );
  if (grant?.has) {
    throw new Error(
      'The financial connection holds UPDATE on financial.ledger_entries. The ledger must be ' +
        'append-only (ADR-009) -- revoke UPDATE/DELETE/TRUNCATE from this role before starting.',
    );
  }

  // `#43a` (ADR-052 §4): the pending-funds journal rests on the SAME
  // INSERT-only guarantee, and on the writer being unable to `SELECT ... FOR
  // UPDATE` -- the reason `FundJournalService` takes an advisory lock instead
  // of a row lock. Both are proved here, at boot, not merely assumed from the
  // ledger's own check above.
  const [fundGrant]: { has: boolean }[] = await dataSource.query(
    "SELECT has_table_privilege('financial.fund_postings', 'UPDATE') AS has",
  );
  if (fundGrant?.has) {
    throw new Error(
      'The financial connection holds UPDATE on financial.fund_postings. The fund journal must be ' +
        'append-only (ADR-052 §4) -- revoke UPDATE/DELETE/TRUNCATE from this role before starting.',
    );
  }

  try {
    await dataSource.query('SELECT 1 FROM financial.fund_postings FOR UPDATE LIMIT 1');
    throw new Error(
      'The financial connection can SELECT ... FOR UPDATE on financial.fund_postings. ADR-052 §4 relies ' +
        'on the writer role being UNABLE to row-lock, so FundJournalService serialises with an advisory ' +
        'lock instead -- if row locking is possible here, that design assumption no longer holds.',
    );
  } catch (err) {
    // `permission denied` (Postgres code 42501) is the expected, REQUIRED
    // outcome -- everything else (including the error thrown above, on
    // purpose) is a genuine failure and must propagate.
    if ((err as { code?: string } | null)?.code !== '42501') throw err;
  }
}

function maskUser(url: string): string {
  try {
    return new URL(url).username || 'unknown';
  } catch {
    return 'unknown';
  }
}
