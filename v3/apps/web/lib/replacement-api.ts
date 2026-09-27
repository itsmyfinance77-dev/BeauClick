/**
 * DEMO BRANCH ONLY (DEMO-DEC-001 part B) — never merged to master.
 * The customer's replacement offer after a provider-side cancellation.
 */
import type { ApiClient } from './api-client';
import type { OutcomeAcceptance } from './checkout-terms';

export interface ReplacementOfferView {
  status: 'open' | 'used' | 'dismissed';
  offeredAt: string;
  resolvedAt: string | null;
  professionalId: string;
  serviceId: string;
  service: { name: string | null; currentPriceToman: number | null; durationMinutes: number | null; active: boolean };
  provider: { displayName: string | null; active: boolean };
  eligible: boolean;
  ineligibleReason: null | 'service_inactive' | 'provider_inactive';
  activeAttempt: null | { bookingId: string; orderId: string | null; holdExpiresAt: string | null };
  replacementBookingId: string | null;
  originalRefund: null | { executionStatus: string; refundToman: string };
}

export const replacementApi = {
  view: (api: ApiClient, bookingId: string) => api.get<ReplacementOfferView>(`/v1/bookings/${encodeURIComponent(bookingId)}/replacement-offer`),
  dismiss: (api: ApiClient, bookingId: string) =>
    api.post<{ status: 'dismissed' | 'used' }>(`/v1/bookings/${encodeURIComponent(bookingId)}/replacement-offer/dismiss`, {}),
  book: (api: ApiClient, bookingId: string, body: { slotId: string; acceptedPolicy?: OutcomeAcceptance }, idempotencyKey: string) =>
    api.post<{ booking: { id: string } | null; order: { id: string }; payment: { intentId: string | null; redirectUrl: string | null } }>(
      `/v1/bookings/${encodeURIComponent(bookingId)}/replacement-offer/bookings`,
      body,
      { 'Idempotency-Key': idempotencyKey },
    ),
};

export const REFUND_STATUS_FA: Record<string, string> = {
  pending: 'در حال انجام',
  executed: 'انجام شد',
  manual_required: 'نیازمند پیگیری دستی',
  failed: 'ناموفق — پیگیری می‌شود',
};
