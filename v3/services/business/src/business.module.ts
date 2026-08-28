import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';

import { BusinessService } from './business.service';
import { StaffService } from './staff.service';
import { BusinessController } from './business.controller';
import {
  BusinessManagerResolver,
  BusinessMembershipResolver,
  BusinessOwnerResolver,
  BusinessStaffSelfResolver,
} from './business-membership.resolver';
import { BusinessSubjectDataContract } from './business-subject-data.contract';

export const BUSINESS_ENTITIES = [BusinessEntity, BusinessStaffEntity, BusinessOutboxEntity];

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(BUSINESS_ENTITIES)],
  controllers: [BusinessController],
  providers: [
    BusinessSubjectDataContract,
    BusinessService,
    StaffService,
    BusinessMembershipResolver,
    BusinessOwnerResolver,
    BusinessManagerResolver,
    BusinessStaffSelfResolver,
  ],
  exports: [
    BusinessSubjectDataContract,BusinessService, StaffService, BusinessMembershipResolver, TypeOrmModule],
})
export class BusinessModule {}
