import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, LoadingDots } from '@/design-system';
import { formatFullJalaliDate, toPersianDigits } from '@/lib/format';
import type { LoyaltySummary } from './types';

const REASON_LABELS: Record<string, string> = {
	booking_completed: 'انجام نوبت',
	review_submitted: 'ثبت نظر',
	order_completed: 'خرید از فروشگاه',
	manual_adjustment: 'اصلاح دستی',
	redeemed: 'استفاده از امتیاز',
};

const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
	active: 'فعال',
	expired: 'منقضی‌شده',
	cancelled: 'لغوشده',
};

function jalali( iso: string | null ): string {
	return iso ? formatFullJalaliDate( new Date( iso.replace( ' ', 'T' ) ) ) : '—';
}

function benefitDescription( b: LoyaltySummary['benefits'][number] ): string {
	if ( 'bonus_points_multiplier' === b.benefitType && b.config.multiplier ) {
		return `${ b.label } (×${ toPersianDigits( String( b.config.multiplier ) ) })`;
	}
	if ( 'discount_percentage' === b.benefitType && b.config.percentage ) {
		return `${ b.label } (٪${ toPersianDigits( String( b.config.percentage ) ) })`;
	}
	return b.label;
}

/**
 * V2.1 Step 9 — replaces the plain-text "X امتیاز وفاداری" line that used
 * to be the entirety of the loyalty surface inside Journey. Reuses the
 * design system's own Badge/Card primitives; no new visual language, no
 * new nav destination (Journey already fills the "باشگاه مشتریان" slot).
 */
export function LoyaltySection() {
	const [ summary, setSummary ] = useState<LoyaltySummary | null>( null );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		api
			.get<LoyaltySummary>( '/loyalty/summary' )
			.then( setSummary )
			.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت اطلاعات وفاداری.' ) );
	}, [] );

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! summary ) return <LoadingDots />;

	const { progress, membership, benefits, history } = summary;

	return (
		<section className="bc-card" style={ { padding: 16, display: 'flex', flexDirection: 'column', gap: 14 } }>
			<div style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 } }>
				<div style={ { display: 'flex', alignItems: 'center', gap: 8 } }>
					<Badge variant="recommended">{ progress.currentTier ? progress.currentTier.name : 'بدون سطح' }</Badge>
					<span className="bc-numeric" style={ { fontSize: 13, color: 'var(--bc-color-ink-soft)' } }>
						{ toPersianDigits( summary.balance ) } امتیاز قابل استفاده
					</span>
				</div>
				{ membership && (
					<Badge variant={ 'active' === membership.status ? 'success' : 'warning' }>
						عضویت { membership.plan?.name ? `«${ membership.plan.name }» ` : '' }{ MEMBERSHIP_STATUS_LABELS[ membership.status ] ?? membership.status }
					</Badge>
				) }
			</div>

			{ progress.nextTier && (
				<div>
					<div
						role="progressbar"
						aria-valuenow={ progress.percentToNext ?? 0 }
						aria-valuemin={ 0 }
						aria-valuemax={ 100 }
						aria-label={ `پیشرفت تا سطح ${ progress.nextTier.name }` }
						style={ { height: 8, borderRadius: 999, background: 'var(--bc-color-line)', overflow: 'hidden' } }
					>
						<div
							style={ {
								height: '100%',
								width: `${ progress.percentToNext ?? 0 }%`,
								background: 'var(--bc-color-primary)',
								borderRadius: 999,
								transition: 'width 200ms ease',
							} }
						/>
					</div>
					<p style={ { margin: '6px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">
						{ toPersianDigits( progress.pointsToNext ?? 0 ) } امتیاز تا سطح «{ progress.nextTier.name }»
					</p>
				</div>
			) }
			{ ! progress.nextTier && progress.currentTier && (
				<p style={ { margin: 0, fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>شما در بالاترین سطح وفاداری هستید.</p>
			) }

			{ membership?.expiresAt && (
				<p style={ { margin: 0, fontSize: 12, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">
					تاریخ انقضای عضویت: { jalali( membership.expiresAt ) }
				</p>
			) }

			{ benefits.length > 0 && (
				<div>
					<h3 style={ { fontSize: 13, margin: '0 0 6px' } }>مزایای شما</h3>
					<div style={ { display: 'flex', flexWrap: 'wrap', gap: 6 } }>
						{ benefits.map( ( b ) => (
							<span key={ b.id } className="bc-badge bc-badge--success" style={ { fontSize: 12 } }>
								{ benefitDescription( b ) }
							</span>
						) ) }
					</div>
				</div>
			) }

			{ history.length > 0 && (
				<div>
					<h3 style={ { fontSize: 13, margin: '0 0 6px' } }>تاریخچه امتیاز</h3>
					<div style={ { display: 'flex', flexDirection: 'column', gap: 4 } }>
						{ history.slice( 0, 10 ).map( ( h, i ) => (
							<div key={ i } style={ { display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--bc-color-line)' } }>
								<span>{ REASON_LABELS[ h.reason ] ?? h.reason }</span>
								<span className="bc-numeric" style={ { color: h.points >= 0 ? 'var(--bc-color-success)' : 'var(--bc-color-error)' } }>
									{ h.points >= 0 ? '+' : '' }{ toPersianDigits( h.points ) } · { jalali( h.createdAt ) }
								</span>
							</div>
						) ) }
					</div>
				</div>
			) }
		</section>
	);
}
