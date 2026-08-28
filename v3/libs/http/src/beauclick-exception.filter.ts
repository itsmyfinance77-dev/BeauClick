import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject, Logger, Optional } from '@nestjs/common';
import type { HttpArgumentsHost } from '@nestjs/common/interfaces';
import { Request, Response } from 'express';
import { currentCorrelationId } from '@beauclick/events';
import { ERROR_REPORTER, ErrorReporterPort } from '@beauclick/observability';
import { ApiResponse } from './api-response';

/**
 * V3_API_CONTRACT_BLUEPRINT.md §6: every error response uses the standard
 * envelope with a Persian message. Any exception this filter doesn't
 * recognize (a real bug, an unexpected library error) is logged with full
 * detail server-side but returns only a generic Persian message to the
 * client -- never a stack trace or an English driver error.
 */
@Catch()
export class BeauClickExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  /**
   * The error reporter (`OPS-04`, V3.1 Phase F).
   *
   * Captured HERE and nowhere else, deliberately. This filter is the single
   * point every unhandled exception in the application already passes through,
   * so reporting from it means a new controller cannot forget to report and no
   * `try { } catch { report() }` has to be sprinkled anywhere. Scattering
   * capture calls is how half the errors end up unreported and the other half
   * reported twice.
   *
   * `@Optional()` because the filter is also constructed in test harnesses and
   * in compositions that do not import `ObservabilityModule`. A missing
   * reporter degrades to logging, which is what the default reporter does
   * anyway; an exception filter that cannot be built is an application that
   * cannot serve an error page.
   */
  constructor(@Optional() @Inject(ERROR_REPORTER) private readonly reporter?: ErrorReporterPort) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const shaped: ApiResponse<null> =
        typeof body === 'object' && body !== null && 'code' in body
          ? { data: null, meta: null, error: body as ApiResponse<null>['error'] as NonNullable<ApiResponse<null>['error']> }
          : { data: null, meta: null, error: { code: httpStatusToCode(status), message: genericMessageFor(status) } };
      response.status(status).json(shaped);
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : exception);
    this.report(exception, ctx);

    const shaped: ApiResponse<null> = {
      data: null,
      meta: null,
      error: { code: 'INTERNAL_ERROR', message: 'خطایی در سرور رخ داد. لطفاً دوباره تلاش کنید.' },
    };
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(shaped);
  }

  /**
   * Hands the error to the reporter, without waiting for it and without ever
   * letting it interfere.
   *
   * Deliberately NOT awaited. The customer's 500 response must not wait on a
   * round trip to an observability backend, and an outage in that backend must
   * not add its own latency to every failing request. The reporter's own
   * contract already says `capture` never throws; the `catch` here is the
   * belt to that braces, because the one thing this filter must never do is
   * throw while handling an exception -- that produces an unhandled rejection
   * and no response at all.
   */
  private report(exception: unknown, ctx: HttpArgumentsHost): void {
    if (!this.reporter) return;
    try {
      // `getRequest` is read inside the try, not passed in: an `ArgumentsHost`
      // is a context object whose shape depends on the transport, and a filter
      // that assumes an HTTP one throws while handling an exception -- which
      // produces an unhandled rejection and NO response at all, turning a
      // recoverable 500 into a dropped request. Found by this file's own spec,
      // whose host double implements `getResponse` and nothing else.
      const request = typeof ctx.getRequest === 'function' ? ctx.getRequest<Request>() : undefined;
      const error = exception instanceof Error ? exception : new Error(String(exception));
      void this.reporter
        .capture({
          error: { name: error.name, message: error.message, stack: error.stack },
          level: 'error',
          correlationId: currentCorrelationId() ?? null,
          // The route TEMPLATE, never `req.url`. A raw path carries ids, and
          // an error tracker groups by what it is given.
          route: (request as { route?: { path?: string } } | undefined)?.route?.path ?? null,
          method: request?.method ?? null,
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          // An ID only. Never the phone number the session was established
          // with -- see `ErrorReport.userId`.
          userId: (request as { user?: { userId?: string } } | undefined)?.user?.userId ?? null,
          context: {},
        })
        .catch(() => undefined);
    } catch {
      // Reporting an error must never become an error.
    }
  }
}

function httpStatusToCode(status: number): string {
  switch (status) {
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND_OR_NOT_YOURS';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.INTERNAL_SERVER_ERROR:
    case HttpStatus.BAD_GATEWAY:
    case HttpStatus.SERVICE_UNAVAILABLE:
    case HttpStatus.GATEWAY_TIMEOUT:
      // A real HttpException in the 5xx range (e.g. a bare
      // InternalServerErrorException thrown somewhere) is a server fault,
      // not a client input problem -- must not be mislabeled
      // VALIDATION_ERROR, which the pre-fix default case did.
      return 'INTERNAL_ERROR';
    default:
      return 'VALIDATION_ERROR';
  }
}

function genericMessageFor(status: number): string {
  switch (status) {
    case HttpStatus.NOT_FOUND:
      return 'این مورد یافت نشد.';
    case HttpStatus.UNAUTHORIZED:
      return 'برای این عملیات باید وارد حساب کاربری خود شوید.';
    case HttpStatus.FORBIDDEN:
      return 'اجازه دسترسی به این بخش را ندارید.';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'تعداد درخواست‌ها بیش از حد مجاز است.';
    case HttpStatus.INTERNAL_SERVER_ERROR:
    case HttpStatus.BAD_GATEWAY:
    case HttpStatus.SERVICE_UNAVAILABLE:
    case HttpStatus.GATEWAY_TIMEOUT:
      return 'خطایی در سرور رخ داد. لطفاً دوباره تلاش کنید.';
    default:
      return 'درخواست نامعتبر است.';
  }
}
