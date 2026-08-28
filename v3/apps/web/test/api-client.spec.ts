import { ApiClient, ApiRequestError } from '@/lib/api-client';

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

/**
 * A 204 No Content, as every DELETE route actually answers: no body, and
 * `json()` would throw. The client must short-circuit on the status before it
 * ever reaches here (R31-18).
 */
function mockFetch204() {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    status: 204,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  });
}

describe('ApiClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  it('returns the envelope on success', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test' });
    mockFetchOnce(200, { data: { id: '1' }, meta: null, error: null });

    const res = await client.get<{ id: string }>('/v1/thing');
    expect(res.data).toEqual({ id: '1' });
  });

  it('attaches the bearer token when one is available', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: () => 'tok-123' });
    mockFetchOnce(200, { data: null, meta: null, error: null });

    await client.get('/v1/me');

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok-123');
  });

  it('sends NO Authorization header when signed out', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: () => null });
    mockFetchOnce(200, { data: null, meta: null, error: null });

    await client.get('/v1/providers');

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('throws ApiRequestError carrying the server-supplied Persian message and code', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test' });
    mockFetchOnce(404, { data: null, meta: null, error: { code: 'NOT_FOUND_OR_NOT_YOURS', message: 'این مورد یافت نشد.' } });

    await expect(client.get('/v1/providers/x')).rejects.toMatchObject({
      code: 'NOT_FOUND_OR_NOT_YOURS',
      message: 'این مورد یافت نشد.',
      status: 404,
    });
  });

  it('never leaks a raw transport error -- surfaces a Persian message instead', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test' });
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:3099'));

    await expect(client.get('/v1/me')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(client.get('/v1/me').catch((e: ApiRequestError) => e.message)).resolves.not.toMatch(/ECONNREFUSED/);
  });

  describe('401 refresh handling', () => {
    it('refreshes once and retries the original request', async () => {
      const onUnauthorized = jest.fn().mockResolvedValue(true);
      const client = new ApiClient({ baseUrl: 'http://api.test', onUnauthorized });

      mockFetchOnce(401, { data: null, meta: null, error: { code: 'UNAUTHORIZED', message: 'نشست شما منقضی شده است.' } });
      mockFetchOnce(200, { data: { ok: true }, meta: null, error: null });

      const res = await client.get<{ ok: boolean }>('/v1/me');
      expect(res.data).toEqual({ ok: true });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it('gives up (does not loop) when the refresh fails', async () => {
      const onUnauthorized = jest.fn().mockResolvedValue(false);
      const client = new ApiClient({ baseUrl: 'http://api.test', onUnauthorized });

      mockFetchOnce(401, { data: null, meta: null, error: { code: 'UNAUTHORIZED', message: 'نشست نامعتبر.' } });

      await expect(client.get('/v1/me')).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1); // no retry attempted
    });

    it('retries at most once even if the retry also 401s', async () => {
      const onUnauthorized = jest.fn().mockResolvedValue(true);
      const client = new ApiClient({ baseUrl: 'http://api.test', onUnauthorized });

      mockFetchOnce(401, { data: null, meta: null, error: { code: 'UNAUTHORIZED', message: 'x' } });
      mockFetchOnce(401, { data: null, meta: null, error: { code: 'UNAUTHORIZED', message: 'x' } });

      await expect(client.get('/v1/me')).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2);
    });
  });

  /**
   * R31-18: a 204 No Content (or any empty body) is a SUCCESSFUL response with
   * nothing to return, not a parse error. Every DELETE route answers 204, and
   * the old client threw "پاسخ سرور نامعتبر بود" on it -- reporting failure for a
   * deletion the server had actually performed.
   */
  describe('empty-body responses (R31-18)', () => {
    it('treats a 204 No Content as success with null data, without throwing', async () => {
      const client = new ApiClient({ baseUrl: 'http://api.test' });
      mockFetch204();

      const res = await client.delete('/v1/providers/p/services/s');
      expect(res).toEqual({ data: null, meta: null, error: null });
    });

    it('still parses a 200 with a JSON body', async () => {
      const client = new ApiClient({ baseUrl: 'http://api.test' });
      mockFetchOnce(200, { data: { id: '7' }, meta: null, error: null });

      const res = await client.get<{ id: string }>('/v1/thing');
      expect(res.data).toEqual({ id: '7' });
    });

    it('still surfaces a 4xx JSON error envelope', async () => {
      const client = new ApiClient({ baseUrl: 'http://api.test' });
      mockFetchOnce(404, { data: null, meta: null, error: { code: 'NOT_FOUND_OR_NOT_YOURS', message: 'این مورد یافت نشد.' } });

      await expect(client.delete('/v1/providers/p/services/x')).rejects.toMatchObject({
        code: 'NOT_FOUND_OR_NOT_YOURS',
        status: 404,
      });
    });

    it('still throws on a 5xx with a non-JSON body', async () => {
      const client = new ApiClient({ baseUrl: 'http://api.test' });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('not json');
        },
      });

      await expect(client.get('/v1/thing')).rejects.toMatchObject({ status: 500 });
    });
  });
});
