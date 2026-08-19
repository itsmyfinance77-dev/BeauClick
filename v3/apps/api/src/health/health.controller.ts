import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '@beauclick/auth';

/**
 * Backend foundation requirement: a real health endpoint -- V2 had NONE
 * (OPS-03, confirmed gap). Checks the actual DB connection, not just "the
 * process is up" -- a real health check should reflect real dependency
 * health.
 */
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Public()
  @Get()
  async check() {
    let database: 'ok' | 'error' = 'ok';
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      database = 'error';
    }

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: { database },
    };
  }
}
