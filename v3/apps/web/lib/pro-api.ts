import type { ApiClient } from './api-client';
import type { BookingSummary, ServiceOffering } from './booking-api';

/**
 * The professional operating surface's API layer.
 *
 * Same discipline as `phase3-api.ts`/`phase4-api.ts`: every type here is the
 * PUBLIC response shape a controller actually returns, not an internal entity.
 *
 * One property is worth naming explicitly because it is the security posture
 * of this whole surface: **almost every call below is a `/v1/me/...` route
 * that takes no owner identifier at all.** The professional id is resolved
 * server-side from the verified session, so there is nothing in any request
 * this file builds that a tampered client could point at another
 * professional. The two exceptions -- the provider profile and its service
 * catalogue -- address `/v1/providers/:id/...`, and those routes are guarded
 * by `ProviderOwnerResolver`, which reads the row's real `ownerId` from the
 * database and compares it against the session. The `:id` this file sends is
 * always the one `myProvider()` returned for the caller's own session; a
 * forged one resolves to the same generic NOT_FOUND_OR_NOT_YOURS a
 * nonexistent id gets.
 */

// ------------------------------------------------------------- reference

export interface ReferenceItem {
  id: string;
  name: string;
}

export function listCities(api: ApiClient) {
  return api.get<ReferenceItem[]>('/v1/cities');
}

export function listSpecialties(api: ApiClient) {
  return api.get<ReferenceItem[]>('/v1/specialties');
}

// -------------------------------------------------------------- profile

export interface MyProviderProfile {
  id: string;
  displayName: string;
  bio: string | null;
  cityId: string | null;
  specialties: ReferenceItem[];
  verificationStatus: 'unverified' | 'pending' | 'verified' | 'rejected' | 'suspended' | 'revoked';
  createdAt: string;
}

/** `null` means "you have not created a professional profile", never "the request failed". */
export function myProvider(api: ApiClient) {
  return api.get<MyProviderProfile | null>('/v1/me/provider');
}

export interface ProfileInput {
  displayName: string;
  bio?: string;
  cityId?: string;
  specialtyIds?: string[];
}

export function createProvider(api: ApiClient, input: ProfileInput) {
  return api.post<MyProviderProfile>('/v1/providers', input);
}

export function updateProvider(api: ApiClient, providerId: string, input: Partial<ProfileInput>) {
  return api.patch<MyProviderProfile>(`/v1/providers/${providerId}`, input);
}

// -------------------------------------------------------------- services

export type { ServiceOffering };

export function listMyServices(api: ApiClient, providerId: string) {
  return api.get<ServiceOffering[]>(`/v1/providers/${providerId}/services`);
}

export interface ServiceInput {
  name: string;
  durationMinutes: number;
  priceToman: number;
}

export function createService(api: ApiClient, providerId: string, input: ServiceInput) {
  return api.post<ServiceOffering>(`/v1/providers/${providerId}/services`, input);
}

export function updateService(
  api: ApiClient,
  providerId: string,
  serviceId: string,
  input: Partial<ServiceInput>,
) {
  return api.patch<ServiceOffering>(`/v1/providers/${providerId}/services/${serviceId}`, input);
}

export function deleteService(api: ApiClient, providerId: string, serviceId: string) {
  return api.delete<null>(`/v1/providers/${providerId}/services/${serviceId}`);
}

// ---------------------------------------------------------- availability

/**
 * The professional's own view of a slot, which — unlike the customer-facing
 * one — carries `status`. `held` means another customer is mid-checkout on it
 * right now; `booked` means it is somebody's confirmed appointment.
 */
export interface MySlot {
  id: string;
  professionalId: string;
  serviceId: string | null;
  startAt: string;
  endAt: string;
  status: 'open' | 'held' | 'booked' | 'blocked';
}

