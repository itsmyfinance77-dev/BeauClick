import { Injectable, NestMiddleware } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { MyFinanceController } from './financial.controller';

/**
 * The one capability the middleware needs from the response. Typed
 * structurally rather than as Express's `Response` so this domain package
 * declares no HTTP-framework dependency of its own (it has none today).
 */
interface HeaderWritableResponse {
  setHeader(name: string, value: string): unknown;
}

/** The exact header value every seller finance response carries. */
export const FINANCE_CACHE_CONTROL = 'private, no-store';

/**
 * The seller finance surface's path prefix, read from `MyFinanceController`'s
 * own `@Controller()` metadata rather than retyped, so the mount in
 * `FinancialModule` covers exactly the routes that controller declares --
 * today `v1/me/finance` -- and cannot drift from it.
 */
export const FINANCE_SURFACE_PATH: string = Reflect.getMetadata(PATH_METADATA, MyFinanceController);

/**
 * Where the middleware is mounted: the global prefix (`api` in every
 * bootstrap of this application) joined to the controller path, with exactly
 * one leading slash and no trailing one -- the shape Express's `use` treats
 * as a segment-bounded prefix.
 */
export function financeSurfaceMountPath(globalPrefix: string): string {
  const segments = [globalPrefix, FINANCE_SURFACE_PATH]
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}

/**
 * `Cache-Control: private, no-store` on every response of the seller
 * finance surface -- V3.3 #154, `V33-DEC-038` R10.
 *
 * ## Why middleware, and why at the module
 *
 * A finance read is a snapshot of one person's money under a live, revocable
 * authority. A browser or intermediary that stored it would keep showing it
 * after a grant is revoked, a membership ends or a session is closed. Setting
 * the header per handler with `@Header` would reach only handler successes;
 * an interceptor would reach nothing a guard refuses. A prefix middleware
 * mounted by `FinancialModule` runs before every guard, so the `401` an
 * unauthenticated caller gets, the `404` a foreign reference gets and the
 * `409` a dual owner gets on a singular route carry the header exactly as a
 * `200` does -- and a route added to `MyFinanceController` tomorrow inherits
 * it without anyone remembering to decorate it.
 *
 * ## Scoped to exactly the `MyFinanceController` surface
 *
 * `FinancialModule` mounts it on that controller's own path prefix (see
 * `financeSurfaceMountPath`) and nothing else. The administrator finance
 * controller, the commercial catalogue and every public route keep whatever
 * cache behaviour they have; this decision changes no unrelated cache policy.
 */
@Injectable()
export class FinanceNoStoreMiddleware implements NestMiddleware {
  use(_request: unknown, response: HeaderWritableResponse, next: () => void): void {
    response.setHeader('Cache-Control', FINANCE_CACHE_CONTROL);
    next();
  }
}
