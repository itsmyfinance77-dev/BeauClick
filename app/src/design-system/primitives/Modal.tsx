import { type ReactNode, useEffect, useRef } from 'react';
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

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal( { open, onClose, children, variant = 'centered', labelledBy }: ModalProps ) {
	const dialogRef = useRef<HTMLDivElement>( null );
	const previouslyFocused = useRef<HTMLElement | null>( null );

	/**
	 * An accessibility audit found this dialog had no focus trap and never
	 * moved focus on open — a keyboard/screen-reader user could tab straight
	 * into the page behind the backdrop. Moves focus in on open, cycles
	 * Tab/Shift+Tab within the dialog while it's open, and restores focus to
	 * whatever triggered it on close.
	 */
	useEffect( () => {
		if ( ! open ) return;

		previouslyFocused.current = document.activeElement as HTMLElement | null;
		const dialog = dialogRef.current;
		const firstFocusable = dialog?.querySelector<HTMLElement>( FOCUSABLE_SELECTOR );
		( firstFocusable ?? dialog )?.focus();

		const onKeyDown = ( e: KeyboardEvent ) => {
			if ( e.key === 'Escape' ) {
				onClose();
				return;
			}
			if ( e.key !== 'Tab' || ! dialog ) return;

			const focusable = Array.from( dialog.querySelectorAll<HTMLElement>( FOCUSABLE_SELECTOR ) );
			if ( focusable.length === 0 ) {
				e.preventDefault();
				return;
			}
			const first = focusable[ 0 ];
			const last = focusable[ focusable.length - 1 ];

			if ( e.shiftKey && document.activeElement === first ) {
				e.preventDefault();
				last.focus();
			} else if ( ! e.shiftKey && document.activeElement === last ) {
				e.preventDefault();
				first.focus();
			}
		};

		document.addEventListener( 'keydown', onKeyDown );
		return () => {
			document.removeEventListener( 'keydown', onKeyDown );
			previouslyFocused.current?.focus();
		};
	}, [ open, onClose ] );

	if ( ! open ) return null;

	return (
		<div className="bc-modal-backdrop" onClick={ onClose }>
			<div
				ref={ dialogRef }
				className={ `bc-modal bc-modal--${ variant }` }
				role="dialog"
				aria-modal="true"
				aria-labelledby={ labelledBy }
				tabIndex={ -1 }
				onClick={ ( e ) => e.stopPropagation() }
			>
				{ /* An accessibility audit found none of the panels using this
				 * modal (AI assistant, cart, booking) rendered any close
				 * control — dismissal was backdrop-click or Escape only, both
				 * invisible affordances. One shared button here covers every
				 * caller instead of each panel adding its own. */ }
				<button type="button" className="bc-modal__close" aria-label="بستن" onClick={ onClose }>
					&times;
				</button>
				{ children }
			</div>
		</div>
	);
}