/**
 * NOTE the path: the professional's own slot LIST is `GET /v1/me/availability`,
 * not `/v1/me/availability/slots`. Creation is `POST .../slots`, bulk
 * generation is `POST .../bulk` (not `.../slots/bulk`), and deletion is
 * `DELETE .../slots/:id`. Recorded here because the asymmetry is easy to get
 * wrong from memory and the controller is the authority.
 */
export function listMySlots(api: ApiClient, params: { from?: string; to?: string } = {}) {
  const query = new URLSearchParams();
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  const suffix = query.toString();
  return api.get<MySlot[]>(`/v1/me/availability${suffix ? `?${suffix}` : ''}`);
}

/** `startAt`/`endAt` are absolute instants. The caller converts Tehran wall clock to an instant, never the other way round. */
export function createSlot(api: ApiClient, input: { startAt: string; endAt: string; serviceId?: string }) {
  return api.post<MySlot>('/v1/me/availability/slots', input);
}

export interface BulkGenerateInput {
  /** 0 = Sunday .. 6 = Saturday, read in the PLATFORM timezone (Asia/Tehran), not the browser's. */
  weekdays: number[];
  /** `HH:mm` local wall clock in the platform timezone. The server does the conversion. */
  timeStart: string;
  timeEnd: string;
  slotMinutes: number;
  /** `YYYY-MM-DD` platform-local dates, inclusive. */
  dateFrom: string;
  dateTo: string;
  serviceId?: string;
}

export interface BulkGenerateResult {
  created: number;
  skipped: number;
}

export function bulkGenerateSlots(api: ApiClient, input: BulkGenerateInput) {
  return api.post<BulkGenerateResult>('/v1/me/availability/bulk', input);
}

export function deleteSlot(api: ApiClient, slotId: string) {
  return api.delete<null>(`/v1/me/availability/slots/${slotId}`);
}

// -------------------------------------------------------------- bookings

export type { BookingSummary };

