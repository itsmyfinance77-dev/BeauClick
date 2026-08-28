import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  CatalogueTable,
  CoverageReport,
  SubjectDataCoverageError,
  evaluateCoverage,
} from './coverage';
import { SubjectDataContract } from './subject-data.port';

/**
 * Schemas that are not this platform's own.
 *
 * Everything else -- including `public`, which holds `schema_migrations` --
 * must be claimed. `public` is deliberately NOT excluded here: excluding a
 * schema is how the first unclaimed table gets in, and the privacy module
 * claims migration bookkeeping explicitly instead.
 */
const FOREIGN_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

/**
 * Reads the real database catalogue and asserts every table is claimed.
 *
 * WHY THIS IS A BOOT ASSERTION and not only a test. It is the same judgement
 * `AuditEnforcementService` records for unaudited admin mutations, reached the
 * same way: the failure this prevents is silent. An export missing a module's
 * data is byte-identical in shape to a complete one, and nobody finds out
 * until a regulator or a user asks why their data is not in it. Refusing to
 * start is the only signal that cannot be overlooked.
 *
 * The check is skipped -- loudly -- when the catalogue comes back empty, which
 * happens on the pg-mem fast layer where there is no `pg_tables` to read. A
 * check that silently passes reads as a guarantee, so the real-PostgreSQL
 * suite asserts the catalogue is non-empty AND that a known table is in it,
 * rather than merely asserting that the violation list is short.
 */
@Injectable()
export class SubjectDataCoverageService {
  private readonly logger = new Logger('SubjectDataCoverage');

  /**
   * The contract list is a PARAMETER of `evaluate`/`assertComplete`, not a
   * constructor injection, and that was not the first design.
   *
   * Injecting `SUBJECT_DATA_CONTRACTS` here resolved to an empty array, because
   * this service lives in a `@Global()` module while the token is provided by
   * the composition root -- a global provider cannot see a token bound in a
   * module that imports it. `@Optional()` then turned the misresolution into
   * silence: the check ran against zero contracts, reported every table in the
   * database as unclaimed, and failed boot for a reason that had nothing to do
   * with coverage. Caught by the suite; the same shape as Phase C's
   * `PRIVILEGED_CAPABILITY_VERIFIER` resolving to `undefined`.
   *
   * Taking the list as an argument removes the scope question entirely: the
   * caller that owns the list passes the list.
   */
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Every table in every non-system schema, with its columns.
   *
   * `pg_tables`/`information_schema.columns` rather than TypeORM metadata for
   * the three reasons in coverage.ts -- most importantly that the application
   * role has no privilege on `financial.*` and would therefore never see the
   * ledger in a privilege-filtered view.
   *
   * Column names come from `information_schema.columns`, which IS privilege
   * filtered; a table whose columns are invisible simply contributes an empty
   * column list, which weakens only the `wrongly_declared_empty` check and
   * never the coverage check itself.
   */
  async readCatalogue(): Promise<CatalogueTable[]> {
    const rows: Array<{ schema: string; name: string; columns: string[] | null }> = await this.dataSource.query(
      `SELECT t.schemaname AS schema,
              t.tablename  AS name,
              (SELECT array_agg(c.column_name::text)
                 FROM information_schema.columns c
                WHERE c.table_schema = t.schemaname AND c.table_name = t.tablename) AS columns
         FROM pg_tables t
        WHERE t.schemaname <> ALL($1::text[])
        ORDER BY t.schemaname, t.tablename`,
      [FOREIGN_SCHEMAS],
    );

    return rows.map((row) => ({ schema: row.schema, name: row.name, columns: row.columns ?? [] }));
  }

  async evaluate(contracts: ReadonlyArray<SubjectDataContract>): Promise<CoverageReport> {
    return evaluateCoverage(await this.readCatalogue(), contracts);
  }

  /** Throws `SubjectDataCoverageError` if anything is unclaimed, double-claimed, stale, or wrongly cleared. */
  async assertComplete(contracts: ReadonlyArray<SubjectDataContract>): Promise<CoverageReport | null> {
    const catalogue = await this.readCatalogue();

    if (catalogue.length === 0) {
      // Not an error, and not silent either. See the class note.
      this.logger.warn(
        'No database catalogue available (pg_tables returned nothing) -- subject-data coverage was NOT verified in this process.',
      );
      return null;
    }

    const report = evaluateCoverage(catalogue, contracts);
    if (report.violations.length > 0) throw new SubjectDataCoverageError(report);

    this.logger.log(
      `${report.tablesInDatabase} tables, all claimed: ` +
        `${report.byDisposition.subject_data} carrying subject data, ` +
        `${report.byDisposition.retained} retained by obligation, ` +
        `${report.byDisposition.no_subject_data} holding none.`,
    );
    return report;
  }
}
