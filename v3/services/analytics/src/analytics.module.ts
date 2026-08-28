import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ANALYTICS_ENTITIES } from './entities/analytics.entities';
import { AdminAnalyticsController, MyAnalyticsController } from './analytics.controller';
import { AnalyticsIngestionService } from './ingestion.service';
import { MetricsService } from './metrics.service';
import { RollupService } from './rollup.service';
import { AnalyticsSubjectDataContract } from './analytics-subject-data.contract';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(ANALYTICS_ENTITIES)],
  controllers: [MyAnalyticsController, AdminAnalyticsController],
  providers: [
    AnalyticsSubjectDataContract,AnalyticsIngestionService, MetricsService, RollupService],
  exports: [
    AnalyticsSubjectDataContract,AnalyticsIngestionService, MetricsService, RollupService, TypeOrmModule],
})
export class AnalyticsModule {}
