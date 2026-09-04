import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { COMMERCIAL_ENTITIES } from '../catalogue/commercial-catalogue.entities';
import { SUBSCRIPTION_ENTITIES } from '../subscription/seller-subscription.entities';
import { SellerSubscriptionModule } from '../subscription/seller-subscription.module';
import {
  SellerCommercialPlansController,
  SellerSubscriptionSurfaceController,
} from './seller-subscription-surface.controller';
import { SellerSubscriptionSurfaceService } from './seller-subscription-surface.service';
import { WorkspaceReferenceService } from './workspace-reference';

/**
 * The seller subscription surface — Story #69 (`#56b`), `V33-DEC-019`.
 *
 * ## A FOURTH module in this service, and why it is not folded into the third
 *
 * `SellerSubscriptionModule` is #56a's foundation: the lifecycle, the
 * snapshots, the grants, the audit. It ships no controller, and its boundary
 * suite asserts that against the source. This module is the seller-facing
 * SURFACE over it.
 *
 * Keeping them apart is not filing. The foundation is called by anything that
 * needs a seller's entitlement — #58's consumption will, and it must not
 * acquire an HTTP dependency to do it. The surface is called by a browser and
 * nothing else. A module that was both would make "does the domain depend on a
 * route layer?" a question a reviewer has to answer by reading, rather than one
 * the import graph answers.
 *
 * ## The dedicated secret is NOT read here any more
 *
 * `V33-DEC-020` shares the workspace reference with the finance surface, so
 * `WORKSPACE_REFERENCE_HMAC_SECRET` is now read ONCE in the composition root
 * (`DomainPortsModule`, which is `@Global()`) and injected under
 * `WORKSPACE_REFERENCE_SECRET`. Two modules each calling `config.get(...)`
 * would be two places a later edit could point at `JWT_ACCESS_SECRET`, and two
 * copies of the development fallback.
 *
 * This module therefore reads no environment variable at all, which the
 * boundary suite asserts. `env.validation.ts` independently refuses to boot in
 * production when the secret is missing, too short, a placeholder, or shared
 * with another secret.
 *
 * ## What this module does NOT introduce
 *
 * No new port: ownership is #56a's `OWNED_SUBSCRIBER_PARTY_RESOLVER`, bound
 * globally in the composition root, and a second resolver would be a second
 * answer to a question that must have exactly one. No entity, no table, no
 * migration beyond the capability grant. No event, no outbox, no scheduler and
 * no clock seam — nothing here recurs and nothing here is consumed.
 */
@Module({
  imports: [
    SellerSubscriptionModule,
    // The surface reads plan versions, schedule versions and tiers directly to
    // project the seller-visible catalogue in one query, and reads
    // subscriptions to render a workspace. It does NOT import
    // `CommercialCatalogueModule`, whose service is the administrator's
    // mutation surface — the same line `SellerSubscriptionModule` draws, for
    // the same reason: a seller route that could publish a plan version would
    // be a boundary violation one autocomplete away.
    TypeOrmModule.forFeature([...SUBSCRIPTION_ENTITIES, ...COMMERCIAL_ENTITIES]),
  ],
  controllers: [SellerSubscriptionSurfaceController, SellerCommercialPlansController],
  providers: [SellerSubscriptionSurfaceService, WorkspaceReferenceService],
  exports: [SellerSubscriptionSurfaceService, WorkspaceReferenceService],
})
export class SellerSubscriptionSurfaceModule {}
