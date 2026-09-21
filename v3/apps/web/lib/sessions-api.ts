import type { ApiClient } from './api-client';

/**
 * The customer's own signed-in devices: `GET/DELETE /v1/auth/sessions`.
 *
 * The list is always the caller's own. `POST /v1/auth/logout-all-devices` is
 * deliberately NOT used: it revokes every session INCLUDING the current one and
 * clears the cookies, so it cannot be "sign out my other devices". That action
 * is built here by revoking each other session by its id.
 */
export interface DeviceSession {
  id: string;
  /** Latin-only, from the `x-device-label` header when the client sent one. */
  deviceLabel: string | null;
  userAgent: string | null;
  /** When THIS DEVICE first signed in, carried across every token rotation. */
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  /**
   * Whether this row is the device making the request. Legitimately `false` on
   * EVERY row for a token minted before the claim existed — that means "not
   * known", not an error, and it corrects itself on the next refresh.
   */
  current: boolean;
}

export function listSessions(api: ApiClient) {
  return api.get<DeviceSession[]>('/v1/auth/sessions');
}

export function revokeSession(api: ApiClient, id: string) {
  return api.delete<{ revoked: true }>(`/v1/auth/sessions/${encodeURIComponent(id)}`);
}
