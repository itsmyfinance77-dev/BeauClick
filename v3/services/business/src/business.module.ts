import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';
import { BusinessVerticalEntity } from './entities/business-vertical.entity';
import { BusinessTraitEntity } from './entities/business-trait.entity';

import { BusinessService } from './business.service';
import { BusinessClassificationService } from './business-classification.service';
import { StaffService } from './staff.service';
import { BusinessController } from './business.controller';
import {
  BusinessManagerResolver,
  BusinessMembershipResolver,
  BusinessOwnerResolver,
  BusinessStaffSelfResolver,
} from './business-membership.resolver';
import { BusinessSubjectDataContract } from './business-subject-data.contract';

export const BUSINESS_ENTITIES = [
  BusinessEntity,
  BusinessStaffEntity,
  BusinessOutboxEntity,
  // V3.3 Story #107 (`#44a`). Registered here and nowhere else: the composition
  // root spreads this list onto the main DataSource, so a new business table
  // cannot be reachable at runtime while being invisible to the ORM.
  BusinessVerticalEntity,
  BusinessTraitEntity,
];

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(BUSINESS_ENTITIES)],
  controllers: [BusinessController],
  providers: [
    BusinessSubjectDataContract,
    BusinessService,
    BusinessClassificationService,
    StaffService,
    BusinessMembershipResolver,
    BusinessOwnerResolver,
    BusinessManagerResolver,
    BusinessStaffSelfResolver,
  ],
  exports: [
    BusinessSubjectDataContract,
    BusinessService,
    BusinessClassificationService,
    StaffService,
    BusinessMembershipResolver,
    TypeOrmModule,
  ],
})
export class BusinessModule {}
