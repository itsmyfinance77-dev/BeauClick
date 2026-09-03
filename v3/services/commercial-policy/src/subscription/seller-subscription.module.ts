import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { COMMERCIAL_ENTITIES } from '../catalogue/commercial-catalogue.entities';
import { BookingCreditGrantService } from './booking-credit-grant.service';
import { SUBSCRIPTION_ENTITIES } from './seller-subscription.entities';
import { SellerSubscriptionService } from './seller-subscription.service';
import { SubscriptionSubjectDataContract } from './subscription-subject-data.contract';

/**
 * The subscription foundation (ADR-042, Story #56 / `#56a`).
 *
 * ## A THIRD module in this service
 *
 * Story #39's `CommercialPolicyModule` resolves the terms one BOOKING accepted;
 * #40a's `CommercialCatalogueModule` is the administrator's catalogue of what a
 * seller MAY subscribe to; this one is what a seller ACTUALLY holds. Three
 * questions, three modules, one service — the same additive shape #40a used
 * rather than a fourth package.
 *
 * ## No controller, and that is the story's boundary
 *
 * There is no `controllers` array. Story #56a ships no HTTP route of any kind —
 * no subscription read, no selection, no cancellation, no plan listing. Those
 * are #69, which adds a controller over the service this module exports.
 *
 * A reviewer can check that claim against this file rather than against
 * intention: a route cannot exist in this story without appearing here.
 *
 * ## It imports the catalogue's entities, not the catalogue's module
 *
 * `activate` reads `plan_versions`, `price_schedule_versions` and `price_tiers`
 * to build a snapshot, so it needs those repositories — but it must NOT reach
 * `CommercialCatalogueService`, whose surface is administrator mutations. A
 * subscription that could publish a plan version would be a boundary violation
 * one autocomplete away.
 *
 * ## One port, and it is deliberately narrow
 *
 * `OWNED_SUBSCRIBER_PARTY_RESOLVER` is bound in the composition root, because
 * `services/commercial-policy` may not import `services/provider` or
 * `services/business` (ADR-011, enforced by lint). The port asks one question —
 * which parties does this user OWN — and cannot be used to ask any other.
 *
 * ## No AuditModule import
 *
 * `AuditModule` is `@Global()`, so `AdminAuditService` resolves here without
 * one. The same arrangement `CommercialCatalogueModule` documents.
 *
 * ## No outbox, no event, no scheduler, no clock seam
 *
 * Nothing here emits: no consumer has been named (ADR-042 §12). Nothing here
 * recurs: every publishable plan version has a NULL billing term, so there is
 * no period boundary to schedule against.
 *
 * ## What it exports, and what it withholds
 *
 * The two services and the subject-data contract. **Not the repositories** —
 * #58 will read balances through a service method, not by reaching into
 * `booking_credit_grants` and bypassing the immutability the triggers exist to
 * guarantee. The same asymmetry `CommercialCatalogueModule` records.
 */
@Module({
  imports: [TypeOrmModule.forFeature([...SUBSCRIPTION_ENTITIES, ...COMMERCIAL_ENTITIES])],
  providers: [SellerSubscriptionService, BookingCreditGrantService, SubscriptionSubjectDataContract],
  exports: [SellerSubscriptionService, BookingCreditGrantService, SubscriptionSubjectDataContract],
})
export class SellerSubscriptionModule {}
