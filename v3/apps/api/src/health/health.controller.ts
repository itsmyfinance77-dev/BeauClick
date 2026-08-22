import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '@beauclick/auth';

/**
 * Backend foundation requirement: a real health endpoint -- V2 had NONE
 * (OPS-03, confirmed gap). Checks the actual DB connection, not just "the
 * process is up" -- a real health check should reflect real dependency
 * health.
 *
 * **The ONLY route in V3 exempt from global rate limiting**, and the
 * exemption is deliberate rather than convenient: every orchestrator,
 * uptime monitor, and load-balancer health probe hits this endpoint on a
 * fixed short interval from a small number of source IPs, so throttling it
 * would eventually mark a HEALTHY service as unhealthy and take it out of
 * rotation -- a rate limit causing the outage it exists to prevent. It is
 * exempt because it is infrastructure-critical, NOT because it is
 * frequently called; no other route qualifies on that reasoning.
 *
 * Safe to exempt because it takes no input, mutates nothing, requires no
 * auth, and returns a fixed-shape status with no data of any kind -- there
 * is no amplification or enumeration to gain by flooding it.
 *
 * Bare `@SkipThrottle()` is correct here ONLY because exactly one throttler
 * is registered, and it is named `default` -- the decorator's own default
 * argument is `{ default: true }`, so it skips that one and there is no
 * other. This was briefly wrong in development: an earlier design registered
 * five named throttlers, and `@SkipThrottle()` then skipped only one of
 * them, leaving health probes throttled by the other four. See
 * `throttlerOptionsFromEnv`'s docblock for why one throttler is the only
 * correct shape.
 */
@SkipThrottle()
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
