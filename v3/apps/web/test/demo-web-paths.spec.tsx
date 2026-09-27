import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProBookingsPage from '@/app/pro/bookings/page';
import ProReviewsPage from '@/app/pro/reviews/page';
import { BookingReviewPanel } from '@/components/booking-review-panel';
import { ApiClient } from '@/lib/api-client';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/pro/bookings',
}));

/**
 * DEMO BRANCH ONLY — the three web paths the API already served with no
 * screen: the customer's review, the professional's reply, the professional's
 * cancellation. Each sends exactly the existing contract, shows the server's
 * own refusal, and reads the server's state back rather than trusting itself.
 */

const HOUR = 3_600_000;
const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
const fail = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });

let sent: Array<{ method: string; url: string; body: unknown }>;
function capture(url: string, init?: RequestInit) {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && !url.includes('/v1/auth/refresh')) sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
  return method;
}

beforeEach(() => {
  sent = [];
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('customer review of a completed booking', () => {
  const api = new ApiClient({ baseUrl: 'http://api.test/api', getAccessToken: () => 't' });

  it('needs a rating before sending; sends { rating, comment } to the booking’s review route', async () => {
    const onSaved = jest.fn();
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      capture(url, init);
      return ok({ id: 'r1', rating: 4, comment: 'خوب بود', response: null, createdAt: '2026-09-27T00:00:00.000Z' });
    }) as unknown as typeof fetch;
    render(<BookingReviewPanel api={api} bookingId="b1" existing={null} onSaved={onSaved} />);

    const submit = screen.getByTestId('review-submit');
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: '۴' }));
    await userEvent.type(screen.getByLabelText('توضیح (اختیاری)'), '  خوب بود  ');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent).toEqual([{ method: 'POST', url: 'http://api.test/api/v1/bookings/b1/review', body: { rating: 4, comment: 'خوب بود' } }]);
  });

  it('shows the server’s refusal in its own words (e.g. a second review)', async () => {
    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      capture(url, init);
      return fail(409, 'REVIEW_ALREADY_EXISTS', 'برای این رزرو قبلاً دیدگاه ثبت شده است.');
    }) as unknown as typeof fetch;
    render(<BookingReviewPanel api={api} bookingId="b1" existing={null} onSaved={jest.fn()} />);
    await userEvent.click(screen.getByRole('radio', { name: '۵' }));
    await userEvent.click(screen.getByTestId('review-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('قبلاً دیدگاه ثبت شده است');
  });

  it('an existing review is shown (with the reply), never a second form', () => {
    render(
      <BookingReviewPanel
        api={api}
        bookingId="b1"
        existing={{
          id: 'r1',
          bookingId: 'b1',
          professionalId: 'p1',
          status: 'published',
          rating: 3,
          comment: 'معمولی',
          response: { text: 'ممنون از نظرتان', respondedAt: null },
          createdAt: '2026-09-27T00:00:00.000Z',
        }}
        onSaved={jest.fn()}
      />,
    );
    expect(screen.getByTestId('review-existing')).toHaveTextContent('۳ از ۵');
    expect(screen.getByTestId('review-response')).toHaveTextContent('ممنون از نظرتان');
    expect(screen.queryByTestId('review-form')).toBeNull();
  });
});

const PROFILE = { id: 'prof-1', displayName: 'سالن', bio: null, cityId: null, specialties: [], verificationStatus: 'verified', createdAt: new Date().toISOString() };
function proBase(url: string) {
  if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
  if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: [], capabilities: [] });
  if (url.includes('/v1/me/provider')) return ok(PROFILE);
  if (url.includes('/v1/me/professional-bookings/upcoming-count')) return ok({ upcomingCount: 1 });
  return null;
}
const renderPro = (page: React.ReactElement) =>
  render(
    <AuthProvider>
      <ProProvider>{page}</ProProvider>
    </AuthProvider>,
  );

