import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProfessionalEntity } from './entities/professional.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CityEntity } from './entities/city.entity';
import { ServiceOfferingEntity } from './entities/service-offering.entity';
import { ProviderOutboxEntity } from './entities/provider-outbox.entity';

import { ProviderService } from './provider.service';
import { ServiceOfferingService } from './service-offering.service';
import { ProviderOwnerResolver } from './provider-owner.resolver';
import { ProviderController } from './provider.controller';
import { ProviderEventsService } from './provider-events.service';

export const PROVIDER_ENTITIES = [ProfessionalEntity, SpecialtyEntity, CityEntity, ServiceOfferingEntity, ProviderOutboxEntity];

@Module({
  imports: [TypeOrmModule.forFeature(PROVIDER_ENTITIES)],
  controllers: [ProviderController],
  providers: [ProviderService, ServiceOfferingService, ProviderOwnerResolver, ProviderEventsService],
  exports: [ProviderService, ServiceOfferingService, ProviderEventsService, TypeOrmModule],
})
export class ProviderModule {}
