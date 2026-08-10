import { type InputHTMLAttributes, forwardRef } from 'react';
import './Input.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
	/** Hero search input sits in a shadowed white box with no visible border;
	 * everywhere else inputs are bordered. Both get a 2px soft violet focus ring. */
	bare?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
	( { bare = false, className = '', ...props }, ref ) => (
		<input ref={ ref } className={ `bc-input ${ bare ? 'bc-input--bare' : '' } ${ className }`.trim() } { ...props } />
	)
);

Input.displayName = 'Input';
