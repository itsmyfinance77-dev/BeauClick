import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { TabList, TabPanel } from '@/components/tab-list';

const TABS = [
  { value: 'a', label: 'الف' },
  { value: 'b', label: 'ب' },
  { value: 'c', label: 'ج' },
] as const;

function Harness({ initial = 'a' }: { initial?: 'a' | 'b' | 'c' }) {
  const [value, setValue] = useState<'a' | 'b' | 'c'>(initial);
  return (
    <>
      <TabList label="فیلتر" idPrefix="t" tabs={TABS} value={value} onChange={setValue} />
      <TabPanel idPrefix="t" value={value}>
        محتوای {value}
      </TabPanel>
    </>
  );
}

afterEach(() => {
  document.documentElement.removeAttribute('dir');
});

describe('TabList — roles and wiring', () => {
  it('exposes a named tablist, exactly one selected tab, and a panel labelled by it', () => {
    render(<Harness initial="b" />);
    expect(screen.getByRole('tablist', { name: 'فیلتر' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    const panel = screen.getByRole('tabpanel', { name: 'ب' });
    expect(panel).toHaveTextContent('محتوای b');
    // Every tab controls that one panel.
    for (const tab of tabs) expect(tab).toHaveAttribute('aria-controls', panel.id);
  });

  it('is ONE tab stop: only the selected tab is in the tab order', () => {
    render(<Harness initial="b" />);
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('selects on click', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: 'ج' }));
    expect(screen.getByRole('tab', { name: 'ج' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('محتوای c');
  });
});

describe('TabList — keyboard', () => {
  it('moves forward with ArrowRight in a left-to-right document, and focuses the new tab', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'الف' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'ب' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'ب' })).toHaveFocus());
  });

  it('moves forward with ArrowLEFT in a right-to-left document — the next tab is drawn to the left', async () => {
    document.documentElement.setAttribute('dir', 'rtl');
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'الف' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'ب' })).toHaveAttribute('aria-selected', 'true');
    // And ArrowRight goes back.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'الف' })).toHaveAttribute('aria-selected', 'true');
  });

  it('wraps at both ends, and Home / End jump to the first and last', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'الف' }).focus();
    await user.keyboard('{ArrowLeft}'); // back from the first wraps to the last
    expect(screen.getByRole('tab', { name: 'ج' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}'); // forward from the last wraps to the first
    expect(screen.getByRole('tab', { name: 'الف' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'ج' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'الف' })).toHaveAttribute('aria-selected', 'true');
  });

  it('leaves every other key alone', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('tab', { name: 'الف' }).focus();
    await user.keyboard('x');
    expect(screen.getByRole('tab', { name: 'الف' })).toHaveAttribute('aria-selected', 'true');
  });
});
