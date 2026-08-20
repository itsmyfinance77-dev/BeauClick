import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProfessionalEntity, ServiceOfferingEntity } from '@beauclick/provider';
import { PROFESSIONAL_DIRECTORY } from '@beauclick/booking';
import { SERVICE_CATALOG } from '@beauclick/commerce';
import { FINANCIAL_DATA_SOURCE, FINANCIAL_PARTY_RESOLVER } from '@beauclick/financial';

import {
  ProviderBackedFinancialPartyResolver,
  ProviderBackedProfessionalDirectory,
  ProviderBackedServiceCatalog,
} from './port-adapters';
import { financialDataSourceProvider } from './financial-datasource.provider';

/**
 * Supplies every outbound port the domain modules declare, plus the
 * financial DataSource.
 *
 * `@Global()` is the right shape here rather than a convenience: these are
 * infrastructure bindings that several sibling feature modules
 * (BookingModule, CommerceModule, FinancialModule) each need, and none of
 * them may import another. Without a global module every consumer would have
 * to receive the tokens through its own `forRoot`, pushing wiring detail into
 * modules whose whole point is not to know about it.
 *
 * A domain module still cannot reach a SERVICE it should not see -- only
 * these four narrow, domain-declared tokens are exported.
 */
@Global()
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([ProfessionalEntity, ServiceOfferingEntity])],
  providers: [
    ProviderBackedProfessionalDirectory,
    ProviderBackedServiceCatalog,
    ProviderBackedFinancialPartyResolver,
    { provide: PROFESSIONAL_DIRECTORY, useExisting: ProviderBackedProfessionalDirectory },
    { provide: SERVICE_CATALOG, useExisting: ProviderBackedServiceCatalog },
    { provide: FINANCIAL_PARTY_RESOLVER, useExisting: ProviderBackedFinancialPartyResolver },
    financialDataSourceProvider,
  ],
  exports: [PROFESSIONAL_DIRECTORY, SERVICE_CATALOG, FINANCIAL_PARTY_RESOLVER, FINANCIAL_DATA_SOURCE],
})
export class DomainPortsModule implements OnApplicationShutdown {
  constructor(@Inject(FINANCIAL_DATA_SOURCE) private readonly financialDataSource: DataSource) {}

  /**
   * The financial DataSource is constructed by hand, so Nest's TypeOrmModule
   * does not own its lifecycle -- without this it stays connected after
   * `app.close()`, holding the process open. Found by the real-Postgres test
   * suite refusing to exit.
   */
  async onApplicationShutdown(): Promise<void> {
    if (this.financialDataSource?.isInitialized) {
      await this.financialDataSource.destroy();
      Logger.log('financial-service connection closed', 'FinancialDataSource');
    }
  }
}
