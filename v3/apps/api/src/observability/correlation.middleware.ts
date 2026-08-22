import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  acceptInboundCorrelationId,
  CORRELATION_HEADER,
  runWithCorrelation,
} from '@beauclick/events';

/**
 * The request edge of correlation tracing: every HTTP request runs under a
 * correlation id, and every event it causes -- directly or through the outbox
 * fan-out -- carries that id (see `libs/events/src/correlation.ts`).
 *
 * The id is echoed back in the response header so a client, a browser network
 * log, or a support ticket can name the exact request without access to the
 * server. That is the difference between "a customer says the notification was
 * wrong" and "here is the id; every row it touched has it in a column".
 *
 * An inbound id is accepted only if it is UUID-shaped. A caller-supplied
 * string that reaches nine outbox tables and every log line is an injection
 * vector for free, and this system produces exactly one id shape.
 *
 * Registered as the FIRST middleware, ahead of cookie parsing, so nothing that
 * runs during a request is outside the context -- including anything that
 * fails before reaching a controller.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const correlationId = acceptInboundCorrelationId(req.headers[CORRELATION_HEADER]);
    res.setHeader(CORRELATION_HEADER, correlationId);
    runWithCorrelation(correlationId, () => next());
  }
}
