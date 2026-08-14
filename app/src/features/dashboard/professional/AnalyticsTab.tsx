import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { track } from '@/lib/analytics';
import { formatToman, formatRating, toPersianDigits } from '@/lib/format';
import { Chip, LoadingDots, EmptyState } from '@/design-system';
import { StatCard } from '../shared/StatCard';

interface AnalyticsSummary {
	range: { from: string; to: string };
	providerId: number;
	postType: string;
	metrics: {
		funnel: {
			started: number;
			confirmed: number;
			completed: number;
			cancelled: number;
			expired: number;
			noShow: number;
			rescheduled: number;
			conversionRate: number;
		};
		profileViews: number;
		reviews: { count: number; avgRating: number };
		customers: { total: number; repeat: number; newInRange: number };
		servicePerformance: { serviceId: number; serviceName: string; completedCount: number }[];
	};
	b2b: {
		accountStatus: string;
		quoteCounts: { requested: number; quoted: number; accepted: number; expired: number };
		grossOrderValueLabel: string;
		grossOrderValue: number;
	} | null;
}

type PresetId = 'today' | '7d' | '30d';

function presetRange( preset: PresetId ): { from: string; to: string } {
	const today = new Date();
	const to = toYmd( today );
	const days = preset === 'today' ? 0 : preset === '7d' ? 6 : 29;
	const fromDate = new Date( today );
	fromDate.setDate( fromDate.getDate() - days );
	return { from: toYmd( fromDate ), to };
}

function toYmd( d: Date ): string {
	return `${ d.getFullYear() }-${ String( d.getMonth() + 1 ).padStart( 2, '0' ) }-${ String( d.getDate() ).padStart( 2, '0' ) }`;
}

const PRESETS: { id: PresetId; label: string }[] = [
	{ id: 'today', label: 'امروز' },
	{ id: '7d', label: '۷ روز اخیر' },
	{ id: '30d', label: '۳۰ روز اخیر' },
];

const B2B_STATUS_LABELS: Record<string, string> = {
	pending: 'در انتظار تأیید',
	approved: 'تأییدشده',
	rejected: 'رد‌شده',
};

/**
 * V2.2 Step 16 — reuses Step 11's MetricsService (via /analytics/my/summary)
 * with an ownership filter, not a second analytics engine. Deliberately a
 * small, actionable set of numbers (task's own "do not build 30 charts"
 * instruction) — funnel, profile views, reviews, customer retention,
 * top services, and B2B activity when relevant — never a revenue/earnings
 * figure this product doesn't yet have an authoritative source for.
 */
export function AnalyticsTab() {
	const [ preset, setPreset ] = useState<PresetId>( '30d' );
	const [ data, setData ] = useState<AnalyticsSummary | null>( null );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => { track( 'crm_opened' ); }, [] );

	useEffect( () => {
		setError( null );
		const { from, to } = presetRange( preset );
		api
			.get<AnalyticsSummary>( `/analytics/my/summary?from=${ from }&to=${ to }` )
			.then( setData )
			.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت آمار.' ) );
	}, [ preset ] );

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! data ) return <LoadingDots />;

	const { funnel, profileViews, reviews, customers, servicePerformance } = data.metrics;

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>آمار و تحلیل</h1>

			<div style={ { display: 'flex', gap: 8, marginBottom: 20 } }>
				{ PRESETS.map( ( p ) => (
					<Chip key={ p.id } active={ preset === p.id } onClick={ () => setPreset( p.id ) }>{ p.label }</Chip>
				) ) }
			</div>

			<div style={ { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16, marginBottom: 24 } }>
				<StatCard label="بازدید پروفایل" value={ toPersianDigits( profileViews ) } />
				<StatCard label="نوبت‌های شروع‌شده" value={ toPersianDigits( funnel.started ) } />
				<StatCard label="نوبت‌های انجام‌شده" value={ toPersianDigits( funnel.completed ) } />
				<StatCard label="نرخ تبدیل" value={ `${ toPersianDigits( Math.round( funnel.conversionRate * 100 ) ) }٪` } />
				<StatCard label="لغو‌شده" value={ toPersianDigits( funnel.cancelled ) } />
				<StatCard label="جابه‌جا‌شده" value={ toPersianDigits( funnel.rescheduled ) } />
				<StatCard label="امتیاز میانگین" value={ reviews.count > 0 ? `${ formatRating( reviews.avgRating ) } (${ toPersianDigits( reviews.count ) })` : '—' } />
				<StatCard label="مشتریان بازگشتی" value={ `${ toPersianDigits( customers.repeat ) } از ${ toPersianDigits( customers.total ) }` } />
				<StatCard label="مشتریان جدید" value={ toPersianDigits( customers.newInRange ) } />
			</div>

			<div className="bc-card" style={ { padding: 16, marginBottom: 24 } }>
				<h3 style={ { marginTop: 0, fontSize: 15 } }>عملکرد خدمات (۵ خدمت برتر)</h3>
				{ servicePerformance.length === 0 ? (
					<EmptyState title="در این بازه زمانی نوبت انجام‌شده‌ای ثبت نشده است." />
				) : (
					<div style={ { overflowX: 'auto' } }>
						<table style={ { width: '100%', borderCollapse: 'collapse', fontSize: 13 } }>
							<thead>
								<tr style={ { textAlign: 'start', color: 'var(--bc-color-ink-faint)' } }>
									<th style={ { padding: '8px 4px' } }>خدمت</th>
									<th style={ { padding: '8px 4px' } }>نوبت انجام‌شده</th>
								</tr>
							</thead>
							<tbody>
								{ servicePerformance.map( ( s ) => (
									<tr key={ s.serviceId } style={ { borderTop: '1px solid var(--bc-color-line)' } }>
										<td style={ { padding: '8px 4px' } }>{ s.serviceName || '—' }</td>
										<td style={ { padding: '8px 4px' } } className="bc-numeric">{ toPersianDigits( s.completedCount ) }</td>
									</tr>
								) ) }
							</tbody>
						</table>
					</div>
				) }
			</div>

			{ data.b2b && (
				<div className="bc-card" style={ { padding: 16 } }>
					<h3 style={ { marginTop: 0, fontSize: 15 } }>فعالیت B2B</h3>
					<p style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)', marginTop: 0 } }>
						وضعیت حساب: { B2B_STATUS_LABELS[ data.b2b.accountStatus ] ?? data.b2b.accountStatus }
					</p>
					<div style={ { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 } }>
						<StatCard label="درخواست‌شده" value={ toPersianDigits( data.b2b.quoteCounts.requested ) } />
						<StatCard label="قیمت‌گذاری‌شده" value={ toPersianDigits( data.b2b.quoteCounts.quoted ) } />
						<StatCard label="پذیرفته‌شده" value={ toPersianDigits( data.b2b.quoteCounts.accepted ) } />
						<StatCard label={ data.b2b.grossOrderValueLabel } value={ `${ formatToman( data.b2b.grossOrderValue ) } تومان` } />
					</div>
				</div>
			) }
		</div>
	);
}
