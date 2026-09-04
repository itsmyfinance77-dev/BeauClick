import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { ProfessionalEntity, ServiceOfferingEntity } from '@beauclick/provider';
import { ProfessionalDirectory } from '@beauclick/booking';
import { ServiceCatalog, ServiceOfferingSnapshot } from '@beauclick/commerce';
import { FinanceWorkspaceOwnerResolver, FinancialParty, FinancialPartyResolver } from '@beauclick/financial';
import { OwnedSubscriberParty, OwnedSubscriberPartyResolver } from '@beauclick/commercial-policy';
import { BusinessEntity, BusinessStaffEntity } from '@beauclick/business';

/**
 * The composition root's implementations of the ports booking-, commerce-,
 * and financial-service DECLARE but must not implement themselves.
 *
 * ADR-011 forbids `services/*` importing another `services/*`. These
 * adapters live in `apps/api` (`scope:app`), the one tier permitted to
 * compose domains, so provider-service data reaches the other modules
 * without any of them depending on it. Each domain still owns the interface
 * -- and therefore the question being asked -- while only the wiring knows
 * who answers it.
 */
@Injectable()
export class ProviderBackedProfessionalDirectory implements ProfessionalDirectory {
  constructor(@InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>) {}

  async ownerUserIdFor(professionalId: string): Promise<string | null> {
    const professional = await this.professionals.findOne({
      where: { id: professionalId, deletedAt: IsNull() },
      select: { id: true, ownerId: true },
    });
    return professional?.ownerId ?? null;
  }

  async professionalIdForOwner(userId: string): Promise<string | null> {
    const professional = await this.professionals.findOne({
      where: { ownerId: userId, deletedAt: IsNull() },
      select: { id: true, ownerId: true },
    });
    return professional?.id ?? null;
  }
}

/**
 * "Who does the money for this professional's work actually belong to?"
 * (ADR-023 §3) -- shared by `ProviderBackedServiceCatalog` (which seller
 * party a new order is created for) and `ProviderBackedFinancialPartyResolver`
 * (which seller party a session IS), so the two can never disagree about the
 * same professional's affiliation. `business_staff`'s partial unique index on
 * `(professional_id) WHERE status = 'active'` is what makes this a lookup
 * rather than a policy decision: a professional has at most one answer.
 */
@Injectable()
export class SellerPartyLookup {
  constructor(
    @InjectRepository(BusinessStaffEntity) private readonly staff: Repository<BusinessStaffEntity>,
  ) {}

  async forProfessional(professionalId: string): Promise<FinancialParty> {
    const membership = await this.staff.findOne({
      where: { professionalId, status: 'active' },
      select: { id: true, businessId: true },
    });
    return membership
      ? { partyType: 'business', partyId: membership.businessId }
      : { partyType: 'professional', partyId: professionalId };
  }
}

@Injectable()
export class ProviderBackedServiceCatalog implements ServiceCatalog {
  constructor(
    @InjectRepository(ServiceOfferingEntity) private readonly services: Repository<ServiceOfferingEntity>,
    private readonly sellerParty: SellerPartyLookup,
  ) {}

  async findServiceOffering(serviceId: string): Promise<ServiceOfferingSnapshot | null> {
    const offering = await this.services.findOne({ where: { id: serviceId, deletedAt: IsNull() } });
    if (!offering) return null;
    const seller = await this.sellerParty.forProfessional(offering.professionalId);
    return {
      id: offering.id,
      professionalId: offering.professionalId,
      name: offering.name,
      priceToman: offering.priceToman,
      durationMinutes: offering.durationMinutes,
      sellerPartyType: seller.partyType,
      sellerPartyId: seller.partyId,
    };
  }
}

/**
 * Resolves "which selling party is this session?" for financial-service.
 *
 * The direction matters: financial-service asks for the party belonging to a
 * USER ID it was given by an authenticated request. It never receives, and
 * has no way to accept, a party id chosen by a caller -- which is the whole
 * structural half of the GAP-05 fix.
 *
 * Resolution order (ADR-023 §3): a user who owns a `BusinessEntity` IS that
 * business party outright -- checked first, since an owner may or may not
 * also hold a professional profile, and owning the business is the stronger,
 * unambiguous claim. Otherwise, a user who owns a professional profile is
 * that professional's party UNLESS `SellerPartyLookup` finds them actively
 * affiliated with a business, in which case their earnings belong to it.
 */
@Injectable()
export class ProviderBackedFinancialPartyResolver implements FinancialPartyResolver {
  constructor(
    @InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>,
    @InjectRepository(BusinessEntity) private readonly businesses: Repository<BusinessEntity>,
    private readonly sellerParty: SellerPartyLookup,
  ) {}

  async resolveForUser(userId: string): Promise<FinancialParty | null> {
    const business = await this.businesses.findOne({
      where: { ownerId: userId, deletedAt: IsNull() },
      select: { id: true, ownerId: true },
    });
    if (business) return { partyType: 'business', partyId: business.id };

    const professional = await this.professionals.findOne({
      where: { ownerId: userId, deletedAt: IsNull() },
      select: { id: true, ownerId: true },
    });
    // A user with neither a business nor a professional profile is simply
    // not a party, and null (never a fabricated zero-balance party) is what
    // says so.
    if (!professional) return null;
    return this.sellerParty.forProfessional(professional.id);
  }
}

