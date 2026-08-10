import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import './Chip.css';

export type ChipAccent = 'primary' | 'accent';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	active?: boolean;
	/** primary (violet) for specialty filters, accent (rose) for city filters —
	 * a deliberate secondary-accent use to visually separate the two filter axes,
	 * per the design handoff's "Chips/filters" note. */
	accent?: ChipAccent;
	children: ReactNode;
}

export function Chip( { active = false, accent = 'primary', className = '', children, ...props }: ChipProps ) {
	return (
		<button
			type="button"
			className={ `bc-chip bc-chip--${ accent } ${ active ? 'bc-chip--active' : '' } ${ className }`.trim() }
			aria-pressed={ active }
			{ ...props }
		>
			{ children }
		</button>
	);
}
