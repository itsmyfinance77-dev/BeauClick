import 'reflect-metadata';

import {
  FINANCE_CACHE_CONTROL,
  FINANCE_SURFACE_PATH,
  FinanceNoStoreMiddleware,
  financeSurfaceMountPath,
} from './finance-no-store.middleware';
import { FinancialModule } from './financial.module';

/**
 * `Cache-Control: private, no-store` on the seller finance surface -- V3.3
 * #154, `V33-DEC-038` R10. The runtime headers on all nine routes, including
 * the refusals a guard produces, are proved by the real-PostgreSQL suite;
 * what belongs here is the middleware's own contract and the fact that the
 * module binds it -- so a refactor that drops `configure` fails a unit test
 * before it reaches a database.
 */
describe('FinanceNoStoreMiddleware (#154)', () => {
  it('sets exactly `private, no-store` and passes the request on', () => {
    const setHeader = jest.fn();
    const next = jest.fn();

    new FinanceNoStoreMiddleware().use({}, { setHeader }, next);

    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(FINANCE_CACHE_CONTROL).toBe('private, no-store');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('is mounted by FinancialModule as a prefix middleware on the seller finance controller\'s own path, under the global prefix, and nothing else', () => {
    const mounted: Array<[string, unknown]> = [];
    const adapterHost = { httpAdapter: { getInstance: () => ({ use: (path: string, fn: unknown) => void mounted.push([path, fn]) }) } };
    const applicationConfig = { getGlobalPrefix: () => 'api' };
    const middleware = new FinanceNoStoreMiddleware();

    new FinancialModule(adapterHost as never, applicationConfig as never, middleware).configure({} as never);

    // The prefix IS the controller's declared path -- never a retyped string
    // that could drift, and never the administrator controller's.
    expect(FINANCE_SURFACE_PATH).toBe('v1/me/finance');
    expect(mounted.map(([path]) => path)).toEqual(['/api/v1/me/finance']);

    // The mounted function delegates to the middleware: one header, then next.
    const setHeader = jest.fn();
    const next = jest.fn();
    (mounted[0][1] as (req: unknown, res: unknown, next: () => void) => void)({}, { setHeader }, next);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('joins the global prefix and the controller path into one segment-bounded mount path', () => {
    expect(financeSurfaceMountPath('api')).toBe('/api/v1/me/finance');
    expect(financeSurfaceMountPath('/api/')).toBe('/api/v1/me/finance');
    expect(financeSurfaceMountPath('')).toBe('/v1/me/finance');
  });
});
