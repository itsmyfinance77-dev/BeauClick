import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingsPage from '@/app/bookings/page';
import { remedyStage } from '@/components/remedy-panel';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';
import type { CustomerRemedyView } from '@/lib/booking-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/bookings',
}));

/**
 * Screen 49, the customer's side — V3.3 #212 over `#42d-read` (#201).
 *
 * From the issue's acceptance list:
 *
 *  1. nothing is read for a row until its panel is opened;
 *  3. no countdown anywhere — the override exists exactly while the server's
 *     `rescheduleStillAvailable` is true;
 *  6. `REMEDY_NOT_OFFERED` renders as "no remedy here", never as an error;
 *  7. the closed states — refund executed, reschedule chosen — render with
 *     nothing left to do, and a repeat request renders the same screen.
 */

function booking(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    customerId: 'u1',
    professionalId: 'prof-1',
    serviceId: 'svc-1',
    slotId: `slot-${id}`,
    startAt: '2026-09-20T06:30:00.000Z',
    endAt: '2026-09-20T07:30:00.000Z',
    status: 'cancelled',
    holdExpiresAt: null,
    rescheduleCount: 0,
    cancellationReason: 'لغو توسط متخصص',
    createdAt: '2026-09-01T06:30:00.000Z',
    orderId: `order-${id}`,
    ...overrides,
  };
}

const IN_PROGRESS: CustomerRemedyView = {
  chosen: null,
  resolvedBy: 'default',
  rescheduleStillAvailable: true,
  refundToman: '480000',
  executionStatus: 'pending',
};
const EXECUTED: CustomerRemedyView = { ...IN_PROGRESS, rescheduleStillAvailable: false, executionStatus: 'executed' };
const RESCHEDULED: CustomerRemedyView = { ...IN_PROGRESS, chosen: 'reschedule', resolvedBy: 'customer', rescheduleStillAvailable: false };

const SLOTS = [
  { id: 'slot-new-1', serviceId: 'svc-1', startAt: '2099-10-01T06:30:00.000Z', endAt: '2099-10-01T07:30:00.000Z' },
  { id: 'slot-new-2', serviceId: 'svc-1', startAt: '2099-10-02T06:30:00.000Z', endAt: '2099-10-02T07:30:00.000Z' },
];

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function refused(status: number, code: string, message: string) {
  return Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });
}

let posted: unknown[];

function mockApi(options: {
  bookings: () => unknown[];
  remedy?: (bookingId: string) => Promise<unknown>;
  resolve?: (body: unknown) => Promise<unknown>;
  availability?: () => Promise<unknown>;
}) {
  posted = [];
  (global.fetch as jest.Mock).mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['customer'], capabilities: [] });
    if (url.includes('/v1/me/bookings')) return ok(options.bookings());
    if (url.includes('/availability')) return options.availability ? options.availability() : ok(SLOTS);
    const remedy = url.match(/\/v1\/bookings\/([^/]+)\/remedy$/);
    if (remedy && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      posted.push(body);
      return options.resolve ? options.resolve(body) : ok({ chosen: 'reschedule', resolvedBy: 'customer' });
    }
    if (remedy) return options.remedy ? options.remedy(remedy[1]) : ok(IN_PROGRESS);
    return ok([]);
  });
}

