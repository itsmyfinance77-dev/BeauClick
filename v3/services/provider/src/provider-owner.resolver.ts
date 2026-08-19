import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OwnerResolver } from '@beauclick/ownership';
import { ProfessionalEntity } from './entities/professional.entity';

/**
 * The concrete, real implementation of the GAP-08 fix for provider-service:
 * given the route's :id param, resolves the REAL owning user id by reading
 * the professional row itself -- OwnershipGuard then compares this against
 * the session's own userId. A forged/nonexistent :id resolves to null,
 * which the guard turns into the same generic NOT_FOUND_OR_NOT_YOURS a real
 * "not yours" case gets (V3_SECURITY_MODEL.md §3).
 */
@Injectable()
export class ProviderOwnerResolver implements OwnerResolver<{ id: string }> {
  constructor(@InjectRepository(ProfessionalEntity) private readonly repo: Repository<ProfessionalEntity>) {}

  async resolve(_sessionUserId: string, params: { id: string }): Promise<string | null> {
    const professional = await this.repo.findOne({ where: { id: params.id } });
    return professional?.ownerId ?? null;
  }
}
