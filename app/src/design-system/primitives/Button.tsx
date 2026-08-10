import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'outline' | 'light' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	children: ReactNode;
}

/**
 * Primary (filled violet, darkens on hover), outline (bordered, tints bg on
 * hover), light (for dark surfaces — B2B hero), ghost (no chrome, for
 * low-emphasis inline actions not in the original token spec but needed
 * consistently across dashboards). 12px radius, 700 weight, per the design
 * handoff's "Components" section.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	( { variant = 'primary', className = '', children, ...props }, ref ) => (
		<button ref={ ref } className={ `bc-btn bc-btn--${ variant } ${ className }`.trim() } { ...props }>
			{ children }
		</button>
	)
);

Button.displayName = 'Button';
