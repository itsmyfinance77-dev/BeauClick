import { type ReactNode } from 'react';
import './EmptyState.css';

export function EmptyState( { title, action }: { title: string; action?: ReactNode } ) {
	return (
		<div className="bc-empty-state">
			<p className="bc-empty-state__title">{ title }</p>
			{ action }
		</div>
	);
}
