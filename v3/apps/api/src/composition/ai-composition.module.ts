import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AI_JOURNEY_CONTEXT, AI_PUBLIC_CATALOGUE, AiModule, AiOutboxEntity } from '@beauclick/ai';
import { OutboxSource } from '@beauclick/events';
import { JourneyModule } from '@beauclick/journey';
import { ProfessionalEntity, ProviderModule, ServiceOfferingEntity } from '@beauclick/provider';
import { RankingSignalsEntity, SearchModule } from '@beauclick/search';

import { AiSweepScheduler } from '../events/ai-sweep.scheduler';
import { JourneyAiContextAdapter, PublicCatalogueAiAdapter } from './ai-ports';
import { AI_OUTBOX_SOURCES } from './ai-tokens';

/**
 * The V3.2-A composition root.
 *
 * Small, because the AI module was built to need very little from here: two
 * port bindings and an outbox source. That smallness is the measure of whether
 * ADR-029's boundary actually holds — a composition root that had to reach into
 * `ai` to make it work would be evidence that the module's dependencies were
 * not really ports.
 *
 * ## Why the ports are bound here and not in `AiModule`
 *
 * ADR-011 forbids a domain from importing another, and lint enforces it: an
 * `@beauclick/journey` import inside `services/ai` fails CI. `apps/api` is
 * `scope:app` and is the one place permitted to depend on every domain, so it
 * is where a cross-domain read is written down.
 *
 * `AiModule` therefore declares `AI_JOURNEY_CONTEXT` and `AI_PUBLIC_CATALOGUE`
 * and provides neither — a composition that forgets to bind them fails to boot
 * rather than falling back to something. There is no default implementation to
 * fall back on, which is what makes the boundary real rather than nominal.
 *
 * ## What is deliberately not composed here
 *
 * **No AI event handler.** The two AI events reach analytics through the
 * platform's existing generic ingestion handler (`buildAnalyticsHandlers` maps
 * every event the analytics fact table declares a mapping for), so there is no
 * bespoke AI consumer to write and no second place where an AI payload is read.
 *
 * **No professional-mode anything** (`V32-DEC-001`). No capability, no adapter,
 * no table.
 *
 * **No vendor adapter, no credential, no external client** (ADR-029). The only
 * registered provider is the deterministic one, and it is registered inside
 * `AiModule` because it needs nothing from any other domain.
 */
@Module({
  imports: [
    ConfigModule,
    // The repositories the catalogue adapter reads. A repository provider is
    // scoped to the module that registers it, so being available in the
    // (@Global) DomainPortsModule does not make it visible here -- the same note
    // `Phase3CompositionModule` records for its own forFeature list.
    TypeOrmModule.forFeature([ProfessionalEntity, ServiceOfferingEntity, RankingSignalsEntity]),
    JourneyModule,
    ProviderModule,
    SearchModule,
    AiModule,
  ],
  providers: [
    AiSweepScheduler,
    JourneyAiContextAdapter,
    PublicCatalogueAiAdapter,
    { provide: AI_JOURNEY_CONTEXT, useExisting: JourneyAiContextAdapter },
    { provide: AI_PUBLIC_CATALOGUE, useExisting: PublicCatalogueAiAdapter },
    {
      provide: AI_OUTBOX_SOURCES,
      // One table, on the shared application DataSource, drained by the same
      // relay every other schema's outbox is drained by. Contributed under its
      // own token and merged into the single relay by DomainCompositionModule,
      // which is the pattern Phase 3's five tables already established.
      useValue: [{ name: 'ai', entity: AiOutboxEntity }] satisfies OutboxSource[],
    },
  ],
  exports: [AI_JOURNEY_CONTEXT, AI_PUBLIC_CATALOGUE, AI_OUTBOX_SOURCES, AiSweepScheduler, AiModule],
})
export class AiCompositionModule {}
