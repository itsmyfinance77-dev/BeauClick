import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProfessionalEntity, ProviderModule, ServiceOfferingEntity } from '@beauclick/provider';
import { WISHLIST_SAVEABLE_TARGET, WishlistModule } from '@beauclick/wishlist';

import { WishlistSaveableTargetAdapter } from './wishlist-ports';

/**
 * The one port binding, `@Global()`.
 *
 * ## Why global, and why this is a separate module from the composition below
 *
 * `WishlistModule` DECLARES `WISHLIST_SAVEABLE_TARGET` and provides nothing, so
 * something else has to bind it. The obvious place is the composition module
 * below — and that does not work, for a reason this codebase has now hit four
 * times and `AiPortsModule` records at length:
 *
 * Nest resolves a provider through the injector of the module that DECLARES the
 * consumer, walking up through that module's own imports.
 * `WishlistCompositionModule` imports `WishlistModule`; the arrow points the
 * wrong way. A token provided there is invisible to `WishlistService`, and the
 * symptom is a boot-time `Nest can't resolve dependencies of the
 * WishlistService`.
 *
 * So the binding lives in a `@Global()` module, exactly as `DomainPortsModule`
 * and `AiPortsModule` do, and for the same reason: this is an infrastructure
 * binding a domain module needs and must not import a domain to obtain.
 *
 * A domain module still cannot reach a service it should not see. Only the one
 * narrow, wishlist-declared token is exported — not `ProviderService`, and not
 * the repositories the adapter reads.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    // The repositories the adapter reads. A repository provider is scoped to the
    // module that registers it, so being available in the (@Global)
    // `DomainPortsModule` does not make it visible here — the same note
    // `AiPortsModule` and `Phase3CompositionModule` both record.
    TypeOrmModule.forFeature([ProfessionalEntity, ServiceOfferingEntity]),
    ProviderModule,
  ],
  providers: [
    WishlistSaveableTargetAdapter,
    { provide: WISHLIST_SAVEABLE_TARGET, useExisting: WishlistSaveableTargetAdapter },
  ],
  exports: [WISHLIST_SAVEABLE_TARGET],
})
export class WishlistPortsModule {}

/**
 * The V3.2-C Story #8 composition root.
 *
 * Smaller than `AiCompositionModule` and smaller than `ChatCompositionModule`,
 * and the smallness is the measure of the boundary rather than of the feature:
 * one port binding, and nothing else.
 *
 * ## What is deliberately not composed here
 *
 * **No outbox source, and no `WISHLIST_OUTBOX_SOURCES` token.** `wishlist` emits
 * no events, has no `outbox_events` table, and is not in `ServiceName`
 * (`V32-DEC-021`, ADR-033 §10). There is nothing for the relay to drain, so there
 * is nothing to contribute and no token to merge.
 *
 * **No event handler.** The module consumes nothing. A saved item is not a
 * reaction to any domain fact.
 *
 * **No sweep scheduler.** There is no retention horizon: a saved item is
 * destroyed by the customer removing it or by their account erasure, and by
 * nothing else (`V32-DEC-021`). `AiSweepScheduler` and `ChatSweepScheduler` exist
 * because those modules have retention periods; this one does not, and adding a
 * scheduler that swept nothing would be a claim the schema cannot support.
 *
 * **No analytics mapping.** `analytics.events` restricts `subject_type` to seven
 * values by CHECK constraint and none of them fits a saved item; widening it is a
 * migration on a shared, privacy-sensitive table that `V32-DEC-021` does not
 * authorise.
 *
 * **Nothing from Story #9 or #10.** No target-state projection, no saved-state
 * hydration for search or profile surfaces, and no frontend.
 */
@Module({
  imports: [
    ConfigModule,
    // FIRST, so the port is bound before `WishlistModule` is instantiated.
    WishlistPortsModule,
    WishlistModule,
  ],
  exports: [WishlistPortsModule, WishlistModule],
})
export class WishlistCompositionModule {}
