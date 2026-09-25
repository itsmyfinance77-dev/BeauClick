import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  COMMISSION_BASES,
  COMMISSION_COMPONENTS,
  COMMISSION_RULE_KINDS,
} from '@beauclick/commercial-policy-contract';
import AdminCommissionPoliciesPage from '@/app/admin/commercial/commission-policies/page';
import { AuthProvider } from '@/lib/auth-context';
import { tokenStorage } from '@/lib/token-storage';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/admin/commercial/commission-policies',
}));

/**
 * The administrator's commission policy read surface — V3.3 `#43b-1` / #173,
 * ADR-052 §1, design `50_ADMIN_COMMISSION_POLICY.md`.
 *
 * ## What these cases are about
 *
 * Three facts this screen must keep apart, because conflating any two of them
 * misinforms the person deciding what the platform charges:
 *
 *  1. **`zero` is a published decision.** Somebody decided to charge nothing.
 *  2. **Nothing published** — nobody has decided.
 *  3. **The read failed** — we do not know.
 *
 * Rendered the same way, (1) and (2) erase a distinction `#43c` depends on,
 * and (3) rendered as (2) tells an administrator the platform charges nothing
 * when in fact the server did not answer.
 *
 * Plus: the three components always appear, in binding order, whatever the
 * server returned.
 */

const POLICIES = {
  booking: { policyKey: 'booking-commission-standard', component: 'booking_commission' as const, displayName: 'کارمزد نوبت', createdAt: '2026-09-01T10:00:00.000Z' },
  acquisition: { policyKey: 'acquisition-standard', component: 'acquisition' as const, displayName: 'جذب مشتری', createdAt: '2026-09-01T10:00:00.000Z' },
  recovery: { policyKey: 'processing-recovery-standard', component: 'processing_recovery' as const, displayName: 'بازیافت هزینه', createdAt: '2026-09-01T10:00:00.000Z' },
};

function version(overrides: Record<string, unknown> = {}) {
  return {
    policyKey: 'booking-commission-standard',
    version: 1,
    lifecycleState: 'published',
    ruleKind: 'percentage',
    basisPoints: 750,
    fixedToman: null,
    base: 'platform_collected_amount',
    arithmeticVersion: 1,
    activationStartsAt: '2026-09-10T08:00:00.000Z',
    activationEndsAt: null,
    publishedAt: '2026-09-10T08:00:00.000Z',
    retiredAt: null,
    createdAt: '2026-09-09T08:00:00.000Z',
    ...overrides,
  };
}

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, meta: null, error: null }) });
}

function refused(status: number, code: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({ data: null, meta: null, error: { code, message: 'خطا' } }),
  });
}

function mockApi(options: {
  policies?: unknown[];
  versionsByKey?: Record<string, unknown[]>;
  policiesFail?: boolean;
  versionsFailFor?: string;
} = {}) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url.includes('/v1/auth/refresh')) return ok({ accessToken: 'a', csrfToken: 'c' });
    if (/\/v1\/me(\?|$)/.test(url)) {
      // #264: the page now carries its own `bc_manage_platform` guard (the gate the
      // `/admin` layout used to supply), so the caller is an administrator,
      // who holds both -- the only role holding the commercial capability.
      return ok({ id: 'u1', phone: '+989123456789', displayName: null, roles: ['admin'], capabilities: ['bc_manage_platform', 'bc_manage_commercial_plans'] });
    }

    const versionsMatch = /commission-policies\/([^/]+)\/versions/.exec(url);
    if (versionsMatch) {
      const key = decodeURIComponent(versionsMatch[1]);
      if (options.versionsFailFor === key) return refused(500, 'INTERNAL_ERROR');
      return ok({ items: options.versionsByKey?.[key] ?? [] });
    }
    if (url.includes('/v1/admin/commercial/commission-policies')) {
      return options.policiesFail ? refused(500, 'INTERNAL_ERROR') : ok({ items: options.policies ?? [] });
    }
    return ok([]);
  });
}

function renderPage() {
  return render(
    <AuthProvider>
      <AdminCommissionPoliciesPage />
    </AuthProvider>,
  );
}

/** One component's card, addressed by its wire name. */
async function componentCard(component: string): Promise<HTMLElement> {
  const grid = await screen.findByTestId('commission-components');
  const card = grid.querySelector(`[data-component="${component}"]`);
  if (!card) throw new Error(`no card for component ${component}`);
  return card as HTMLElement;
}

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  tokenStorage.clear();
  tokenStorage.set({ accessToken: 'test-access-token', csrfToken: 'test-csrf-token' });
});

