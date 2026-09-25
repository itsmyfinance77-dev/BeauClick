import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminMediaPage from '@/app/admin/media/page';
import { AuthProvider } from '@/lib/auth-context';
import { UnreadProvider } from '@/lib/unread-context';
import { tokenStorage } from '@/lib/token-storage';
import { UNKNOWN_REASON_LABEL } from '@/lib/moderation-labels';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/media',
}));

/**
 * `/admin/media`, against `27_ADMIN_MEDIA_MODERATION.md` and, for the image
 * itself, `52_MODERATOR_LANDING.md` §5 (#265): the irreversible «تأیید و حذف»
 * is offered only while the reported image is actually on screen in the panel.
 */

const ok = (data: unknown, meta: unknown = null) =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta, error: null }) });
const fail = (status: number, code: string, message: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ data: null, meta: null, error: { code, message } }) });

const REPORTS = [
  { id: 'rep-1', mediaObjectId: '0191aaaa-bbbb-7ccc-8ddd-eeeeffff0001', reason: 'explicit', note: 'این تصویر مناسب نمایه نیست', status: 'open', createdAt: '2026-09-15T06:30:00.000Z' },
  { id: 'rep-2', mediaObjectId: '0191aaaa-bbbb-7ccc-8ddd-eeeeffff0002', reason: 'not_own_work', note: null, status: 'open', createdAt: '2026-09-16T06:30:00.000Z' },
  { id: 'rep-3', mediaObjectId: '0191aaaa-bbbb-7ccc-8ddd-eeeeffff0003', reason: 'brand_new_reason', note: null, status: 'open', createdAt: '2026-09-17T06:30:00.000Z' },
];

/** Every URL the fake API has minted, in order: the secrets no text, log or link may ever carry. */
let minted: string[] = [];

/** A fresh, distinct inspection URL for a report, valid for `lifetimeMs`. */
function mintFor(reportId: string, lifetimeMs = 5 * 60_000) {
  const url = `http://api.test/api/v1/media/${reportId}-object/content?token=secret-${reportId}-${minted.length + 1}.mac`;
  minted.push(url);
  return ok({ id: reportId, inspectionUrl: url, expiresAt: new Date(Date.now() + lifetimeMs).toISOString() });
}

function mockApi({
  capabilities = ['bc_manage_platform', 'bc_moderate_media'],
  me = () => capabilities,
  queue = () => ok(REPORTS, { pagination: { page: 1, limit: 20, total: REPORTS.length } }),
  decide = () => ok({ id: 'rep-1', status: 'rejected', decidedAt: '2026-09-18T00:00:00.000Z' }),
  inspection = (reportId: string) => mintFor(reportId),
}: {
  capabilities?: string[];
  me?: () => string[];
  queue?: () => Promise<unknown>;
  decide?: () => Promise<unknown>;
  inspection?: (reportId: string) => Promise<unknown>;
} = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) return ok({ id: 'u1', phone: '+989123456789', displayName: 'ناظر', roles: [], capabilities: me() });
    if (url.includes('/decide')) return decide();
    const inspected = /\/v1\/admin\/media\/reports\/([^/]+)\/inspection$/.exec(url);
    if (inspected) return inspection(decodeURIComponent(inspected[1]));
    if (url.includes('/v1/admin/media/reports')) return queue();
    return ok([]);
  });
}

const never = () => new Promise<never>(() => undefined);

const calls = (fragment: string) =>
  (global.fetch as jest.Mock).mock.calls.filter(([url]: [string]) => String(url).includes(fragment));
const decideBodies = () => calls('/decide').map(([, init]: [string, RequestInit]) => JSON.parse(String(init.body)));

function renderPage() {
  return render(
    <AuthProvider>
      <UnreadProvider>
        <AdminMediaPage />
      </UnreadProvider>
    </AuthProvider>,
  );
}

const row = (id: string) => document.querySelector(`[data-report="${id}"]`) as HTMLElement;
const panel = () => document.querySelector('[data-panel]') as HTMLElement | null;

async function openReport(user: ReturnType<typeof userEvent.setup>, id: string) {
  await screen.findByRole('table');
  await user.click(within(row(id)).getByRole('button', { name: /^بررسی گزارش/ }));
  return panel() as HTMLElement;
}

