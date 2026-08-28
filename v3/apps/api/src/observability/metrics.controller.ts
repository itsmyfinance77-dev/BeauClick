import { Controller, ForbiddenException, Get, Headers, Header, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '@beauclick/auth';
import { SkipResponseEnvelope } from '@beauclick/http';
import { MetricsRegistry } from '@beauclick/observability';

import { timingSafeEqualStrings } from './timing-safe-equal';

/**
 * `GET /metrics` — the Prometheus scrape endpoint (`OPS-03`).
 *
 * ## Why it is not simply public
 *
 * A metrics endpoint is a very good description of a system: every route
 * template it serves, the request volume on each, the latency distribution,
 * the error rate, and -- for this platform -- the count of payment
 * verifications by outcome. Published openly that is a free reconnaissance
 * document and a free traffic-analysis feed. Most deployments avoid the
 * question by scraping over a private network; this platform has no network
 * topology yet, because the hosting decision is open (`HOSTING`), so the
 * endpoint has to defend itself.
 *
 * `METRICS_AUTH_TOKEN` is therefore required to read it. Not a session: a
 * scraper is a machine with no login, and requiring one would mean the
 * endpoint could never be scraped.
 *
 * ## Why an unconfigured token means 404 rather than 200
 *
 * Because the alternative is a deployment that publishes its metrics because
 * somebody forgot a variable, and nothing anywhere would say so. Failing
 * CLOSED means the worst outcome of a forgotten variable is a missing
 * dashboard, which is visible and harmless, rather than an open one, which is
 * invisible and is not.
 *
 * 404 rather than 403 deliberately: an unconfigured endpoint should be
 * indistinguishable from an absent one, so a scan learns nothing from probing
 * it. A CONFIGURED endpoint answers 403 to a wrong token, because at that
 * point the operator holding the right token needs to know the difference
 * between "wrong credential" and "not enabled here".
 */
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsRegistry,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @SkipResponseEnvelope()
  @Get()
  // The exposition format's own content type. A scraper given
  // `application/json` will refuse the body.
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(@Headers('authorization') authorization?: string): string {
    const expected = this.config.get<string>('METRICS_AUTH_TOKEN')?.trim();
    if (!expected) throw new NotFoundException();

    const presented = (authorization ?? '').replace(/^Bearer\s+/i, '');
    // Constant-time, because a byte-at-a-time comparison on an unthrottled,
    // unauthenticated endpoint is exactly the shape a timing attack needs.
    if (!timingSafeEqualStrings(presented, expected)) throw new ForbiddenException();

    return this.metrics.render();
  }
}
