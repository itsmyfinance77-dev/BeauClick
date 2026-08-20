/**
 * V3 API client. Carries forward the ONE genuinely portable piece of V2's
 * app/src/lib/api.ts (V3_MIGRATION_MATRIX.md: "envelope/ApiError/method-
 * surface/error-message-hygiene patterns carry over") while dropping
 * everything WordPress-specific (nonces, window.BeauClick globals,
 * permalink quirks) -- those are replaced by real bearer-token auth.
 */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

export interface ApiResponse<T> {
  data: T | null;
  meta: { pagination?: Pagination } | null;
  error: ApiError | null;
}

/**
 * Thrown for every non-2xx response. `message` is always the server's
 * Persian text -- V3_API_CONTRACT_BLUEPRINT.md §6 makes translation the
 * server's job, so the client never invents or patches error copy.
 */
export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const GENERIC_NETWORK_ERROR = 'ارتباط با سرور برقرار نشد. اتصال اینترنت خود را بررسی کنید.';

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns the current access token, or null when signed out. Kept as a callback so the client never owns token storage. */
  getAccessToken?: () => string | null;
  /** Called once on a 401 to attempt a refresh; returns true if a new token is now available. */
  onUnauthorized?: () => Promise<boolean>;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private buildHeaders(hasBody: boolean, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (hasBody) headers['Content-Type'] = 'application/json';

    const token = this.options.getAccessToken?.() ?? null;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  private async raw<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers: this.buildHeaders(body !== undefined, extraHeaders),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // A genuine network/transport failure -- never surfaced as a raw
      // English fetch error (V2's api.ts guaranteed the same property).
      throw new ApiRequestError('NETWORK_ERROR', GENERIC_NETWORK_ERROR, 0);
    }

    let payload: ApiResponse<T>;
    try {
      payload = (await response.json()) as ApiResponse<T>;
    } catch {
      throw new ApiRequestError('INTERNAL_ERROR', 'پاسخ سرور نامعتبر بود.', response.status);
    }

    if (!response.ok) {
      const error = payload?.error;
      throw new ApiRequestError(error?.code ?? 'INTERNAL_ERROR', error?.message ?? 'خطایی رخ داد.', response.status, error?.details);
    }

    return payload;
  }

  /** Performs the request, and on a 401 gives onUnauthorized() exactly one chance to refresh before retrying once. */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    try {
      return await this.raw<T>(method, path, body, extraHeaders);
    } catch (err) {
      const isAuthFailure = err instanceof ApiRequestError && err.status === 401;
      if (!isAuthFailure || !this.options.onUnauthorized) throw err;

      const refreshed = await this.options.onUnauthorized();
      if (!refreshed) throw err;
      // Exactly one retry -- never a loop, so a persistently-401 endpoint
      // can't spin. The SAME extra headers are replayed, which is what keeps
      // an Idempotency-Key meaningful across the refresh retry: without it
      // the retry would look like a brand-new request and could create a
      // second booking.
      return this.raw<T>(method, path, body, extraHeaders);
    }
  }

  get<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body ?? {}, headers);
  }

  patch<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', path, body);
  }

  delete<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path);
  }
}