describe('the professional’s reply to reviews', () => {
  it('says honestly when there are no reviews (no "coming soon")', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) => proBase(url) ?? ok([]));
    renderPro(<ProReviewsPage />);
    expect(await screen.findByText(/هنوز نظری برای شما ثبت نشده است/)).toBeInTheDocument();
  });

  it('replies through the respond route and shows the server’s list afterwards; editing pre-fills the reply', async () => {
    let reply: string | null = null;
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
      const method = capture(url, init);
      const base = proBase(url);
      if (base) return base;
      if (method === 'POST' && url.includes('/respond')) {
        reply = (JSON.parse(String(init?.body)) as { text: string }).text;
        return ok({});
      }
      if (url.includes('/v1/providers/prof-1/reviews'))
        return ok([{ id: 'r1', rating: 5, comment: 'عالی', response: reply ? { text: reply, respondedAt: null } : null, createdAt: '2026-09-27T00:00:00.000Z' }]);
      return ok([]);
    });
    renderPro(<ProReviewsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'پاسخ دادن' }));
    await user.type(screen.getByLabelText('پاسخ شما'), 'سپاس از شما');
    await user.click(screen.getByTestId('pro-review-save'));

    expect(await screen.findByTestId('pro-review-reply')).toHaveTextContent('سپاس از شما');
    expect(sent).toEqual([{ method: 'POST', url: expect.stringContaining('/v1/providers/prof-1/reviews/r1/respond'), body: { text: 'سپاس از شما' } }]);

    await user.click(screen.getByRole('button', { name: 'ویرایش پاسخ' }));
    expect(screen.getByLabelText('پاسخ شما')).toHaveValue('سپاس از شما');
  });

  it('a refusal is shown in the server’s words and the list is unchanged', async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
      const method = capture(url, init);
      const base = proBase(url);
      if (base) return base;
      if (method === 'POST' && url.includes('/respond')) return fail(404, 'NOT_FOUND_OR_NOT_YOURS', 'یافت نشد.');
      if (url.includes('/v1/providers/prof-1/reviews'))
        return ok([{ id: 'r1', rating: 5, comment: 'عالی', response: null, createdAt: '2026-09-27T00:00:00.000Z' }]);
      return ok([]);
    });
    renderPro(<ProReviewsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'پاسخ دادن' }));
    await user.type(screen.getByLabelText('پاسخ شما'), 'متن');
    await user.click(screen.getByTestId('pro-review-save'));
    expect(await screen.findByText('یافت نشد.')).toBeInTheDocument();
    expect(screen.queryByTestId('pro-review-reply')).toBeNull();
  });
});

describe('the professional’s cancellation', () => {
  function booking(id: string, status: string, hours: number) {
    return {
      id,
      customerId: 'c1',
      customerDisplayName: 'مریم',
      professionalId: 'prof-1',
      serviceId: null,
      slotId: `slot-${id}`,
      startAt: new Date(Date.now() + hours * HOUR).toISOString(),
      endAt: new Date(Date.now() + (hours + 1) * HOUR).toISOString(),
      status,
      holdExpiresAt: null,
      rescheduleCount: 0,
      cancellationReason: null,
      createdAt: new Date().toISOString(),
    };
  }

  it('offers «لغو نوبت» only on a live booking ahead; confirms first; sends the cancel and shows the server’s state', async () => {
    const live = booking('b-live', 'confirmed', 48);
    const done = booking('b-done', 'completed', -48);
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
      const method = capture(url, init);
      const base = proBase(url);
      if (base) return base;
      if (method === 'POST' && url.includes('/v1/bookings/b-live/cancel')) return ok({ ...live, status: 'cancelled' });
      if (url.includes('/v1/me/professional-bookings')) return ok([live, done]);
      return ok([]);
    });
    renderPro(<ProBookingsPage />);
    const user = userEvent.setup();
    const row = (await screen.findAllByText('مشتری: مریم'))[0].closest('[data-booking]') as HTMLElement;
    expect(row.getAttribute('data-booking')).toBe('b-live');

    await user.click(within(row).getByRole('button', { name: 'لغو نوبت' }));
    // Nothing is sent before the confirmation.
    expect(sent).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'بله، لغو کن' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: 'POST', url: expect.stringContaining('/v1/bookings/b-live/cancel'), body: { reason: 'لغو توسط متخصص' } });
    expect(await screen.findByText('نوبت لغو شد.')).toBeInTheDocument();
  });

  it('a completed booking offers no cancel', async () => {
    const done = booking('b-done', 'completed', -48);
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      const base = proBase(url);
      if (base) return base;
      if (url.includes('/v1/me/professional-bookings')) return ok([done]);
      return ok([]);
    });
    renderPro(<ProBookingsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /گذشته/ }));
    const row = (await screen.findByText('مشتری: مریم')).closest('[data-booking]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'لغو نوبت' })).toBeNull();
  });

  it('a refusal (e.g. the customer cancelled first) shows the server’s words and re-reads the list', async () => {
    const live = booking('b-live', 'confirmed', 48);
    let reads = 0;
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
      const method = capture(url, init);
      const base = proBase(url);
      if (base) return base;
      if (method === 'POST' && url.includes('/cancel')) return fail(409, 'INVALID_BOOKING_TRANSITION', 'این رزرو دیگر قابل لغو نیست.');
      if (url.includes('/v1/me/professional-bookings')) {
        reads += 1;
        return ok([live]);
      }
      return ok([]);
    });
    renderPro(<ProBookingsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'لغو نوبت' }));
    const before = reads;
    await user.click(await screen.findByRole('button', { name: 'بله، لغو کن' }));
    expect(await screen.findByText('این رزرو دیگر قابل لغو نیست.')).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });
});
