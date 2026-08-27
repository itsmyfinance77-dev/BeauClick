import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Badge,
  ContextBand,
  NavLink,
  SegmentedControl,
  StatCard,
  StatGrid,
  TextLink,
} from '@/components/kit';

/**
 * The shared component kit's contracts.
 *
 * Two of these primitives exist to close recurring BUG CLASSES rather than
 * instances, so the cases that matter are the ones that fail if the class comes
 * back: a link below the touch baseline, and a nav that marks two pages current
 * at once. `V3.1_UIUX_BACKLOG.md` records six separate historical instances of
 * the first and the roadmap's Phase G goal is stated as "stop manufacturing new
 * instances of two known bug classes" -- which is a claim only a test can keep.
 */

let pathname = '/pro';
jest.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

beforeEach(() => {
  pathname = '/pro';
});

/**
 * jsdom computes no layout, so a rendered height cannot be measured here. What
 * CAN be asserted is the declared style that produces it, which is exactly
 * where every one of the six historical instances went wrong -- none was a
 * layout surprise, each was a missing `minHeight`.
 */
function assertTouchBaseline(element: HTMLElement) {
  expect(element).toHaveStyle({ minHeight: '44px' });
  // `min-height` alone does nothing on an inline element, which is the trap
  // that makes this a two-part contract rather than one property.
  expect(element).toHaveStyle({ display: 'inline-flex' });
}

describe('TOUCH-CLASS — every interactive primitive carries the 44px baseline', () => {
  it('TextLink does, at any font size the caller picks', () => {
    render(<TextLink href="/providers">مشاهده‌ی متخصص‌ها</TextLink>);
    assertTouchBaseline(screen.getByRole('link', { name: 'مشاهده‌ی متخصص‌ها' }));
  });

  it('NavLink does, current or not', () => {
    render(
      <>
        <NavLink href="/pro">نمای کلی</NavLink>
        <NavLink href="/pro/bookings">رزروها</NavLink>
      </>,
    );
    assertTouchBaseline(screen.getByRole('link', { name: 'نمای کلی' }));
    assertTouchBaseline(screen.getByRole('link', { name: 'رزروها' }));
  });

  it('SegmentedControl options do', () => {
    render(
      <SegmentedControl
        label="بازه زمانی"
        value={30}
        options={[
          { value: 7, label: '۷ روز' },
          { value: 30, label: '۳۰ روز' },
        ]}
        onChange={jest.fn()}
      />,
    );
    for (const option of screen.getAllByRole('button')) {
      expect(option).toHaveStyle({ minHeight: '44px' });
    }
  });

  it('ContextBand’s exit link does — the one link a user in the wrong mode needs most', () => {
    render(
      <ContextBand
        tone="primary"
        modeLabel="حالت متخصص"
        exitHref="/"
        exitLabel="بازگشت به نمای مشتری"
        navLabel="ناوبری متخصص"
      >
        <NavLink href="/pro">نمای کلی</NavLink>
      </ContextBand>,
    );
    assertTouchBaseline(screen.getByRole('link', { name: 'بازگشت به نمای مشتری' }));
  });

  it('Badge deliberately does NOT — a chip that cannot be tapped for anything is not a target', () => {
    render(<Badge tone="success">تأیید شده</Badge>);
    expect(screen.getByText('تأیید شده')).not.toHaveStyle({ minHeight: '44px' });
  });
});

describe('NavLink — current-page marking', () => {
  it('marks exactly the current page, never a parent by prefix', () => {
    pathname = '/pro/bookings';
    render(
      <>
        <NavLink href="/pro">نمای کلی</NavLink>
        <NavLink href="/pro/bookings">رزروها</NavLink>
      </>,
    );

    // The regression this guards: prefix matching would mark BOTH, because
    // '/pro/bookings' starts with '/pro'. Three separate hand-written nav links
    // each had to rediscover this before the primitive existed.
    expect(screen.getByRole('link', { name: 'رزروها' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'نمای کلی' })).not.toHaveAttribute('aria-current');
  });

  it('signals the current page by WEIGHT as well as colour', () => {
    pathname = '/pro';
    render(<NavLink href="/pro">نمای کلی</NavLink>);
    // Colour alone is not a distinction every reader can make, so the weight
    // change is load-bearing rather than decorative.
    expect(screen.getByRole('link', { name: 'نمای کلی' })).toHaveStyle({ fontWeight: '800' });
  });

  it('uses the warning accent in the admin context and the primary one elsewhere', () => {
    pathname = '/admin';
    const { rerender } = render(
      <NavLink href="/admin" tone="warning">
        نمای کلی
      </NavLink>,
    );
    expect(screen.getByRole('link')).toHaveStyle({ color: 'var(--bc-color-warning)' });

    pathname = '/pro';
    rerender(<NavLink href="/pro">نمای کلی</NavLink>);
    expect(screen.getByRole('link')).toHaveStyle({ color: 'var(--bc-color-primary)' });
  });
});

