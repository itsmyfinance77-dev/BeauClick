import type { ApiClient } from './api-client';

/**
 * Typed wrappers for the Phase 3 surfaces.
 *
 * Every response type here is the PUBLIC API shape, not an internal document:
 * the search controller strips `revision`, `rankingScore`, and `indexedAt`
 * before responding, and these types reflect that. If a field is absent from
 * this file, the API does not return it.
 */

export interface SearchResultItem {
  id: string;
  displayName: string;
  bio: string | null;
  city: { id: string; name: string } | null;
  specialties: string[];
  isVerified: boolean;
  services: Array<{ id: string; name: string; priceToman: number; durationMinutes: number }>;
  priceFromToman: number | null;
  rating: { average: number; count: number };
  /** Explainability keys -- `verified`, `reliable`, `high_rating`. V2 rendered these too. */
  badges: string[];
}

export interface FacetBucket {
  key: string;
  label: string | null;
  count: number;
}

export interface SearchResponse {
  items: SearchResultItem[];
  pagination: { page: number; pageSize: number; total: number; totalIsApproximate: boolean; totalPages: number };
  facets: { cities: FacetBucket[]; specialties: FacetBucket[]; verification: FacetBucket[]; priceRanges: FacetBucket[] };
  /**
   * True when the search engine was unreachable and results came from the
   * database fallback. Surfaced to the user rather than hidden -- a degraded
   * result set has no fuzzy matching and no relevance ranking.
   */
  degraded: boolean;
}

export interface SearchParams {
  q?: string;
  cityId?: string;
  specialtyIds?: string[];
  minPrice?: number;
  maxPrice?: number;
  verifiedOnly?: boolean;
  sort?: string;
  page?: number;
}

export function buildSearchQuery(params: SearchParams): string {
  const query = new URLSearchParams();
  if (params.q?.trim()) query.set('q', params.q.trim());
  if (params.cityId) query.set('cityId', params.cityId);
  for (const id of params.specialtyIds ?? []) query.append('specialtyIds', id);
  if (params.minPrice !== undefined) query.set('minPrice', String(params.minPrice));
  if (params.maxPrice !== undefined) query.set('maxPrice', String(params.maxPrice));
  if (params.verifiedOnly) query.set('verifiedOnly', 'true');
  if (params.sort) query.set('sort', params.sort);
  if (params.page && params.page > 1) query.set('page', String(params.page));
  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

export function searchProviders(api: ApiClient, params: SearchParams) {
  return api.get<SearchResponse>(`/v1/search/providers${buildSearchQuery(params)}`);
}

export function autocomplete(api: ApiClient, prefix: string) {
  return api.get<{ suggestions: Array<{ text: string; kind: string; professionalId: string | null }> }>(
    `/v1/search/autocomplete?q=${encodeURIComponent(prefix)}`,
  );
}

/**
 * Records a profile view.
 *
 * Fire-and-forget on purpose: a failed analytics beacon must never block or
 * delay the page the customer actually asked for.
 */
export function recordProfileView(api: ApiClient, professionalId: string, source: string): void {
  void api.post(`/v1/search/providers/${professionalId}/view`, { source }).catch(() => undefined);
}

// ---------------------------------------------------------------- loyalty

export interface LoyaltySummary {
  balance: number;
  lifetimeEarned: number;
  tier: { slug: string; name: string; thresholdPoints: number } | null;
  nextTier: { slug: string; name: string; thresholdPoints: number } | null;
  pointsToNextTier: number | null;
  percentToNextTier: number | null;
  membership: {
    planId: string;
    planName: string;
    status: string;
    source: string;
    startedAt: string;
    expiresAt: string | null;
  } | null;
  benefits: Array<{ type: string; label: string; config: Record<string, number | string> }>;
}

export interface LoyaltyHistoryEntry {
  id: string;
  points: number;
  basePoints: number;
  multiplierBp: number;
  reason: string;
  createdAt: string;
}

export function loyaltySummary(api: ApiClient) {
  return api.get<LoyaltySummary>('/v1/me/loyalty/summary');
}

export function loyaltyHistory(api: ApiClient, page = 1) {
  return api.get<{ items: LoyaltyHistoryEntry[]; pagination: { page: number; totalPages: number } }>(
    `/v1/me/loyalty/history?page=${page}`,
  );
}

// ----------------------------------------------------------- notifications

export interface NotificationItem {
  id: string;
  category: string;
  title: string;
  body: string;
  deepLink: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationPreference {
  category: string;
  enabled: boolean;
  /** Mandatory categories cannot be disabled; the UI renders them as fixed. */
  mandatory: boolean;
}

export function listNotifications(api: ApiClient, page = 1, unreadOnly = false) {
  return api.get<{
    items: NotificationItem[];
    unreadCount: number;
    pagination: { page: number; totalPages: number; total: number };
  }>(`/v1/me/notifications?page=${page}${unreadOnly ? '&unreadOnly=true' : ''}`);
}

export function unreadCount(api: ApiClient) {
  return api.get<{ unreadCount: number }>('/v1/me/notifications/unread-count');
}

export function markNotificationRead(api: ApiClient, id: string) {
  return api.post<{ read: boolean; unreadCount: number }>(`/v1/me/notifications/${id}/read`);
}

export function markAllNotificationsRead(api: ApiClient) {
  return api.post<{ marked: number; unreadCount: number }>('/v1/me/notifications/read-all');
}

export function notificationPreferences(api: ApiClient) {
  return api.get<{ preferences: NotificationPreference[] }>('/v1/me/notifications/preferences');
}

export function updateNotificationPreferences(api: ApiClient, preferences: Record<string, boolean>) {
  return api.patch<{ preferences: NotificationPreference[] }>('/v1/me/notifications/preferences', { preferences });
}

// ----------------------------------------------------------------- journey

export interface BeautyProfile {
  preferredCityId: string | null;
  preferredSpecialtyIds: string[];
  budgetMinToman: number | null;
  budgetMaxToman: number | null;
  /** Private to its author. Never sent to an AI provider (ADR-019). */
  notes: string | null;
}

export interface BeautyGoal {
  id: string;
  title: string;
  specialtyId: string | null;
  cityId: string | null;
  budgetToman: number | null;
  targetDate: string | null;
  status: 'active' | 'achieved' | 'abandoned';
  createdAt: string;
}

export interface TimelineEntry {
  type: string;
  label: string;
  sourceType: string;
  sourceId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export function journeyProfile(api: ApiClient) {
  return api.get<BeautyProfile>('/v1/me/journey/profile');
}

export function updateJourneyProfile(api: ApiClient, patch: Partial<BeautyProfile>) {
  return api.patch<BeautyProfile>('/v1/me/journey/profile', patch);
}

export function journeyGoals(api: ApiClient) {
  return api.get<BeautyGoal[]>('/v1/me/journey/goals');
}

export function createJourneyGoal(api: ApiClient, goal: { title: string; budgetToman?: number; targetDate?: string }) {
  return api.post<{ id: string; title: string; status: string }>('/v1/me/journey/goals', goal);
}

export function updateGoalStatus(api: ApiClient, id: string, status: BeautyGoal['status']) {
  return api.patch<{ id: string; status: string }>(`/v1/me/journey/goals/${id}`, { status });
}

export function journeyTimeline(api: ApiClient, page = 1) {
  return api.get<{ items: TimelineEntry[]; pagination: { page: number; totalPages: number } }>(
    `/v1/me/journey/timeline?page=${page}`,
  );
}
