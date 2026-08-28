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
  /**
   * Sends the httpOnly refresh cookie with the request.
   *
   * Off by default and enabled ONLY for the auth routes. A cookie attached to
   * every request is a cookie that can be replayed by any page that can make
   * one -- which is what CSRF is. Restricting it to the two routes that
   * genuinely need it is the client-side half of the server's `Path`
   * restriction.
   */
  withCredentials?: boolean;
  /** Supplies the double-submit CSRF token for cookie-authenticated requests. */
  getCsrfToken?: () => string | null;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private buildHeaders(hasBody: boolean, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (hasBody) headers['Content-Type'] = 'application/json';

    const token = this.options.getAccessToken?.() ?? null;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Only sent on the credentialed client. The server rejects a
    // cookie-authenticated refresh whose header does not match the cookie, so
    // omitting it here on a cookie request is a 403, not a silent downgrade.
    if (this.options.withCredentials) {
      const csrf = this.options.getCsrfToken?.() ?? null;
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
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
        // `include` rather than `same-origin`: the API is a different origin
        // from the web app, and without this the browser sends no cookie at
        // all -- the refresh would silently fall back to the body path and
        // the whole httpOnly design would be inert.
        credentials: this.options.withCredentials ? 'include' : 'omit',
      });
    } catch {
      // A genuine network/transport failure -- never surfaced as a raw
      // English fetch error (V2's api.ts guaranteed the same property).
      throw new ApiRequestError('NETWORK_ERROR', GENERIC_NETWORK_ERROR, 0);
    }

    // `204 No Content` is a SUCCESSFUL response with no body, and every DELETE
    // route answers with it. `R31-18`: calling `response.json()` on that empty
    // body threw, so the client reported "پاسخ سرور نامعتبر بود" and skipped its
    // state update even though the deletion had succeeded server-side.
    // Short-circuiting here is the standard No-Content handling and leaves the
    // JSON path (200/201 envelopes, 4xx/5xx error envelopes) untouched.
    if (response.status === 204) {
      return { data: null as T, meta: null, error: null };
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
