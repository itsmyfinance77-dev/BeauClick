import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiResponse } from './api-response';
import { SKIP_RESPONSE_ENVELOPE_KEY } from './skip-response-envelope.decorator';

/**
 * Wraps every successful controller return value in the standard envelope.
 * A handler may return either a bare payload (wrapped as `data`) or an
 * already-shaped `{ value, meta }` pair when it needs to set pagination
 * metadata (see PaginatedResult below).
 */
export interface PaginatedResult<T> {
  value: T;
  meta: ApiResponse<T>['meta'];
}

function isPaginatedResult<T>(payload: unknown): payload is PaginatedResult<T> {
  return typeof payload === 'object' && payload !== null && 'value' in payload && 'meta' in payload;
}

@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T> | T> {
    const skip = this.reflector.get<boolean | undefined>(SKIP_RESPONSE_ENVELOPE_KEY, context.getHandler());

    return next.handle().pipe(
      map((payload) => {
        // @Redirect() routes return a control object Nest itself consumes;
        // wrapping it would break the redirect entirely.
        if (skip) return payload;
        if (isPaginatedResult<T>(payload)) {
          return { data: payload.value, meta: payload.meta, error: null };
        }
        return { data: payload ?? null, meta: null, error: null };
      }),
    );
  }
}
