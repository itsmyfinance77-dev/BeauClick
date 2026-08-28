import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaModule } from '@beauclick/media';

import { ProfessionalEntity } from './entities/professional.entity';
import { SpecialtyEntity } from './entities/specialty.entity';
import { CityEntity } from './entities/city.entity';
import { ServiceOfferingEntity } from './entities/service-offering.entity';
import { ProviderOutboxEntity } from './entities/provider-outbox.entity';
import { VerificationRequestEntity } from './entities/verification-request.entity';
import { PortfolioItemEntity } from './entities/portfolio-item.entity';
import { VerificationEvidenceEntity } from './entities/verification-evidence.entity';

import { ProviderService } from './provider.service';
import { ServiceOfferingService } from './service-offering.service';
import { ProviderOwnerResolver } from './provider-owner.resolver';
import { MyProviderController, ProviderController, ReferenceDataController } from './provider.controller';
import { ProviderEventsService } from './provider-events.service';
import { PortfolioService } from './portfolio.service';
import { VerificationService } from './verification/verification.service';
import { AdminVerificationController, VerificationController } from './verification/verification.controller';

export const PROVIDER_ENTITIES = [
  ProfessionalEntity,
  SpecialtyEntity,
  CityEntity,
  ServiceOfferingEntity,
  ProviderOutboxEntity,
  VerificationRequestEntity,
  PortfolioItemEntity,
  VerificationEvidenceEntity,
];

@Module({
  // MediaModule for portfolio/avatar/evidence attachment; ConfigModule so the
  // verification controller can read PUBLIC_API_BASE_URL when minting a
  // protected-download URL.
  imports: [ConfigModule, TypeOrmModule.forFeature(PROVIDER_ENTITIES), MediaModule],
  controllers: [
    ReferenceDataController,
    MyProviderController,
    ProviderController,
    VerificationController,
    AdminVerificationController,
  ],
  providers: [
    ProviderService,
    ServiceOfferingService,
    ProviderOwnerResolver,
    ProviderEventsService,
    VerificationService,
    PortfolioService,
  ],
  exports: [
    ProviderService,
    ServiceOfferingService,
    ProviderEventsService,
    VerificationService,
    PortfolioService,
    TypeOrmModule,
  ],
})
export class ProviderModule {}
