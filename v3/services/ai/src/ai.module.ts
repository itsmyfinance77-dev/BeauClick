import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MetricsRegistry, ObservabilityModule } from '@beauclick/observability';

import { AI_CLOCK, systemAiClock } from './ai-clock';
import { AiAssistantService } from './ai-assistant.service';
import { AiConsentService } from './ai-consent.service';
import { AiController } from './ai.controller';
import { AiConversationService } from './ai-conversation.service';
import { AiQuotaService } from './ai-quota.service';
import { AiSubjectDataContract } from './ai-subject-data.contract';
import { AI_ENTITIES, AiConsentEntity, AiUsageDailyEntity } from './entities/ai.entities';
import { AiContextAssembler } from './context/ai-context.assembler';
import { registerAiMetrics } from './ai.metrics';
import { AI_PROVIDERS } from './providers/ai-provider.interface';
import { AiProviderRegistry } from './providers/ai-provider.registry';
import { DeterministicAssistantProvider } from './providers/deterministic-assistant.provider';
import { AiOutputVerifier } from './safety/ai-output-verification';

/**
 * The AI assistant module (ADR-029).
 *
 * ## What it exports, and what it deliberately does not
 *
 * The services and the subject-data contract are exported. The repositories are
 * NOT — the same asymmetry `JourneyModule` records, expressed in the module
 * definition rather than in a comment: a module composed alongside this one can
 * ask the assistant a question and can register its erasure, and has no route to
 * the tables holding customers' messages.
 *
 * ## What it does not import, and cannot
 *
 * No other domain. `ai` is tagged `scope:ai` and the Nx boundary matrix permits
 * it `scope:shared` and nothing else, so a `@beauclick/journey` or
 * `@beauclick/search` import here fails lint rather than merely disappointing a
 * reviewer. The two context ports (`AI_JOURNEY_CONTEXT`, `AI_PUBLIC_CATALOGUE`)
 * are declared by this module and BOUND by the composition root, which is the
 * only place ADR-011 permits a cross-domain read.
 *
 * That is why they are not provided here. A module that cannot boot without its
 * ports bound is a module whose boundary is real: there is no default
 * implementation to fall back on, and no way to accidentally ship one.
 *
 * ## The provider registration
 *
 * `DeterministicAssistantProvider` is contributed under `AI_PROVIDERS` as a
 * one-element array — a REGISTERED provider with its own key, never an implicit
 * fallback (`F-03`, ADR-029 §3). A real vendor adapter would be a second element
 * plus an `AI_DEFAULT_PROVIDER` value, and nothing else in this file would
 * change.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature(AI_ENTITIES),
    // For `MetricsRegistry`. `ObservabilityModule` is `@Global()`, but a module
    // that injects from it says so -- the same rule `MediaModule`'s consumers
    // follow, and the reason a missing import shows up as a boot failure rather
    // than as counters that silently never move.
    ObservabilityModule,
  ],
  controllers: [AiController],
  providers: [
    { provide: AI_CLOCK, useValue: systemAiClock },

    DeterministicAssistantProvider,
    {
      provide: AI_PROVIDERS,
      inject: [DeterministicAssistantProvider],
      useFactory: (deterministic: DeterministicAssistantProvider) => [deterministic],
    },
    AiProviderRegistry,

    AiConsentService,
    AiQuotaService,
    AiConversationService,
    AiContextAssembler,
    AiOutputVerifier,
    AiAssistantService,
    AiSubjectDataContract,
  ],
  exports: [
    AiAssistantService,
    AiConsentService,
    AiConversationService,
    AiQuotaService,
    AiProviderRegistry,
    AiSubjectDataContract,
    TypeOrmModule,
  ],
})
export class AiModule implements OnModuleInit {
  constructor(private readonly metrics: MetricsRegistry) {}

  /**
   * Metric registration at module init rather than at the platform level.
   *
   * `registerPlatformMetrics` covers what every deployment has. These exist only
   * where the AI module is composed, and registering them there means a
   * composition without AI does not publish six always-zero series that read as
   * "the assistant handled nothing" rather than "there is no assistant".
   */
  onModuleInit(): void {
    registerAiMetrics(this.metrics);
  }
}

/** Re-exported so the composition root can register these on the shared DataSource. */
export { AiConsentEntity, AiUsageDailyEntity };
