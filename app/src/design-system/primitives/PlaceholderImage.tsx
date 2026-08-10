import './PlaceholderImage.css';

/**
 * No real photography/icons in the approved design — every image is a
 * placeholder treatment: a soft two-tone diagonal gradient wash (hue varies
 * per entity) with a small monospace Persian caption, deliberately subdued
 * so the caption never dominates the card. Swap for real photography using
 * the same aspect ratio/radius once content exists — this component is the
 * single place that swap happens.
 */
export function PlaceholderImage( { caption, hue = 290, aspectRatio = '4 / 3' }: { caption: string; hue?: number; aspectRatio?: string } ) {
	return (
		<div
			className="bc-placeholder-image"
			style={ {
				aspectRatio,
				background: `linear-gradient(135deg, oklch(0.9 0.04 ${ hue }), oklch(0.8 0.06 ${ hue + 40 }))`,
			} }
		>
			<span>{ caption }</span>
		</div>
	);
}
