import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProfessionalEntity } from './entities/professional.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CityEntity } from './entities/city.entity';
import { ServiceOfferingEntity } from './entities/service-offering.entity';
import { ProviderOutboxEntity } from './entities/provider-outbox.entity';
import { VerificationRequestEntity } from './entities/verification-request.entity';

import { ProviderService } from './provider.service';
import { ServiceOfferingService } from './service-offering.service';
import { ProviderOwnerResolver } from './provider-owner.resolver';
import { MyProviderController, ProviderController, ReferenceDataController } from './provider.controller';
import { ProviderEventsService } from './provider-events.service';
import { VerificationService } from './verification/verification.service';
import { AdminVerificationController, VerificationController } from './verification/verification.controller';

export const PROVIDER_ENTITIES = [
  ProfessionalEntity,
  SpecialtyEntity,
  CityEntity,
  ServiceOfferingEntity,
  ProviderOutboxEntity,
  VerificationRequestEntity,
];

@Module({
  imports: [TypeOrmModule.forFeature(PROVIDER_ENTITIES)],
  controllers: [
    ReferenceDataController,
    MyProviderController,
    ProviderController,
    VerificationController,
    AdminVerificationController,
  ],
  providers: [ProviderService, ServiceOfferingService, ProviderOwnerResolver, ProviderEventsService, VerificationService],
  exports: [ProviderService, ServiceOfferingService, ProviderEventsService, VerificationService, TypeOrmModule],
})
export class ProviderModule {}
