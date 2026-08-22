import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent, AuditLogger } from '@beauclick/events';

import { BusinessEntity } from './entities/business.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';
import { CreateBusinessDto } from './dto/create-business.dto';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { BusinessAlreadyExistsException } from './business.errors';

/**
 * Profile CRUD, deliberately mirroring `ProviderService`'s professional-
 * creation shape: self-service, ownership-gated, no capability or role
 * check required to become a business owner (see ADR-023 §1 -- V3 never
 * grants the identity-level `business` role dynamically, exactly as it
 * never does for `professional`; "am I a seller" is answered entirely by
 * "do I own a row", not by a role array nobody ever populates).
 */
@Injectable()
export class BusinessService {
  private readonly auditLog = new AuditLogger('business');

  constructor(
    @InjectRepository(BusinessEntity) private readonly businesses: Repository<BusinessEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async create(ownerId: string, dto: CreateBusinessDto): Promise<BusinessEntity> {
    const existing = await this.businesses.findOne({ where: { ownerId, deletedAt: IsNull() } });
    if (existing) throw new BusinessAlreadyExistsException();

    return this.dataSource.transaction(async (manager) => {
      const id = uuidv7();
      await manager.insert(BusinessEntity, {
        id,
        ownerId,
        displayName: dto.displayName,
        bio: dto.bio ?? null,
        cityId: dto.cityId ?? null,
        verificationStatus: 'unverified',
        revision: 1,
        deletedAt: null,
      });

      await emitEvent(manager, BusinessOutboxEntity, {
        aggregateType: 'business',
        aggregateId: id,
        eventType: 'BusinessCreated',
        payload: { businessId: id, ownerId, displayName: dto.displayName },
      });

      this.auditLog.log({ action: 'business.created', businessId: id, ownerId });
      return manager.findOneOrFail(BusinessEntity, { where: { id } });
    });
  }

  async update(businessId: string, dto: UpdateBusinessDto): Promise<BusinessEntity> {
    return this.dataSource.transaction(async (manager) => {
      const business = await manager.findOneOrFail(BusinessEntity, { where: { id: businessId } });
      await manager
        .createQueryBuilder()
        .update(BusinessEntity)
        .set({
          displayName: dto.displayName ?? business.displayName,
          bio: dto.bio !== undefined ? dto.bio : business.bio,
          cityId: dto.cityId !== undefined ? dto.cityId : business.cityId,
          revision: () => 'revision + 1',
        })
        .where('id = :id', { id: businessId })
        .execute();

      await emitEvent(manager, BusinessOutboxEntity, {
        aggregateType: 'business',
        aggregateId: businessId,
        eventType: 'BusinessUpdated',
        payload: { businessId },
      });

      return manager.findOneOrFail(BusinessEntity, { where: { id: businessId } });
    });
  }

  async findById(businessId: string): Promise<BusinessEntity | null> {
    return this.businesses.findOne({ where: { id: businessId, deletedAt: IsNull() } });
  }

  async findByOwner(ownerId: string): Promise<BusinessEntity | null> {
    return this.businesses.findOne({ where: { ownerId, deletedAt: IsNull() } });
  }
}
