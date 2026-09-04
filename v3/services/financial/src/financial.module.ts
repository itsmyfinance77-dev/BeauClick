import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { LedgerEntryEntity } from './entities/ledger-entry.entity';
import { SettlementBatchEntity, SettlementItemEntity } from './entities/settlement.entity';
import { FinancialOutboxEntity } from './entities/financial-outbox.entity';

import { FinancialConfig } from './financial.config';
import { LedgerService } from './ledger.service';
import { SettlementService } from './settlement.service';
import { MyFinanceService } from './my-finance.service';
import { FinanceWorkspaceService } from './finance-workspace.service';
import { FinancialAdminController, MyFinanceController } from './financial.controller';
import { FinancialSubjectDataContract } from './financial-subject-data.contract';

export const FINANCIAL_ENTITIES = [
  LedgerEntryEntity,
  SettlementBatchEntity,
  SettlementItemEntity,
  FinancialOutboxEntity,
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
    FinancialConfig,
    LedgerService,
    SettlementService,
    FinanceWorkspaceService,
    MyFinanceService,
  ],
  exports: [
    FinancialSubjectDataContract,
    LedgerService,
    SettlementService,
    FinanceWorkspaceService,
    MyFinanceService,
    FinancialConfig,
  ],
})
export class FinancialModule {}
