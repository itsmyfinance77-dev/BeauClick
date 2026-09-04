import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { COMMERCIAL_ENTITIES } from '../catalogue/commercial-catalogue.entities';
import { SUBSCRIPTION_ENTITIES } from '../subscription/seller-subscription.entities';
import { SellerSubscriptionModule } from '../subscription/seller-subscription.module';
import {
  SellerCommercialPlansController,
  SellerSubscriptionSurfaceController,
} from './seller-subscription-surface.controller';
import { SellerSubscriptionSurfaceService } from './seller-subscription-surface.service';
import { WORKSPACE_REFERENCE_SECRET, WorkspaceReferenceService } from './workspace-reference';

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
 * ## The dedicated secret is bound HERE, and its absence is visible
 *
 * `WORKSPACE_REFERENCE_HMAC_SECRET` is read once, in the factory below, and
 * nowhere else. Three properties follow from putting it here rather than in a
 * `config.get(...)` inside the service:
 *
 *  * the dedicated-secret requirement is visible at the wiring, so pointing it
 *    at `JWT_ACCESS_SECRET` would be an edit a reviewer sees rather than a
 *    default nobody notices;
 *  * `env.validation.ts` independently refuses to boot in production when it is
 *    missing, too short, a placeholder, or shared with another secret — this
 *    factory does not restate those rules, because two implementations of one
 *    rule are one waiting to disagree;
 *  * the development fallback is the SAME literal the rest of this codebase
 *    uses, which production validation rejects by name. A developer gets a
 *    working application; a production deployment carrying it does not start.
 *
 * The value is never logged, never returned, and never reaches a metric label.
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
    ConfigModule,
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
  providers: [
    SellerSubscriptionSurfaceService,
    WorkspaceReferenceService,
    {
      provide: WORKSPACE_REFERENCE_SECRET,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string =>
        // A DISTINCT development literal, not the shared
        // `dev-only-insecure-secret-override-in-env` that `app.module.ts` falls
        // back to for the JWT. Reusing that one would make this secret equal to
        // the token-signing secret on every developer machine — the exact
        // sharing the production validator refuses — so the dedicated-secret
        // property would hold only where it is checked. Both literals carry
        // `dev-only` and `insecure`, which `FORBIDDEN_SECRET_FRAGMENTS` refuses
        // by name, so neither can reach production.
        config.get<string>('WORKSPACE_REFERENCE_HMAC_SECRET') ??
        'dev-only-insecure-workspace-reference-secret-override-in-env',
    },
  ],
  exports: [SellerSubscriptionSurfaceService, WorkspaceReferenceService],
})
export class SellerSubscriptionSurfaceModule {}