describe('ContextBand — one implementation of the role-context pattern', () => {
  it('exposes the mode nav as its own labelled landmark', () => {
    render(
      <ContextBand
        tone="warning"
        modeLabel="پنل مدیریت"
        identity="اپراتور"
        exitHref="/"
        exitLabel="خروج از پنل مدیریت"
        navLabel="ناوبری مدیریت"
      >
        <NavLink href="/admin" tone="warning">
          نمای کلی
        </NavLink>
      </ContextBand>,
    );

    const nav = screen.getByRole('navigation', { name: 'ناوبری مدیریت' });
    expect(within(nav).getByRole('link', { name: 'نمای کلی' })).toBeInTheDocument();
    expect(screen.getByText('پنل مدیریت')).toBeInTheDocument();
    expect(screen.getByText('اپراتور')).toBeInTheDocument();
  });

  it('always offers a way out of the context', () => {
    // `exitHref`/`exitLabel` are REQUIRED props rather than optional ones, so a
    // fourth role context cannot ship without this. The test states the
    // property; the type states it too, which is the stronger of the two.
    render(
      <ContextBand
        tone="primary"
        modeLabel="حالت متخصص"
        exitHref="/"
        exitLabel="بازگشت به نمای مشتری"
        navLabel="ناوبری متخصص"
      >
        <NavLink href="/pro">نمای کلی</NavLink>
      </ContextBand>,
    );
    expect(screen.getByRole('link', { name: 'بازگشت به نمای مشتری' })).toHaveAttribute('href', '/');
  });

  it('shows a name only once there is a name to show', () => {
    const { rerender } = render(
      <ContextBand
        tone="primary"
        modeLabel="حالت متخصص"
        exitHref="/"
        exitLabel="بازگشت"
        navLabel="ناوبری متخصص"
      >
        <NavLink href="/pro">نمای کلی</NavLink>
      </ContextBand>,
    );

    // A professional whose profile has not loaded yet is shown the mode they
    // are in and no name, rather than a name-shaped blank. The mode badge is
    // present either way, so the band never renders as an unlabelled strip.
    expect(screen.queryByText('سالن آزمایشی')).not.toBeInTheDocument();
    expect(screen.getByText('حالت متخصص')).toBeInTheDocument();

    rerender(
      <ContextBand
        tone="primary"
        modeLabel="حالت متخصص"
        identity="سالن آزمایشی"
        exitHref="/"
        exitLabel="بازگشت"
        navLabel="ناوبری متخصص"
      >
        <NavLink href="/pro">نمای کلی</NavLink>
      </ContextBand>,
    );
    expect(screen.getByText('سالن آزمایشی')).toBeInTheDocument();
  });
});

describe('SegmentedControl', () => {
  it('is a labelled group of pressed-state buttons, NOT a tablist', () => {
    render(
      <SegmentedControl
        label="بازه زمانی"
        value={30}
        options={[
          { value: 7, label: '۷ روز' },
          { value: 30, label: '۳۰ روز' },
        ]}
        onChange={jest.fn()}
      />,
    );

    // `role="tablist"` promises arrow-key traversal and an associated tabpanel.
    // Claiming a keyboard contract that is not implemented is worse for a
    // screen-reader user than claiming no role, so this deliberately is not one.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    const group = screen.getByRole('group', { name: 'بازه زمانی' });
    expect(within(group).getByRole('button', { name: '۳۰ روز' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: '۷ روز' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the chosen value and is operable from the keyboard', async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    render(
      <SegmentedControl
        label="بازه زمانی"
        value={30}
        options={[
          { value: 7, label: '۷ روز' },
          { value: 30, label: '۳۰ روز' },
        ]}
        onChange={onChange}
      />,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: '۷ روز' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it('reports nothing while disabled', async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    render(
      <SegmentedControl
        label="بازه زمانی"
        value={30}
        options={[
          { value: 7, label: '۷ روز' },
          { value: 30, label: '۳۰ روز' },
        ]}
        onChange={onChange}
        disabled
      />,
    );

    // The screen re-requests on change, so a second range must not land on top
    // of a first one still on the wire.
    await user.click(screen.getByRole('button', { name: '۷ روز' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('StatCard / StatGrid', () => {
  it('renders a label, a value, and an optional footer', () => {
    render(
      <StatGrid>
        <StatCard label="خالص قابل دریافت" value="۲۱۲٬۵۰۰" footer={<Badge tone="success">بدون مورد</Badge>} />
      </StatGrid>,
    );
    expect(screen.getByText('خالص قابل دریافت')).toBeInTheDocument();
    expect(screen.getByText('۲۱۲٬۵۰۰')).toBeInTheDocument();
    expect(screen.getByText('بدون مورد')).toBeInTheDocument();
  });

  it('lets a long currency figure wrap instead of widening its own column', () => {
    // A formatted Toman figure is a long unbroken run of Persian digits and
    // separators. Inside a 180px grid track at 375px, the eight inline versions
    // this component replaced could push their own card past its column.
    render(<StatCard label="فروش ناخالص" value="۱۲۳٬۴۵۶٬۷۸۹" />);
    expect(screen.getByText('۱۲۳٬۴۵۶٬۷۸۹')).toHaveStyle({ overflowWrap: 'anywhere' });
  });

  it('omits the footer row entirely when there is no footer', () => {
    const { container } = render(<StatCard label="خدمات" value="۳" />);
    expect(container.querySelectorAll('div')).toHaveLength(1); // the Card itself
  });
});
