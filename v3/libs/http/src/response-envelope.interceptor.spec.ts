import { of } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

function run(payload: unknown) {
  const interceptor = new ResponseEnvelopeInterceptor();
  const handler: CallHandler = { handle: () => of(payload) };
  let result: unknown;
  interceptor.intercept({} as ExecutionContext, handler).subscribe((v) => (result = v));
  return result;
}

describe('ResponseEnvelopeInterceptor', () => {
  it('wraps a bare payload as data, with null meta/error', () => {
    expect(run({ id: '1' })).toEqual({ data: { id: '1' }, meta: null, error: null });
  });

  it('wraps null/undefined payloads as data: null', () => {
    expect(run(undefined)).toEqual({ data: null, meta: null, error: null });
  });

  it('unwraps a PaginatedResult shape into data + meta', () => {
    const result = run({ value: [1, 2, 3], meta: { pagination: { page: 1, limit: 20, total: 3 } } });
    expect(result).toEqual({ data: [1, 2, 3], meta: { pagination: { page: 1, limit: 20, total: 3 } }, error: null });
  });
});
