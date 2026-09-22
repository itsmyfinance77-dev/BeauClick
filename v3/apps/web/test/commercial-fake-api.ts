/**
 * A tiny routed fake of the API for the admin commercial specs (#239).
 *
 * Each route is `[method, path regex, handler]`; the handler gets the regex
 * match and the parsed body and returns `ok(...)` or `fail(...)`. Every call is
 * recorded, so a spec can assert exactly what was sent — including that
 * something was NOT.
 */

export interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

type Reply = { status: number; payload: unknown };
type Handler = (match: RegExpMatchArray, body: Record<string, unknown> | null) => Reply;
export type Route = [method: string, path: RegExp, handler: Handler];

export const ok = (data: unknown): Reply => ({ status: 200, payload: { data, meta: null, error: null } });
export const fail = (status: number, code: string, message: string, details?: unknown): Reply => ({
  status,
  payload: { data: null, meta: null, error: { code, message, details } },
});

export function installFakeApi(capabilities: string[], routes: Route[]) {
  const calls: Call[] = [];
  (global.fetch as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname.replace(/^\/api/, '');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    let reply: Reply;
    if (path === '/v1/auth/refresh') reply = ok({ accessToken: 'a', csrfToken: 'c' });
    else if (path === '/v1/me') reply = ok({ id: 'u1', phone: '+989123456789', displayName: 'مدیر', roles: [], capabilities });
    else {
      calls.push({ method, path, body });
      const route = routes.find(([m, re]) => m === method && re.test(path));
      reply = route ? route[2](path.match(route[1]) as RegExpMatchArray, body) : fail(404, 'COMMERCIAL_NOT_FOUND', 'موردی با این مشخصات یافت نشد.');
    }
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.payload };
  });
  return {
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    sent: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
  };
}

export const ADMIN = '/v1/admin/commercial';
export const FAR_PAST = '2020-01-01T00:00:00.000Z';
export const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
