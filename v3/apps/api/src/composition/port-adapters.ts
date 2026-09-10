import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { CityEntity, ProfessionalEntity, SellerOwnerRoleGrantPort, ServiceOfferingEntity } from '@beauclick/provider';
import { ProfessionalDirectory } from '@beauclick/booking';
import {
  BookingCollectionPolicyResolver,
  OrderSellerParty,
  ResolvedBookingCollectionPolicy,
  ServiceCatalog,
  ServiceOfferingSnapshot,
} from '@beauclick/commerce';
import { FinanceWorkspaceOwnerResolver, FinancialParty, FinancialPartyResolver } from '@beauclick/financial';
import {
  CollectionPolicyResolutionService,
  OwnedSubscriberParty,
  OwnedSubscriberPartyResolver,
} from '@beauclick/commercial-policy';
import {
  AssignableCity,
  BusinessEntity,
  BusinessOwnerRoleGrantPort,
  BusinessStaffEntity,
  InvitableIdentity,
  LocationCityCataloguePort,
  ServiceOwnershipDirectoryPort,
  StaffInviteIdentityResolverPort,
} from '@beauclick/business';
import { RoleService, UserEntity, canonicalizePhone } from '@beauclick/identity';
import { DeliveryLocationDirectory, EligibleResourceDirectory } from '@beauclick/booking';

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
  /**
   * V3.3 #115 (`#41d-2b`), ADR-048 R3: the caller's `EntityManager` is
   * MANDATORY and there is no injected-repository fallback.
   *
   * The repository is gone from this class entirely rather than kept as a
   * default, because a default is exactly how an out-of-transaction read
   * survives a refactor: every call site that forgot to pass a manager would
   * keep compiling and keep reading on another connection, and nothing would
   * report it. Removing the field makes that unrepresentable.
   */
  async forProfessional(manager: EntityManager, professionalId: string): Promise<FinancialParty> {
    const membership = await manager.findOne(BusinessStaffEntity, {
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
  constructor(private readonly sellerParty: SellerPartyLookup) {}

  /**
   * V3.3 #115 (`#41d-2b`), ADR-048 R3.
   *
   * Both reads -- the offering and the affiliation behind the seller party --
   * now go through the CALLER's manager, so neither happens on this adapter's
   * own connection outside the order's transaction. The injected
   * `ServiceOfferingEntity` repository was removed rather than left unused, so
   * there is no connection here to accidentally read from again.
   */
  async findServiceOffering(manager: EntityManager, serviceId: string): Promise<ServiceOfferingSnapshot | null> {
    const offering = await manager.findOne(ServiceOfferingEntity, { where: { id: serviceId, deletedAt: IsNull() } });
    if (!offering) return null;
    const seller = await this.sellerParty.forProfessional(manager, offering.professionalId);
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
 * Commerce's collection-policy resolver, answered by commercial-policy —
 * V3.3 #115 (`#41d-2b`), ADR-048 R4.
 *
 * ## The whole adapter is a delegation, and that is the design
 *
 * `scope:commerce` may depend only on `scope:shared`, so Commerce declares the
 * question and cannot name who answers it. This class is the ONE place the two
 * domains meet, exactly as `ProviderBackedServiceCatalog` above is for the
 * catalogue -- `apps/api` is the only tier permitted to compose domains
 * (ADR-011).
 *
 * It binds to `CollectionPolicyResolutionService`, which is read-only and has
 * no actor, reason or audit contract. It deliberately does NOT bind to
 * `BookingCollectionPolicyService` (the privileged administrator writer) or to
 * `CollectionPolicyAssignmentService` (the seller's writer): either would put a
 * mutation surface one autocomplete away from the code path that runs for every
 * booking on the platform.
 *
 * The port's own `null` case is translated here into the closed union Commerce
 * declared, so "unenrolled" is a value the caller must handle rather than a
 * null it might forget to.
 */
@Injectable()
export class CommercialPolicyBackedCollectionResolver implements BookingCollectionPolicyResolver {
  constructor(private readonly resolution: CollectionPolicyResolutionService) {}

  async resolveForSellerParty(
    manager: EntityManager,
    sellerParty: OrderSellerParty,
  ): Promise<ResolvedBookingCollectionPolicy> {
    const snapshot = await this.resolution.resolveForParty(manager, sellerParty.partyType, sellerParty.partyId);
    return snapshot === null ? { outcome: 'legacy_unenrolled' } : { outcome: 'enrolled', snapshot };
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
    /*
     * V3.3 #115 made the manager mandatory on `forProfessional`. This resolver
     * is NOT on the transactional order path -- it answers "whose earnings are
     * these?" for a finance read -- so it passes its own repository's manager,
     * which is the exact connection it already used. Behaviour is unchanged;
     * only the parameter is now explicit rather than implicit.
     */
    return this.sellerParty.forProfessional(this.professionals.manager, professional.id);
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

/**
 * Grants the seller OWNER role atomically with the ownership row — V3.3 #75,
 * `V33-DEC-021`.
 *
 * ## One adapter, two domain tokens
 *
 * `provider` declares `SELLER_OWNER_ROLE_GRANT` and `business` declares
 * `BUSINESS_OWNER_ROLE_GRANT`, because neither may import the other and neither
 * may import `identity` (ADR-011). Both are bound to THIS instance in
 * `DomainPortsModule` — the arrangement `PROFESSIONAL_DIRECTORY` and
 * `PROFESSIONAL_OWNER_LOOKUP` already use, and for the same reason: two tokens
 * are a boundary artefact, while two implementations of "grant the owner role"
 * would be two answers to a question that must have exactly one.
 *
 * ## It delegates rather than reimplementing
 *
 * `RoleService.assignOwnerRole` owns the whole rule: slug lookup from the data,
 * additive insert with `ON CONFLICT DO NOTHING`, denormalized-column sync, and
 * the system-actor audit row — all on the caller's manager. This class adds
 * nothing except the fixed role slug, which is exactly what a composition-root
 * adapter should be.
 *
 * ## Why the slug is hard-coded here and not passed through
 *
 * The two port methods take no role argument, so the choice has to be made
 * somewhere; making it here means `provider` and `business` are structurally
 * incapable of asking for a role they should not have. There is no request
 * field, DTO property or port parameter anywhere in the chain that could carry
 * `administrator`, so escalation through the ownership path is unrepresentable
 * rather than merely checked (`V33-DEC-021` Rulings 2, 3 and 5).
 */
@Injectable()
export class IdentityBackedOwnerRoleGrant implements SellerOwnerRoleGrantPort, BusinessOwnerRoleGrantPort {
  constructor(private readonly roles: RoleService) {}

  /**
   * Takes the CALLER's manager and passes it straight through.
   *
   * The adapter holds no repository and no DataSource of its own, which is what
   * makes "runs on a different connection" impossible rather than discouraged —
   * the same property `OwnershipBackedSubscriberPartyResolver` above relies on
   * (ADR-042 §9).
   */
  async grantProfessionalOwnerRole(manager: EntityManager, ownerUserId: string): Promise<boolean> {
    return this.roles.assignOwnerRole(manager, ownerUserId, 'professional');
  }

  async grantBusinessOwnerRole(manager: EntityManager, ownerUserId: string): Promise<boolean> {
    return this.roles.assignOwnerRole(manager, ownerUserId, 'business');
  }
}

/**
 * Answers `business`'s city-catalogue port from `provider.locations_cities` —
 * V3.3 Story #108 (`#44b`), ADR-049 section 3.2.
 *
 * ## This is the one place the two schemas meet for cities
 *
 * `scope:business` may depend only on `scope:shared`, so `business` declares
 * `LOCATION_CITY_CATALOGUE` and cannot name who answers it. `apps/api` is the
 * only tier permitted to compose domains (ADR-011), and this adapter is where
 * `provider`'s `CityEntity` is read — `business` imports no `provider` ORM entity
 * and issues no `provider.*` query, which a boundary spec asserts.
 *
 * ## Every read is on the CALLER's manager
 *
 * The adapter holds no repository and no DataSource of its own. The city check
 * therefore runs inside the location-write transaction (ADR-049 section 8.2): a
 * city that vanishes mid-request cannot be accepted, and a rolled-back write
 * rolls back a check that had "passed". The same construction `SellerPartyLookup`
 * uses.
 *
 * ## Availability is `is_launched`, and nothing else
 *
 * `lookupAssignableCity` filters on `is_launched = true` — the exact predicate
 * `GET /v1/cities` (`ProviderService.listCities`) already applies. #108 invents
 * no city policy. `describeCities` ignores `is_launched`: a city that becomes
 * unavailable after a location was created still renders its name.
 */
@Injectable()
export class ProviderBackedLocationCityCatalogue implements LocationCityCataloguePort {
  async lookupAssignableCity(manager: EntityManager, cityId: string): Promise<AssignableCity | null> {
    const row = await manager.getRepository(CityEntity).findOne({
      where: { id: cityId, isLaunched: true },
      select: { id: true, name: true },
    });
    return row ? { id: row.id, name: row.name } : null;
  }

  async describeCities(
    manager: EntityManager,
    cityIds: readonly string[],
  ): Promise<ReadonlyMap<string, AssignableCity>> {
    if (cityIds.length === 0) return new Map();
    const rows = await manager.getRepository(CityEntity).find({
      where: { id: In([...new Set(cityIds)]) },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name }]));
  }
}

/**
 * Resolves a staff-invitation phone number to an eligible account — V3.3 Story
 * #109 (`#44c`), `V33-DEC-030` D5 and ADR-049 section 4.5.
 *
 * ## This is the only place the two schemas meet for an invitation
 *
 * `scope:business` may depend only on `scope:shared`, so `business` declares
 * `STAFF_INVITE_IDENTITY_RESOLVER` and cannot name who answers it. `apps/api` is
 * the only tier permitted to compose domains (ADR-011), and this adapter is where
 * `identity.users` and `provider.professionals` are read — the same construction
 * `IdentityBackedRecipientResolver` already uses.
 *
 * ## Canonicalisation is not re-implemented
 *
 * `canonicalizePhone` is identity's own rule — local `09…`, `+98…`, `0098…`,
 * `98…`, Persian and Arabic-Indic digits, all folded to one `+98XXXXXXXXX` form
 * before any comparison (`V3_SECURITY_MODEL.md` section 1). Restating that
 * grammar in `business` would be a second implementation of one rule, and two
 * implementations of one rule are one waiting to disagree.
 *
 * ## Every negative cause returns the SAME null
 *
 * A phone that does not canonicalise, one with no account, and an account that is
 * soft-deleted or erased are indistinguishable to the caller — `business` receives
 * `null` and could not leak the difference if it tried. An erased subject is
 * doubly covered: `identity` tombstones the phone to `del:…`, which no real
 * number canonicalises to, *and* sets `deleted_at`.
 *
 * ## The professional link is resolved here, never asserted by the inviter
 *
 * `V33-DEC-033` R2/R4. It becomes the membership's `professional_id`, which is
 * what a later `practitioner_chat` grant is checked against. An account with no
 * professional profile yields `null`, and a membership with a null link can
 * satisfy no such check — fail-closed by construction.
 *
 * ## It writes nothing
 *
 * This is a read. No pending-invite row, no raw phone, no phone hash, no
 * encrypted phone, no lookup token, no outbox event and no notification —
 * durable or transient — for any phone, and least of all one with no account
 * (ADR-049 section 4.6 as extended by `V33-DEC-033` R3).
 */
@Injectable()
export class IdentityBackedStaffInviteResolver implements StaffInviteIdentityResolverPort {
  async resolveInvitableIdentity(manager: EntityManager, rawPhone: string): Promise<InvitableIdentity | null> {
    const canonical = canonicalizePhone(rawPhone);
    if (!canonical) return null;

    const user = await manager.getRepository(UserEntity).findOne({
      where: { phone: canonical, deletedAt: IsNull() },
      select: { id: true },
    });
    if (!user) return null;

    const professional = await manager.getRepository(ProfessionalEntity).findOne({
      where: { ownerId: user.id, deletedAt: IsNull() },
      select: { id: true },
    });

    return { userId: user.id, professionalId: professional?.id ?? null };
  }
}

/**
 * The authoritative delivery location for a professional's new slots — V3.3
 * Story #127 (`#127a`), `V33-DEC-035` R3.
 *
 * ## This is the only place `booking` and `business` meet for a slot
 *
 * `scope:booking` may depend only on `scope:shared`, so `booking` declares
 * `DELIVERY_LOCATION_DIRECTORY` and cannot name who answers it. `apps/api` is the
 * only tier permitted to compose domains (ADR-011), and this adapter is where the
 * `business` schema is read — the same construction `SellerPartyLookup` and
 * `IdentityBackedStaffInviteResolver` already use.
 *
 * ## One statement, four conditions, no ordering
 *
 * The join asserts every condition the binding must satisfy at once, so a caller
 * cannot satisfy three and forget the fourth:
 *
 *  1. an **`active`** membership — an `invited`, `inactive`, `declined` or
 *     `removed` one delivers nothing;
 *  2. naming **this** professional;
 *  3. carrying a **non-null** branch;
 *  4. whose branch is still **`active`** and still belongs to the **same
 *     business** as the membership, on a **live** business.
 *
 * There is no `ORDER BY` and no `LIMIT`, and that is deliberate rather than an
 * omission: `uq_business_staff_active_professional` already admits at most one
 * active membership per professional, and a membership carries at most one
 * branch, so the result is unambiguous by construction. A `LIMIT 1` here would be
 * exactly the first-row rule `V33-DEC-035` R4 forbids — it would silently pick
 * one answer on the day the model gained a second, instead of failing loudly.
 *
 * **Business ownership is not a binding.** A user who owns a business and also
 * owns a professional profile gets `null` unless an active membership says
 * otherwise, because guessing a branch from ownership is the same defect wearing
 * a different hat — and a business may have many branches.
 *
 * ## It runs on the caller's manager
 *
 * The answer is snapshotted onto the row being inserted in the same transaction,
 * so the read joins that transaction. That is what linearises it against a
 * concurrent owner rebinding, which holds `FOR UPDATE` on the membership row.
 */
@Injectable()
export class BusinessBackedDeliveryLocationDirectory implements DeliveryLocationDirectory {
  async deliveryLocationFor(manager: EntityManager, professionalId: string): Promise<string | null> {
    const rows: Array<{ location_id: string }> = await manager.query(
      `SELECT s.location_id
         FROM business.business_staff s
         JOIN business.businesses b ON b.id = s.business_id
         JOIN business.locations l ON l.id = s.location_id AND l.business_id = s.business_id
        WHERE s.professional_id = $1
          AND s.status = 'active'
          AND s.location_id IS NOT NULL
          AND b.deleted_at IS NULL
          AND l.lifecycle = 'active'`,
      [professionalId],
    );

    // Zero rows is the ordinary answer for almost everyone. More than one is
    // unrepresentable today; if the model ever changes underneath this, refusing
    // to guess is safer than picking one.
    return rows.length === 1 ? rows[0].location_id : null;
  }
}

/**
 * Proves a `provider.services` id belongs to a business -- V3.3 Story #131
 * (`#127b`), `V33-DEC-035` R5.
 *
 * ## This is the only place `business` and `provider` meet for a requirement
 *
 * `scope:business` may depend only on `scope:shared`, so `business` declares
 * `SERVICE_OWNERSHIP_DIRECTORY` and cannot name who answers it. `apps/api` is
 * the only tier permitted to compose domains (ADR-011), and this adapter is
 * where `provider.services`, `provider.professionals` and
 * `business.business_staff` are read together -- the same construction
 * `BusinessBackedDeliveryLocationDirectory` above already uses in the
 * opposite direction.
 *
 * ## One statement, three conditions, no ordering
 *
 * The join asserts every condition at once: the service is **live**
 * (`deleted_at IS NULL`); its owning professional is **live**; and that
 * professional holds an **active** `business.business_staff` membership of
 * THIS business. A service belonging to a professional with no membership, an
 * `invited`/`inactive`/`declined`/`removed` one, or a membership of a
 * DIFFERENT business, all answer `false` identically -- there is no
 * distinguishing cause for `business` to leak.
 *
 * `uq_business_staff_active_professional` already admits at most one active
 * membership per professional, so there is no first-row ambiguity here to
 * refuse: the answer is unambiguous by construction, exactly as
 * `deliveryLocationFor` above documents for the same invariant.
 *
 * ## It runs on the caller's manager
 *
 * The check and the requirement write are one transaction (ADR-049 §8.2): a
 * service reassigned to another business mid-request cannot be accepted, and a
 * rolled-back requirement write rolls back a check that already "passed".
 */
@Injectable()
export class ProviderBackedServiceOwnershipDirectory implements ServiceOwnershipDirectoryPort {
  async verifyServiceBelongsToBusiness(manager: EntityManager, businessId: string, serviceId: string): Promise<boolean> {
    const rows: unknown[] = await manager.query(
      `SELECT 1
         FROM provider.services s
         JOIN provider.professionals p ON p.id = s.professional_id
         JOIN business.business_staff m ON m.professional_id = p.id
        WHERE s.id = $1
          AND s.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND m.business_id = $2
          AND m.status = 'active'`,
      [serviceId, businessId],
    );
    return rows.length > 0;
  }
}

/**
 * Resolves the eligible resource candidates for a service at a delivery
 * location -- V3.3 Story #131 (`#127b`), `V33-DEC-035` R5/R7.
 *
 * ## This is the only place `booking` and `business` meet for eligibility
 *
 * `scope:booking` may depend only on `scope:shared`, so `booking` declares
 * `ELIGIBLE_RESOURCE_DIRECTORY` and cannot name who answers it. `apps/api` is
 * the only tier permitted to compose domains, and this adapter reads
 * `business.service_resource_requirements` and `business.location_resources`
 * together -- the same construction every other cross-domain adapter in this
 * file uses.
 *
 * ## The null cases short-circuit before any query runs
 *
 * A `null` `serviceId` (the slot/booking accepts any service) and a `null`
 * `deliveryLocationId` (no branch context) both mean "nothing to resolve" --
 * `V33-DEC-035`'s nullable-service semantics, restated at the one place that
 * would otherwise have to dereference a missing key. Neither reaches the
 * database: the empty result is returned directly, so a booking with no
 * concrete service or no branch behaves byte-identically to the pre-#131
 * path with zero added queries.
 *
 * ## One statement for the candidate set, never a winner
 *
 * When a requirement row exists, one query returns every ACTIVE resource at
 * the location whose kind matches -- set-based, no N+1, no `LIMIT`. When no
 * requirement row exists, the LEFT JOIN makes that fact visible without a
 * second round trip, and the method returns `[]` rather than treating "no
 * requirement" as an error (`V33-DEC-035` R6/R7). Picking one candidate is
 * `#128`'s job under its own locking discipline; this adapter never orders
 * toward a single answer.
 */
@Injectable()
export class BusinessBackedEligibleResourceDirectory implements EligibleResourceDirectory {
  async eligibleResourcesFor(
    manager: EntityManager,
    serviceId: string | null,
    deliveryLocationId: string | null,
  ): Promise<readonly string[]> {
    if (serviceId === null || deliveryLocationId === null) return [];

    // The join is on BOTH `service_id` AND `r.business_id` -- not `service_id`
    // alone. `service_resource_requirements` is uniquely keyed on
    // `(business_id, service_id)`, not `service_id` alone, precisely because a
    // professional who has moved businesses can leave a STALE requirement row
    // behind under their old business (`V33-DEC-035`'s "stale rows are
    // harmless" reasoning: they are harmless only because nothing ever reads
    // them without also matching the CURRENT business). Matching on
    // `r.business_id` -- the resource's own business, which is authoritative
    // because it is derived from `deliveryLocationId`, itself the slot's
    // frozen snapshot -- is what keeps an old employer's requirement from ever
    // leaking into a candidate set resolved for the new one.
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT r.id
         FROM business.location_resources r
         JOIN business.service_resource_requirements q
           ON q.business_id = r.business_id
          AND q.service_id = $1
          AND q.required_kind = r.kind
        WHERE r.location_id = $2
          AND r.lifecycle = 'active'
        ORDER BY r.id`,
      [serviceId, deliveryLocationId],
    );
    return rows.map((row) => row.id);
  }
}
