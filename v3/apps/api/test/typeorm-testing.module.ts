import { DynamicModule, Global, Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

/**
 * Stands in for `TypeOrmModule.forRoot(...)` in tests ONLY. @nestjs/typeorm's
 * real forRoot() always constructs its own `new DataSource(options)`
 * internally -- which, for pg-mem, silently discards the in-memory binding
 * and falls back to a real TCP connection attempt (see
 * libs/testing/src/in-memory-data-source.ts's docblock for the full
 * explanation). This module instead accepts an ALREADY-INITIALIZED
 * DataSource (built by the caller via `createInMemoryDataSource` before
 * compiling the testing module -- deliberately synchronous/pre-built, not
 * an async dynamic module, to avoid a real Nest testing-module edge case
 * found during Phase 1: an async DynamicModule combined with @Global()
 * did not reliably propagate global-provider visibility to sibling
 * modules' TypeOrmModule.forFeature() calls in @nestjs/testing's module
 * compiler) and provides that EXACT instance under both tokens Nest's
 * TypeOrmModule.forFeature()-generated repository providers look up:
 * `DataSource` and `getDataSourceToken()`. Every downstream
 * TypeOrmModule.forFeature([...]) call (inside IdentityModule,
 * ProviderModule) resolves against this instance unmodified -- the guards,
 * services, and controllers under test never know their database isn't a
 * real network-connected Postgres.
 */
@Global()
@Module({})
export class TypeOrmTestingModule {
  static forDataSource(dataSource: DataSource): DynamicModule {
    return {
      module: TypeOrmTestingModule,
      providers: [
        { provide: DataSource, useValue: dataSource },
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
      exports: [DataSource, getDataSourceToken()],
    };
  }
}
