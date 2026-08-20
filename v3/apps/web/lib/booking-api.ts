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
    const dayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);

    const bucket = buckets.get(dayKey);
    if (bucket) bucket.slots.push(slot);
    else buckets.set(dayKey, { date: at, slots: [slot] });
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayKey, value]) => ({ dayKey, ...value }));
}

/** Tehran-local HH:mm for a slot, so a customer sees the time they will actually turn up at. */
export function slotTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
