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
import { ReviewEntity } from './entities/review.entity';
import { ReviewEligibilityEntity } from './entities/review-eligibility.entity';

import { ProviderService } from './provider.service';
import { ServiceOfferingService } from './service-offering.service';
import { ProviderOwnerResolver } from './provider-owner.resolver';
import { MyProviderController, ProviderController, ReferenceDataController } from './provider.controller';
import { ProviderEventsService } from './provider-events.service';
import { PortfolioService } from './portfolio.service';
import { ReviewService } from './review.service';
import {
  AdminReviewController,
  BookingReviewController,
  MyReviewsController,
  ProviderReviewController,
} from './review.controller';
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
  ReviewEntity,
  ReviewEligibilityEntity,
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
    BookingReviewController,
    MyReviewsController,
    ProviderReviewController,
    AdminReviewController,
  ],
  providers: [
    ProviderService,
    ServiceOfferingService,
    ProviderOwnerResolver,
    ProviderEventsService,
    VerificationService,
    PortfolioService,
    ReviewService,
  ],
  exports: [
    ProviderService,
    ServiceOfferingService,
    ProviderEventsService,
    VerificationService,
    PortfolioService,
    ReviewService,
    TypeOrmModule,
  ],
})
export class ProviderModule {}
