import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  ProfessionalEntity,
  ProviderModule,
  ServiceOfferingEntity,
  WISHLIST_SAVED_TARGETS as PROVIDER_WISHLIST_SAVED_TARGETS,
} from '@beauclick/provider';
import { WISHLIST_SAVED_TARGETS as SEARCH_WISHLIST_SAVED_TARGETS } from '@beauclick/search';
import { WISHLIST_TARGET_PORT, WishlistModule } from '@beauclick/wishlist';

import { WishlistSavedTargetsAdapter, WishlistTargetAdapter } from './wishlist-ports';

/**
 * The wishlist's read INTO the catalogue, `@Global()`.
 *
 * ## Why global, and why this is a separate module from the composition below
 *
 * `WishlistModule` DECLARES `WISHLIST_TARGET_PORT` and provides nothing, so
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
    WishlistTargetAdapter,
    { provide: WISHLIST_TARGET_PORT, useExisting: WishlistTargetAdapter },
  ],
  exports: [WISHLIST_TARGET_PORT],
})
export class WishlistPortsModule {}

/**
 * The catalogue's read INTO the wishlist — the opposite direction (ADR-034).
 *
 * ## Why it is a SECOND module and not two more providers above
 *
 * `WishlistPortsModule` imports `ProviderModule`. If the saved-state adapter
 * lived there, that module would additionally have to import `WishlistModule` —
 * and `WishlistModule`'s own service resolves `WISHLIST_TARGET_PORT` from that
 * same module. A module importing another that depends back on it is the shape
 * that turns a resolution failure into a boot-time puzzle. Two modules, each
 * with one direction of dependency, keeps both graphs acyclic:
 *
 *   WishlistPortsModule    → ProviderModule        (wishlist reads the catalogue)
 *   WishlistSavedStateModule → WishlistModule      (the catalogue reads the wishlist)
 *
 * ## One adapter, two tokens
 *
 * `search` and `provider` each declare their own `WISHLIST_SAVED_TARGETS`
 * symbol, because ADR-011 forbids either importing the other's. Both are bound
 * with `useExisting` to the SAME instance — precisely what `PROFESSIONAL_OWNER_LOOKUP`
 * and `PROFESSIONAL_DIRECTORY` already do in `DomainPortsModule`, and for the
 * reason recorded there: a second implementation answering the same question a
 * second way is how two surfaces start disagreeing.
 *
 * ## Neither consumer provides a default, deliberately
 *
 * `SearchModule` and `ProviderModule` declare their tokens and bind nothing, so
 * a composition that omits this module fails to boot. The alternative — an
 * `@Optional()` injection falling back to `null` — would ship a marketplace
 * where every signed-in customer's save control renders as "unknown" forever,
 * with no error anywhere. That is the failure mode `SearchModule`'s in-memory
 * engine guard exists to prevent for search itself, and the same argument
 * applies.
 */
@Global()
@Module({
  imports: [ConfigModule, WishlistModule],
  providers: [
    WishlistSavedTargetsAdapter,
    { provide: SEARCH_WISHLIST_SAVED_TARGETS, useExisting: WishlistSavedTargetsAdapter },
    { provide: PROVIDER_WISHLIST_SAVED_TARGETS, useExisting: WishlistSavedTargetsAdapter },
  ],
  exports: [SEARCH_WISHLIST_SAVED_TARGETS, PROVIDER_WISHLIST_SAVED_TARGETS],
})
export class WishlistSavedStateModule {}

/**
 * The V3.2-C wishlist composition root (Stories #8 and #9).
 *
 * Two port bindings in opposite directions, and nothing else. The smallness is
 * the measure of the boundary rather than of the feature.
 *
 * ## What is deliberately not composed here
 *
 * **No outbox source, and no `WISHLIST_OUTBOX_SOURCES` token.** `wishlist` emits
 * no events, has no `outbox_events` table, and is not in `ServiceName`
 * (`V32-DEC-021`, ADR-033 §10). There is nothing for the relay to drain, so there
 * is nothing to contribute and no token to merge. Story #9 adds none either: a
 * target becoming unavailable produces no event, because a notification about it
 * would disclose a third party's status change.
 *
 * **No event handler.** The module consumes nothing. A saved item is not a
 * reaction to any domain fact, and a saved item's target going away is not a
 * fact this module is told about — it is one it computes on read.
 *
 * **No sweep scheduler.** There is no retention horizon: a saved item is
 * destroyed by the customer removing it or by their account erasure, and by
 * nothing else (`V32-DEC-021`). `AiSweepScheduler` and `ChatSweepScheduler` exist
 * because those modules have retention periods; this one does not, and adding a
 * scheduler that swept unavailable targets would implement the option the owner
 * rejected.
 *
 * **No analytics mapping, and no ranking contribution.** `analytics.events`
 * restricts `subject_type` to seven values by CHECK constraint and none of them
 * fits a saved item. A popularity or ranking signal is refused separately and
 * more strongly by `V32-DEC-021`; `search.ranking_signals` and `ranking.ts` are
 * untouched by this story.
 *
 * **Nothing from Story #10.** No frontend, and no design artifact.
 */
@Module({
  imports: [
    ConfigModule,
    // FIRST, so the port is bound before `WishlistModule` is instantiated.
    WishlistPortsModule,
    WishlistModule,
    // The reverse binding, so `search` and `provider` can resolve their own
    // saved-state tokens. Global, so neither has to import anything to get it.
    WishlistSavedStateModule,
  ],
  exports: [WishlistPortsModule, WishlistModule, WishlistSavedStateModule],
})
export class WishlistCompositionModule {}
