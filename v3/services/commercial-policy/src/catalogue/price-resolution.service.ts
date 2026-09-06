import { Injectable, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import {
  COMMERCIAL_CURRENCY,
  PriceQuoteV1,
  PriceResolutionError,
  PriceScheduleTermsV1,
  ResolvedPriceQuoteV1,
  attachPriceIdentityV1,
  resolvePriceV1,
} from '@beauclick/commercial-policy-contract';

import {
  COMMERCIAL_ENTITIES,
  CommercialPriceScheduleEntity,
  CommercialPriceScheduleVersionEntity,
  CommercialPriceTierEntity,
} from './commercial-catalogue.entities';
import { CommercialNotConfiguredException, CommercialTermsInvalidException } from './commercial-catalogue.exceptions';

/**
 * Reading a price. Nothing else — V3.3 #57 (`#40c-1`), ADR-047 §4.
 *
 * ## Why this is its own service rather than a method on the catalogue
 *
 * `SellerSubscriptionSurfaceModule` deliberately does not import
 * `CommercialCatalogueModule`: that module's service is the ADMINISTRATOR's
 * mutation surface, and "a seller route that could publish a plan version would
 * be a boundary violation one autocomplete away" is the line #69 drew and this
 * story must not cross.
 *
 * But a seller route does need to read a price. So the read-only core lives
 * here, in a module both sides may import, and it has no mutation surface at
 * all — not a narrower API on a wide service, but a service that is only this
 * wide. `CommercialCatalogueService.resolvePrice` delegates to it, so there is
 * one resolution path rather than two that can drift.
 *
 * ## It never guesses
 *
 * No latest, no nearest, no default. An absent price is an absent price, which
 * is `V33-DEC-009`'s "an unconfigured plan or price schedule refuses safely
 * rather than falling back" made executable.
 */
@Injectable()
export class PriceResolutionService {
  /**
   * The exact price of a quantity under the version of `scheduleKey` published
   * and active at `at`, inside the CALLER's transaction.
   *
   * ## Why the manager is a parameter and not a field
   *
   * A purchase snapshots the exact version and tier it was priced by. If the
   * price were read on a different connection from the one that writes the row,
   * an administrator publishing a new version between the two would give a
   * purchase a price it was never offered — and no constraint could catch it,
   * because both rows would be individually valid.
   *
   * ## Identity is attached, never fabricated
   *
   * `resolvePriceV1` is a pure function of tier VALUES and cannot know which
   * rows they came from. Rather than make it return ids it cannot fill, the
   * identity is attached here from the rows actually read (ADR-047 §5).
   *
   * The tier is matched back by `minQuantity`, which `ex_price_tiers_no_overlap`
   * makes unique within a version — so the match is a storage guarantee rather
   * than a heuristic.
   */
  async resolveWithin(
    manager: EntityManager,
    scheduleKey: string,
    at: Date,
    quantity: number,
  ): Promise<ResolvedPriceQuoteV1> {
    // Two live conditions against ONE captured instant, exactly as
    // `resolveActivePlanVersion` applies them: published, and inside
    // `[activation_starts_at, activation_ends_at)`.
    const active = await manager
      .getRepository(CommercialPriceScheduleVersionEntity)
      .createQueryBuilder('v')
      .where('v.schedule_key = :scheduleKey', { scheduleKey })
      .andWhere("v.lifecycle_state = 'published'")
      .andWhere('v.activation_starts_at <= :at', { at })
      .andWhere('(v.activation_ends_at IS NULL OR v.activation_ends_at > :at)', { at })
      .getOne();

    if (!active) {
      throw new CommercialNotConfiguredException(
        'no published price schedule version is active for this key at this instant',
      );
    }

    const tiers = await manager
      .getRepository(CommercialPriceTierEntity)
      .find({ where: { scheduleVersionId: active.id }, order: { minQuantity: 'ASC' } });

    let quote: PriceQuoteV1;
    try {
      quote = resolvePriceV1(termsFrom(active, tiers), quantity);
    } catch (error) {
      if (error instanceof PriceResolutionError) {
        // A schedule that reached `published` cannot be incomplete — the
        // publication trigger refuses it — so this branch means the data
        // changed underneath a guarantee, and a refusal is the only honest
        // answer. It is NOT translated into a zero price.
        if (error.refusal === 'schedule_incomplete') {
          throw new CommercialNotConfiguredException('the active price schedule version does not resolve a price');
        }
        throw new CommercialTermsInvalidException([error.message]);
      }
      throw error;
    }

    const tier = tiers.find((candidate) => candidate.minQuantity === quote.tier.minQuantity);
    if (!tier) {
      // Unreachable while `ex_price_tiers_no_overlap` holds: the quote's tier
      // was built from this very set. Kept because a refusal is a better
      // failure than a snapshot pointing at a tier that does not exist.
      throw new CommercialNotConfiguredException('the resolved tier is not present in the active schedule version');
    }

    return attachPriceIdentityV1(quote, {
      scheduleKey,
      scheduleVersionId: active.id,
      tierId: tier.id,
      resolvedAt: at.toISOString(),
    });
  }

  /**
   * The same, with the schedule's purpose verified — `V33-DEC-027` R6.
   *
   * The check is a SECOND line, not the guarantee. The guarantee is
   * `fk_plan_versions_booking_credit_schedule`, which makes a `seller_plan`
   * binding unwritable in the first place. This exists so a misuse produces a
   * typed refusal the seller layer can collapse, rather than a foreign-key
   * error surfacing as a 500.
   */
  async resolveBookingCreditWithin(
    manager: EntityManager,
    scheduleKey: string,
    at: Date,
    quantity: number,
  ): Promise<ResolvedPriceQuoteV1> {
    const schedule = await manager
      .getRepository(CommercialPriceScheduleEntity)
      .findOne({ where: { scheduleKey } });

    if (!schedule || schedule.purpose !== 'booking_credit') {
      throw new CommercialNotConfiguredException('no booking-credit price schedule exists for this key');
    }

    return this.resolveWithin(manager, scheduleKey, at, quantity);
  }
}

/** The pure terms of a version and its already-read tiers. No I/O. */
function termsFrom(
  version: CommercialPriceScheduleVersionEntity,
  tiers: CommercialPriceTierEntity[],
): PriceScheduleTermsV1 {
  return {
    currency: COMMERCIAL_CURRENCY,
    minPurchaseQuantity: version.minPurchaseQuantity,
    maxPurchaseQuantity: version.maxPurchaseQuantity,
    uiPresetQuantities: version.uiPresetQuantities,
    tiers: tiers.map((tier) => ({
      minQuantity: tier.minQuantity,
      maxQuantity: tier.maxQuantity,
      unitPriceToman: tier.unitPriceToman,
    })),
  };
}

/**
 * A module with one read-only provider, so both the administrator's catalogue
 * and the seller's surface can price a quantity without either importing the
 * other's mutation surface.
 */
@Module({
  imports: [TypeOrmModule.forFeature(COMMERCIAL_ENTITIES)],
  providers: [PriceResolutionService],
  exports: [PriceResolutionService],
})
export class PriceResolutionModule {}
