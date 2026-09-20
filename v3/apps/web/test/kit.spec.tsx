import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Badge,
  DataCell,
  DataRow,
  DataTable,
  FormFullRow,
  FormGrid,
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

  it('Badge deliberately does NOT — a chip that cannot be tapped for anything is not a target', () => {
    render(<Badge tone="success">تأیید شده</Badge>);
    expect(screen.getByText('تأیید شده')).not.toHaveStyle({ minHeight: '44px' });
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

describe('DataTable — a table at every width, a card list on mobile', () => {
  function renderTable() {
    return render(
      <>
        <h3 id="t-head">نسخه‌ها</h3>
        <DataTable head={['نسخه', 'وضعیت']} aria-labelledby="t-head">
          <DataRow data-version={2}>
            <DataCell label="نسخه">۲</DataCell>
            <DataCell label="وضعیت">منتشرشده</DataCell>
          </DataRow>
        </DataTable>
      </>,
    );
  }

  it('stays a named table with column headers, so block display below 640px cannot strip the semantics', () => {
    renderTable();
    const table = screen.getByRole('table', { name: 'نسخه‌ها' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['نسخه', 'وضعیت']);
    expect(within(table).getAllByRole('row')).toHaveLength(2); // header + one body row
  });

  it('gives every body cell the label the card layout prints above its value', () => {
    renderTable();
    const cells = within(screen.getByRole('table')).getAllByRole('cell');
    expect(cells.map((c) => c.getAttribute('data-label'))).toEqual(['نسخه', 'وضعیت']);
  });

  it('wraps the table in a focusable, named region so a keyboard user can scroll it at tablet width', () => {
    renderTable();
    const region = screen.getByRole('region', { name: 'نسخه‌ها' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(within(region).getByRole('table')).toBeInTheDocument();
  });

  it('passes row attributes through', () => {
    const { container } = renderTable();
    expect(container.querySelector('tr[data-version="2"]')).not.toBeNull();
  });
});

describe('FormGrid', () => {
  it('renders every field in order, with a full-row escape for anything that is not half of a pair', () => {
    render(
      <FormGrid>
        <input aria-label="از ساعت" />
        <input aria-label="تا ساعت" />
        <FormFullRow>
          <input aria-label="خدمت" />
        </FormFullRow>
      </FormGrid>,
    );
    expect(screen.getAllByRole('textbox').map((i) => i.getAttribute('aria-label'))).toEqual(['از ساعت', 'تا ساعت', 'خدمت']);
  });
});
