import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Modal } from './Modal';
import { expectNoAccessibilityViolations } from '../../test/axe';

/**
 * V2.2 Step 13 (A11Y-03) — first automated accessibility test in this
 * suite, establishing the axe-core pattern (see src/test/axe.ts) other
 * component tests can adopt. Modal is a deliberate first target: it's
 * reused by every stateful overlay in the app-shell (booking, cart, AI
 * panel, dashboards), so a real regression here has the widest blast
 * radius of any single component in the design system.
 */
describe( 'Modal accessibility', () => {
	it( 'has no automatically detectable accessibility violations when open', async () => {
		const { container } = render(
			<Modal open onClose={ () => {} } labelledBy="modal-a11y-test-title">
				<h2 id="modal-a11y-test-title">عنوان آزمایشی</h2>
				<p>محتوای آزمایشی برای بررسی دسترس‌پذیری.</p>
			</Modal>
		);

		await expectNoAccessibilityViolations( container );
	} );

	it( 'renders nothing (and has nothing to violate) when closed', () => {
		const { container } = render(
			<Modal open={ false } onClose={ () => {} }>
				<p>محتوای آزمایشی</p>
			</Modal>
		);

		expect( container.innerHTML ).toBe( '' );
	} );
} );
