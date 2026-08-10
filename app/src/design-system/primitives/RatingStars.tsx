import { formatCount, formatRating } from '@/lib/format';
import './RatingStars.css';

/** Typographic ★ only — no icon library was used in the approved design. */
export function RatingStars( { rating, reviewCount }: { rating: number; reviewCount?: number } ) {
	return (
		<span className="bc-rating bc-numeric">
			<span className="bc-rating__star" aria-hidden="true">★</span>
			<span>{ formatRating( rating ) }</span>
			{ typeof reviewCount === 'number' && (
				<span className="bc-rating__count">({ formatCount( reviewCount ) })</span>
			) }
		</span>
	);
}
