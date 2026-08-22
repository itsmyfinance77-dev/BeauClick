import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SkipThrottle } from '@nestjs/throttler';
import { Public, SKIP_ALL_THROTTLES } from '@beauclick/auth';

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
 * `SKIP_ALL_THROTTLES`, never a bare `@SkipThrottle()`: the bare form's
 * default argument is `{ default: true }`, which skips ONLY the policy
 * named `default` and leaves the other four still applying -- so health
 * probes were still being throttled. CI caught it; review did not.
 */
@SkipThrottle(SKIP_ALL_THROTTLES)
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
