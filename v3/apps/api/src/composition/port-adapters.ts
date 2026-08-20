import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { ProfessionalEntity, ServiceOfferingEntity } from '@beauclick/provider';
import { ProfessionalDirectory } from '@beauclick/booking';
import { ServiceCatalog, ServiceOfferingSnapshot } from '@beauclick/commerce';
import { FinancialParty, FinancialPartyResolver } from '@beauclick/financial';

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

@Injectable()
export class ProviderBackedServiceCatalog implements ServiceCatalog {
  constructor(@InjectRepository(ServiceOfferingEntity) private readonly services: Repository<ServiceOfferingEntity>) {}

  async findServiceOffering(serviceId: string): Promise<ServiceOfferingSnapshot | null> {
    const offering = await this.services.findOne({ where: { id: serviceId, deletedAt: IsNull() } });
    if (!offering) return null;
    return {
      id: offering.id,
      professionalId: offering.professionalId,
      name: offering.name,
      priceToman: offering.priceToman,
      durationMinutes: offering.durationMinutes,
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
 */
@Injectable()
export class ProviderBackedFinancialPartyResolver implements FinancialPartyResolver {
  constructor(@InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>) {}

  async resolveForUser(userId: string): Promise<FinancialParty | null> {
    const professional = await this.professionals.findOne({
      where: { ownerId: userId, deletedAt: IsNull() },
      select: { id: true, ownerId: true },
    });
    // Business sellers are a later phase; a user with no professional profile
    // is simply not a party, and null (never a fabricated zero-balance party)
    // is what says so.
    return professional ? { partyType: 'professional', partyId: professional.id } : null;
  }
}
