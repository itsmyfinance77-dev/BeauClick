import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { track } from '@/lib/analytics';
import { Button, LoadingDots } from '@/design-system';
import { toPersianDigits } from '@/lib/format';

interface ReferralSummary {
	code: string;
	shareUrl: string;
	referredCount: number;
	qualifiedCount: number;
	rewardedCount: number;
	pointsEarned: number;
}

/**
 * V2.2 Step 12 — lives inside the Journey tab as a sibling of
 * LoyaltySection, not a new nav destination, matching the exact same
 * "loyalty-adjacent features belong in Journey" precedent LoyaltySection's
 * own docblock already established. A fetch failure here is deliberately
 * non-fatal to the rest of the tab (renders nothing rather than an error) —
 * referral is a nice-to-have surface, not core to what a customer came to
 * Journey for.
 */
export function ReferralCard() {
	const [ summary, setSummary ] = useState<ReferralSummary | null>( null );
	const [ failed, setFailed ] = useState( false );
	const [ statusMessage, setStatusMessage ] = useState( '' );

	useEffect( () => {
		api.get<ReferralSummary>( '/referrals/summary' ).then( setSummary ).catch( () => setFailed( true ) );
	}, [] );

	async function copyLink(): Promise<void> {
		if ( ! summary ) return;
		try {
			await navigator.clipboard.writeText( summary.shareUrl );
			setStatusMessage( 'لینک کپی شد.' );
		} catch {
			setStatusMessage( 'کپی خودکار ممکن نشد — لینک را به‌صورت دستی انتخاب و کپی کنید.' );
		}
		window.setTimeout( () => setStatusMessage( '' ), 4000 );
	}

	async function shareLink(): Promise<void> {
		if ( ! summary ) return;
		track( 'referral_link_shared' );

		const shareText = `با لینک من در BeauClick ثبت‌نام کن و امتیاز هدیه بگیر: ${ summary.shareUrl }`;
		if ( navigator.share ) {
			try {
				await navigator.share( { title: 'BeauClick', text: shareText, url: summary.shareUrl } );
				return;
			} catch {
				// Cancelled by the user or the platform share sheet failed -- fall back to copy below.
			}
		}
		await copyLink();
	}

	if ( failed ) return null;
	if ( ! summary ) return <LoadingDots />;

	return (
		<section className="bc-card" style={ { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } }>
			<div>
				<h3 style={ { margin: '0 0 4px', fontSize: 15 } }>دوستانت رو به BeauClick دعوت کن</h3>
				<p style={ { margin: 0, fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>
					با هر معرفی موفق، هم تو و هم دوستت امتیاز هدیه می‌گیرید.
				</p>
			</div>

			<div style={ { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }>
				<code className="bc-numeric" style={ { background: 'var(--bc-color-surface-tint)', padding: '6px 10px', borderRadius: 8, fontSize: 14, letterSpacing: 1 } }>
					{ summary.code }
				</code>
				<Button variant="outline" onClick={ () => void copyLink() } aria-label="کپی لینک معرفی">کپی لینک</Button>
				<Button variant="primary" onClick={ () => void shareLink() } aria-label="اشتراک‌گذاری لینک معرفی">اشتراک‌گذاری</Button>
			</div>

			{ /* aria-live region -- copy/share success or failure is announced to screen readers, not communicated by color/icon alone (§30's own accessibility requirement). Fixed min-height so its appearance doesn't shift layout. */ }
			<p role="status" aria-live="polite" style={ { margin: 0, fontSize: 12, minHeight: 16, color: 'var(--bc-color-success)' } }>
				{ statusMessage }
			</p>

			<div className="bc-numeric" style={ { display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--bc-color-ink-soft)' } }>
				<span>{ toPersianDigits( summary.referredCount ) } نفر ثبت‌نام کرده‌اند</span>
				<span>{ toPersianDigits( summary.qualifiedCount ) } واجد شرایط شده</span>
				<span>{ toPersianDigits( summary.pointsEarned ) } امتیاز کسب‌شده</span>
			</div>
		</section>
	);
}
