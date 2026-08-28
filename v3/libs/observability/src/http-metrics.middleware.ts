import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { METRICS, MetricsRegistry } from './metrics';

/**
 * Request rate, latency, and error rate (`OPS-03`).
 *
 * ## Why this is MIDDLEWARE and not an interceptor
 *
 * It was an interceptor first, and that was wrong in a way that would have
 * been very hard to notice: **every 4xx was invisible.**
 *
 * Nest runs middleware, then guards, then interceptors. A request rejected by
 * `JwtAuthGuard` (401), `CapabilityGuard` (403), `OwnershipGuard` (404), or
 * `BeauClickThrottlerGuard` (429) throws BEFORE any interceptor runs, so an
 * interceptor never sees it. A request that matches no route never enters the
 * Nest pipeline at all, so a 404 flood is invisible too.
 *
 * The result would have been an error-rate dashboard that reported zero
 * authentication failures, zero authorization failures, zero rate limiting,
 * and zero 404s -- which is to say a dashboard that looked healthy during
 * exactly the incidents it exists to surface. Found by the suite, driving real
 * requests through the real router.
 *
 * Middleware runs for EVERY request, including the ones that never reach a
 * controller, so it is the only layer that can count them all.
 *
 * ## Recording on the response, not on the way in
 *
 * `req.route` is populated by the router, which has not run when middleware is
 * entered -- so the route template is read when the response closes, by which
 * time it is set. That is also when the true final status code is known: the
 * exception filter may have changed it long after the handler threw.
 *
 * ## The route TEMPLATE, never the path
 *
 * The cardinality decision, and the one that decides whether a metrics
 * endpoint is useful or fatal. Labelling by `req.url` makes
 * `/v1/orders/01a04a62-...` and `/v1/orders/01a04a63-...` two time series; a
 * day of traffic produces hundreds of thousands, each retained for the full
 * window. `req.route.path` is `/v1/orders/:id` for every order -- one series.
 *
 * When nothing matched there is no template, and the raw path must NOT be
 * substituted: that is precisely the unbounded case, and a 404 flood is how an
 * attacker would trigger it deliberately. Those are labelled `unmatched`.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsRegistry) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    let recorded = false;

    const record = (status: string): void => {
      if (recorded) return;
      recorded = true;
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const route = (req as { route?: { path?: string } }).route?.path ?? 'unmatched';
      const method = req.method ?? 'UNKNOWN';
      this.metrics.increment(METRICS.httpRequests, { method, route, status });
      // Duration is NOT labelled by status: a histogram is already eleven
      // series per label set, and splitting latency by status class triples
      // that to answer a question ("how slow are the failures") the logs
      // answer better, keyed by the same correlation id.
      this.metrics.observe(METRICS.httpDuration, seconds, { method, route });
    };

    // A completed response. `res.statusCode` here is the FINAL code, after the
    // exception filter has had its say.
    res.on('finish', () => record(`${Math.floor(res.statusCode / 100)}xx`));

    // A connection that closed without finishing -- the client went away
    // mid-request. Its own label rather than a status class, because it is
    // neither a success nor a server fault, and a rising rate of it is a real
    // signal (a slow endpoint customers are abandoning) that would otherwise
    // be reported as whatever `statusCode` happened to hold. `recorded` makes
    // this a no-op for a response that already finished, since `close` fires
    // after `finish` too.
    res.on('close', () => record('aborted'));

    // Unconditional, and outside any try/catch above it. Middleware that fails
    // to call `next()` does not fail loudly -- it hangs every request in the
    // application forever, with no error anywhere. Which is exactly what this
    // did on the first run, and what the suite caught: twelve tests timing out
    // on a `GET /api/health`.
    next();
  }
}
