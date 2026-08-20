import { ApiClient, ApiRequestError } from '@/lib/api-client';

function mockFetchOnce(status: number, body: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
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
});