/**
 * Resolves "which selling parties does this session OWN?" for
 * commercial-policy's subscription foundation (ADR-042 §3, `V33-DEC-018`).
 *
 * ## Read this beside `ProviderBackedFinancialPartyResolver` above
 *
 * They look similar and they are deliberately different in two ways, both of
 * which are load-bearing. Merging them would be the natural refactor and would
 * be wrong.
 *
 * **It does not follow staff affiliation.** The financial resolver ends with
 * `sellerParty.forProfessional(...)`, which maps an affiliated professional to
 * their EMPLOYER — correct for earnings, and wrong for a subscription. Reading
 * affiliation here would mean a professional joining a salon silently re-points
 * "my subscription" at the salon, transferring a commercial commitment on the
 * strength of an employment change. `V33-DEC-018` forbids it, and
 * `V33-DEC-010` had already ruled the same way for credit returns.
 *
 * **It returns every owned party, not one.** `provider.professionals.owner_id`
 * and `business.businesses.owner_id` are independent unique indexes, so a user
 * may own both. The financial resolver picks business-first because earnings
 * need a single answer; subscriptions are per PARTY, so a user owning two
 * parties owns two unrelated subscriptions.
 *
 * ## Eligibility is `deleted_at IS NULL`, and nothing else
 *
 * `verification_status` is deliberately not consulted. An unverified
 * professional is a seller whose identity is unconfirmed, not a seller without
 * commercial terms, and conflating the two would deny the base workspace to
 * everyone awaiting review.
 *
 * Erasure sets `deleted_at` (provider anonymizes in place), so an erased seller
 * becomes ineligible through the same predicate — no separate erasure branch,
 * and none to forget.
 */
@Injectable()
export class OwnershipBackedSubscriberPartyResolver implements OwnedSubscriberPartyResolver {
  /**
   * Every query takes the CALLER's manager rather than an injected repository.
   *
   * A resolver that used its own repository would run on a different
   * connection, could not see the activating transaction's uncommitted rows,
   * and would not roll back with it (ADR-042 §9). The port's signature is what
   * makes that impossible rather than merely discouraged, and this
   * implementation honours it by holding no repository at all.
   */
  async ownedPartiesFor(manager: EntityManager, userId: string): Promise<OwnedSubscriberParty[]> {
    const parties: OwnedSubscriberParty[] = [];

    const professional = await manager.getRepository(ProfessionalEntity).findOne({
      where: { ownerId: userId, deletedAt: IsNull() },
      select: { id: true },
    });
    if (professional) parties.push({ partyType: 'professional', partyId: professional.id });

    const business = await manager.getRepository(BusinessEntity).findOne({
      where: { ownerId: userId, deletedAt: IsNull() },
      select: { id: true },
    });
    if (business) parties.push({ partyType: 'business', partyId: business.id });

    // Empty when they own neither -- never a fabricated party, and never one
    // they merely work for.
    return parties;
  }

  async isEligible(manager: EntityManager, party: OwnedSubscriberParty): Promise<boolean> {
    if (party.partyType === 'professional') {
      return (
        (await manager.getRepository(ProfessionalEntity).count({
          where: { id: party.partyId, deletedAt: IsNull() },
        })) === 1
      );
    }
    return (
      (await manager.getRepository(BusinessEntity).count({
        where: { id: party.partyId, deletedAt: IsNull() },
      })) === 1
    );
  }
}

/**
 * Resolves "which seller workspaces does this session OWN?" for
 * financial-service — V3.3 #72, `V33-DEC-020`.
 *
 * ## It delegates rather than reimplementing, deliberately
 *
 * `OwnershipBackedSubscriberPartyResolver` above already answers exactly this
 * question, correctly, for the subscription surface: `owner_id` only, soft-
 * deleted rows excluded, and `business_staff` never consulted. Writing a second
 * ownership predicate here would be a second answer to a question that must
 * have exactly one — and the two would drift the first time either changed.
 *
 * So this is an ADAPTER, not an implementation. It exists only because
 * `services/financial` may not import `services/commercial-policy`
 * (`@nx/enforce-module-boundaries` restricts `scope:financial` to
 * `scope:shared`), so finance declares its own token and the composition root
 * binds the one real resolver behind it. The same arrangement
 * `PROFESSIONAL_DIRECTORY` and `PROFESSIONAL_OWNER_LOOKUP` already use.
 *
 * ## Why it supplies the manager rather than taking one
 *
 * The subscription port takes the caller's `EntityManager` so an ownership read
 * inside an activation transaction sees that transaction's own uncommitted rows
 * (ADR-042 §9). Finance has no such transaction to join: its rows live on a
 * physically separate DataSource connected as the append-only writer role
 * (ADR-017), and `V33-DEC-020` forbids a cross-database transaction. Ownership
 * is therefore an independent read on the application DataSource, and this
 * adapter supplies that manager so finance never has to know which database
 * ownership lives in.
 *
 * ## What it must never become
 *
 * A place that consults `SellerPartyLookup`. That lookup answers "whose money
 * is this?", follows an active affiliation, and using it here would reinstate
 * the #72 disclosure exactly.
 */
@Injectable()
export class OwnershipBackedFinanceWorkspaceResolver implements FinanceWorkspaceOwnerResolver {
  constructor(
    private readonly owned: OwnershipBackedSubscriberPartyResolver,
    private readonly dataSource: DataSource,
  ) {}

  async ownedWorkspacesFor(userId: string): Promise<FinancialParty[]> {
    const parties = await this.owned.ownedPartiesFor(this.dataSource.manager, userId);
    // `OwnedSubscriberParty` and `FinancialParty` are the same two fields for
    // the same reason. Mapped explicitly rather than cast, so a future field on
    // either side is a compile error here instead of a silent pass-through.
    return parties.map((party) => ({ partyType: party.partyType, partyId: party.partyId }));
  }
}