beforeEach(() => {
  minted = [];
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('who may open it', () => {
  it('refuses a platform operator without `bc_moderate_media`, and never asks for the queue', async () => {
    mockApi({ capabilities: ['bc_manage_platform', 'bc_moderate_verification'] });
    renderPage();
    expect(await screen.findByText(/دسترسی لازم برای این بخش را ندارد/)).toBeInTheDocument();
    expect(calls('/v1/admin/media/reports')).toHaveLength(0);
  });
});

describe('the queue', () => {
  it('lists each report with its reason in Persian and a neutral word for a reason it has never heard of', async () => {
    mockApi();
    renderPage();
    await screen.findByRole('table');
    expect(within(row('rep-1')).getByText('محتوای نامناسب')).toBeInTheDocument();
    expect(within(row('rep-2')).getByText('اثرِ شخص دیگری است')).toBeInTheDocument();
    expect(within(row('rep-3')).getByText(UNKNOWN_REASON_LABEL)).toBeInTheDocument();
    expect(row('rep-3').textContent).not.toContain('brand_new_reason');
  });

  it('says so when there is nothing to review', async () => {
    mockApi({ queue: () => ok([], { pagination: { page: 1, limit: 20, total: 0 } }) });
    renderPage();
    expect(await screen.findByText('هیچ گزارشِ بازی وجود ندارد.')).toBeInTheDocument();
  });

  it('does not call a failed load an empty queue, and offers a retry', async () => {
    mockApi({ queue: () => fail(500, 'INTERNAL', 'خطای سرور') });
    renderPage();
    expect(await screen.findByText('خطای سرور')).toBeInTheDocument();
    expect(screen.queryByText('هیچ گزارشِ بازی وجود ندارد.')).toBeNull();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });
});

describe('the decision', () => {
  it('opens the panel on demand with the full note, and moves focus into it', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, 'rep-1');
    expect(within(opened).getByText('این تصویر مناسب نمایه نیست')).toBeInTheDocument();
    expect(within(opened).getByRole('heading', { level: 2 })).toHaveFocus();
  });

  it('waits for a reason the server will accept before a rejection can be sent', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, 'rep-1');
    const reject = within(opened).getByRole('button', { name: 'رد گزارش' });
    expect(reject).toBeDisabled();

    await user.type(within(opened).getByLabelText('دلیل تصمیم'), '  ab  ');
    expect(reject).toBeDisabled();
    expect(within(opened).getByText('دلیل باید حداقل ۴ نویسه باشد.')).toBeInTheDocument();

    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'cd');
    expect(reject).toBeEnabled();
  });

  it('sends the rejection with the trimmed reason, reloads the queue, and puts focus on the next report', async () => {
    let decided = false;
    mockApi({
      queue: () => ok(decided ? REPORTS.slice(1) : REPORTS, { pagination: { page: 1, limit: 20, total: 3 } }),
      decide: () => {
        decided = true;
        return ok({ id: 'rep-1', status: 'rejected', decidedAt: null });
      },
    });
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, 'rep-1');
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), '  تصویر از خودِ متخصص است  ');
    await user.click(within(opened).getByRole('button', { name: 'رد گزارش' }));

    await waitFor(() => expect(row('rep-1')).toBeNull());
    expect(decideBodies()).toEqual([{ decision: 'reject', reason: 'تصویر از خودِ متخصص است' }]);
    expect(calls('/v1/admin/media/reports/rep-1/decide')).toHaveLength(1);
    await waitFor(() => expect(within(row('rep-2')).getByRole('button')).toHaveFocus());
  });

  it('keeps a colleague’s earlier decision on screen AFTER reloading, rather than letting the reload erase it', async () => {
    mockApi({ decide: () => fail(400, 'CONFLICT', 'این گزارش پیش‌تر بررسی شده است.') });
    const user = userEvent.setup();
    renderPage();
    const opened = await openReport(user, 'rep-1');
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'دلیل کافی');
    await user.click(within(opened).getByRole('button', { name: 'رد گزارش' }));

    expect(await screen.findByText('این گزارش پیش‌تر توسط اپراتور دیگری بررسی شده است. صف تازه شد.')).toBeInTheDocument();
    // Queue fetched twice: the first load and the reload after the refusal.
    expect(calls('/v1/admin/media/reports?')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- #265

describe('inspecting the reported image (#265, screen 52 §5)', () => {
  const ALT = 'تصویرِ گزارش‌شده';
  const UNAVAILABLE = 'تصویر در دسترس نیست';
  const BLOCKED = 'تا نمایش تصویر، حذف ممکن نیست.';
  const CONSEQUENCE = 'حذف تصویر برگشت‌پذیر نیست.';

  const inspectionCalls = (id?: string) =>
    calls(id ? `/v1/admin/media/reports/${id}/inspection` : '/inspection');
  const panelImage = () => (panel() as HTMLElement).querySelector('img');
  const upholdButton = () => within(panel() as HTMLElement).getByRole('button', { name: 'تأیید و حذف' });
  const describedText = (element: HTMLElement) => {
    const ids = element.getAttribute('aria-describedby');
    return ids ? ids.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '';
  };

  async function openWithReason(user: ReturnType<typeof userEvent.setup>, id = 'rep-1') {
    const opened = await openReport(user, id);
    await user.type(within(opened).getByLabelText('دلیل تصمیم'), 'تصویر نامناسب است');
    return opened;
  }

  /** The image the panel is drawing, once the fake API has minted it, then loaded as a browser would. */
  async function showImage() {
    const img = await waitFor(() => {
      const found = panelImage();
      if (!found) throw new Error('no panel image yet');
      return found;
    });
    fireEvent.load(img);
    return img;
  }

  it('asks for each row’s inspection once, draws a skeleton while it loads, and keeps uphold disabled with its reason', async () => {
    mockApi({ inspection: never });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    await waitFor(() => expect(inspectionCalls()).toHaveLength(REPORTS.length));
    expect(document.querySelector('img')).toBeNull();

    const opened = await openWithReason(user);
    const frame = opened.querySelector('[data-image-state]') as HTMLElement;
    expect(frame).toHaveAttribute('data-image-state', 'loading');
    expect(frame).toHaveAttribute('aria-busy', 'true');
    expect(upholdButton()).toBeDisabled();
    expect(describedText(upholdButton())).toBe(BLOCKED);
    // Reject is never held hostage to the image.
    expect(within(opened).getByRole('button', { name: 'رد گزارش' })).toBeEnabled();
    // Opening the panel does not ask again: the row's request serves both.
    expect(inspectionCalls('rep-1')).toHaveLength(1);
  });

  it('shows the image from the protected URL only, with the fixed alt, and enables uphold only once it has rendered', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWithReason(user);

    const img = await waitFor(() => {
      const found = panelImage();
      if (!found) throw new Error('no panel image yet');
      return found;
    });
    expect(img).toHaveAttribute('alt', ALT);
    expect(img.getAttribute('src')).toBe(minted.find((url) => url.includes('secret-rep-1-')));
    expect(img).toHaveAttribute('crossorigin', 'anonymous');
    // Minted, not yet rendered: still no uphold.
    expect(upholdButton()).toBeDisabled();

    fireEvent.load(img);
    await waitFor(() => expect(upholdButton()).toBeEnabled());
    expect(upholdButton()).not.toHaveAttribute('aria-describedby');
    expect(opened.querySelector('[data-image-state]')).toHaveAttribute('data-image-state', 'shown');

    // The uploader's words never become the image's name.
    for (const image of Array.from(document.querySelectorAll('img'))) {
      expect(image).toHaveAttribute('alt', ALT);
    }
    // Rows draw a thumbnail from the same kind of URL.
    expect(within(row('rep-2')).getByRole('img', { name: ALT })).toBeInTheDocument();

    // Never shown, linked, offered for download or put in text.
    expect(document.querySelectorAll('a[href], [download]')).toHaveLength(0);
    const text = document.body.textContent ?? '';
    for (const url of minted) {
      expect(text).not.toContain(url);
      expect(text).not.toContain(new URL(url).searchParams.get('token') as string);
    }
  });

  it('uphold goes through the reasoned confirmation, described by its irreversible consequence', async () => {
    let decided = false;
    mockApi({
      queue: () => ok(decided ? REPORTS.slice(1) : REPORTS, { pagination: { page: 1, limit: 20, total: 3 } }),
      decide: () => {
        decided = true;
        return ok({ id: 'rep-1', status: 'upheld', decidedAt: null });
      },
    });
    const user = userEvent.setup();
    renderPage();
    await openWithReason(user);
    await showImage();

    await user.click(upholdButton());
    const dialog = await screen.findByRole('dialog');
    expect(describedText(dialog)).toBe(CONSEQUENCE);
    expect(dialog).toHaveTextContent('تصویر نامناسب است');
    // Opening the dialog sends nothing.
    expect(decideBodies()).toEqual([]);

    // Cancel sends nothing either.
    await user.click(within(dialog).getByRole('button', { name: 'انصراف' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(decideBodies()).toEqual([]);

    await user.click(upholdButton());
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'تأیید و حذف' }));
    await waitFor(() => expect(row('rep-1')).toBeNull());
    expect(decideBodies()).toEqual([{ decision: 'uphold', reason: 'تصویر نامناسب است' }]);
    // A decision does not re-mint the reports still in the queue.
    expect(inspectionCalls('rep-2')).toHaveLength(1);
    expect(inspectionCalls('rep-3')).toHaveLength(1);
  });

  it('shows the shared unavailable state, with no cause and no retry, and still lets the report be rejected', async () => {
    mockApi({ inspection: () => fail(404, 'NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.') });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    await waitFor(() => expect(within(row('rep-1')).getByText(UNAVAILABLE)).toBeInTheDocument());

    const opened = await openWithReason(user);
    const frame = opened.querySelector('[data-image-state]') as HTMLElement;
    expect(frame).toHaveAttribute('data-image-state', 'unavailable');
    expect(frame.textContent).toBe(UNAVAILABLE);
    expect(within(opened).queryByRole('button', { name: 'دریافت دوباره' })).toBeNull();
    expect(upholdButton()).toBeDisabled();
    expect(describedText(upholdButton())).toBe(BLOCKED);
    await user.click(upholdButton());
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(within(opened).getByRole('button', { name: 'رد گزارش' }));
    await waitFor(() => expect(decideBodies()).toEqual([{ decision: 'reject', reason: 'تصویر نامناسب است' }]));
  });

  it('after a broken image: one silent re-request, then the sentence and «دریافت دوباره», and a fresh render re-enables uphold', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWithReason(user);
    const first = await showImage();
    await waitFor(() => expect(upholdButton()).toBeEnabled());

    // The image breaks (an expired URL looks like this to a browser).
    fireEvent.error(first);
    expect(upholdButton()).toBeDisabled();
    await waitFor(() => expect(inspectionCalls('rep-1')).toHaveLength(2));
    const second = await waitFor(() => {
      const found = panelImage();
      if (!found || found.getAttribute('src') === first.getAttribute('src')) throw new Error('not re-minted yet');
      return found;
    });
    // Silent: no sentence, no button while it happens.
    expect(within(opened).queryByText(UNAVAILABLE)).toBeNull();
    expect(within(opened).queryByRole('button', { name: 'دریافت دوباره' })).toBeNull();

    // The re-requested image breaks too: now it says so, and asks nothing more by itself.
    fireEvent.error(second);
    const retry = await within(opened).findByRole('button', { name: 'دریافت دوباره' });
    expect(within(opened).getByText(UNAVAILABLE)).toBeInTheDocument();
    expect(upholdButton()).toBeDisabled();
    expect(inspectionCalls('rep-1')).toHaveLength(2);

    await user.click(retry);
    await waitFor(() => expect(inspectionCalls('rep-1')).toHaveLength(3));
    const third = await showImage();
    expect(third.getAttribute('src')).toBe(minted[minted.length - 1]);
    await waitFor(() => expect(upholdButton()).toBeEnabled());
  });

  it('takes uphold away when the URL lapses on screen, and re-requests it silently once', async () => {
    let first = true;
    mockApi({
      inspection: (reportId) => {
        if (reportId !== 'rep-1') return mintFor(reportId);
        const lifetime = first ? 200 : 5 * 60_000;
        first = false;
        return mintFor(reportId, lifetime);
      },
    });
    const user = userEvent.setup();
    renderPage();
    await openWithReason(user);
    await showImage();
    await waitFor(() => expect(upholdButton()).toBeEnabled());

    await waitFor(() => expect(upholdButton()).toBeDisabled(), { timeout: 2000 });
    await waitFor(() => expect(inspectionCalls('rep-1')).toHaveLength(2));
    await showImage();
    await waitFor(() => expect(upholdButton()).toBeEnabled());
  });

  it('withdraws the confirmation if the image breaks while the dialog is open', async () => {
    mockApi({ inspection: (reportId) => (reportId === 'rep-1' && minted.length > 3 ? never() : mintFor(reportId)) });
    const user = userEvent.setup();
    renderPage();
    await openWithReason(user);
    const img = await showImage();
    await user.click(upholdButton());
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'تأیید و حذف' });
    expect(confirm).toBeEnabled();

    fireEvent.error(img);
    await waitFor(() => expect(confirm).toBeDisabled());
    await user.click(confirm);
    expect(decideBodies()).toEqual([]);
  });

  it('asks again for a closed-and-reopened panel before uphold returns', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const opened = await openWithReason(user);
    await showImage();
    await waitFor(() => expect(upholdButton()).toBeEnabled());

    await user.click(within(opened).getByRole('button', { name: 'بستن' }));
    await openWithReason(user);
    // Same URL, but THIS panel has not drawn it yet.
    expect(upholdButton()).toBeDisabled();
    await showImage();
    await waitFor(() => expect(upholdButton()).toBeEnabled());
  });

  it('asks again when the moderator switches to another report and back, without closing the panel', async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openWithReason(user, 'rep-1');
    await showImage();
    await waitFor(() => expect(upholdButton()).toBeEnabled());

    await openWithReason(user, 'rep-2');
    await openWithReason(user, 'rep-1');
    expect(upholdButton()).toBeDisabled();
    await showImage();
    await waitFor(() => expect(upholdButton()).toBeEnabled());
  });

  it('clears the rows and the panel when the media capability is revoked mid-inspection', async () => {
    let revoked = false;
    mockApi({
      me: () => (revoked ? ['bc_moderate_reviews'] : ['bc_moderate_media']),
      inspection: (reportId) => {
        if (!revoked) return mintFor(reportId);
        return fail(403, 'FORBIDDEN', 'اجازه دسترسی به این بخش را ندارید.');
      },
    });
    const user = userEvent.setup();
    renderPage();
    await openWithReason(user);
    const img = await showImage();

    revoked = true;
    await act(async () => {
      fireEvent.error(img);
    });
    expect(await screen.findByText('دسترسی شما به این بخش تغییر کرده است.')).toBeInTheDocument();
    expect(document.querySelector('[data-report]')).toBeNull();
    expect(panel()).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).not.toContain('این تصویر مناسب نمایه نیست');
  });

  it('never writes a minted URL or its token to the console -- and the scan is proven to look', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => undefined),
    );
    mockApi({
      inspection: (reportId) =>
        reportId === 'rep-2' ? fail(404, 'NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.') : mintFor(reportId),
    });
    const user = userEvent.setup();
    renderPage();
    await openWithReason(user);
    const img = await showImage();
    fireEvent.error(img);
    await waitFor(() => expect(inspectionCalls('rep-1')).toHaveLength(2));

    const logged = () => spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' '))).join('\n');
    const secrets = minted.flatMap((url) => [url, new URL(url).searchParams.get('token') as string]);
    expect(secrets.length).toBeGreaterThanOrEqual(4);
    expect(secrets.filter((secret) => logged().includes(secret))).toEqual([]);

    // Canary: the same scan over the same spies does find a secret that is there.
    console.warn(`canary ${secrets[0]}`);
    expect(secrets.filter((secret) => logged().includes(secret))).toContain(secrets[0]);
    spies.forEach((spy) => spy.mockRestore());
  });
});
