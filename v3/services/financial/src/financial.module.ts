import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ApplicationConfig, HttpAdapterHost } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';

import { LedgerEntryEntity } from './entities/ledger-entry.entity';
import { SettlementBatchEntity, SettlementItemEntity } from './entities/settlement.entity';
import { FinancialOutboxEntity } from './entities/financial-outbox.entity';
import { FundJournalEntity } from './entities/fund-journal.entity';
import { FundPostingEntity } from './entities/fund-posting.entity';

import { LedgerService } from './ledger.service';
import { SettlementService } from './settlement.service';
import { FundJournalService } from './fund-journal.service';
import { MyFinanceService } from './my-finance.service';
import { FinanceWorkspaceService } from './finance-workspace.service';
import { FinancialAdminController, MyFinanceController } from './financial.controller';
import { FinancialSubjectDataContract } from './financial-subject-data.contract';
import { FinanceNoStoreMiddleware, financeSurfaceMountPath } from './finance-no-store.middleware';

export const FINANCIAL_ENTITIES = [
  LedgerEntryEntity,
  SettlementBatchEntity,
  SettlementItemEntity,
  FinancialOutboxEntity,
  FundJournalEntity,
  FundPostingEntity,
];

/**
 * Note the absence of `TypeOrmModule.forFeature(...)`.
 *
 * Every other module registers its entities against the application's shared
 * DataSource. financial-service must NOT: it runs on its own connection,
 * under a PostgreSQL role that holds INSERT + SELECT and nothing else on the
 * `financial` schema (ADR-017). Registering these entities on the shared
 * DataSource would hand the main application pool -- the one every
 * controller, guard, and background job uses -- a live handle on the ledger,
 * defeating the entire guarantee.
 *
 * The composition root supplies that second DataSource under
 * `FINANCIAL_DATA_SOURCE`, along with `FINANCIAL_PARTY_RESOLVER`,
 * `FINANCE_WORKSPACE_OWNER_RESOLVER` and `WORKSPACE_REFERENCE_SECRET`.
 *
 * ## Two party ports, deliberately (V3.3 #72, `V33-DEC-020`)
 *
 * `FINANCIAL_PARTY_RESOLVER` answers "whose money is this?" and follows staff
 * affiliation. `FINANCE_WORKSPACE_OWNER_RESOLVER` answers "which workspaces
 * does this user own?" and never does. Using the first to decide who may READ
 * was the #72 disclosure; both stay bound because they answer different
 * questions that must be free to disagree.
 */
@Module({
  imports: [ConfigModule],
  controllers: [MyFinanceController, FinancialAdminController],
  providers: [
    FinancialSubjectDataContract,
    LedgerService,
    SettlementService,
    FundJournalService,
    FinanceWorkspaceService,
    MyFinanceService,
    FinanceNoStoreMiddleware,
  ],
  exports: [
    FinancialSubjectDataContract,
    LedgerService,
    SettlementService,
    FundJournalService,
    FinanceWorkspaceService,
    MyFinanceService,
  ],
})
export class FinancialModule implements NestModule {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly applicationConfig: ApplicationConfig,
    private readonly noStore: FinanceNoStoreMiddleware,
  ) {}

  /**
   * `Cache-Control: private, no-store` on the seller finance surface -- V3.3
   * #154, `V33-DEC-038` R10.
   *
   * Mounted as a plain Express prefix middleware (`use(path, fn)`) on the
   * controller's own path under the global prefix, from the module that owns
   * the controller, so every consumer of `FinancialModule` -- the real
   * bootstrap and the test harness alike -- gets it identically. Not through
   * `MiddlewareConsumer`: Nest binds that as one Express ROUTE layer per path
   * (`app.get`/`app.all`), which the #72/#111 proofs that the finance route
   * table is exactly nine routes would count as new routes; a `use` layer is
   * not a route. Registered at module init, which precedes route
   * registration, so it runs before every guard: the `401` an unauthenticated
   * caller gets, the `404` a foreign reference gets and the `409` a dual owner
   * gets carry the header exactly as a `200` does. A prefix mount stops at a
   * path segment, so `v1/admin/finance` and every other route are untouched.
   *
   * Done in `configure` rather than `onModuleInit`: Nest collects middleware
   * configuration BEFORE it registers routes and runs init hooks AFTER, and an
   * Express `use` layer only runs ahead of a route if it was mounted first.
   * The consumer itself is deliberately not used -- see above.
   */
  configure(_consumer: MiddlewareConsumer): void {
    const mount = financeSurfaceMountPath(this.applicationConfig.getGlobalPrefix());
    this.adapterHost.httpAdapter.getInstance().use(mount, (request: unknown, response: HeaderWritableResponse, next: () => void) =>
      this.noStore.use(request, response, next),
    );
  }
}

interface HeaderWritableResponse {
  setHeader(name: string, value: string): unknown;
}
