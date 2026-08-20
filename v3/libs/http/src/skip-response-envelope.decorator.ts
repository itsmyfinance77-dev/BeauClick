import { CustomDecorator, SetMetadata } from '@nestjs/common';

export const SKIP_RESPONSE_ENVELOPE_KEY = 'beauclick:skipResponseEnvelope';

/**
 * Opts a route out of the standard `{ data, meta, error }` envelope.
 *
 * There is exactly one legitimate reason to use this today, and it is a real
 * one: a route decorated with Nest's `@Redirect()` returns a
 * `{ url, statusCode }` control object that Nest itself interprets. The
 * global interceptor would wrap that into `{ data: { url, statusCode } }`,
 * at which point Nest no longer recognises it and falls back to a default
 * 302 with no location -- silently breaking the redirect. Found by the
 * payment-callback suite asserting on the 303 the gateway return leg needs.
 *
 * This is deliberately an explicit decorator rather than the interceptor
 * sniffing for a `url`-shaped payload: shape-sniffing would also catch a
 * legitimate DTO that happens to carry a `url` field, and would silently
 * un-envelope it.
 */
export const SkipResponseEnvelope = (): CustomDecorator<string> => SetMetadata(SKIP_RESPONSE_ENVELOPE_KEY, true);
