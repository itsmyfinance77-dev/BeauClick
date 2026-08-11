import { formatToman, formatRating, toPersianDigits } from '@/lib/format';
import { api } from '@/lib/api';
import type { AiRecommendation } from './types';

/**
 * Routes straight into profile view (provider), the product page, or the
 * provider's profile with booking-prefill query params (service) — design
 * handoff §9. No add-to-cart/booking shortcut here, since a card still
 * benefits from the same page context (images, reviews) a direct
 * click-through provides.
 */
export function RecommendationCard( { rec }: { rec: AiRecommendation } ) {
	function onClick() {
		if ( rec.eventId ) {
			api.post( `/ai/recommendations/${ rec.eventId }/click` ).catch( () => {} );
		}
	}

	const reason = rec.reason ? (
		<span style={ { fontSize: 11, color: 'var(--bc-color-ink-faint)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }>
			{ rec.reason }
		</span>
	) : null;

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
					{ reason }
				</div>
			</a>
		);
	}

	if ( 'service' === rec.type ) {
		return (
			<a href={ rec.url ?? '#' } onClick={ onClick } className="bc-card" style={ { display: 'flex', gap: 10, padding: 10, textDecoration: 'none', color: 'inherit', alignItems: 'center' } }>
				<div style={ { width: 48, height: 48, borderRadius: 12, background: 'var(--bc-gradient-brand)', flexShrink: 0 } } />
				<div style={ { minWidth: 0 } }>
					<strong style={ { fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }>{ rec.name }</strong>
					<span style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">
						{ rec.providerName && `${ rec.providerName } · ` }
						{ null != rec.price && rec.price > 0 && `${ formatToman( rec.price ) } تومان` }
						{ null != rec.durationMinutes && rec.durationMinutes > 0 && ` · ${ toPersianDigits( rec.durationMinutes ) } دقیقه` }
					</span>
					{ reason }
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
				{ reason }
			</div>
		</a>
	);
}
