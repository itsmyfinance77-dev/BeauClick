import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WaitlistEntryEntity } from './entities/waitlist-entry.entity';
import { WaitlistOutboxEntity } from './entities/waitlist-outbox.entity';

import { WaitlistConfig } from './waitlist.config';
import { WaitlistService } from './waitlist.service';
import { WaitlistController } from './waitlist.controller';
import { WaitlistEntryOwnerResolver, WaitlistProfessionalResolver } from './waitlist-owner.resolver';
import { WaitlistSubjectDataContract } from './waitlist-subject-data.contract';

export const WAITLIST_ENTITIES = [WaitlistEntryEntity, WaitlistOutboxEntity];

/**
 * Note the absence of a `PROFESSIONAL_OWNER_LOOKUP` implementation -- like
 * booking-service's `PROFESSIONAL_DIRECTORY`, that port is declared here
 * and supplied by the composition root, so this module is unusable without
 * a deliberate wiring decision.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(WAITLIST_ENTITIES)],
  controllers: [WaitlistController],
  providers: [
    WaitlistSubjectDataContract,WaitlistConfig, WaitlistService, WaitlistEntryOwnerResolver, WaitlistProfessionalResolver],
  exports: [
    WaitlistSubjectDataContract,WaitlistService, WaitlistConfig, TypeOrmModule],
})
export class WaitlistModule {}
