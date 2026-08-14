import axe from 'axe-core';

/**
 * V2.2 Step 13 (A11Y-03) — automated accessibility testing wired into the
 * existing Vitest pipeline, rather than standing up a separate tool/runner
 * (e.g. Playwright + @axe-core/playwright) this project doesn't otherwise
 * have. axe-core runs directly against jsdom-rendered output, the same
 * environment every other component test in this suite already uses.
 *
 * Deliberately a thin wrapper, not a custom Vitest matcher package (no
 * jest-axe/vitest-axe dependency) — one focused library, used directly.
 */
export async function expectNoAccessibilityViolations( container: Element ): Promise<void> {
	const results = await axe.run( container, {
		rules: {
			// jsdom has no real layout/rendering engine, so contrast can't be
			// computed reliably here — it throws (no <canvas> support) rather
			// than giving a trustworthy pass/fail either way. Real contrast
			// verification already happens via this project's own design
			// tokens (fixed, pre-approved palette) and manual/live browser QA.
			'color-contrast': { enabled: false },
		},
	} );

	if ( results.violations.length > 0 ) {
		const summary = results.violations
			.map( ( v ) => `- [${ v.id }] ${ v.help } (${ v.nodes.length } node(s)): ${ v.helpUrl }` )
			.join( '\n' );
		throw new Error( `Accessibility violations found:\n${ summary }` );
	}
}
