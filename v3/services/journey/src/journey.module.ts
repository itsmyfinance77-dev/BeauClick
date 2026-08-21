import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { JOURNEY_ENTITIES } from './entities/journey.entities';
import { JourneyContextProvider } from './journey-context.provider';
import { JourneyController } from './journey.controller';
import { JourneyService } from './journey.service';

/**
 * Journey is a top-level domain module, not a sub-module of AI (ADR-019).
 *
 * Note that `JourneyContextProvider` is exported while the repositories are
 * not: an AI module composed alongside this one can obtain a typed, curated
 * context and has no route to the underlying tables. That asymmetry is the
 * boundary, expressed in the module definition rather than in a comment.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(JOURNEY_ENTITIES)],
  controllers: [JourneyController],
  providers: [JourneyService, JourneyContextProvider],
  exports: [JourneyService, JourneyContextProvider, TypeOrmModule],
})
export class JourneyModule {}
