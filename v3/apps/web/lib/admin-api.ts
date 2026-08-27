import type { ApiClient } from './api-client';

/**
 * The admin surface's API layer.
 *
 * Every type here was read off the controller that returns it, not written
 * from memory. Task 1 shipped two types that declared fields the API never
 * returns -- `OutstandingOrder.occurredAt` and `SeriesResponse.value` -- and
 * both typechecked, because a hand-written response type is an ASSERTION about
 * the server rather than a check of it. The compiler faithfully verified the UI
 * against a shape that was wrong, and only a browser caught it.
 *
 * Security note, stated once for the whole file: nothing here is a security
 * boundary. Every route below is gated server-side by
 * `@RequireCapability('bc_manage_platform')` or `'bc_moderate_verification'`,
 * and the privileged ones are re-checked against live role data on every
 * request -- so a revoked operator is refused even holding a valid token. The
 * frontend hides what it cannot use; the API refuses it.
 */

// ------------------------------------------------------------------ roles

export interface AdminRole {
  slug: string;
  name: string;
  description: string;
  isPrivileged: boolean;
  isDefault: boolean;
}

export interface AdminCapability {
  slug: string;
  description: string;
  isPrivileged: boolean;
}

export interface AdminUserSummary {
  id: string;
  phone: string;
  displayName: string | null;
  roles: string[];
  createdAt: string;
}

export interface ResolvedAccess {
  roles: string[];
  capabilities: string[];
}

export function roleCatalogue(api: ApiClient) {
  return api.get<{ roles: AdminRole[]; capabilities: AdminCapability[] }>('/v1/admin/users/roles/catalogue');
}

/** Exact phone match only -- the server deliberately offers no partial search. */
export function findUserByPhone(api: ApiClient, phone: string) {
  return api.get<AdminUserSummary[]>(`/v1/admin/users?phone=${encodeURIComponent(phone)}`);
}

export function mutateUserRole(
  api: ApiClient,
  userId: string,
  input: { roleSlug: string; operation: 'grant' | 'revoke'; reason: string },
) {
  return api.post<ResolvedAccess>(`/v1/admin/users/${userId}/roles`, input);
}

// -------------------------------------------------------------- audit log

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  before: Record<string, string | number | boolean | null> | null;
  after: Record<string, string | number | boolean | null> | null;
  reason: string | null;
  correlationId: string | null;
  createdAt: string;
}

export function auditLog(
  api: ApiClient,
  params: { page?: number; limit?: number; action?: string; targetType?: string; actorUserId?: string } = {},
) {
  const query = new URLSearchParams();
  query.set('page', String(params.page ?? 1));
  query.set('limit', String(params.limit ?? 25));
  if (params.action) query.set('action', params.action);
  if (params.targetType) query.set('targetType', params.targetType);
  if (params.actorUserId) query.set('actorUserId', params.actorUserId);
  return api.get<AuditEntry[]>(`/v1/admin/audit-log?${query.toString()}`);
}

export function auditActions(api: ApiClient) {
  return api.get<string[]>('/v1/admin/audit-log/actions');
}

// ----------------------------------------------------------- verification

export interface VerificationQueueItem {
  id: string;
  professionalId: string;
  status: 'pending' | 'approved' | 'rejected';
  note: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  displayName: string;
  cityId: string | null;
}

export function verificationQueue(api: ApiClient, page = 1, limit = 20) {
  return api.get<VerificationQueueItem[]>(`/v1/admin/verification/queue?page=${page}&limit=${limit}`);
}

export function decideVerification(
  api: ApiClient,
  requestId: string,
  input: { decision: 'approve' | 'reject'; reason: string },
) {
  return api.post<VerificationQueueItem>(`/v1/admin/verification/${requestId}/decide`, input);
}

/** The professional's own side, consumed by `/pro/profile`. */
export interface MyVerificationRequest {
  id: string;
  professionalId: string;
  status: 'pending' | 'approved' | 'rejected';
  note: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
}

export function myVerification(api: ApiClient) {
  return api.get<MyVerificationRequest | null>('/v1/verification/me');
}

export function submitVerification(api: ApiClient, note?: string) {
  return api.post<MyVerificationRequest>('/v1/verification/submit', note ? { note } : {});
}

// -------------------------------------------------------- phone conflicts

