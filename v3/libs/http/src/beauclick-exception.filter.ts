import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
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
    const shaped: ApiResponse<null> = {
      data: null,
      meta: null,
      error: { code: 'INTERNAL_ERROR', message: 'خطایی در سرور رخ داد. لطفاً دوباره تلاش کنید.' },
    };
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(shaped);
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
