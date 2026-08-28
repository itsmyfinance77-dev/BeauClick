import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DataRequestEntity } from './entities/data-request.entity';
import { ExportPayloadEntity } from './entities/export-payload.entity';
import { PrivacyOutboxEntity } from './entities/privacy-outbox.entity';
import { PrivacyConfig } from './privacy.config';
import { PrivacyService } from './privacy.service';
import { PrivacySweepService } from './privacy-sweep.service';
import { AdminPrivacyController, PrivacyController } from './privacy.controller';
import { PrivacySubjectDataContract } from './privacy-subject-data.contract';

export const PRIVACY_ENTITIES = [DataRequestEntity, ExportPayloadEntity, PrivacyOutboxEntity];

/**
 * privacy-service.
 *
 * It imports no other domain and holds no other schema's repository -- the
 * whole point of the `SubjectDataContract` port is that this module can
 * orchestrate an export across fourteen domains while depending on none of
 * them. `@nx/enforce-module-boundaries` checks that rather than trusting it.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(PRIVACY_ENTITIES)],
  controllers: [PrivacyController, AdminPrivacyController],
  providers: [PrivacyConfig, PrivacyService, PrivacySweepService, PrivacySubjectDataContract],
  exports: [PrivacyService, PrivacySweepService, PrivacyConfig, PrivacySubjectDataContract],
})
export class PrivacyModule {}
