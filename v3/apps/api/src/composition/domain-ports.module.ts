import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProfessionalEntity, ServiceOfferingEntity } from '@beauclick/provider';
import { UserEntity } from '@beauclick/identity';
import { PROFESSIONAL_DIRECTORY } from '@beauclick/booking';
import { PRICING_RULES, SERVICE_CATALOG } from '@beauclick/commerce';
import { FINANCIAL_DATA_SOURCE, FINANCIAL_PARTY_RESOLVER } from '@beauclick/financial';
import { PROVIDER_REINDEX_SOURCE } from '@beauclick/search';
import { RECIPIENT_RESOLVER } from '@beauclick/notification';
import { ANALYTICS_SUBJECT_RESOLVER } from '@beauclick/analytics';
import { LoyaltyModule } from '@beauclick/loyalty';
import { BusinessEntity, BusinessStaffEntity } from '@beauclick/business';

import {
  ProviderBackedFinancialPartyResolver,
  ProviderBackedProfessionalDirectory,
  ProviderBackedServiceCatalog,
  SellerPartyLookup,
} from './port-adapters';
import {
  IdentityBackedRecipientResolver,
  ProviderBackedAnalyticsSubjectResolver,
  ProviderBackedReindexSource,
} from './phase3-ports';
import { MembershipDiscountRule } from '../pricing/membership-discount.rule';
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
 * A domain module still cannot reach a SERVICE it should not see -- only the
 * narrow, domain-declared tokens are exported.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([ProfessionalEntity, ServiceOfferingEntity, UserEntity, BusinessEntity, BusinessStaffEntity]),
    // Imported so the membership pricing rule can resolve BenefitService.
    LoyaltyModule,
  ],
  providers: [
    SellerPartyLookup,
    ProviderBackedProfessionalDirectory,
    ProviderBackedServiceCatalog,
    ProviderBackedFinancialPartyResolver,
    { provide: PROFESSIONAL_DIRECTORY, useExisting: ProviderBackedProfessionalDirectory },
    { provide: SERVICE_CATALOG, useExisting: ProviderBackedServiceCatalog },
    { provide: FINANCIAL_PARTY_RESOLVER, useExisting: ProviderBackedFinancialPartyResolver },
    financialDataSourceProvider,

    // Phase 3's ports, global for the same reason as Phase 2's: search,
    // notification, and analytics each DECLARE a port they must not
    // implement, and none of them may import the domain that can answer it.
    ProviderBackedReindexSource,
    IdentityBackedRecipientResolver,
    ProviderBackedAnalyticsSubjectResolver,
    { provide: PROVIDER_REINDEX_SOURCE, useExisting: ProviderBackedReindexSource },
    { provide: RECIPIENT_RESOLVER, useExisting: IdentityBackedRecipientResolver },
    { provide: ANALYTICS_SUBJECT_RESOLVER, useExisting: ProviderBackedAnalyticsSubjectResolver },

    /**
     * The pricing rules commerce's engine evaluates.
     *
     * Bound HERE, in the global ports module, rather than in
     * Phase3CompositionModule -- and that placement is load-bearing rather
     * than tidy. `PricingService` lives inside CommerceModule and resolves
     * `PRICING_RULES` from ITS OWN injector, so a binding provided by a
     * sibling module is simply not visible to it: the `@Optional()` fallback
     * kicks in, the engine runs with zero rules, and every order is priced at
     * full price with no error anywhere.
     *
     * That is exactly what happened -- caught by driving a real booking for a
     * customer who genuinely held a 10% membership benefit and watching the
     * total come back at 850,000 instead of 765,000. A silent, money-affecting
     * failure that no unit test would have surfaced, because the rule itself
     * was correct.
     */
    MembershipDiscountRule,
    {
      provide: PRICING_RULES,
      inject: [MembershipDiscountRule],
      useFactory: (membership: MembershipDiscountRule) => [membership],
    },
  ],
  exports: [
    PROFESSIONAL_DIRECTORY,
    SERVICE_CATALOG,
    FINANCIAL_PARTY_RESOLVER,
    FINANCIAL_DATA_SOURCE,
    PROVIDER_REINDEX_SOURCE,
    RECIPIENT_RESOLVER,
    ANALYTICS_SUBJECT_RESOLVER,
    PRICING_RULES,
  ],
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
