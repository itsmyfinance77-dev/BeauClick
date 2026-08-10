import { type HTMLAttributes, type ReactNode, forwardRef } from 'react';
import './Card.css';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
	hoverable?: boolean;
	children: ReactNode;
}

/** 18px radius per token spec; hoverable cards lift 3px with a soft shadow on hover (provider/product cards). */
export const Card = forwardRef<HTMLDivElement, CardProps>(
	( { hoverable = false, className = '', children, ...props }, ref ) => (
		<div ref={ ref } className={ `bc-card ${ hoverable ? 'bc-card--hoverable' : '' } ${ className }`.trim() } { ...props }>
			{ children }
		</div>
	)
);

Card.displayName = 'Card';
