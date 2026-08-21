import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ANALYTICS_ENTITIES } from './entities/analytics.entities';
import { AdminAnalyticsController, MyAnalyticsController } from './analytics.controller';
import { AnalyticsIngestionService } from './ingestion.service';
import { MetricsService } from './metrics.service';
import { RollupService } from './rollup.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(ANALYTICS_ENTITIES)],
  controllers: [MyAnalyticsController, AdminAnalyticsController],
  providers: [AnalyticsIngestionService, MetricsService, RollupService],
  exports: [AnalyticsIngestionService, MetricsService, RollupService, TypeOrmModule],
})
export class AnalyticsModule {}
