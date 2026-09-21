import { formatZonedTime, zonedIsoDate } from '@beauclick/persian-utils';

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

/**
 * A stored image, as the media pipeline describes it.
 *
 * `url` is null for a protected object by construction, not by omission —
 * so a null url is "no picture to show", never "the field is missing".
 */
export interface MediaDescriptor {
  id: string;
  url: string | null;
  contentType: string | null;
  width: number | null;
  height: number | null;
}

export interface ProviderSummary {
  id: string;
  displayName: string;
  bio: string | null;
  cityId: string | null;
  specialties: { id: string; name: string }[];
  verificationStatus: string;
  /**
   * Four fields the server has returned all along and this type did not
   * name, so no surface could use them: the profile imagery, the rating
   * aggregate, the caller's own saved state, and when the professional
   * joined. Each is always present with an explicit null rather than
   * optional, which is how the server defines them.
   */
  images: { avatar: MediaDescriptor | null; cover: MediaDescriptor | null };
  /** `average` is null when `count` is 0 — never 0, which would be a rating. */
  rating: { average: number | null; count: number };
  /** `null` for an anonymous visitor: not "unsaved", but "no caller to answer for". */
  saved: boolean | null;
  createdAt: string;
}

/** One picture of this professional's work. */
export interface PortfolioItem {
  id: string;
  caption: string | null;
  position: number;
  media: MediaDescriptor | null;
  createdAt: string;
}

/** A launched city, from the public reference list. */
export interface CityRef {
  id: string;
  name: string;
}

export interface ServiceOffering {
  id: string;
  professionalId: string;
  name: string;
  durationMinutes: number;
  priceToman: number;
  /** The caller's own saved state for THIS service — independent of the professional's. */
  saved?: boolean | null;
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

/**
 * The order's collection schedule — V3.3 `#41a`.
 *
 * All three amounts are served by the API and rendered as given. The client
 * never derives one from another: a split computed here could be computed from
 * a stale total or a wrong rounding assumption, and would show a number the
 * server never agreed to.
 *
 * Today every order is `full_payment_online`, so `venueBalanceToman` is `0` and
 * `platformCollectibleNowToman` equals `serviceTotalToman`. That is the honest
 * current state rather than a placeholder.
 */
export interface OrderPaymentSchedule {
  collectionMode: 'pay_at_venue' | 'deposit_online_balance_at_venue' | 'full_payment_online';
  serviceTotalToman: number;
  platformCollectibleNowToman: number;
  venueBalanceToman: number;
}

export interface OrderDetail {
  id: string;
  sourceType: string;
  sourceId: string;
  /**
   * `online_collection_not_required` is V3.3 `#41b`: BeauClick collects nothing
   * online for this order. It is not paid, not free and not settled — a venue
   * balance may still be owed to the seller.
   */
  status:
    | 'pending'
    | 'paid'
    | 'partially_refunded'
    | 'refunded'
    | 'cancelled'
    | 'online_collection_not_required'
    | 'online_collection_completed';
  currency: string;
  subtotalToman: number;
  discountTotalToman: number;
  feeTotalToman: number;
  totalToman: number;
  refundedTotalToman: number;
  /**
   * What BeauClick actually collected — V3.3 `#41c`. A server fact, never
   * derived here: the client must not subtract schedule amounts to reach it.
   */
  collectedTotalToman: number;
  paidAt: string | null;
  createdAt: string;
  items: { id: string; name: string; quantity: number; unitPriceToman: number; lineTotalToman: number }[];
  adjustments: OrderAdjustment[];
  /** Additive in `#41a`; every field above keeps its existing meaning. */
  paymentSchedule: OrderPaymentSchedule;
}

export interface CheckoutResponse {
  booking: BookingSummary | null;
  order: OrderDetail;
  /**
   * Both keys are always present; both are null when nothing is collected
   * online (V3.3 `#41b`, `V33-DEC-023` Ruling 7). The key is never omitted and
   * `intentId` is never a placeholder — a sentinel id is indistinguishable from
   * a real one at every call site that receives it.
   */
  payment: { intentId: string | null; redirectUrl: string | null };
}

export const bookingApi = {
  listProviders: (api: ApiClient) => api.get<ProviderSummary[]>('/v1/providers'),

  getProvider: (api: ApiClient, id: string) => api.get<ProviderSummary>(`/v1/providers/${id}`),

  listServices: (api: ApiClient, id: string) => api.get<ServiceOffering[]>(`/v1/providers/${id}/services`),

  /** This professional's own pictures of their work. Public, like the profile. */
  listPortfolio: (api: ApiClient, id: string) => api.get<PortfolioItem[]>(`/v1/providers/${id}/portfolio`),

  /**
   * The launched cities, so a profile can name the one its `cityId` points
   * at. The professional shape carries the id and not the name, and a page
   * that shows a raw uuid to a customer is showing them nothing.
   */
  listCities: (api: ApiClient) => api.get<CityRef[]>('/v1/providers/cities'),

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

  /*
    Days ascending, and the SLOTS INSIDE each day ascending too.

    The day sort was here and the slot sort was not, which nothing noticed
    while the old screen rendered slots as a flat list per day in whatever
    order they arrived. The redesigned booking panel renders them as a grid
    a customer reads left to right, and an unsorted grid puts 16:30 before
    09:30. `startAt` is an ISO instant, so a lexical compare is a
    chronological one.
  */
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayKey, value]) => ({
      dayKey,
      ...value,
      slots: [...value.slots].sort((a, b) => a.startAt.localeCompare(b.startAt)),
    }));
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
 *
 * It returns PERSIAN digits, which it did not.
 *
 * The function is named for display and was returning `09:30`; every caller
 * was expected to remember `toPersianDigits` around it. Two did, the third
 * did not, and Latin digits appeared in the middle of a Persian sentence on
 * the booking panel — the same defect class live QA found once before. A
 * display helper that needs a wrapper to be correct is a helper that will be
 * used without one.
 */
export function slotTimeLabel(iso: string): string {
  return formatZonedTime(new Date(iso));
}

/**
 * Upcoming means confirmed or awaiting payment, and in the future.
 *
 * One definition for the dashboard and the bookings list: two copies would
 * eventually disagree about which tab a booking belongs in.
 */
export function isUpcomingBooking(booking: BookingSummary): boolean {
  if (booking.status !== 'confirmed' && booking.status !== 'pending') return false;
  return new Date(booking.startAt).getTime() > Date.now();
}
