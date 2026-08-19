import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiResponse } from './api-response';

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
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((payload) => {
        if (isPaginatedResult<T>(payload)) {
          return { data: payload.value, meta: payload.meta, error: null };
        }
        return { data: payload ?? null, meta: null, error: null };
      }),
    );
  }
}
