import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProfessionalEntity, ProviderModule, SELLER_OWNER_ROLE_GRANT, ServiceOfferingEntity } from '@beauclick/provider';
import { IdentityModule, UserEntity } from '@beauclick/identity';
import { BOOKING_CANCELLATION_ENTITLEMENT_HOOK, PROFESSIONAL_DIRECTORY } from '@beauclick/booking';
import {
  BOOKING_COLLECTION_POLICY_RESOLVER,
  BOOKING_CONFIRMATION_ENTITLEMENT_HOOK,
  PRICING_RULES,
  SERVICE_CATALOG,
} from '@beauclick/commerce';
import { FINANCE_WORKSPACE_OWNER_RESOLVER, FINANCIAL_DATA_SOURCE, FINANCIAL_PARTY_RESOLVER } from '@beauclick/financial';
import {
  CollectionPolicyResolutionModule,
  OWNED_SUBSCRIBER_PARTY_RESOLVER,
  SellerSubscriptionModule,
} from '@beauclick/commercial-policy';
import { PROVIDER_REINDEX_SOURCE } from '@beauclick/search';
import { RECIPIENT_RESOLVER } from '@beauclick/notification';
import { ANALYTICS_SUBJECT_RESOLVER } from '@beauclick/analytics';
import { LoyaltyModule } from '@beauclick/loyalty';
import {
  BUSINESS_OWNER_ROLE_GRANT,
  BusinessEntity,
  BusinessScopedStaffAuthorizer,
  BusinessStaffEntity,
  LOCATION_CITY_CATALOGUE,
  SCOPED_STAFF_AUTHORIZER,
  STAFF_INVITE_IDENTITY_RESOLVER,
} from '@beauclick/business';
import { DELIVERY_LOCATION_DIRECTORY } from '@beauclick/booking';
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
  CommercialPolicyBackedCollectionResolver,
  IdentityBackedOwnerRoleGrant,
  BusinessBackedDeliveryLocationDirectory,
  IdentityBackedStaffInviteResolver,
  ProviderBackedLocationCityCatalogue,
  SellerPartyLookup,
} from './port-adapters';
import {
  IdentityBackedRecipientResolver,
  ProviderBackedAnalyticsSubjectResolver,
  ProviderBackedReindexSource,
} from './phase3-ports';
import {
  BookingCreditCancellationAdapter,
  BookingCreditEntitlementAdapter,
} from './booking-credit-entitlement.adapter';
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
    /*
     * V3.3 #58a. The credit ledger lives in commercial-policy; the two
     * entitlement adapters bound below delegate to it. Imported rather than
     * reimplemented for the same reason the role grant is: a second "how much
     * credit does this party have" would be a second answer.
     */
    SellerSubscriptionModule,
    /*
     * V3.3 #115 (`#41d-2b`), ADR-048 R4. The read-only resolver module, whose
     * one provider `CommercialPolicyBackedCollectionResolver` delegates to.
     * Imported rather than reimplemented for the reason the credit ledger above
     * is: a second "which policy governs this party" would be a second answer.
     */
    CollectionPolicyResolutionModule,
    // V3.3 #75 (`V33-DEC-021`). `IdentityBackedOwnerRoleGrant` delegates the
    // whole grant rule to `RoleService`, which lives here. Imported rather than
    // reimplemented for the same reason the finance workspace resolver
    // delegates: a second "grant the owner role" would be a second answer.
    IdentityModule,
  ],
  providers: [
    SellerPartyLookup,
    ProviderBackedProfessionalDirectory,
    ProviderBackedServiceCatalog,
    CommercialPolicyBackedCollectionResolver,
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
    /*
     * V3.3 #115 (`#41d-2b`), ADR-048 R4. The one cross-domain binding for
     * collection-policy resolution, and the only place Commerce and Commercial
     * Policy meet on the order path.
     */
    { provide: BOOKING_COLLECTION_POLICY_RESOLVER, useExisting: CommercialPolicyBackedCollectionResolver },
    /*
     * V3.3 #81 (`#41b`, ADR-044 §6). The entitlement seam a zero-collectible
     * confirmation passes through, bound to an explicit no-op until #58.
     *
     * Bound here rather than left to each composition to remember, and exported
     * below, so that "is the hook present?" has exactly one answer for the whole
     * application. `V33-DEC-023` Ruling 8 makes it mandatory: `CheckoutService`
     * injects it without `@Optional()`, so a composition that drops this line
     * fails to construct at boot instead of quietly confirming bookings that
     * consume nothing.
     */
    BookingCreditEntitlementAdapter,
    BookingCreditCancellationAdapter,
    { provide: BOOKING_CONFIRMATION_ENTITLEMENT_HOOK, useExisting: BookingCreditEntitlementAdapter },
    // The cancellation half, bound to booking-service's own port so the
    // return is written inside the cancellation transaction (ADR-046 §8).
    { provide: BOOKING_CANCELLATION_ENTITLEMENT_HOOK, useExisting: BookingCreditCancellationAdapter },
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
    /*
     * V3.3 #75 (`V33-DEC-021`). ONE adapter, bound under BOTH domain tokens.
     *
     * `provider` and `business` each declare their own token because neither
     * may import the other and neither may import `identity` (ADR-011). The
     * arrangement above for `PROFESSIONAL_DIRECTORY` /
     * `PROFESSIONAL_OWNER_LOOKUP` is the precedent, and the reasoning is the
     * same: two tokens are a module-boundary artefact; two implementations of
     * "grant the owner role atomically with ownership" would be two answers to
     * a question that must have exactly one.
     *
     * Both bindings are MANDATORY. Neither domain declares an `@Optional()`
     * fallback, so a composition that forgot one would fail to boot rather than
     * quietly recreating #75 for half the sellers on the platform.
     */
    IdentityBackedOwnerRoleGrant,
    { provide: SELLER_OWNER_ROLE_GRANT, useExisting: IdentityBackedOwnerRoleGrant },
    { provide: BUSINESS_OWNER_ROLE_GRANT, useExisting: IdentityBackedOwnerRoleGrant },
    /*
     * V3.3 #108 (`#44b`), ADR-049 section 3.2. `business` declares
     * `LOCATION_CITY_CATALOGUE` and cannot import `provider`; this adapter reads
     * `provider.locations_cities` on the caller's own manager. Mandatory -- no
     * `@Optional()` fallback -- so a composition that omits it fails to boot
     * rather than refusing every location create.
     */
    ProviderBackedLocationCityCatalogue,
    { provide: LOCATION_CITY_CATALOGUE, useExisting: ProviderBackedLocationCityCatalogue },
    /*
     * V3.3 #109 (`#44c`), ADR-049 sections 4.4-4.5.
     *
     * Two bindings, and the asymmetry is deliberate.
     *
     * `SCOPED_STAFF_AUTHORIZER` is bound `useClass` to a class `business` owns
     * and exports. Every fact it reads is a `business` table, so there is no
     * cross-domain read to compose — what the root supplies is the TOKEN, which
     * is what lets chat's seller-access adapter ask "does this person hold this
     * authority" without importing a `business` ORM entity. The class holds no
     * repository and no DataSource (every method takes the caller's manager), so
     * a second instance is indistinguishable from the one `BusinessModule` also
     * provides — there is one implementation, which is the property that matters.
     *
     * `STAFF_INVITE_IDENTITY_RESOLVER` genuinely crosses domains: it reads
     * `identity.users` and `provider.professionals`, neither of which `business`
     * may import. Both are MANDATORY — no `@Optional()` fallback — so a
     * composition that forgets one fails to boot rather than silently refusing
     * every invitation or, worse, silently allowing a scoped action.
     */
    { provide: SCOPED_STAFF_AUTHORIZER, useClass: BusinessScopedStaffAuthorizer },
    IdentityBackedStaffInviteResolver,
    { provide: STAFF_INVITE_IDENTITY_RESOLVER, useExisting: IdentityBackedStaffInviteResolver },
    /*
     * V3.3 #127 (`#127a`), `V33-DEC-035` R3.
     *
     * Where a professional currently delivers is a `business` fact, and
     * `services/booking` may not import `services/business` (ADR-011). Booking
     * declares the question; this adapter answers it by reading the consented
     * membership and its branch in ONE statement, on the CALLER's manager, so the
     * snapshot lands in the same transaction as the slot insert and linearises
     * against a concurrent owner rebinding.
     *
     * MANDATORY -- no `@Optional()` fallback. A composition that forgets it must
     * fail to boot rather than silently stamping every new slot with no context,
     * which would look exactly like a platform where nobody has a branch.
     */
    BusinessBackedDeliveryLocationDirectory,
    { provide: DELIVERY_LOCATION_DIRECTORY, useExisting: BusinessBackedDeliveryLocationDirectory },
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
    BOOKING_COLLECTION_POLICY_RESOLVER,
    BOOKING_CONFIRMATION_ENTITLEMENT_HOOK,
    BOOKING_CANCELLATION_ENTITLEMENT_HOOK,
    FINANCIAL_PARTY_RESOLVER,
    OWNED_SUBSCRIBER_PARTY_RESOLVER,
    FINANCE_WORKSPACE_OWNER_RESOLVER,
    SELLER_OWNER_ROLE_GRANT,
    BUSINESS_OWNER_ROLE_GRANT,
    LOCATION_CITY_CATALOGUE,
    SCOPED_STAFF_AUTHORIZER,
    STAFF_INVITE_IDENTITY_RESOLVER,
    DELIVERY_LOCATION_DIRECTORY,
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
