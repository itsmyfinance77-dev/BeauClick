import { type ReactNode } from 'react';
import './Badge.css';

export type BadgeVariant = 'verified' | 'discount' | 'recommended' | 'success' | 'warning' | 'error';

export function Badge( { variant, children }: { variant: BadgeVariant; children: ReactNode } ) {
	return <span className={ `bc-badge bc-badge--${ variant }` }>{ children }</span>;
}
