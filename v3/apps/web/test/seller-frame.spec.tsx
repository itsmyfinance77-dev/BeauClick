import { render, screen } from '@testing-library/react';
import { SellerFrame } from '@/components/seller-frame';

let auth: { status: string; user: { roles: string[] } | null };

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  usePathname: () => '/business',
}));

jest.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    ...auth,
    api: { get: async () => ({ data: { id: 'p1', displayName: 'سارا محمدی', verificationStatus: 'verified' } }) },
  }),
}));

/**
 * `SellerFrame`'s own contract, pinned directly rather than through
 * `AuthProvider`: the professional column appears only for a session that is
 * BOTH settled (`authenticated`) and a seller.
 *
 * The `status` half matters on its own. Today `AuthProvider` only ever sets
 * `user` together with `authenticated`, so `user` alone would give the same
 * answer — but that is an invariant of the provider, stated nowhere. Paint
 * from a cached user before validating, and `user.roles` would carry
 * `professional` while the session is still `loading`; only the status check
 * would then stand between an unvalidated session and a flashed professional
 * column. `business-shell.spec.tsx` covers the same frame through the real
 * provider, where this state cannot be reached.
 */

const page = () =>
  render(
    <SellerFrame>
      <p>صفحه</p>
    </SellerFrame>,
  );

const column = () => screen.queryByRole('navigation', { name: 'ناوبری متخصص' });

describe('SellerFrame', () => {
  it('renders the professional column for a settled seller (the control)', async () => {
    auth = { status: 'authenticated', user: { roles: ['professional'] } };
    page();
    expect(await screen.findByRole('navigation', { name: 'ناوبری متخصص' })).toBeInTheDocument();
  });

  it.each(['loading', 'unauthenticated'])(
    'renders no column while the session is %s, even if a user carrying the seller role is present',
    (status) => {
      auth = { status, user: { roles: ['professional'] } };
      page();
      expect(screen.getByText('صفحه')).toBeInTheDocument();
      expect(column()).toBeNull();
    },
  );

  it('renders no column for a settled session that is not a seller', () => {
    auth = { status: 'authenticated', user: { roles: [] } };
    page();
    expect(column()).toBeNull();
  });
});
