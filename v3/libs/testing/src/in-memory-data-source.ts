import { newDb, DataType } from 'pg-mem';
import { DataSource, DataSourceOptions, getMetadataArgsStorage } from 'typeorm';
import { uuidv7 } from 'uuidv7';

/**
 * V3_DATABASE_BLUEPRINT.md mandates PostgreSQL, and ADR-015 mandates real,
 * testcontainers-backed Postgres for integration tests -- this development
 * environment has neither Docker nor a local Postgres server available
 * (confirmed during Phase 1 setup: no `docker`, no `psql`, no Postgres
 * Windows service). pg-mem is a real in-memory SQL engine that emulates
 * Postgres's wire behavior closely enough to run TypeORM migrations and
 * repository queries against real SQL, not a mocked repository layer --
 * this is a stand-in for a real Postgres server, not a mock of our own
 * code, so it still catches real query/schema bugs. It's a disclosed
 * limitation, not silently presented as equivalent to real Postgres --
 * see V3_PHASE1_IMPLEMENTATION.md's Known Limitations.
 *
 * IMPORTANT: `db.adapters.createTypeormDataSource(options)` returns an
 * already-wired DataSource instance bound to pg-mem's in-memory backend --
 * the binding lives on the instance itself, not on its `.options`. Building
 * a FRESH `new DataSource(dataSource.options)` (an earlier version of this
 * file did exactly that) silently loses the binding and falls back to
 * TypeORM's real `pg` driver, which then attempts a genuine TCP connection
 * to localhost:5432 and fails with ECONNREFUSED -- always use the instance
 * pg-mem itself returns, never reconstruct one from its options.
 */
function buildPgMemDataSource(entities: DataSourceOptions['entities']): DataSource {
  const db = newDb({ autoCreateForeignKeyIndices: true });

  // pg-mem needs these Postgres builtins registered explicitly; real
  // Postgres has them natively. gen_random_uuid() is used nowhere in our
  // own migrations (UUIDs are generated application-side per
  // V3_DATABASE_BLUEPRINT.md §4), but TypeORM's schema sync path probes
  // for it, so it's registered defensively.
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => uuidv7(),
  });
  db.public.registerFunction({
    name: 'version',
    returns: DataType.text,
    implementation: () => 'PostgreSQL 16.0 (pg-mem)',
  });
  db.public.registerFunction({
    name: 'current_database',
    returns: DataType.text,
    implementation: () => 'beauclick_test',
  });

  // Unlike real Postgres, pg-mem does not implicitly create a schema just
  // because an @Entity({schema: '...'}) references it -- synchronize would
  // otherwise fail with "schema not found". Real Postgres deployments get
  // their schemas from the real migration files (database/migrations/),
  // which is out of scope for this in-memory stand-in; here, every schema
  // named on any of the given entities is created up front from the
  // entities' own decorator metadata, so callers never need to pass schema
  // names separately from the entity list they already have to provide.
  for (const schema of distinctSchemaNames(entities)) {
    db.public.none(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  }

  // dropSchema:true deliberately omitted -- it makes TypeORM issue a
  // pre-sync `DROP VIEW`/introspection pass against `pg_views`, a system
  // catalog pg-mem doesn't implement. Unneeded anyway: each call here
  // builds a brand-new, empty `newDb()` instance, so there is nothing to
  // drop -- synchronize:true alone creates the schema fresh every time.
  return db.adapters.createTypeormDataSource({
    type: 'postgres',
    entities,
    synchronize: true,
  } as DataSourceOptions) as DataSource;
}

function distinctSchemaNames(entities: DataSourceOptions['entities']): string[] {
  const entityList: unknown[] = Array.isArray(entities) ? entities : [];
  const wantedClasses = new Set<unknown>(entityList.filter((e) => typeof e === 'function'));
  const schemas = new Set<string>();
  for (const table of getMetadataArgsStorage().tables) {
    if (table.target && wantedClasses.has(table.target) && typeof table.schema === 'string') {
      schemas.add(table.schema);
    }
  }
  return Array.from(schemas);
}

export async function createInMemoryDataSource(entities: DataSourceOptions['entities']): Promise<DataSource> {
  const dataSource = buildPgMemDataSource(entities);
  await dataSource.initialize();
  return dataSource;
}

/**
 * For callers (e.g. NestJS test modules) that need to provide an
 * already-initialized DataSource as a value provider rather than pass
 * DataSourceOptions through TypeOrmModule.forRoot -- see
 * apps/api/test/typeorm-testing.module.ts for why forRoot can't be used
 * here (it always constructs its OWN fresh DataSource from options,
 * hitting the exact same lost-binding problem this file's docblock
 * describes).
 */
export { createInMemoryDataSource as createInitializedInMemoryDataSource };