export interface BookingHistoryEntry {
  id: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export function listProfessionalBookings(api: ApiClient, page = 1, limit = 20) {
  return api.get<BookingSummary[]>(`/v1/me/professional-bookings?page=${page}&limit=${limit}`);
}

export function bookingHistory(api: ApiClient, bookingId: string) {
  return api.get<BookingHistoryEntry[]>(`/v1/bookings/${bookingId}/history`);
}

export function completeBooking(api: ApiClient, bookingId: string) {
  return api.post<BookingSummary>(`/v1/bookings/${bookingId}/complete`);
}

export function markNoShow(api: ApiClient, bookingId: string) {
  return api.post<BookingSummary>(`/v1/bookings/${bookingId}/no-show`);
}

export function rescheduleBooking(api: ApiClient, bookingId: string, newSlotId: string, reason?: string) {
  return api.post<BookingSummary>(`/v1/bookings/${bookingId}/reschedule`, { newSlotId, reason });
}

// --------------------------------------------------------------- finance

export interface FinanceSummary {
  partyType: 'professional' | 'business';
  receivableNetToman: number;
  settledToman: number;
  outstandingToman: number;
  currency: string;
}

/**
 * EXACTLY what `SettlementService.outstandingOrdersForParty` returns -- two
 * fields, and no date.
 *
 * This type originally also declared `amountToman`, `currency`, and
 * `occurredAt`. None of them exist. TypeScript could not catch it, because a
 * hand-written response type is an ASSERTION about the server, not a check of
 * it: the compiler faithfully verified the UI against a shape that was wrong.
 * `new Date(undefined)` then threw `RangeError: Invalid time value` and the
 * error boundary swallowed the whole finance screen. Found in a real browser;
 * invisible to typecheck, lint, and every mocked test.
 */
export interface OutstandingOrder {
  orderId: string;
  outstandingToman: number;
}

export interface SettlementBatch {
  id: string;
  kind: string;
  amountToman: number;
  currency: string;
  method: string | null;
  reference: string | null;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  entryType: 'commission' | 'receivable';
  amountToman: number;
  currency: string;
  commissionRateBp: number;
  referenceType: string;
  createdAt: string;
}

/**
 * One finance workspace the signed-in seller OWNS -- V3.3 #72,
 * `V33-DEC-020`.
 *
 * `workspaceRef` is opaque and issued by the server. It is NOT a credential:
 * live ownership is re-verified on every request, so it stops working the
 * moment the workspace stops being owned. Never persist it as if it granted
 * anything -- if it stops resolving, re-read the list.
 *
 * One user may own both a professional profile and a business, and each has its
 * own separate financial position. That is why this is a list and not a field.
 */
export interface FinanceWorkspace {
  workspaceRef: string;
  workspaceType: 'professional' | 'business';
}

export interface SettlementPage {
  items: SettlementBatch[];
  nextCursor: string | null;
}

export function financeWorkspaces(api: ApiClient) {
  return api.get<{ items: FinanceWorkspace[] }>('/v1/me/finance/workspaces');
}

export function financeSummary(api: ApiClient, workspaceRef: string) {
  return api.get<FinanceSummary>(`/v1/me/finance/${workspaceRef}/summary`);
}

export function outstandingOrders(api: ApiClient, workspaceRef: string) {
  return api.get<OutstandingOrder[]>(`/v1/me/finance/${workspaceRef}/outstanding-orders`);
}

export function settlements(api: ApiClient, workspaceRef: string) {
  return api.get<SettlementPage>(`/v1/me/finance/${workspaceRef}/settlements`);
}

export function orderLedger(api: ApiClient, workspaceRef: string, orderId: string) {
  return api.get<LedgerEntry[]>(`/v1/me/finance/${workspaceRef}/orders/${orderId}/ledger`);
}

// ------------------------------------------------------------- analytics

export interface Metric {
  key: string;
  value: number;
  kind: string;
}

export interface ProviderMetrics {
  range: { from: string; to: string };
  funnel: {
    created: Metric;
    confirmed: Metric;
    completed: Metric;
    cancelled: Metric;
    expired: Metric;
    profileViews: Metric;
    completionRate: Metric;
  };
  revenue: Record<string, Metric>;
}

/**
 * `MetricsService.dailySeries` returns `{ day, count, sum }` per row -- a COUNT
 * of events and a SUM of their metric value, which are different questions.
 *
 * This type originally said `{ day, value }`. It typechecked (a hand-written
 * response type asserts a shape rather than verifying it), and rendered a
 * literal "undefined" next to every date in the chart. Found in a real
 * browser, same class as `OutstandingOrder` above.
 */
export interface SeriesPoint {
  day: string;
  /** How many events occurred that day. */
  count: number;
  /** The sum of their metric values -- meaningful for money events, 0 for count-only ones. */
  sum: number;
}

export interface SeriesResponse {
  eventType: string;
  points: SeriesPoint[];
}

export function myMetrics(api: ApiClient, range: { from?: string; to?: string } = {}) {
  const query = new URLSearchParams();
  if (range.from) query.set('from', range.from);
  if (range.to) query.set('to', range.to);
  const suffix = query.toString();
  return api.get<ProviderMetrics>(`/v1/me/analytics${suffix ? `?${suffix}` : ''}`);
}

/**
 * The event allow-list is enforced SERVER-side (`SeriesDto`'s `@IsIn`), and is
 * mirrored here only so the picker cannot offer a value the API will reject.
 * This constant is not the security boundary; the DTO is.
 */
export const SERIES_EVENTS = [
  'BookingCreated',
  'BookingCompleted',
  'BookingCancelled',
  'ProviderProfileViewed',
  'OrderPaid',
  'SearchPerformed',
] as const;

export type SeriesEvent = (typeof SERIES_EVENTS)[number];

export function mySeries(api: ApiClient, eventType: SeriesEvent, range: { from?: string; to?: string } = {}) {
  const query = new URLSearchParams({ eventType });
  if (range.from) query.set('from', range.from);
  if (range.to) query.set('to', range.to);
  return api.get<SeriesResponse>(`/v1/me/analytics/series?${query.toString()}`);
}
