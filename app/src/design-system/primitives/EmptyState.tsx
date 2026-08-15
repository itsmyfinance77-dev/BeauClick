import { type ReactNode } from 'react';
import './EmptyState.css';

export function EmptyState( { title, action, illustration }: { title: string; action?: ReactNode; illustration?: string } ) {
	return (
		<div className="bc-empty-state">
			{ illustration && (
				// Decorative only -- the title text already carries the actual
				// information, so this must never be announced a second time to
				// a screen reader (alt="").
				<img src={ illustration } alt="" className="bc-empty-state__illustration" width="100" height="80" />
			) }
			<p className="bc-empty-state__title">{ title }</p>
			{ action }
		</div>
	);
}