const calls = (pattern: RegExp) => (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0])).filter((url) => pattern.test(url));
const remedyReads = () =>
  (global.fetch as jest.Mock).mock.calls.filter(
    (c) => /\/remedy$/.test(String(c[0])) && ((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET',
  );

function renderPage() {
  return render(
    <AuthProvider>
      <BookingsPage />
    </AuthProvider>,
  );
}

function rowOf(id: string) {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-booking="${id}"]`);
    if (!found) throw new Error(`row ${id} not rendered`);
    return found;
  });
}

async function openRemedy(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(await screen.findByRole('button', { name: 'گذشته' }));
  const row = await rowOf(id);
  await user.click(within(row).getByRole('button', { name: 'بازپرداخت و جبران' }));
  return row;
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('remedyStage — the server answer, read and never re-derived', () => {
  it.each<[string, CustomerRemedyView, string]>([
    ['default, refund pending', IN_PROGRESS, 'in_progress'],
    ['default, manual_required', { ...IN_PROGRESS, executionStatus: 'manual_required' }, 'in_progress'],
    ['default, no live decision yet', { ...IN_PROGRESS, refundToman: null, executionStatus: null, rescheduleStillAvailable: false }, 'in_progress'],
    ['default, executed', EXECUTED, 'closed_refund'],
    ['default, failed', { ...EXECUTED, executionStatus: 'failed' }, 'refund_failed'],
    ['customer chose reschedule', RESCHEDULED, 'closed_reschedule'],
  ])('%s', (_label, view, stage) => {
    expect(remedyStage(view)).toBe(stage);
  });
});

describe('screen 49 — the customer’s remedy (#212)', () => {
  it('reads nothing until a row is opened, and offers the panel only on cancelled or rescheduled bookings', async () => {
    mockApi({
      bookings: () => [
        booking('c1'),
        booking('c2'),
        booking('done', { status: 'completed' }),
        booking('moved', { status: 'confirmed', startAt: '2099-10-01T06:30:00.000Z', endAt: '2099-10-01T07:30:00.000Z', rescheduleCount: 1 }),
      ],
    });
    const user = userEvent.setup();
    renderPage();

    const moved = await rowOf('moved');
    expect(within(moved).getByRole('button', { name: 'بازپرداخت و جبران' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'گذشته' }));
    expect(within(await rowOf('done')).queryByRole('button', { name: 'بازپرداخت و جبران' })).toBeNull();
    expect(remedyReads()).toHaveLength(0);

    await user.click(within(await rowOf('c2')).getByRole('button', { name: 'بازپرداخت و جبران' }));
    await screen.findByTestId('remedy-in-progress');
    expect(remedyReads().map((c) => String(c[0]))).toEqual([expect.stringMatching(/\/v1\/bookings\/c2\/remedy$/)]);
    // The slot list is later still: only when the customer asks for it.
    expect(calls(/\/availability/)).toHaveLength(0);
  });

  it('renders REMEDY_NOT_OFFERED as an ordinary sentence, never as an error', async () => {
    mockApi({ bookings: () => [booking('c1')], remedy: () => refused(404, 'REMEDY_NOT_OFFERED', 'برای این رزرو گزینه‌ی جبران در دسترس نیست.') });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');

    expect(await within(row).findByTestId('remedy-not-offered')).toHaveTextContent('برای این رزرو گزینهٔ جبرانی وجود ندارد.');
    expect(within(row).queryByRole('alert')).toBeNull();
    expect(within(row).queryByRole('button', { name: 'تلاش دوباره' })).toBeNull();
  });

  it('shows the default as already applied, with its amount, and no "accept the refund" button', async () => {
    mockApi({ bookings: () => [booking('c1')] });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');

    const panel = await within(row).findByTestId('remedy-in-progress');
    expect(panel).toHaveTextContent('بازپرداخت کامل در جریان است');
    expect(panel).toHaveTextContent('لازم نیست کاری بکنید');
    expect(within(panel).getByTestId('remedy-amount')).toHaveTextContent('۴۸۰٬۰۰۰ تومان');
    expect(within(panel).queryByRole('button', { name: /بازپرداخت را می‌پذیرم|تأیید بازپرداخت/ })).toBeNull();
    expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual(['به‌جای بازپرداخت، نوبت تازه می‌خواهم']);
  });

  it('has no override control at all once the server says it is gone — no disabled button, no countdown', async () => {
    mockApi({ bookings: () => [booking('c1')], remedy: () => ok({ ...IN_PROGRESS, rescheduleStillAvailable: false }) });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');

    const panel = await within(row).findByTestId('remedy-in-progress');
    expect(within(panel).queryByTestId('remedy-override')).toBeNull();
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/مانده|ثانیه|شمارش|\d{1,2}:\d{2}:\d{2}/);
    expect(document.querySelector('[role="timer"]')).toBeNull();
  });

  it('reschedules through the server’s own claimable slots, sending the chosen slot, then shows the closed resolution', async () => {
    let chosen = false;
    mockApi({
      bookings: () =>
        chosen
          ? [booking('c1', { status: 'confirmed', slotId: 'slot-new-2', startAt: SLOTS[1].startAt, endAt: SLOTS[1].endAt, rescheduleCount: 1 })]
          : [booking('c1')],
      remedy: () => ok(chosen ? RESCHEDULED : IN_PROGRESS),
      resolve: () => {
        chosen = true;
        return ok({ chosen: 'reschedule', resolvedBy: 'customer' });
      },
    });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');
    await user.click(await within(row).findByRole('button', { name: 'به‌جای بازپرداخت، نوبت تازه می‌خواهم' }));

    const picker = await within(row).findByTestId('remedy-slot-picker');
    // The public availability route, narrowed to this booking's professional and service.
    expect(calls(/\/availability/)).toEqual([expect.stringMatching(/\/v1\/providers\/prof-1\/availability\?serviceId=svc-1$/)]);
    expect(picker).toHaveTextContent('بازپرداخت انجام نمی‌شود و این انتخاب بازگشت ندارد');

    // No slot chosen: the picker requires one, and nothing is sent.
    await user.click(within(picker).getByRole('button', { name: 'ثبت نوبت تازه' }));
    expect(await within(picker).findByText('زمان تازه را انتخاب کنید.')).toBeInTheDocument();
    expect(posted).toHaveLength(0);

    await user.selectOptions(within(picker).getByLabelText('زمان تازه'), 'slot-new-2');
    await user.click(within(picker).getByRole('button', { name: 'ثبت نوبت تازه' }));

    // The booking is confirmed again on its new slot: the page follows it to
    // «پیش‌رو», with the panel still open on the closed resolution.
    const closed = await screen.findByTestId('remedy-closed-reschedule');
    expect(posted).toEqual([{ choice: 'reschedule', newSlotId: 'slot-new-2' }]);
    expect(closed).toHaveTextContent('کاری باقی نمانده است');
    expect(within(closed).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'پیش‌رو' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('never resends a refused slot: a taken slot that leaves the refreshed list is deselected, and only an explicit current choice is sent', async () => {
    // Codex review of 5fb038e: the select went blank after the refresh but
    // the component still held slot A, so the next submit re-sent A.
    let availabilityReads = 0;
    let chosen = false;
    mockApi({
      bookings: () =>
        chosen
          ? [booking('c1', { status: 'confirmed', slotId: SLOTS[1].id, startAt: SLOTS[1].startAt, endAt: SLOTS[1].endAt, rescheduleCount: 1 })]
          : [booking('c1')],
      remedy: () => ok(chosen ? RESCHEDULED : IN_PROGRESS),
      availability: () => {
        availabilityReads += 1;
        return ok(availabilityReads === 1 ? SLOTS : [SLOTS[1]]);
      },
      resolve: (body) => {
        if ((body as { newSlotId: string }).newSlotId === SLOTS[0].id) {
          return refused(409, 'SLOT_UNAVAILABLE', 'این زمان دیگر در دسترس نیست. لطفاً زمان دیگری انتخاب کنید.');
        }
        chosen = true;
        return ok({ chosen: 'reschedule', resolvedBy: 'customer' });
      },
    });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');
    await user.click(await within(row).findByRole('button', { name: 'به‌جای بازپرداخت، نوبت تازه می‌خواهم' }));

    // Choose A; the server refuses it as taken.
    let picker = await within(row).findByTestId('remedy-slot-picker');
    await user.selectOptions(within(picker).getByLabelText('زمان تازه'), SLOTS[0].id);
    await user.click(within(picker).getByRole('button', { name: 'ثبت نوبت تازه' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('این زمان دیگر در دسترس نیست');
    expect(posted).toEqual([{ choice: 'reschedule', newSlotId: SLOTS[0].id }]);

    // The refreshed list no longer offers A, and nothing is selected.
    await waitFor(() => expect(availabilityReads).toBe(2));
    picker = await within(row).findByTestId('remedy-slot-picker');
    const select = within(picker).getByLabelText('زمان تازه') as HTMLSelectElement;
    await waitFor(() => expect([...select.options].map((o) => o.value)).toEqual(['', SLOTS[1].id]));
    expect(select.value).toBe('');

    // Submitting now sends nothing: an explicit current choice is required.
    await user.click(within(picker).getByRole('button', { name: 'ثبت نوبت تازه' }));
    expect(await within(picker).findByText('زمان تازه را انتخاب کنید.')).toBeInTheDocument();
    expect(posted).toHaveLength(1);

    // Choosing B, which IS offered, succeeds.
    await user.selectOptions(select, SLOTS[1].id);
    await user.click(within(picker).getByRole('button', { name: 'ثبت نوبت تازه' }));
    expect(await screen.findByTestId('remedy-closed-reschedule')).toBeInTheDocument();
    expect(posted).toEqual([
      { choice: 'reschedule', newSlotId: SLOTS[0].id },
      { choice: 'reschedule', newSlotId: SLOTS[1].id },
    ]);
  });

  it('keeps a selection that is still offered after a refresh', async () => {
    let availabilityReads = 0;
    let attempts = 0;
    mockApi({
      bookings: () => [booking('c1')],
      availability: () => {
        availabilityReads += 1;
        return ok(SLOTS);
      },
      resolve: () => {
        attempts += 1;
        return attempts === 1 ? refused(409, 'RESCHEDULE_NOT_ALLOWED', 'تغییر زمان ممکن نشد.') : ok({ chosen: 'reschedule', resolvedBy: 'customer' });
      },
    });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');
    await user.click(await within(row).findByRole('button', { name: 'به‌جای بازپرداخت، نوبت تازه می‌خواهم' }));
    const picker = await within(row).findByTestId('remedy-slot-picker');
    await user.selectOptions(within(picker).getByLabelText('زمان تازه'), SLOTS[1].id);
    await user.click(within(picker).getByRole('button', { name: 'ثبت نوبت تازه' }));
    await within(row).findByRole('alert');
    await waitFor(() => expect(availabilityReads).toBe(2));

    const again = await within(row).findByTestId('remedy-slot-picker');
    expect((within(again).getByLabelText('زمان تازه') as HTMLSelectElement).value).toBe(SLOTS[1].id);
  });

  it('renders the refund-executed second visit with its amount and nothing left to do', async () => {
    mockApi({ bookings: () => [booking('c1')], remedy: () => ok(EXECUTED) });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');

    const closed = await within(row).findByTestId('remedy-closed-refund');
    expect(closed).toHaveTextContent('بازپرداخت کامل انجام شد');
    expect(within(closed).getByTestId('remedy-amount')).toHaveTextContent('۴۸۰٬۰۰۰ تومان');
    expect(closed).toHaveTextContent('کاری باقی نمانده است');
    expect(within(row).queryByRole('button', { name: /نوبت تازه/ })).toBeNull();
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('renders a refund that finished while the screen was open as the same closed screen — no error, no reprimand', async () => {
    let executed = false;
    mockApi({
      bookings: () => [booking('c1')],
      remedy: () => ok(executed ? EXECUTED : IN_PROGRESS),
      resolve: () => {
        executed = true;
        return refused(409, 'REMEDY_REFUND_ALREADY_EXECUTED', 'بازپرداخت این رزرو قبلاً انجام شده است.');
      },
    });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');
    await user.click(await within(row).findByRole('button', { name: 'به‌جای بازپرداخت، نوبت تازه می‌خواهم' }));
    const picker = await within(row).findByTestId('remedy-slot-picker');
    await user.selectOptions(within(picker).getByLabelText('زمان تازه'), 'slot-new-1');
    await user.click(within(picker).getByRole('button', { name: 'ثبت نوبت تازه' }));

    expect(await within(row).findByTestId('remedy-closed-refund')).toHaveTextContent('کاری باقی نمانده است');
    expect(within(row).queryByRole('alert')).toBeNull();
    expect(within(row).queryByText(/قبلاً انجام شده/)).toBeNull();
  });

  it('renders the reschedule-chosen second visit identically on every read, with nothing left to do', async () => {
    mockApi({ bookings: () => [booking('c1', { status: 'confirmed', startAt: SLOTS[0].startAt, endAt: SLOTS[0].endAt, rescheduleCount: 1 })], remedy: () => ok(RESCHEDULED) });
    const user = userEvent.setup();
    renderPage();

    // Opened, closed and opened again: two reads, one screen, no action left.
    const row = await rowOf('c1');
    const toggle = within(row).getByRole('button', { name: 'بازپرداخت و جبران' });
    await user.click(toggle);
    const first = (await within(row).findByTestId('remedy-closed-reschedule')).textContent;
    await user.click(within(row).getByRole('button', { name: 'بستن بازپرداخت و جبران' }));
    await user.click(within(row).getByRole('button', { name: 'بازپرداخت و جبران' }));
    const second = await within(row).findByTestId('remedy-closed-reschedule');
    expect(second.textContent).toBe(first);
    expect(remedyReads()).toHaveLength(2);
    expect(within(second).queryByRole('button')).toBeNull();
  });

  it('keeps a failed read a failure, says it changed nothing, and retries', async () => {
    let attempts = 0;
    mockApi({
      bookings: () => [booking('c1')],
      remedy: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new TypeError('Failed to fetch')) : ok(IN_PROGRESS);
      },
    });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');

    expect(await within(row).findByRole('alert')).toHaveTextContent('فقط دربارهٔ خواندن وضعیت است و چیزی را تغییر نمی‌دهد');
    await user.click(within(row).getByRole('button', { name: 'تلاش دوباره' }));
    expect(await within(row).findByTestId('remedy-in-progress')).toBeInTheDocument();
  });

  it('says a failed refund plainly, without promising what happens next or offering a dead control', async () => {
    mockApi({ bookings: () => [booking('c1')], remedy: () => ok({ ...EXECUTED, executionStatus: 'failed' }) });
    const user = userEvent.setup();
    renderPage();
    const row = await openRemedy(user, 'c1');

    const panel = await within(row).findByTestId('remedy-refund-failed');
    expect(panel).toHaveTextContent('هنوز تکمیل نشده است');
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
  });
});
