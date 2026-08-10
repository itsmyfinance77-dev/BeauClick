import { type ReactNode, useEffect } from 'react';
import './Modal.css';

export interface ModalProps {
	open: boolean;
	onClose: () => void;
	children: ReactNode;
	/** Full-screen sheet on mobile, centered rounded modal on desktop — matches the
	 * booking modal / cart drawer / AI panel chrome described in the design handoff. */
	variant?: 'centered' | 'drawer-end';
	labelledBy?: string;
}

export function Modal( { open, onClose, children, variant = 'centered', labelledBy }: ModalProps ) {
	useEffect( () => {
		if ( ! open ) return;
		const onKeyDown = ( e: KeyboardEvent ) => {
			if ( e.key === 'Escape' ) onClose();
		};
		document.addEventListener( 'keydown', onKeyDown );
		return () => document.removeEventListener( 'keydown', onKeyDown );
	}, [ open, onClose ] );

	if ( ! open ) return null;

	return (
		<div className="bc-modal-backdrop" onClick={ onClose }>
			<div
				className={ `bc-modal bc-modal--${ variant }` }
				role="dialog"
				aria-modal="true"
				aria-labelledby={ labelledBy }
				onClick={ ( e ) => e.stopPropagation() }
			>
				{ children }
			</div>
		</div>
	);
}