describe('screen 50a — the admin commission policy read surface', () => {
  it('re-declares the server’s closed vocabularies without drifting from them', () => {
    // The page and `admin-api.ts` carry literal unions rather than importing
    // the contract into the browser bundle. That is only safe while the two
    // agree, which this asserts against the contract itself.
    expect([...COMMISSION_COMPONENTS]).toEqual(['booking_commission', 'acquisition', 'processing_recovery']);
    expect([...COMMISSION_RULE_KINDS]).toEqual(['zero', 'percentage', 'fixed', 'hybrid']);
    expect([...COMMISSION_BASES]).toEqual(['platform_collected_amount', 'service_total']);
  });

  it('shows all three components in binding order even when the server returned none', async () => {
    mockApi({ policies: [] });
    renderPage();

    const grid = await screen.findByTestId('commission-components');
    const rendered = [...grid.querySelectorAll('[data-component]')].map((n) => n.getAttribute('data-component'));
    // Order included: ADR-052 §3 allocates across components in this sequence.
    expect(rendered).toEqual([...COMMISSION_COMPONENTS]);
  });

  it('keeps "no policy", "nothing published" and "published zero" as three different statements', async () => {
    mockApi({
      policies: [POLICIES.booking, POLICIES.acquisition],
      versionsByKey: {
        // A policy exists, and a version of it publishes "charge nothing".
        [POLICIES.booking.policyKey]: [version({ ruleKind: 'zero', basisPoints: null, base: null })],
        // A policy exists, but only a draft.
        [POLICIES.acquisition.policyKey]: [version({ policyKey: POLICIES.acquisition.policyKey, lifecycleState: 'draft', publishedAt: null })],
      },
    });
    renderPage();

    const booking = await componentCard('booking_commission');
    await waitFor(() => expect(booking.querySelector('[data-state="effective"]')).not.toBeNull());
    expect(booking.textContent).toContain('چیزی دریافت نمی‌شود');

    const acquisition = await componentCard('acquisition');
    await waitFor(() => expect(acquisition.querySelector('[data-state="none-published"]')).not.toBeNull());
    expect(acquisition.textContent).toContain('هیچ نسخه‌ای از آن منتشر نشده');

    // No policy row at all — the third statement.
    const recovery = await componentCard('processing_recovery');
    expect(recovery.querySelector('[data-state="no-policy"]')).not.toBeNull();
    expect(recovery.textContent).toContain('هیچ سیاستی ساخته نشده');

    // And the three are genuinely different text, not one string reused.
    const texts = [booking, acquisition, recovery].map((c) => c.querySelector('p')?.textContent ?? c.textContent);
    expect(new Set(texts).size).toBe(3);
  });

  it('never renders a failed read as "nothing published", and only the failure retries', async () => {
    mockApi({
      policies: [POLICIES.booking],
      versionsFailFor: POLICIES.booking.policyKey,
    });
    renderPage();

    const booking = await componentCard('booking_commission');
    await waitFor(() => expect(booking.querySelector('[data-state="error"]')).not.toBeNull());
    // The two claims the failure must NOT make.
    expect(booking.querySelector('[data-state="none-published"]')).toBeNull();
    expect(booking.textContent).not.toContain('چیزی دریافت نمی‌شود');
    // By name: the card also carries a write control since #207.
    const retry = within(booking).getByRole('button', { name: /تلاش/ });
    expect(retry).toBeInTheDocument();

    // Retry succeeds and the card becomes the real answer.
    mockApi({ policies: [POLICIES.booking], versionsByKey: { [POLICIES.booking.policyKey]: [version()] } });
    await userEvent.click(retry);
    await waitFor(() => expect(booking.querySelector('[data-state="effective"]')).not.toBeNull());
  });

  it('renders each shape with only its own fields', async () => {
    mockApi({
      policies: [POLICIES.booking, POLICIES.acquisition, POLICIES.recovery],
      versionsByKey: {
        [POLICIES.booking.policyKey]: [version({ ruleKind: 'percentage', basisPoints: 750, fixedToman: null, base: 'service_total' })],
        [POLICIES.acquisition.policyKey]: [
          version({ policyKey: POLICIES.acquisition.policyKey, ruleKind: 'fixed', basisPoints: null, fixedToman: 25_000, base: null }),
        ],
        [POLICIES.recovery.policyKey]: [
          version({ policyKey: POLICIES.recovery.policyKey, ruleKind: 'hybrid', basisPoints: 120, fixedToman: 5_000, base: 'platform_collected_amount' }),
        ],
      },
    });
    renderPage();

    const percentage = await componentCard('booking_commission');
    await waitFor(() => expect(percentage.textContent).toContain('۷۵۰ bp'));
    expect(percentage.textContent).toContain('مبلغ کلِ خدمت');
    expect(percentage.textContent).not.toContain('مبلغ ثابت'); // percentage carries no amount

    const fixed = await componentCard('acquisition');
    await waitFor(() => expect(fixed.textContent).toContain('مبلغ ثابت'));
    expect(fixed.textContent).not.toContain('bp'); // fixed carries no rate
    expect(fixed.textContent).not.toContain('بر مبنای'); // and no base

    const hybrid = await componentCard('processing_recovery');
    await waitFor(() => expect(hybrid.textContent).toContain('۱۲۰ bp'));
    expect(hybrid.textContent).toContain('مبلغ ثابت');
    expect(hybrid.textContent).toContain('مبلغی که سکو واقعاً وصول کرده');
  });

  it('proposes no rate, amount or base of its own when nothing is published', async () => {
    mockApi({ policies: [] });
    renderPage();

    const grid = await screen.findByTestId('commission-components');
    // No digits at all, in either numeral system: an empty surface that shows
    // a number is proposing one.
    expect(grid.textContent ?? '').not.toMatch(/[0-9۰-۹]/);
    expect(grid.textContent).not.toContain('bp');
    // And no language implying an incident.
    for (const alarm of ['هشدار', 'خطا', 'ناقص', '۰ از ۳']) {
      expect(grid.textContent).not.toContain(alarm);
    }
  });

  describe('the effective version follows the server’s rule, not `lifecycleState` alone', () => {
    // `CommissionPolicyResolutionService` requires published AND started AND
    // not ended. The lifecycle is a transition an administrator makes, never
    // something a clock does, so a time-expired version is still `published`.
    const PAST = '2026-09-01T00:00:00.000Z';
    const FUTURE = '2099-01-01T00:00:00.000Z';

    it('does not show a published-but-expired version as effective', async () => {
      mockApi({
        policies: [POLICIES.booking],
        versionsByKey: {
          [POLICIES.booking.policyKey]: [
            version({ version: 1, lifecycleState: 'published', activationStartsAt: PAST, activationEndsAt: PAST }),
          ],
        },
      });
      renderPage();

      const booking = await componentCard('booking_commission');
      // The server reports this component `absent`; the screen must agree.
      await waitFor(() => expect(booking.querySelector('[data-state="none-published"]')).not.toBeNull());
      expect(booking.querySelector('[data-state="effective"]')).toBeNull();
      expect(booking.textContent).not.toContain('۷۵۰ bp');
    });

    it('does not show a version whose activation has not started yet', async () => {
      mockApi({
        policies: [POLICIES.booking],
        versionsByKey: {
          [POLICIES.booking.policyKey]: [
            version({ version: 1, lifecycleState: 'published', activationStartsAt: FUTURE, activationEndsAt: null }),
          ],
        },
      });
      renderPage();

      const booking = await componentCard('booking_commission');
      await waitFor(() => expect(booking.querySelector('[data-state="none-published"]')).not.toBeNull());
    });

    it('picks the one in force when an expired version sits beside a live one', async () => {
      mockApi({
        policies: [POLICIES.booking],
        versionsByKey: {
          [POLICIES.booking.policyKey]: [
            version({ version: 1, lifecycleState: 'published', basisPoints: 300, activationStartsAt: PAST, activationEndsAt: PAST }),
            version({ version: 2, lifecycleState: 'published', basisPoints: 750, activationStartsAt: PAST, activationEndsAt: FUTURE }),
          ],
        },
      });
      renderPage();

      const booking = await componentCard('booking_commission');
      await waitFor(() => expect(booking.querySelector('[data-state="effective"]')).not.toBeNull());
      expect(booking.textContent).toContain('۷۵۰ bp');
      // The expired one is in the timeline, never on the card.
      expect(booking.textContent).not.toContain('۳۰۰ bp');
    });
  });

  it('carries the lifecycle of every version as text, not only as a coloured chip', async () => {
    mockApi({
      policies: [POLICIES.booking],
      versionsByKey: {
        [POLICIES.booking.policyKey]: [
          version(),
          version({ version: 2, lifecycleState: 'draft', publishedAt: null }),
          version({ version: 3, lifecycleState: 'retired', retiredAt: '2026-09-12T08:00:00.000Z' }),
        ],
      },
    });
    renderPage();

    const timeline = await screen.findByRole('table');
    for (const state of ['منتشرشده', 'پیش‌نویس', 'بازنشسته']) {
      expect(timeline.textContent).toContain(state);
    }
    // Newest first, so the row order is a deliberate claim rather than the
    // server's arrival order. (Which controls each state carries is asserted
    // per lifecycle state in `admin-commission-write.spec.tsx`.)
    const order = [...timeline.querySelectorAll('[data-version]')].map((r) => r.getAttribute('data-version'));
    expect(order).toEqual(['3', '2', '1']);
  });

  it('shows the whole page failing as one retryable error, not as three empty components', async () => {
    mockApi({ policiesFail: true });
    renderPage();

    expect(await screen.findByRole('button', { name: /تلاش/ })).toBeInTheDocument();
    expect(screen.queryByTestId('commission-components')).toBeNull();
  });
});
