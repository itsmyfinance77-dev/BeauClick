import { formatToman, formatRating, toPersianDigits } from '@/lib/format';
import { api } from '@/lib/api';
import type { AiRecommendation } from './types';

/**
 * Routes straight into profile view (provider) or the product page (design
 * handoff §9) — no add-to-cart shortcut here, since a product recommendation
 * still benefits from the same page context (images, reviews) a direct
 * click-through provides.
 */
export function RecommendationCard( { rec }: { rec: AiRecommendation } ) {
	function onClick() {
		if ( rec.eventId ) {
			api.post( `/ai/recommendations/${ rec.eventId }/click` ).catch( () => {} );
		}
	}

	if ( 'provider' === rec.type ) {
		return (
			<a href={ rec.url ?? '#' } onClick={ onClick } className="bc-card" style={ { display: 'flex', gap: 10, padding: 10, textDecoration: 'none', color: 'inherit', alignItems: 'center' } }>
				<div style={ { width: 48, height: 48, borderRadius: 12, background: 'var(--bc-gradient-brand)', flexShrink: 0 } } />
				<div style={ { minWidth: 0 } }>
					<strong style={ { fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }>{ rec.name }</strong>
					<span style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">
						★ { formatRating( rec.rating ?? 0 ) } ({ toPersianDigits( rec.reviewCount ?? 0 ) })
						{ null != rec.priceFrom && ` · ${ formatToman( rec.priceFrom ) } تومان` }
					</span>
				</div>
			</a>
		);
	}

	return (
		<a href={ rec.url ?? '#' } onClick={ onClick } className="bc-card" style={ { display: 'flex', gap: 10, padding: 10, textDecoration: 'none', color: 'inherit', alignItems: 'center' } }>
			{ rec.image
				? <img src={ rec.image } alt="" style={ { width: 48, height: 48, borderRadius: 12, objectFit: 'cover', flexShrink: 0 } } />
				: <div style={ { width: 48, height: 48, borderRadius: 12, background: 'var(--bc-color-surface-tint)', flexShrink: 0 } } /> }
			<div style={ { minWidth: 0 } }>
				<strong style={ { fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }>{ rec.name }</strong>
				{ null != rec.price && <span style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">{ formatToman( rec.price ) } تومان</span> }
			</div>
		</a>
	);
}
