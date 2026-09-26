import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatZonedFullDate, formatZonedTime } from '@beauclick/persian-utils';
import ProBookingsPage from '@/app/pro/bookings/page';
import { AuthProvider } from '@/lib/auth-context';
import { ProProvider } from '@/lib/pro-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/pro/bookings',
}));

/**
 * Screen 49, the seller's side — V3.3 #212 over `#42d-read` (#201).
 *
 * What these cases hold the screen to, from the issue's acceptance list:
 *
 *  1. nothing is read for a row until its panel is opened;
 *  2. `statementRequired` drives the form — the client never decides it;
 *  3. no countdown and no permitted instant anywhere in the rendered output;
 *  4. before the permitted moment a SENTENCE stands in place of the control,
 *     not a disabled button;
 *  5. the confirmation states what the declaration does and does not do, in
 *     two columns, and that it cannot be withdrawn;
 *  8. no photo, location or health affordance on the declaration form.
 */

const PROFILE = {
  id: 'prof-1',
  displayName: 'سالن آزمایشی',
  bio: null,
  cityId: 'city-1',
  specialties: [],
  verificationStatus: 'verified',
  createdAt: '2026-09-01T00:00:00.000Z',
};

/** Started 20 minutes ago and still running: on the «پیش‌رو» tab, where the seller is. */
function running(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    customerId: `cust-${id}`,
    customerDisplayName: `مشتری ${id}`,
    professionalId: 'prof-1',
    serviceId: null,
    slotId: `slot-${id}`,
    startAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    endAt: new Date(Date.now() + 40 * 60_000).toISOString(),
    status: 'confirmed',
    holdExpiresAt: null,
    rescheduleCount: 0,
    cancellationReason: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const GOVERNED_PERMITTED = { governed: true, graceMinutes: 15, statementRequired: true, declarationPermitted: true, declaration: null };
const GOVERNED_TOO_EARLY = { governed: true, graceMinutes: 45, statementRequired: true, declarationPermitted: false, declaration: null };
const UNGOVERNED_PERMITTED = { governed: false, graceMinutes: null, statementRequired: false, declarationPermitted: true, declaration: null };

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function refused(status: number, code: string, message: string) {
  return Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });
}

let sent: Array<{ url: string; body: unknown }>;

function mockApi(options: {
  bookings: unknown[];
  noShow?: (bookingId: string) => Promise<unknown>;
  declare?: (bookingId: string, body: unknown) => Promise<unknown>;
}) {
  sent = [];
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['professional'], capabilities: [] });
    if (url.includes('/v1/me/provider')) return ok(PROFILE);
    if (url.includes('/upcoming-count')) return ok({ upcomingCount: 1 });
    if (url.includes('/v1/me/professional-bookings')) return ok(options.bookings);
    const noShow = url.match(/\/v1\/bookings\/([^/]+)\/no-show$/);
    if (noShow && method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ url, body });
      return options.declare ? options.declare(noShow[1], body) : ok({ ...running(noShow[1]), status: 'no_show' });
    }
    if (noShow) return options.noShow ? options.noShow(noShow[1]) : ok(GOVERNED_PERMITTED);
    return ok([]);
  });
}

const noShowReads = () =>
  (global.fetch as jest.Mock).mock.calls.filter(
    (call) => /\/no-show$/.test(String(call[0])) && ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET',
  );

function renderPage() {
  return render(
    <AuthProvider>
      <ProProvider>
        <ProBookingsPage />
      </ProProvider>
    </AuthProvider>,
  );
}

