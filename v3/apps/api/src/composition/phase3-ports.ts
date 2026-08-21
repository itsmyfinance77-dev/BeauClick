import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ProfessionalEntity, ServiceOfferingEntity } from '@beauclick/provider';
import { UserEntity } from '@beauclick/identity';
import { ProviderReindexSourcePort } from '@beauclick/search';
import { RecipientResolverPort } from '@beauclick/notification';
import { AnalyticsSubjectResolverPort } from '@beauclick/analytics';

/**
 * The Phase 3 outbound ports, implemented where cross-domain reads are
 * allowed.
 *
 * Same pattern as Phase 2's `port-adapters.ts`: each domain declares the
 * QUESTION it needs answered, and only `apps/api` knows who answers it. The
 * lint rule enforcing that is now extended to all eleven domains.
 */

/**
 * Rebuilds search-service's PostgreSQL projection from provider-service.
 *
 * The second level of search's recovery story, and also the migration path
 * for every professional who existed before search-service did -- without it,
 * the index would only ever contain providers who happened to be edited after
 * this phase shipped.
 *
 * Keyset pagination (`id > :after`) rather than OFFSET: a rebuild over a
 * growing table with OFFSET re-scans everything it has already skipped, and
 * worse, silently skips rows if anything is inserted mid-rebuild.
 */
@Injectable()
export class ProviderBackedReindexSource implements ProviderReindexSourcePort {
  constructor(
    @InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>,
    @InjectRepository(ServiceOfferingEntity) private readonly services: Repository<ServiceOfferingEntity>,
  ) {}

  async fetchProfessionalsForReindex(afterId: string | null, limit: number) {
    const qb = this.professionals
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.specialties', 'specialty')
      .leftJoinAndSelect('p.city', 'city')
      .orderBy('p.id', 'ASC')
      .take(limit);

    if (afterId) qb.where('p.id > :afterId', { afterId });

    const rows = await qb.getMany();
    if (rows.length === 0) return [];

    // One query for every professional's services rather than one per
    // professional. A per-row lookup here would be an N+1 executed across the
    // entire provider table on every rebuild -- exactly the shape GAP-16
    // flagged in V2's ranking recompute.
    const offerings = await this.services.find({
      where: { professionalId: In(rows.map((r) => r.id)), deletedAt: IsNull() },
    });
    const byProfessional = new Map<string, ServiceOfferingEntity[]>();
    for (const offering of offerings) {
      const list = byProfessional.get(offering.professionalId) ?? [];
      list.push(offering);
      byProfessional.set(offering.professionalId, list);
    }

    return rows.map((p) => ({
      professionalId: p.id,
      revision: p.revision,
      displayName: p.displayName,
      bio: p.bio,
      cityId: p.cityId,
      cityName: p.city?.name ?? null,
      specialtyIds: (p.specialties ?? []).map((s) => s.id),
      specialtyNames: (p.specialties ?? []).map((s) => s.name),
      verificationStatus: p.verificationStatus,
      isDeleted: p.deletedAt !== null,
      updatedAt: p.updatedAt,
      services: (byProfessional.get(p.id) ?? []).map((s) => ({
        serviceId: s.id,
        name: s.name,
        priceToman: s.priceToman,
        durationMinutes: s.durationMinutes,
      })),
    }));
  }
}

/**
 * Resolves a user id to their contact details, at dispatch time only.
 *
 * The important property is what this ENABLES rather than what it does:
 * because notification-service can call this whenever it needs a recipient,
 * it never has to STORE one. V2 persisted `recipient` on every notification
 * row and consequently had to scrub the column on account deletion -- a whole
 * class of privacy work that not storing it removes entirely.
 *
 * V3 identity has no email column (phone is the root of trust), so `email` is
 * honestly null rather than fabricated. The email channel therefore fails
 * permanently with `no_email_on_file`, which is the truth.
 */
@Injectable()
export class IdentityBackedRecipientResolver implements RecipientResolverPort {
  constructor(@InjectRepository(UserEntity) private readonly users: Repository<UserEntity>) {}

  async resolve(userId: string): Promise<{ phone: string | null; email: string | null }> {
    const user = await this.users.findOne({ where: { id: userId }, select: { id: true, phone: true } });
    return { phone: user?.phone ?? null, email: null };
  }
}

/**
 * Resolves the session user to the professional whose analytics they may see.
 *
 * The whole of professional-analytics isolation rests on this being the ONLY
 * way a subject is chosen. There is no route parameter, no body field, and no
 * method anywhere that takes a professional id from a request -- so
 * Professional A cannot express a request for Professional B's numbers.
 */
@Injectable()
export class ProviderBackedAnalyticsSubjectResolver implements AnalyticsSubjectResolverPort {
  constructor(@InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>) {}

  async professionalIdForUser(userId: string): Promise<string | null> {
    const professional = await this.professionals.findOne({
      where: { ownerId: userId, deletedAt: IsNull() },
      select: { id: true, ownerId: true },
    });
    return professional?.id ?? null;
  }
}
