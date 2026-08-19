import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { ServiceOfferingEntity } from './entities/service-offering.entity';

export interface CreateServiceOfferingInput {
  name: string;
  durationMinutes: number;
  priceToman: number;
}

/** Catalog only -- no availability/slot logic (booking-service's domain, Phase 2). */
@Injectable()
export class ServiceOfferingService {
  constructor(@InjectRepository(ServiceOfferingEntity) private readonly repo: Repository<ServiceOfferingEntity>) {}

  async listForProfessional(professionalId: string): Promise<ServiceOfferingEntity[]> {
    return this.repo.find({ where: { professionalId, deletedAt: IsNull() } });
  }

  async create(professionalId: string, input: CreateServiceOfferingInput): Promise<ServiceOfferingEntity> {
    const entity = this.repo.create({ id: uuidv7(), professionalId, deletedAt: null, ...input });
    return this.repo.save(entity);
  }
}