/** `waitFor` retries only on a throw, so a missing row has to throw. */
function rowOf(bookingId: string) {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-booking="${bookingId}"]`);
    if (!found) throw new Error(`row ${bookingId} not rendered`);
    return found;
  });
}

async function openPanel(user: ReturnType<typeof userEvent.setup>, bookingId: string) {
  const row = await rowOf(bookingId);
  await user.click(within(row).getByRole('button', { name: 'عدم حضور مشتری' }));
  return row;
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('screen 49 — the seller’s no-show declaration (#212)', () => {
  it('reads nothing for any row until that row’s panel is opened, then reads only that row', async () => {
    mockApi({ bookings: [running('b1'), running('b2'), running('b3')] });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(document.querySelectorAll('[data-booking]')).toHaveLength(3));
    expect(noShowReads()).toHaveLength(0);

    await openPanel(user, 'b2');
    await screen.findByTestId('no-show-permitted');
    expect(noShowReads().map((call) => String(call[0]))).toEqual([expect.stringMatching(/\/v1\/bookings\/b2\/no-show$/)]);
  });

  it('offers the panel on confirmed and no-show rows only — not on completed or cancelled ones', async () => {
    mockApi({
      bookings: [
        running('conf'),
        running('done', { status: 'completed', startAt: '2026-09-01T06:00:00.000Z', endAt: '2026-09-01T07:00:00.000Z' }),
        running('gone', { status: 'cancelled', startAt: '2026-09-02T06:00:00.000Z', endAt: '2026-09-02T07:00:00.000Z' }),
      ],
    });
    const user = userEvent.setup();
    renderPage();

    const conf = await rowOf('conf');
    expect(within(conf).getByRole('button', { name: 'عدم حضور مشتری' })).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('tab', { name: /گذشته/ }));
    const done = await rowOf('done');
    expect(within(done).queryByRole('button', { name: 'عدم حضور مشتری' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: /لغوشده/ }));
    const gone = await rowOf('gone');
    expect(within(gone).queryByRole('button', { name: 'عدم حضور مشتری' })).toBeNull();
  });

  describe('before the permitted moment', () => {
    it('puts a sentence where the control would be — no button, disabled or otherwise — and states the booking’s own grace', async () => {
      mockApi({ bookings: [running('b1')], noShow: () => ok(GOVERNED_TOO_EARLY) });
      const user = userEvent.setup();
      renderPage();
      const row = await openPanel(user, 'b1');

      const sentence = await screen.findByTestId('no-show-too-early');
      expect(sentence).toHaveAttribute('role', 'status');
      expect(sentence).toHaveTextContent('هنوز ممکن نیست');
      expect(sentence).toHaveTextContent('۴۵ دقیقه');
      expect(within(row).queryByRole('button', { name: 'اعلام عدم حضور' })).toBeNull();
      expect(row.querySelectorAll('button[disabled]')).toHaveLength(0);
    });

    it('renders no countdown and no permitted instant anywhere', async () => {
      const booking = running('b1');
      mockApi({ bookings: [booking], noShow: () => ok(GOVERNED_TOO_EARLY) });
      const user = userEvent.setup();
      renderPage();
      await openPanel(user, 'b1');
      await screen.findByTestId('no-show-too-early');

      // The instant the server would permit it (start + grace) is never
      // computed, so it cannot appear — neither can any "time left" phrasing.
      const permittedAt = formatZonedTime(new Date(new Date(booking.startAt).getTime() + 45 * 60_000));
      const text = document.body.textContent ?? '';
      expect(text).not.toContain(permittedAt);
      expect(text).not.toMatch(/مانده|ثانیه|شمارش|\d{1,2}:\d{2}:\d{2}/);
      expect(document.querySelector('[role="timer"]')).toBeNull();
    });

    it('states the rule without a number when the booking carries no terms', async () => {
      mockApi({
        bookings: [running('b1')],
        noShow: () => ok({ ...UNGOVERNED_PERMITTED, declarationPermitted: false }),
      });
      const user = userEvent.setup();
      renderPage();
      await openPanel(user, 'b1');

      const sentence = await screen.findByTestId('no-show-too-early');
      expect(sentence).toHaveTextContent('پس از پایان زمان نوبت');
      expect(sentence.textContent).not.toMatch(/[۰-۹]/);
    });
  });

  describe('the declaration, on a governed booking', () => {
    it('confirms in two columns — what it does and does not do — and says it cannot be withdrawn, before sending anything', async () => {
      mockApi({ bookings: [running('b1')] });
      const user = userEvent.setup();
      renderPage();
      await openPanel(user, 'b1');
      await user.click(await screen.findByRole('button', { name: 'اعلام عدم حضور' }));

      const dialog = await screen.findByRole('dialog', { name: 'عدم حضور را اعلام می‌کنید' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      const columns = within(dialog).getByTestId('no-show-consequences');
      expect(dialog).toHaveAttribute('aria-describedby', columns.id);

      const [does, doesNot] = within(columns).getAllByRole('region');
      expect(within(does).getByRole('heading')).toHaveTextContent('این اعلام چه می‌کند');
      expect(does).toHaveTextContent('یک ثبت دائمی');
      expect(does).toHaveTextContent('پنجرهٔ اعتراض مشتری');
      expect(within(doesNot).getByRole('heading')).toHaveTextContent('چه نمی‌کند');
      expect(doesNot).toHaveTextContent('هیچ مبلغی را برنمی‌دارد');
      expect(doesNot).toHaveTextContent('هیچ بازپرداختی را لغو نمی‌کند');
      expect(doesNot).toHaveTextContent('پس گرفته نمی‌شود');

      expect(sent).toHaveLength(0);
    });

    it('requires the statement because the SERVER says so, with the 1–2000 bound, and refuses to send an empty one', async () => {
      mockApi({ bookings: [running('b1')] });
      const user = userEvent.setup();
      renderPage();
      await openPanel(user, 'b1');
      await user.click(await screen.findByRole('button', { name: 'اعلام عدم حضور' }));
      const dialog = await screen.findByRole('dialog');

      const field = within(dialog).getByLabelText('توضیح — الزامی برای این رزرو');
      expect(field).toBeRequired();
      expect(field).toHaveAttribute('maxLength', '2000');
      expect(dialog).toHaveTextContent('بین ۱ تا ۲۰۰۰ نویسه');

      await user.type(field, '   ');
      await user.click(within(dialog).getByRole('button', { name: 'اعلام می‌کنم' }));
      expect(await within(dialog).findByText('توضیح را بنویسید.')).toBeInTheDocument();
      expect(sent).toHaveLength(0);
    });

    it('sends the trimmed statement, then shows the permanent record with nothing left to do', async () => {
      let declared = false;
      mockApi({
        bookings: [running('b1')],
        noShow: () =>
          ok(
            declared
              ? {
                  ...GOVERNED_PERMITTED,
                  declarationPermitted: false,
                  declaration: {
                    declaredAt: '2026-09-27T06:50:00.000Z',
                    statement: 'مشتری نیامد و پاسخ نداد.',
                    objectionWindowEndsAt: '2026-09-29T06:50:00.000Z',
                    evaluationState: 'window_open',
                  },
                }
              : GOVERNED_PERMITTED,
          ),
        declare: (id) => {
          declared = true;
          return ok({ ...running(id), status: 'no_show' });
        },
      });
      const user = userEvent.setup();
      renderPage();
      await openPanel(user, 'b1');
      await user.click(await screen.findByRole('button', { name: 'اعلام عدم حضور' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('توضیح — الزامی برای این رزرو'), '  مشتری نیامد و پاسخ نداد.  ');
      await user.click(within(dialog).getByRole('button', { name: 'اعلام می‌کنم' }));

      // The declared booking is terminal: the page follows it to «گذشته» and
      // announces the result there.
      expect(await screen.findByText('عدم حضور ثبت شد.')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /گذشته/ })).toHaveAttribute('aria-selected', 'true');

      const record = await screen.findByTestId('no-show-declared');
      expect(sent).toEqual([{ url: expect.stringMatching(/\/v1\/bookings\/b1\/no-show$/), body: { statement: 'مشتری نیامد و پاسخ نداد.' } }]);
      expect(record).toHaveTextContent('عدم حضور ثبت شده است');
      expect(record).toHaveTextContent('مشتری نیامد و پاسخ نداد.');
      expect(record).toHaveTextContent('کاری باقی نمانده است');
      expect(within(record).queryByRole('button')).toBeNull();
      // The customer's objection window belongs to #42e (#162): not rendered.
      expect(document.body.textContent).not.toContain(formatZonedFullDate(new Date('2026-09-29T06:50:00.000Z')));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('offers no photo, location or health affordance — one text field and nothing else', async () => {
      mockApi({ bookings: [running('b1')] });
      const user = userEvent.setup();
      renderPage();
      await openPanel(user, 'b1');
      await user.click(await screen.findByRole('button', { name: 'اعلام عدم حضور' }));
      const dialog = await screen.findByRole('dialog');

      expect(dialog.querySelectorAll('input')).toHaveLength(0);
      expect(dialog.querySelectorAll('textarea')).toHaveLength(1);
      expect(dialog.querySelectorAll('select, [type="file"], progress, meter')).toHaveLength(0);
      expect(dialog.textContent).not.toMatch(/عکس|تصویر|موقعیت|مکان|سلامت|پزشکی/);
    });

    it('treats a refused transition as "not yet, or it moved on": closes the dialog, says so, and re-reads', async () => {
      mockApi({
        bookings: [running('b1')],
        declare: () => refused(409, 'INVALID_BOOKING_TRANSITION', 'انتقال نامعتبر'),
      });
      const user = userEvent.setup();
      renderPage();
      await openPanel(user, 'b1');
      await user.click(await screen.findByRole('button', { name: 'اعلام عدم حضور' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('توضیح — الزامی برای این رزرو'), 'نیامد');
      const readsBefore = noShowReads().length;
      await user.click(within(dialog).getByRole('button', { name: 'اعلام می‌کنم' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('یا زمان آن هنوز نرسیده، یا وضعیت نوبت تغییر کرده است');
      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(() => expect(noShowReads().length).toBeGreaterThan(readsBefore));
    });
  });

  describe('the declaration, on an ungoverned booking', () => {
    it('offers no statement field — the server would not keep one — and sends the request it always sent', async () => {
      mockApi({ bookings: [running('b1')], noShow: () => ok(UNGOVERNED_PERMITTED) });
      const user = userEvent.setup();
      renderPage();
      await openPanel(user, 'b1');
      await user.click(await screen.findByRole('button', { name: 'اعلام عدم حضور' }));
      const dialog = await screen.findByRole('dialog');

      expect(dialog.querySelectorAll('textarea')).toHaveLength(0);
      expect(within(dialog).queryByText(/پنجرهٔ اعتراض/)).toBeNull();
      expect(dialog).toHaveTextContent('پس گرفته نمی‌شود');

      await user.click(within(dialog).getByRole('button', { name: 'اعلام می‌کنم' }));
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].body).toEqual({});
    });
  });

  it('shows a legacy no-show with no declaration row as recorded, with nothing to do', async () => {
    mockApi({
      bookings: [running('b1', { status: 'no_show', startAt: '2026-09-01T06:00:00.000Z', endAt: '2026-09-01T07:00:00.000Z' })],
      noShow: () => ok({ ...UNGOVERNED_PERMITTED, declarationPermitted: false }),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('tab', { name: /گذشته/ }));
    await openPanel(user, 'b1');

    const record = await screen.findByTestId('no-show-declared');
    expect(record).toHaveTextContent('به‌عنوان عدم حضور ثبت شده است');
    expect(within(record).queryByRole('button')).toBeNull();
  });

  it('keeps a failed read a failure, with a retry — never an empty panel', async () => {
    let attempts = 0;
    mockApi({
      bookings: [running('b1')],
      noShow: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new TypeError('Failed to fetch')) : ok(GOVERNED_PERMITTED);
      },
    });
    const user = userEvent.setup();
    renderPage();
    await openPanel(user, 'b1');

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('no-show-permitted')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));
    expect(await screen.findByTestId('no-show-permitted')).toBeInTheDocument();
  });
});
