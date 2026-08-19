import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProfessionalEntity } from './entities/professional.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CityEntity } from './entities/city.entity';
import { ServiceOfferingEntity } from './entities/service-offering.entity';

import { ProviderService } from './provider.service';
import { ServiceOfferingService } from './service-offering.service';
import { ProviderOwnerResolver } from './provider-owner.resolver';
import { ProviderController } from './provider.controller';

export const PROVIDER_ENTITIES = [ProfessionalEntity, SpecialtyEntity, CityEntity, ServiceOfferingEntity];

@Module({
  imports: [TypeOrmModule.forFeature(PROVIDER_ENTITIES)],
  controllers: [ProviderController],
  providers: [ProviderService, ServiceOfferingService, ProviderOwnerResolver],
  exports: [ProviderService, TypeOrmModule],
})
export class ProviderModule {}
