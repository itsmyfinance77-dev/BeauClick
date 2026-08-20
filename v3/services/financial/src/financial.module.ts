import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { LedgerEntryEntity } from './entities/ledger-entry.entity';
import { SettlementBatchEntity, SettlementItemEntity } from './entities/settlement.entity';
import { FinancialOutboxEntity } from './entities/financial-outbox.entity';

import { FinancialConfig } from './financial.config';
import { LedgerService } from './ledger.service';
import { SettlementService } from './settlement.service';
import { MyFinanceService } from './my-finance.service';
import { FinancialAdminController, MyFinanceController } from './financial.controller';

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
 * `FINANCIAL_DATA_SOURCE`, along with `FINANCIAL_PARTY_RESOLVER`.
 */
@Module({
  imports: [ConfigModule],
  controllers: [MyFinanceController, FinancialAdminController],
  providers: [FinancialConfig, LedgerService, SettlementService, MyFinanceService],
  exports: [LedgerService, SettlementService, MyFinanceService, FinancialConfig],
})
export class FinancialModule {}
