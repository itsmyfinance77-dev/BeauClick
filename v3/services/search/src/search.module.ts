import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Client } from '@opensearch-project/opensearch';

import { SEARCH_ENTITIES } from './entities/search.entities';
import { SearchIndexerService } from './indexing/search-indexer.service';
import { InMemorySearchEngine } from './opensearch/in-memory-search.engine';
import { OpenSearchAdapter } from './opensearch/opensearch.adapter';
import { SEARCH_ENGINE } from './ports';
import { SearchAdminController, SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchSubjectDataContract } from './search-subject-data.contract';

export const OPENSEARCH_CLIENT = Symbol('BEAUCLICK_OPENSEARCH_CLIENT');

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(SEARCH_ENTITIES)],
  controllers: [SearchController, SearchAdminController],
  providers: [
    SearchSubjectDataContract,
    SearchService,
    SearchIndexerService,
    {
      provide: SEARCH_ENGINE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('OPENSEARCH_URL');

        // No URL configured -> the in-memory engine, and a LOUD refusal in
        // production. A production deployment silently falling back to an
        // in-process fake would serve a permanently empty, permanently stale
        // marketplace while every health check stayed green -- the failure
        // mode is invisible, which is what makes it worth failing to boot
        // over. V2's dev-only Cash-on-Delivery gateway is the precedent:
        // Phase 2 found its "local development only" status was UI text with
        // no mechanism behind it.
        if (!url) {
          if (config.get('NODE_ENV') === 'production') {
            throw new Error(
              'OPENSEARCH_URL is required in production. Refusing to boot with the in-memory search engine, which would serve an empty marketplace with no visible error.',
            );
          }
          return new InMemorySearchEngine();
        }

        return new OpenSearchAdapter(
          new Client({
            node: url,
            // A search query must never be the thing that exhausts the API's
            // request timeout budget. The degraded path exists precisely so a
            // slow engine becomes a slightly worse result page rather than a
            // hung request.
            requestTimeout: Number(config.get('OPENSEARCH_TIMEOUT_MS') ?? 5000),
            maxRetries: 2,
            ssl: { rejectUnauthorized: config.get('NODE_ENV') === 'production' },
          }),
        );
      },
    },
  ],
  exports: [
    SearchSubjectDataContract,SearchService, SearchIndexerService, SEARCH_ENGINE, TypeOrmModule],
})
export class SearchModule {}
