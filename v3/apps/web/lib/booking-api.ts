import { zonedIsoDate, zonedIsoTime } from '@beauclick/persian-utils';

import type { ApiClient } from './api-client';

/**
 * The Phase 2 API surface the customer booking flow uses.
 *
 * Note what these types deliberately do NOT contain: no price field on any
 * REQUEST. The client names what it wants (professional, service, slot) and
 * every monetary figure comes back from the server, computed by the pricing
 * engine from the professional's own catalogue. A price the browser could
 * send is a price an attacker can choose.
 */

export interface ProviderSummary {
  id: string;
  displayName: string;
  bio: string | null;
  cityId: string | null;
  specialties: { id: string; name: string }[];
  verificationStatus: string;
}

export interface ServiceOffering {
  id: string;
  professionalId: string;
  name: string;
  durationMinutes: number;
  priceToman: number;
}

export interface AvailableSlot {
  id: string;
  serviceId: string | null;
  startAt: string;
  endAt: string;
}

export interface BookingSummary {
  id: string;
  /**
   * Present on every booking response -- `toBookingShape` has always included
   * it -- but it was missing from this type until the professional surface
   * needed it. A raw identity id is the ONLY thing the booking API exposes
   * about the customer: no name, no phone, by design.
   */
  customerId: string;
  professionalId: string;
  serviceId: string | null;
  slotId: string;
  startAt: string;
  endAt: string;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'expired' | 'no_show';
  holdExpiresAt: string | null;
  rescheduleCount: number;
  cancellationReason: string | null;
  createdAt: string;
}

export interface OrderAdjustment {
  ruleKey: string;
  kind: 'discount' | 'fee';
  code: string | null;
  label: string;
  amountToman: number;
}

export interface OrderDetail {
  id: string;
  sourceType: string;
  sourceId: string;
  status: 'pending' | 'paid' | 'partially_refunded' | 'refunded' | 'cancelled';
  currency: string;
  subtotalToman: number;
  discountTotalToman: number;
  feeTotalToman: number;
  totalToman: number;
  refundedTotalToman: number;
  paidAt: string | null;
  createdAt: string;
  items: { id: string; name: string; quantity: number; unitPriceToman: number; lineTotalToman: number }[];
  adjustments: OrderAdjustment[];
}

export interface CheckoutResponse {
  booking: BookingSummary | null;
  order: OrderDetail;
  payment: { intentId: string; redirectUrl: string | null };
}

export const bookingApi = {
  listProviders: (api: ApiClient) => api.get<ProviderSummary[]>('/v1/providers'),

  getProvider: (api: ApiClient, id: string) => api.get<ProviderSummary>(`/v1/providers/${id}`),

  listServices: (api: ApiClient, id: string) => api.get<ServiceOffering[]>(`/v1/providers/${id}/services`),

  listAvailability: (api: ApiClient, id: string, serviceId?: string | null) =>
    api.get<AvailableSlot[]>(`/v1/providers/${id}/availability${serviceId ? `?serviceId=${serviceId}` : ''}`),

  /**
   * `Idempotency-Key` travels as a header rather than in the body, so a
   * double-clicked "confirm" or a retried request converges on ONE booking
   * instead of claiming a second slot. The key is generated once per
   * checkout attempt and reused across retries of that attempt.
   */
  createBooking: (
    api: ApiClient,
    body: { professionalId: string; slotId: string; serviceId?: string },
    idempotencyKey: string,
  ) => api.post<CheckoutResponse>('/v1/bookings', body, { 'Idempotency-Key': idempotencyKey }),

  myBookings: (api: ApiClient) => api.get<BookingSummary[]>('/v1/me/bookings'),

  getOrder: (api: ApiClient, orderId: string) => api.get<OrderDetail>(`/v1/orders/${orderId}`),

  cancelBooking: (api: ApiClient, bookingId: string, reason?: string) =>
    api.post<BookingSummary>(`/v1/bookings/${bookingId}/cancel`, { reason }),

  /**
   * Send the customer back to the gateway for an order whose payment failed
   * (V3.1 Phase F).
   *
   * ORDER-scoped, with no intent id anywhere in the request. That is a
   * deliberate property of the contract rather than a convenience: an intent
   * id in a URL is a payment-domain identifier written into browser history,
   * referrer headers, and every analytics script the result page loads, and it
   * buys nothing the customer's own order id does not already provide. The
   * server resolves which intent this means, from its own records.
   *
   * The body is empty on purpose. There is nothing the client could put in it
   * that the server would read -- not the failure reason, not a retryable
   * flag, not a customer id. Every one of those is derived server-side from
   * the authenticated session and the stored payment record, so a client that
   * lies is answering a question nobody asked it.
   *
   * Returns only `{ redirectUrl }`. Refuses with `PAYMENT_RETRY_NOT_AVAILABLE`
   * and a `reason` from the closed `PAYMENT_RETRY_REFUSALS` set, or with
   * `NOT_FOUND_OR_NOT_YOURS` for an order that is not the caller's -- which is
   * the same answer an order that does not exist gets.
   */
  retryOrderPayment: (api: ApiClient, orderId: string) =>
    api.post<{ redirectUrl: string }>(`/v1/orders/${orderId}/payment/retry`, {}),
};

/**
 * Groups slots by their Tehran-local calendar day.
 *
 * Grouping by the LOCAL day, not by the UTC day, matters here: a 00:30
 * Tehran slot is the previous day in UTC, so a naive grouping would file it
 * under yesterday and show the customer an appointment on the wrong date.
 */
export function groupSlotsByDay(slots: AvailableSlot[]): { dayKey: string; date: Date; slots: AvailableSlot[] }[] {
  const buckets = new Map<string, { date: Date; slots: AvailableSlot[] }>();

  for (const slot of slots) {
    const at = new Date(slot.startAt);
    // `zonedIsoDate` rather than a locally-built `Intl.DateTimeFormat` naming
    // the zone inline -- the fourth copy of that conversion in this repo, and
    // the second in this file. Same reasoning as `slotTimeLabel` below.
    const dayKey = zonedIsoDate(at);

    const bucket = buckets.get(dayKey);
    if (bucket) bucket.slots.push(slot);
    else buckets.set(dayKey, { date: at, slots: [slot] });
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayKey, value]) => ({ dayKey, ...value }));
}

/**
 * Platform-local HH:mm for a slot, so a customer sees the time they will
 * actually turn up at.
 *
 * This was right about the CONCEPT and wrong about the implementation: it built
 * its own `Intl.DateTimeFormat` with the zone name spelled out inline, which
 * made it the third independent copy of the platform-timezone conversion in
 * this repository (`zoned.ts`, booking-service's `platform-time.ts`, and this).
 * Three copies is how two of them end up disagreeing after a change only one of
 * them hears about -- and this one hardcoded the zone rather than reading
 * `PLATFORM_TIMEZONE`, so it would not have heard.
 */
export function slotTimeLabel(iso: string): string {
  return zonedIsoTime(new Date(iso));
}
