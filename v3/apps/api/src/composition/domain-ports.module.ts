import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProfessionalEntity, ProviderModule, ServiceOfferingEntity } from '@beauclick/provider';
import { UserEntity } from '@beauclick/identity';
import { PROFESSIONAL_DIRECTORY } from '@beauclick/booking';
import { PRICING_RULES, SERVICE_CATALOG } from '@beauclick/commerce';
import { FINANCE_WORKSPACE_OWNER_RESOLVER, FINANCIAL_DATA_SOURCE, FINANCIAL_PARTY_RESOLVER } from '@beauclick/financial';
import { OWNED_SUBSCRIBER_PARTY_RESOLVER } from '@beauclick/commercial-policy';
import { PROVIDER_REINDEX_SOURCE } from '@beauclick/search';
import { RECIPIENT_RESOLVER } from '@beauclick/notification';
import { ANALYTICS_SUBJECT_RESOLVER } from '@beauclick/analytics';
import { LoyaltyModule } from '@beauclick/loyalty';
import { BusinessEntity, BusinessStaffEntity } from '@beauclick/business';
import { PROFESSIONAL_OWNER_LOOKUP } from '@beauclick/waitlist';
import {
  DEVELOPMENT_WORKSPACE_REFERENCE_SECRET,
  WORKSPACE_REFERENCE_SECRET,
} from '@beauclick/workspace-reference';

import {
  ProviderBackedFinancialPartyResolver,
  OwnershipBackedSubscriberPartyResolver,
  OwnershipBackedFinanceWorkspaceResolver,
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
    // V3.1 Phase C: the reindex source reads a professional's imagery through
    // `PortfolioService`, deliberately reusing the SAME query the live event
    // uses rather than growing a second implementation of "what images does
    // this professional have".
    ProviderModule,
  ],
  providers: [
    SellerPartyLookup,
    ProviderBackedProfessionalDirectory,
    ProviderBackedServiceCatalog,
    ProviderBackedFinancialPartyResolver,
    OwnershipBackedSubscriberPartyResolver,
    { provide: PROFESSIONAL_DIRECTORY, useExisting: ProviderBackedProfessionalDirectory },
    // waitlist-service's port for the identical question booking-service's
    // PROFESSIONAL_DIRECTORY already answers -- ADR-011 forbids waitlist
    // importing booking's token directly, so the SAME adapter instance is
    // bound a second time under waitlist's own token, rather than a second
    // implementation answering the same question a second way.
    { provide: PROFESSIONAL_OWNER_LOOKUP, useExisting: ProviderBackedProfessionalDirectory },
    { provide: SERVICE_CATALOG, useExisting: ProviderBackedServiceCatalog },
    { provide: FINANCIAL_PARTY_RESOLVER, useExisting: ProviderBackedFinancialPartyResolver },
    // V3.3-A #56a. A SECOND party resolver, deliberately not the one above: it
    // resolves ownership only and returns every owned party (ADR-042 §3).
    { provide: OWNED_SUBSCRIBER_PARTY_RESOLVER, useExisting: OwnershipBackedSubscriberPartyResolver },
    /*
     * V3.3 #72 (`V33-DEC-020`). The SAME ownership answer, bound a second time
     * under finance's own token.
     *
     * One adapter, two tokens — the arrangement `PROFESSIONAL_DIRECTORY` and
     * `PROFESSIONAL_OWNER_LOOKUP` already use above, and for the same reason:
     * `services/financial` may not import `services/commercial-policy`, and a
     * second implementation of "which parties does this user OWN" is a second
     * answer to a question that must have exactly one.
     *
     * This is deliberately NOT `FINANCIAL_PARTY_RESOLVER`. That one answers
     * "whose money is this?" and follows staff affiliation, which is correct
     * for attribution and was the #72 defect when used to decide who may READ.
     */
    OwnershipBackedFinanceWorkspaceResolver,
    { provide: FINANCE_WORKSPACE_OWNER_RESOLVER, useExisting: OwnershipBackedFinanceWorkspaceResolver },
    /**
     * The workspace-reference secret, read ONCE for the whole application.
     *
     * `V33-DEC-020` shares one reference vocabulary between the subscription
     * and finance surfaces, so the secret is bound here rather than in each
     * feature module: two `config.get(...)` calls would be two places a later
     * edit could point at `JWT_ACCESS_SECRET`, and two copies of the
     * development fallback.
     *
     * `env.validation.ts` independently refuses to boot in production when the
     * value is missing, too short, a placeholder, or shared with another
     * secret. This factory does not restate those rules — two implementations
     * of one rule are one waiting to disagree — and it never logs the value.
     */
    {
      provide: WORKSPACE_REFERENCE_SECRET,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string =>
        config.get<string>('WORKSPACE_REFERENCE_HMAC_SECRET') ?? DEVELOPMENT_WORKSPACE_REFERENCE_SECRET,
    },
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
    PROFESSIONAL_OWNER_LOOKUP,
    SERVICE_CATALOG,
    FINANCIAL_PARTY_RESOLVER,
    OWNED_SUBSCRIBER_PARTY_RESOLVER,
    FINANCE_WORKSPACE_OWNER_RESOLVER,
    WORKSPACE_REFERENCE_SECRET,
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
