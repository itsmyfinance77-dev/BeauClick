/**
 * DEMO BRANCH ONLY — DEMO-DEC-001 B: the customer's replacement-offer panel.
 * A real ApiClient over a fetch mock; the panel's promises are asserted as text
 * because they are the contract with the customer.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReplacementOfferPanel } from '@/components/replacement-offer-panel';
import { ApiClient } from '@/lib/api-client';

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}
function fail(status: number, code: string, message = 'x') {
  return Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });
}

const OPEN = {
  status: 'open',
  offeredAt: '2026-09-27T08:00:00.000Z',
  resolvedAt: null,
  professionalId: 'prof-1',
  serviceId: 'svc-1',
  service: { name: 'میکاپ مجلسی', currentPriceToman: 1_900_000, durationMinutes: 60, active: true },
  provider: { displayName: 'نگار', active: true },
  eligible: true,
  ineligibleReason: null,
  activeAttempt: null,
  replacementBookingId: null,
  originalRefund: { executionStatus: 'executed', refundToman: '1800000' },
};
const SLOTS = [{ id: 'slot-r1', serviceId: 'svc-1', startAt: '2099-10-01T06:30:00.000Z', endAt: '2099-10-01T07:30:00.000Z' }];
const DISCLOSURE = {
  sellerParty: { kind: 'professional', displayName: 'نگار' },
  amounts: { serviceTotalToman: 1_900_000, platformCollectibleNowToman: 1_900_000, venueBalanceToman: 0 },
  slotStartsAt: '2099-10-01T06:30:00.000Z',
  displayTimeZone: 'Asia/Tehran',
  acceptanceRequired: true,
  outcome: {
    cutoffHours: 12,
    cutoffInstant: '2099-09-30T18:30:00.000Z',
    lateCancellationRetention: { kind: 'none' },
    noShowGraceMinutes: 5,
    noShowRetention: { kind: 'none' },
    rescheduleFreeCountBeforeCutoff: 1,
    disputeWindowHours: 36,
    bodilyHarmWindowHours: null,
    appealWindowHours: 48,
    copy: { locale: 'fa-IR', body: 'متن نمونه', bodySha256: 'x', publishedAt: '2026-09-27T00:00:00.000Z' },
  },
  acceptance: { policyKey: 'op', policyVersion: 1, copyKey: 'cc', copyVersion: 1 },
};

let sent: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }>;
function mock(routes: { offer: unknown | 'none'; slots?: unknown[]; book?: () => Promise<unknown> }) {
  sent = [];
  global.fetch = jest.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes('/replacement-offer/bookings')) return routes.book ? routes.book() : ok({ booking: { id: 'b-new' }, order: { id: 'o-new' }, payment: { intentId: 'i', redirectUrl: null } });
    if (url.includes('/replacement-offer/dismiss')) return ok({ status: 'dismissed' });
    if (url.includes('/replacement-offer')) return routes.offer === 'none' ? fail(404, 'REPLACEMENT_OFFER_NOT_FOUND') : ok(routes.offer);
    if (url.includes('/availability')) return ok(routes.slots ?? SLOTS);
    if (url.includes('/v1/checkout/disclosure')) return ok(DISCLOSURE);
    return ok(null);
  }) as unknown as typeof fetch;
}
const api = new ApiClient({ baseUrl: 'http://api.test/api', getAccessToken: () => 't' });
const renderPanel = () => render(<ReplacementOfferPanel api={api} bookingId="b-old" />);

describe('replacement offer panel (DEMO-DEC-001 B)', () => {
  it('renders nothing when there is no offer', async () => {
    mock({ offer: 'none' });
    const { container } = renderPanel();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('states the promise honestly: refund continues, no slot or price guarantee, current price shown', async () => {
    mock({ offer: OPEN });
    renderPanel();
    expect(await screen.findByTestId('replacement-open')).toHaveTextContent('نه تضمین زمان یا قیمت قبلی');
    expect(screen.getByTestId('replacement-refund')).toHaveTextContent('مستقل از این پیشنهاد ادامه دارد');
    expect(screen.getByTestId('replacement-open')).toHaveTextContent('۱٬۹۰۰٬۰۰۰');
  });

  it('requires the NEW terms to be accepted, discloses the new payment, and sends slot + acceptance + one key', async () => {
    mock({ offer: OPEN });
    renderPanel();
    await userEvent.click(await screen.findByRole('radio'));
    expect(await screen.findByTestId('replacement-payment-disclosure')).toHaveTextContent('هیچ مبلغی از رزرو قبلی منتقل نمی‌شود');
    const pay = screen.getByTestId('replacement-pay');
    expect(pay).toBeDisabled();
    const box = (await screen.findByTestId('terms-accept')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await userEvent.click(box);
    expect(pay).toBeEnabled();
    await userEvent.click(pay);
    await waitFor(() => expect(sent.some((r) => r.url.includes('/replacement-offer/bookings'))).toBe(true));
    const req = sent.find((r) => r.url.includes('/replacement-offer/bookings'))!;
    expect(req.body).toEqual({ slotId: 'slot-r1', acceptedPolicy: { policyKey: 'op', policyVersion: 1, copyKey: 'cc', copyVersion: 1 } });
    expect(String(req.headers['Idempotency-Key']).length).toBeGreaterThan(8);
  });

  it('keeps the offer open and says so when there are no free times', async () => {
    mock({ offer: OPEN, slots: [] });
    renderPanel();
    expect(await screen.findByTestId('replacement-no-slots')).toHaveTextContent('پیشنهاد باز می‌ماند');
  });

  it('dismisses only after a confirmation that says the refund continues', async () => {
    mock({ offer: OPEN });
    renderPanel();
    await userEvent.click(await screen.findByTestId('replacement-dismiss'));
    expect(sent.filter((r) => r.url.includes('/dismiss'))).toHaveLength(0);
    expect(screen.getByText(/بازپرداخت ادامه دارد/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('replacement-dismiss-confirm'));
    await waitFor(() => expect(sent.filter((r) => r.url.includes('/dismiss'))).toHaveLength(1));
  });

  it('shows an in-progress attempt with retry and cancel, and never a second booking form', async () => {
    mock({ offer: { ...OPEN, activeAttempt: { bookingId: 'b-try', orderId: 'o-try', holdExpiresAt: null } } });
    renderPanel();
    expect(await screen.findByTestId('replacement-in-progress')).toHaveTextContent('پیشنهاد مصرف نمی‌شود');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'پرداخت دوباره' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'لغو این تلاش' })).toBeInTheDocument();
  });

  it('shows used and unavailable states without any booking control', async () => {
    mock({ offer: { ...OPEN, status: 'used', replacementBookingId: 'b-new', eligible: false } });
    const first = renderPanel();
    expect(await screen.findByTestId('replacement-used')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    first.unmount();

    mock({ offer: { ...OPEN, eligible: false, ineligibleReason: 'service_inactive', service: { ...OPEN.service, active: false } } });
    renderPanel();
    expect(await screen.findByTestId('replacement-unavailable')).toHaveTextContent('پیشنهاد باز می‌ماند');
    expect(screen.getByTestId('replacement-refund')).toBeInTheDocument();
  });

  it('a refused attempt reloads the offer and the live times instead of leaving a stale selection', async () => {
    mock({ offer: OPEN, book: () => fail(409, 'SLOT_UNAVAILABLE', 'این زمان دیگر آزاد نیست.') });
    renderPanel();
    await userEvent.click(await screen.findByRole('radio'));
    await userEvent.click(await screen.findByTestId('terms-accept'));
    await userEvent.click(screen.getByTestId('replacement-pay'));
    expect(await screen.findByText('این زمان دیگر آزاد نیست.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('replacement-payment-disclosure')).not.toBeInTheDocument());
  });
});
