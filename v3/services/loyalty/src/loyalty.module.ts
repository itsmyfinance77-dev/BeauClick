import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LOYALTY_ENTITIES } from './entities/loyalty.entities';
import { BenefitService } from './benefit.service';
import { LoyaltyAdminController, LoyaltyController } from './loyalty.controller';
import { LoyaltyConfig } from './loyalty.config';
import { LoyaltyLedgerService } from './loyalty-ledger.service';
import { MembershipService } from './membership.service';
import { TierService } from './tier.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(LOYALTY_ENTITIES)],
  controllers: [LoyaltyController, LoyaltyAdminController],
  providers: [LoyaltyConfig, TierService, BenefitService, LoyaltyLedgerService, MembershipService],
  exports: [LoyaltyLedgerService, TierService, BenefitService, MembershipService, LoyaltyConfig, TypeOrmModule],
})
export class LoyaltyModule {}
