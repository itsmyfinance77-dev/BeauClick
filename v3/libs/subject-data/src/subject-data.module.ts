import { Global, Module } from '@nestjs/common';
import { SubjectDataCoverageService } from './subject-data-coverage.service';

/**
 * `@Global()` for the same reason `AuditModule` is: the coverage assertion has
 * to be reachable from wherever the application's bootstrap sequence lives,
 * and it must not depend on which modules a particular composition happens to
 * include -- a check you can accidentally leave out of a composition is a
 * check that will be accidentally left out of one.
 *
 * The CONTRACTS themselves are contributed by the composition root under
 * `SUBJECT_DATA_CONTRACTS`, not here: this lib must not know that booking or
 * loyalty exist.
 */
@Global()
@Module({
  providers: [SubjectDataCoverageService],
  exports: [SubjectDataCoverageService],
})
export class SubjectDataModule {}