export interface PhoneConflict {
  id: string;
  phone: string;
  existingUserId: string;
  note: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export function phoneConflicts(api: ApiClient, params: { page?: number; includeResolved?: boolean } = {}) {
  const query = new URLSearchParams();
  query.set('page', String(params.page ?? 1));
  query.set('limit', '25');
  if (params.includeResolved) query.set('includeResolved', 'true');
  return api.get<PhoneConflict[]>(`/v1/admin/phone-conflicts?${query.toString()}`);
}

export function resolvePhoneConflict(api: ApiClient, id: string, reason: string) {
  return api.post<PhoneConflict>(`/v1/admin/phone-conflicts/${id}/resolve`, { reason });
}

// --------------------------------------------------------------- finance

/** `LedgerService.platformTotals()` -- three fields, no more. */
export interface PlatformTotals {
  commissionToman: number;
  receivableToman: number;
  orderCount: number;
}

export function platformTotals(api: ApiClient) {
  return api.get<PlatformTotals>('/v1/admin/finance/totals');
}

export interface PartySummary {
  partyType: string;
  partyId: string;
  receivableNetToman: number;
  settledToman: number;
  outstandingToman: number;
}

export function partySummary(api: ApiClient, partyType: 'professional' | 'business', partyId: string) {
  return api.get<PartySummary>(
    `/v1/admin/finance/parties/summary?partyType=${partyType}&partyId=${encodeURIComponent(partyId)}`,
  );
}

/** Two fields, and no date -- the shape Task 1's browser QA corrected. */
export interface PartyOutstandingOrder {
  orderId: string;
  outstandingToman: number;
}

export function partyOutstandingOrders(api: ApiClient, partyType: 'professional' | 'business', partyId: string) {
  return api.get<PartyOutstandingOrder[]>(
    `/v1/admin/finance/parties/outstanding-orders?partyType=${partyType}&partyId=${encodeURIComponent(partyId)}`,
  );
}

export function createSettlement(
  api: ApiClient,
  input: {
    partyType: 'professional' | 'business';
    partyId: string;
    orderIds: string[];
    method?: string;
    reference?: string;
    note?: string;
  },
) {
  return api.post<{ id: string; amountToman: number; createdAt: string }>('/v1/admin/finance/settlements', input);
}

export function reverseSettlement(api: ApiClient, settlementId: string, reason: string) {
  return api.post<{ id: string; reversesSettlementId: string; amountToman: number }>(
    `/v1/admin/finance/settlements/${settlementId}/reverse`,
    { reason },
  );
}

// ---------------------------------------------------------------- search

export interface SearchIndexStatus {
  physicalIndex: string;
  pendingDocuments: number;
  stalePendingOverFiveMinutes: number;
  [key: string]: unknown;
}

export function searchStatus(api: ApiClient) {
  return api.get<SearchIndexStatus>('/v1/admin/search/status');
}

export function reindexSearch(api: ApiClient) {
  return api.post<{ indexed: number; physicalIndex: string }>('/v1/admin/search/reindex');
}

export function rebuildSearchProjection(api: ApiClient) {
  return api.post<{ projectionRows: number; indexed: number; physicalIndex: string }>(
    '/v1/admin/search/rebuild-projection',
  );
}

// --------------------------------------------------------- notifications

export interface NotificationStatus {
  channels: Array<{ channel: string; providerVerified: boolean }>;
  deadLetters: {
    total: number;
    items: Array<{
      id: string;
      category: string;
      channel: string;
      templateKey: string;
      errorCode: string | null;
      attempts: number;
      deadLetteredAt: string | null;
    }>;
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

export function notificationStatus(api: ApiClient, page = 1) {
  return api.get<NotificationStatus>(`/v1/admin/notifications/status?page=${page}&limit=20`);
}

export function retryDueNotifications(api: ApiClient) {
  return api.post<{ attempted: number; sent: number; deadLettered: number }>('/v1/admin/notifications/retry-due');
}

// --------------------------------------------------------------- loyalty

export interface LoyaltyPolicy {
  policy: Record<string, number>;
  tierQualificationBasis: string;
  /** GAP-10: which values are still V2's placeholders rather than a business decision. */
  unresolvedBusinessDecisions: string[];
}

export function loyaltyPolicy(api: ApiClient) {
  return api.get<LoyaltyPolicy>('/v1/admin/loyalty/policy');
}

// ------------------------------------------------------------- analytics

export interface Metric {
  key: string;
  value: number;
  kind: string;
  note?: string;
}

export interface PlatformMetrics {
  range: { from: string; to: string };
  search: {
    searches: Metric;
    emptyResultSearches: Metric;
    emptyResultRate: Metric;
    degradedSearches: Metric;
    searchSourcedViews: Metric;
    clickThroughRate: Metric;
  };
  bookings: { created: Metric; completed: Metric };
  commerce: { ordersPaid: Metric; grossToman: Metric; refundedToman: Metric };
  notifications: { sent: Metric; failed: Metric; deadLettered: Metric; read: Metric; readRate: Metric };
  loyalty: { pointsEarned: Metric; tierChanges: Metric; membershipsActivated: Metric };
}

export function platformMetrics(api: ApiClient, range: { from?: string; to?: string } = {}) {
  const query = new URLSearchParams();
  if (range.from) query.set('from', range.from);
  if (range.to) query.set('to', range.to);
  const suffix = query.toString();
  return api.get<PlatformMetrics>(`/v1/admin/analytics${suffix ? `?${suffix}` : ''}`);
}
