import { createRoot } from 'react-dom/client';
import { type ReactElement } from 'react';

/**
 * Every app-shell surface mounts itself into a DOM node the theme provides
 * (e.g. `<div id="bc-booking-root" data-provider-id="42">`), rather than
 * assuming it owns the whole page — the theme server-renders the page,
 * this only hydrates the interactive island. No-ops if the mount point
 * isn't present on the current page, so each bundle can be enqueued
 * broadly without erroring on pages that don't use it.
 */
export function mount( elementId: string, render: ( el: HTMLElement ) => ReactElement ): void {
	const el = document.getElementById( elementId );
	if ( ! el ) return;
	createRoot( el ).render( render( el ) );
}
