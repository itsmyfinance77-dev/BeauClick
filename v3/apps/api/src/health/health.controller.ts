import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '@beauclick/auth';
import { MediaService } from '@beauclick/media';

import { ReadinessReport, ReadinessService } from './readiness.service';

/**
 * Backend foundation requirement: a real health endpoint -- V2 had NONE
 * (OPS-03, confirmed gap). Checks the actual DB connection, not just "the
 * process is up" -- a real health check should reflect real dependency
 * health.
 *
 * **The ONLY routes in V3 exempt from global rate limiting**, and the
 * exemption is deliberate rather than convenient: every orchestrator,
 * uptime monitor, and load-balancer health probe hits these endpoints on a
 * fixed short interval from a small number of source IPs, so throttling them
 * would eventually mark a HEALTHY service as unhealthy and take it out of
 * rotation -- a rate limit causing the outage it exists to prevent. They are
 * exempt because they are infrastructure-critical, NOT because they are
 * frequently called; no other route qualifies on that reasoning.
 *
 * Safe to exempt because they take no input, mutate nothing, require no
 * auth, and return fixed-shape status with no data of any kind -- there
 * is no amplification or enumeration to gain by flooding them.
 *
 * Bare `@SkipThrottle()` is correct here ONLY because exactly one throttler
 * is registered, and it is named `default` -- the decorator's own default
 * argument is `{ default: true }`, so it skips that one and there is no
 * other. This was briefly wrong in development: an earlier design registered
 * five named throttlers, and `@SkipThrottle()` then skipped only one of
 * them, leaving health probes throttled by the other four. See
 * `throttlerOptionsFromEnv`'s docblock for why one throttler is the only
 * correct shape.
 *
 * ## Two endpoints, two different questions (V3.1 Phase F)
 *
 * `GET /health` is LIVENESS: should this process be restarted? Fast, coarse,
 * and unchanged in shape from Phase 1 -- an orchestrator already depends on
 * it and a liveness probe is the wrong place to add fields.
 *
 * `GET /health/ready` is READINESS: should traffic be routed here, and -- the
 * question this platform actually needed -- **is this deployment talking to
 * real things or to stand-ins?** See `readiness.ts` for why "healthy" could
 * never answer that: a deployment running the sandbox gateway, the in-memory
 * search engine, the local disk driver, and the null SMS provider is
 * perfectly healthy and is not a marketplace.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly media: MediaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Public()
  @Get()
  async check() {
    let database: 'ok' | 'error' = 'ok';
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      database = 'error';
    }

    /**
     * Which object-storage driver this deployment is actually running, and
     * whether it is durable (V3.1 Phase C).
     *
     * Reported for the same reason `NotificationChannelPort.providerVerified`
     * is: a driver writing to one container's own disk must never be
     * indistinguishable from one writing to real object storage. V2 shipped a
     * "local development only" payment stand-in whose production-safety was a
     * sentence in the UI with no mechanism behind it, and Phase 2 found it
     * still reachable. This is the mechanism.
     *
     * Deliberately NOT part of the `status` verdict: a development machine on
     * the local driver is healthy, not degraded. The fact is surfaced; the
     * judgement about whether it is acceptable belongs to whoever is reading.
     */
    const storage = this.media.describeDriver();

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: { database },
      storage,
    };
  }

  /**
   * Readiness, including the simulated-versus-real distinction and the
   * external-verification ledger.
   *
   * `@Public()` for the same reason the liveness probe is: an orchestrator's
   * readiness check carries no session, and requiring one would mean the
   * probe could never succeed. Everything the report contains is therefore
   * written on the assumption that anyone can read it -- enums, booleans, and
   * gap ids, never a host, credential, or endpoint. `ReadinessService`'s
   * docblock states that rule and the suite asserts it.
   */
  @Public()
  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    return this.readiness.report();
  }
}
