import './LoadingDots.css';

/**
 * The AI "typing" indicator — three staggered pulsing dots in a tinted
 * bubble. Per the design handoff, this is the only loading pattern in the
 * approved system; reuse it for any future async action rather than
 * inventing a new spinner style.
 */
export function LoadingDots() {
	return (
		<span className="bc-loading-dots" role="status" aria-label="در حال بارگذاری">
			<span />
			<span />
			<span />
		</span>
	);
}
