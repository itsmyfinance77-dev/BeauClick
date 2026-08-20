import { DataSource, DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

/**
 * A REAL PostgreSQL DataSource for integration tests -- the counterpart to
 * in-memory-data-source.ts's pg-mem stand-in. ADR-015 mandates real
 * Postgres for database-sensitive behavior; pg-mem remains as the fast
 * layer, but it is explicitly NOT the only database test (a real
 * naming-strategy divergence bug slipped past pg-mem entirely during
 * Phase 1 precisely because pg-mem generated its own schema rather than
 * running the real migration SQL).
 *
 * Skips (rather than fails) when TEST_DATABASE_URL is unset, so the suite
 * stays runnable on a machine without Postgres -- but CI/verification runs
 * must set it. `isRealPostgresConfigured()` lets a spec file decide.
 */
export function isRealPostgresConfigured(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL);
}

export async function createRealPostgresDataSource(entities: DataSourceOptions['entities']): Promise<DataSource> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set -- guard with isRealPostgresConfigured() before calling this.');
  }

  const dataSource = new DataSource({
    type: 'postgres',
    url,
    entities,
    // Deliberately NOT synchronize: these tests run against the schema the
    // REAL migration files created (database/migrations/**), which is the
    // entire point -- synchronize would regenerate a schema from entity
    // metadata and mask exactly the migration/entity divergence this suite
    // exists to catch.
    synchronize: false,
    namingStrategy: new SnakeNamingStrategy(),
  });

  await dataSource.initialize();
  return dataSource;
}

/** Deletes all rows from the given tables, in the given order (children first) -- for test isolation between cases. */
export async function truncateTables(dataSource: DataSource, schemaQualifiedTables: string[]): Promise<void> {
  if (schemaQualifiedTables.length === 0) return;
  await dataSource.query(`TRUNCATE ${schemaQualifiedTables.join(', ')} CASCADE`);
}
