import { Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { SUBJECT_DATA_CONTRACTS, SubjectDataContract, SubjectDataCoverageService } from '@beauclick/subject-data';
import { AuditModule, AuditSubjectDataContract } from '@beauclick/audit';
import { MediaModule, MediaSubjectDataContract } from '@beauclick/media';
import { IdentityModule, IdentitySubjectDataContract } from '@beauclick/identity';
import { ProviderModule, ProviderSubjectDataContract } from '@beauclick/provider';
import { BookingModule, BookingSubjectDataContract } from '@beauclick/booking';
import { CommerceModule, CommerceSubjectDataContract } from '@beauclick/commerce';
import { PaymentModule, PaymentSubjectDataContract } from '@beauclick/payment';
import { FinancialModule, FinancialSubjectDataContract } from '@beauclick/financial';
import { LoyaltyModule, LoyaltySubjectDataContract } from '@beauclick/loyalty';
import { JourneyModule, JourneySubjectDataContract } from '@beauclick/journey';
import { NotificationModule, NotificationSubjectDataContract } from '@beauclick/notification';
import { AnalyticsModule, AnalyticsSubjectDataContract } from '@beauclick/analytics';
import { BusinessModule, BusinessSubjectDataContract } from '@beauclick/business';
import { WaitlistModule, WaitlistSubjectDataContract } from '@beauclick/waitlist';
import { SearchModule, SearchSubjectDataContract } from '@beauclick/search';
import { ERASURE_RUNNER, PrivacyModule, PrivacyService, PrivacySubjectDataContract } from '@beauclick/privacy';
import { AiModule, AiSubjectDataContract } from '@beauclick/ai';
import { ChatModule, ChatSubjectDataContract } from '@beauclick/chat';
import { WishlistModule, WishlistSubjectDataContract } from '@beauclick/wishlist';
import { ReferralModule, ReferralSubjectDataContract } from '@beauclick/referral';

/**
 * Erasure's one out-of-transaction step.
 *
 * `media` marks its rows deleted inside the erasure transaction and can do
 * nothing about the BYTES from there, because object storage has no
 * transaction to enlist in. This wrapper reads what will need purging before
 * the erasure runs, lets the transaction commit, and only then removes the
 * objects.
 *
 * The ordering is the safe one: a crash after the commit leaves orphaned bytes
 * whose rows already say they are gone -- an operational cleanup problem
 * `MediaService.purgeBytes` already documents itself as tolerating. Purging
 * first would let a rolled-back erasure destroy a professional's portfolio
 * while every row still claimed the images existed.
 *
 * It lives in the composition root because it is the only thing here that
 * needs both `PrivacyService` and `MediaService`, and neither domain may
 * import the other.
 */
@Injectable()
export class PrivacyErasureCompleter {
  private readonly logger = new Logger('PrivacyErasure');

  constructor(
    private readonly dataSource: DataSource,
    private readonly privacy: PrivacyService,
    private readonly media: MediaSubjectDataContract,
  ) {}

  async executeWithBytePurge(requestId: string, subjectUserId: string): Promise<void> {
    const pending = await this.media.pendingByteDeletions(this.dataSource.manager, subjectUserId);
    const outcome = await this.privacy.executeErasure(requestId);
    // Only purge if the erasure actually ran. A request somebody else already
    // claimed returns null, and destroying that subject's images on the
    // strength of a lost race would be irreversible damage done by a no-op.
    if (!outcome) return;
    if (pending.length === 0) return;

    await this.media.purge(pending);
    this.logger.log(`Purged ${pending.length} stored object(s) for an erased subject`);
  }
}

/**
 * Where every `SubjectDataContract` is collected into the one array
 * `PrivacyService` iterates.
 *
 * `@Global()`, and that is not convenience. `PrivacyService` lives in
 * `PrivacyModule`, which this module IMPORTS -- so a token provided here is
 * invisible to it through the ordinary import graph, and the `@Optional()`
 * injection resolved to an empty array. The symptom was an export document
 * with zero sections and an erasure that erased nothing, both of which look
 * like working code. Found by the suite. Registering the token globally is the
 * same fix, and for the same reason, that `PrivilegedCapabilityModule` records
 * for `PRIVILEGED_CAPABILITY_VERIFIER`.
 *
 * The array is assembled by hand here, and that is exactly the hand-maintained
 * list `PRIV-06` warns about -- which is why it is not what the guarantee
 * rests on. `SubjectDataCoverageService` reads the real `pg_tables` catalogue
 * at boot and refuses to start if any table is unclaimed, so a module added to
 * the workspace and forgotten here fails startup rather than being silently
 * skipped by an export. The list is the wiring; the catalogue check is the
 * proof.
 *
 * Eighteen contracts. `financial`'s reads on its own connection (ADR-017);
 * `search`'s is a claim with no work, because provider's `ProfessionalUpdated`
 * event already removes the document. Both are explained in their own files.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    AuditModule,
    MediaModule,
    IdentityModule,
    ProviderModule,
    BookingModule,
    CommerceModule,
    PaymentModule,
    FinancialModule,
    LoyaltyModule,
    JourneyModule,
    NotificationModule,
    AnalyticsModule,
    BusinessModule,
    WaitlistModule,
    SearchModule,
    PrivacyModule,
    // V3.2-A. Imported for its contract only. `ai`'s six tables are claimed
    // like every other module's, and the boot assertion is what turns "somebody
    // remembered to register" into a startup failure -- an unclaimed `ai` table
    // stops the application, which is the intended severity for a schema
    // holding the most sensitive prose in the platform.
    AiModule,
    // V3.2-B. Imported for its contract only. Chat's seven tables are claimed
    // like every other module's, and the boot assertion is what turns "somebody
    // remembered to register" into a startup failure.
    ChatModule,
    // V3.2-C Story #8. Imported for its contract only. One table, claimed like
    // every other schema is -- and the boot assertion is what turns "somebody
    // remembered to register" into a startup failure.
    //
    // Worth the extra line here: a wishlist row is DELETED on erasure rather
    // than anonymized, which is the opposite of the platform default. That is a
    // claim somebody had to make deliberately, and the coverage check is what
    // made them make it.
    WishlistModule,
    ReferralModule,
  ],
  providers: [
    PrivacyErasureCompleter,
    {
      // The seam `PrivacySweepService` declares. Bound here because this is
      // the only scope that can see both privacy and media.
      provide: ERASURE_RUNNER,
      useFactory: (completer: PrivacyErasureCompleter) => ({
        run: (requestId: string, subjectUserId: string) =>
          completer.executeWithBytePurge(requestId, subjectUserId),
      }),
      inject: [PrivacyErasureCompleter],
    },
    {
      provide: SUBJECT_DATA_CONTRACTS,
      inject: [
        IdentitySubjectDataContract,
        ProviderSubjectDataContract,
        BookingSubjectDataContract,
        CommerceSubjectDataContract,
        PaymentSubjectDataContract,
        FinancialSubjectDataContract,
        LoyaltySubjectDataContract,
        JourneySubjectDataContract,
        NotificationSubjectDataContract,
        AnalyticsSubjectDataContract,
        BusinessSubjectDataContract,
        WaitlistSubjectDataContract,
        SearchSubjectDataContract,
        MediaSubjectDataContract,
        AuditSubjectDataContract,
        PrivacySubjectDataContract,
        AiSubjectDataContract,
        ChatSubjectDataContract,
        WishlistSubjectDataContract,
        ReferralSubjectDataContract,
      ],
      useFactory: (...contracts: SubjectDataContract[]): SubjectDataContract[] => contracts,
    },
  ],
  exports: [SUBJECT_DATA_CONTRACTS, ERASURE_RUNNER, PrivacyErasureCompleter, PrivacyModule],
})
export class PrivacyCompositionModule implements OnApplicationBootstrap {
  constructor(
    private readonly coverage: SubjectDataCoverageService,
    // The list this module itself provides. Injected here rather than into
    // the service for the scope reason recorded on that constructor.
    @Inject(SUBJECT_DATA_CONTRACTS) private readonly contracts: SubjectDataContract[],
  ) {}

  /**
   * The boot assertion.
   *
   * Deliberately here rather than inside `libs/subject-data`: this is the
   * module that knows the complete contract list, so it is the only place
   * where "everything is registered" is a meaningful claim. Failing here stops
   * the application, which is the intended severity -- an incomplete privacy
   * export is silently wrong, and silently wrong is what a boot assertion is
   * for.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.coverage.assertComplete(this.contracts);
  }
}
