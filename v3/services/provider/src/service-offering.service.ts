import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { ServiceOfferingEntity } from './entities/service-offering.entity';
import { ProviderEventsService } from './provider-events.service';

export interface CreateServiceOfferingInput {
  name: string;
  durationMinutes: number;
  priceToman: number;
}

/**
 * Catalog only -- no availability/slot logic (booking-service's domain).
 *
 * Phase 3 makes every write here an event producer: a service's name and
 * price are both searchable and facetable, so a catalogue edit that did not
 * reach the index would leave a customer searching for a service the provider
 * no longer offers, at a price they no longer charge.
 */
@Injectable()
export class ServiceOfferingService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ServiceOfferingEntity) private readonly repo: Repository<ServiceOfferingEntity>,
    private readonly events: ProviderEventsService,
  ) {}

  async listForProfessional(professionalId: string): Promise<ServiceOfferingEntity[]> {
    return this.repo.find({ where: { professionalId, deletedAt: IsNull() } });
  }

  async create(professionalId: string, input: CreateServiceOfferingInput): Promise<ServiceOfferingEntity> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const entity = manager
        .getRepository(ServiceOfferingEntity)
        .create({ id: uuidv7(), professionalId, deletedAt: null, ...input });
      const saved = await manager.getRepository(ServiceOfferingEntity).save(entity);
      await this.events.emitServiceUpdated(manager, saved);
      return saved;
    });
  }

  async update(
    serviceId: string,
    professionalId: string,
    input: Partial<CreateServiceOfferingInput>,
  ): Promise<ServiceOfferingEntity> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      // professionalId in the WHERE clause: another provider's service id
      // resolves the same way a nonexistent one does.
      const entity = await manager
        .getRepository(ServiceOfferingEntity)
        .findOneOrFail({ where: { id: serviceId, professionalId, deletedAt: IsNull() } });

      if (input.name !== undefined) entity.name = input.name;
      if (input.durationMinutes !== undefined) entity.durationMinutes = input.durationMinutes;
      if (input.priceToman !== undefined) entity.priceToman = input.priceToman;

      const saved = await manager.getRepository(ServiceOfferingEntity).save(entity);
      await this.events.emitServiceUpdated(manager, saved);
      return saved;
    });
  }

  /**
   * Soft delete.
   *
   * Soft rather than hard because a past order's line item references this
   * row, and because the search index needs to be TOLD the service is gone --
   * a hard delete would leave the index with no event to react to and the
   * service would keep appearing in results until the next full reindex.
   */
  async remove(serviceId: string, professionalId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const result = await manager
        .createQueryBuilder()
        .update(ServiceOfferingEntity)
        .set({ deletedAt: new Date() })
        .where('id = :serviceId AND professional_id = :professionalId AND deleted_at IS NULL', {
          serviceId,
          professionalId,
        })
        .execute();
      if (result.affected !== 1) return false;

      const entity = await manager.getRepository(ServiceOfferingEntity).findOneOrFail({ where: { id: serviceId } });
      await this.events.emitServiceUpdated(manager, entity);
      return true;
    });
  }
}
