import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, type BadgeVariant } from '@/design-system';
import type { VerificationSummary } from './types';
import { VerificationModal } from './VerificationModal';

const STATUS_LABELS: Record<string, string> = {
	unverified: 'بدون درخواست تأیید',
	pending: 'در انتظار بررسی',
	verified: 'تأییدشده',
	rejected: 'ردشده',
	suspended: 'معلق‌شده',
	revoked: 'لغوشده',
};

const STATUS_VARIANTS: Record<string, BadgeVariant> = {
	unverified: 'warning',
	pending: 'warning',
	verified: 'verified',
	rejected: 'error',
	suspended: 'error',
	revoked: 'error',
};

const STATUS_HINTS: Record<string, string> = {
	unverified: 'با ثبت مدارک، نشان «تأییدشده» بگیرید و اعتماد مشتریان را جلب کنید.',
	pending: 'درخواست تأیید شما ارسال شده و در حال بررسی توسط تیم BeauClick است.',
	verified: 'پروفایل شما توسط BeauClick بررسی و تأیید شده است.',
	rejected: 'درخواست قبلی شما رد شده است. برای مشاهده دلیل و ارسال دوباره کلیک کنید.',
	suspended: 'نشان تأیید شما به‌طور موقت معلق شده است.',
	revoked: 'تأیید پروفایل شما لغو شده است.',
};

/**
 * Status banner on the Overview tab -- the single entry point into the
 * verification workflow (a deliberate choice not to add an 11th fixed nav
 * item to the professional dashboard). Fetches its own lightweight summary
 * to render the badge/hint, independent from VerificationModal's own fetch
 * on open -- two small requests for one user's own record, not a real N+1
 * concern, and it keeps the card simple rather than threading fetched
 * state through a shared parent.
 */
export function VerificationCard() {
	const [ summary, setSummary ] = useState<VerificationSummary | null>( null );
	const [ open, setOpen ] = useState( false );

	const load = useCallback( () => {
		api.get<VerificationSummary>( '/marketplace/verification/me' ).then( setSummary ).catch( () => setSummary( null ) );
	}, [] );

	useEffect( load, [ load ] );

	if ( ! summary ) return null;

	return (
		<>
			<button
				type="button"
				onClick={ () => setOpen( true ) }
				className="bc-card"
				style={ {
					width: '100%',
					textAlign: 'start',
					border: 'none',
					font: 'inherit',
					cursor: 'pointer',
					padding: 16,
					marginBottom: 24,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: 12,
					flexWrap: 'wrap',
				} }
			>
				<div style={ { display: 'flex', flexDirection: 'column', gap: 4 } }>
					<div style={ { display: 'flex', alignItems: 'center', gap: 8 } }>
						<strong style={ { fontSize: 14 } }>وضعیت تأیید پروفایل</strong>
						<Badge variant={ STATUS_VARIANTS[ summary.status ] ?? 'warning' }>{ STATUS_LABELS[ summary.status ] ?? summary.status }</Badge>
					</div>
					<span style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>{ STATUS_HINTS[ summary.status ] ?? '' }</span>
				</div>
				<span style={ { fontSize: 13, color: 'var(--bc-color-primary)', fontWeight: 700 } }>مشاهده و مدیریت &larr;</span>
			</button>
			<VerificationModal
				open={ open }
				onClose={ () => {
					setOpen( false );
					load();
				} }
			/>
		</>
	);
}
