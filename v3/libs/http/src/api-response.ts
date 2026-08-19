/**
 * V3_API_CONTRACT_BLUEPRINT.md §1/§6 — the one response shape every V3
 * endpoint returns. `error` is always null on success; `data`/`meta` are
 * always null on failure. Never mix the two.
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

export interface CursorPagination {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ApiResponse<T> {
  data: T | null;
  meta: { pagination?: Pagination | CursorPagination } | null;
  error: ApiError | null;
}

export function ok<T>(data: T, meta: ApiResponse<T>['meta'] = null): ApiResponse<T> {
  return { data, meta, error: null };
}
