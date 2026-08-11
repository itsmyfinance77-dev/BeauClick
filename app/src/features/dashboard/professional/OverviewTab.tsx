import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatToman, formatRating, formatShortDate, formatTime, toPersianDigits } from '@/lib/format';
import { LoadingDots } from '@/design-system';
import { StatCard } from '../shared/StatCard';
import type { DashboardStats } from './types';

const STATUS_LABELS: Record<string, string> = {
	pending: 'در انتظار',
	confirmed: 'تأیید‌شده',
	completed: 'انجام‌شده',
	cancelled: 'لغو‌شده',
	no_show: 'عدم حضور',
};

function StatusPill( { status }: { status: string } ) {
	const variant = status === 'confirmed' || status === 'completed' ? 'success' : status === 'cancelled' || status === 'no_show' ? 'error' : 'warning';
	return <span className={ `bc-badge bc-badge--${ variant }` }>{ STATUS_LABELS[ status ] ?? status }</span>;
}

export function OverviewTab() {
	const [ stats, setStats ] = useState<DashboardStats | null>( null );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		api.get<DashboardStats>( '/booking/my/stats' )
			.then( setStats )
			.catch( () => setError( 'خطا در دریافت آمار داشبورد.' ) );
	}, [] );

	if ( error ) return <p style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! stats ) return <LoadingDots />;

	const maxCount = Math.max( 1, ...stats.weeklyBookings.map( ( d ) => d.count ) );

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>سلام 👋</h1>

			<div style={ { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginBottom: 24 } }>
				<StatCard label="نوبت‌های امروز" value={ toPersianDigits( stats.todaysBookings ) } />
				<StatCard label="درآمد این ماه" value={ `${ formatToman( stats.monthRevenue ) } تومان` } />
				<StatCard label="مشتریان جدید" value={ toPersianDigits( stats.newClients ) } />
				<StatCard label="امتیاز کلی" value={ `${ formatRating( stats.rating ) } (${ toPersianDigits( stats.reviewCount ) })` } />
			</div>

			<div className="bc-overview-grid" style={ { display: 'grid', gap: 16, marginBottom: 24 } }>
				<div className="bc-card" style={ { padding: 16 } }>
					<h3 style={ { marginTop: 0, fontSize: 15 } }>نوبت‌های هفته</h3>
					<div style={ { display: 'flex', alignItems: 'flex-end', gap: 8, height: 100 } }>
						{ stats.weeklyBookings.map( ( d ) => (
							<div key={ d.date } style={ { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 } }>
								<div
									style={ {
										width: '100%',
										height: `${ Math.max( 4, ( d.count / maxCount ) * 80 ) }px`,
										background: 'var(--bc-color-primary)',
										borderRadius: 4,
									} }
									title={ String( d.count ) }
								/>
								<span className="bc-numeric" style={ { fontSize: 11, color: 'var(--bc-color-ink-faint)' } }>{ formatShortDate( new Date( d.date ) ).day }</span>
							</div>
						) ) }
					</div>
				</div>

				<div className="bc-card" style={ { padding: 16 } }>
					<h3 style={ { marginTop: 0, fontSize: 15 } }>نوبت‌های امروز</h3>
					{ stats.todayUpcoming.length === 0 && <p style={ { color: 'var(--bc-color-ink-faint)', fontSize: 13 } }>نوبتی برای امروز نیست.</p> }
					{ stats.todayUpcoming.map( ( b ) => (
						<div key={ b.id } style={ { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--bc-color-line)', fontSize: 13 } }>
							<span>{ b.customerName }</span>
							<span className="bc-numeric">{ formatTime( new Date( b.slotStart.replace( ' ', 'T' ) ) ) }</span>
						</div>
					) ) }
				</div>
			</div>

			<div className="bc-card" style={ { padding: 16 } }>
				<h3 style={ { marginTop: 0, fontSize: 15 } }>رزروهای اخیر</h3>
				<div style={ { overflowX: 'auto' } }>
					<table style={ { width: '100%', borderCollapse: 'collapse', fontSize: 13 } }>
						<thead>
							<tr style={ { textAlign: 'start', color: 'var(--bc-color-ink-faint)' } }>
								<th style={ { padding: '8px 4px' } }>مشتری</th>
								<th style={ { padding: '8px 4px' } }>زمان</th>
								<th style={ { padding: '8px 4px' } }>وضعیت</th>
							</tr>
						</thead>
						<tbody>
							{ stats.recentBookings.map( ( b ) => (
								<tr key={ b.id } style={ { borderTop: '1px solid var(--bc-color-line)' } }>
									<td style={ { padding: '8px 4px' } }>{ b.customerName }</td>
									<td style={ { padding: '8px 4px' } } className="bc-numeric">{ formatShortDate( new Date( b.slotStart.replace( ' ', 'T' ) ) ).weekday }، { formatTime( new Date( b.slotStart.replace( ' ', 'T' ) ) ) }</td>
									<td style={ { padding: '8px 4px' } }><StatusPill status={ b.status } /></td>
								</tr>
							) ) }
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}
