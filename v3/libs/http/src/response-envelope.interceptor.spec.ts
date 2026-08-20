import { of } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

function run(payload: unknown, skipEnvelope = false) {
  const reflector = { get: () => (skipEnvelope ? true : undefined) } as unknown as Reflector;
  const interceptor = new ResponseEnvelopeInterceptor(reflector);
  const handler: CallHandler = { handle: () => of(payload) };
  const context = { getHandler: () => () => undefined } as unknown as ExecutionContext;
  let result: unknown;
  interceptor.intercept(context, handler).subscribe((v) => (result = v));
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

  it('passes a payload through untouched on a @SkipResponseEnvelope route', () => {
    // A @Redirect() route returns a control object Nest itself interprets.
    // Wrapping it silently broke the payment-gateway return leg -- the
    // redirect degraded to a default 302 with no location.
    const redirect = { url: 'https://example.test/result', statusCode: 303 };
    expect(run(redirect, true)).toEqual(redirect);
  });

  it('still envelopes a normal route that merely happens to return a url field', () => {
    // The opt-out is an explicit decorator rather than shape-sniffing, so a
    // legitimate DTO carrying a `url` is not accidentally un-enveloped.
    expect(run({ url: 'https://example.test/avatar.png' })).toEqual({
      data: { url: 'https://example.test/avatar.png' },
      meta: null,
      error: null,
    });
  });
});
