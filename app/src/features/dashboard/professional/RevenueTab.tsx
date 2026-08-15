import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatToman, toPersianDigits } from '@/lib/format';
import { LoadingDots, EmptyState } from '@/design-system';
import { StatCard } from '../shared/StatCard';

interface OutstandingOrder {
	orderId: number;
	outstanding: number;
}

interface Settlement {
	id: number;
	amount: number;
	method: string | null;
	status: 'recorded' | 'reversed';
	createdAt: string;
	reversedReason: string | null;
}

interface FinanceSummary {
	partyType: 'professional' | 'business';
	partyId: number;
	summary: { receivableNet: number; settled: number; outstanding: number };
	outstanding: OutstandingOrder[];
	settlements: Settlement[];
}

const STATUS_LABELS: Record<string, string> = {
	recorded: 'ثبت‌شده',
	reversed: 'برگشت‌خورده',
};

/**
 * V2.3 Step 18 — the real `درآمد` tab, replacing the `ready: false`
 * placeholder that has existed since V1 (see dashboard-professional.tsx's
 * own docblock history). Reads `/financial/my-summary`, an ownership-scoped
 * endpoint over the real, WooCommerce-order-derived ledger — this component
 * never computes or estimates a figure itself, only renders what the server
 * already resolved for the current professional/business.
 *
 * Deliberately shows only booking-order-derived receivable/settlement data,
 * never a Shop/B2B "gross order value" figure — that concept, already
 * surfaced honestly on the Analytics tab, is platform revenue, not this
 * professional's own receivable (see beauclick-financial's own migration
 * docblock for why B2B/Shop orders never produce a ledger entry at all).
 */
export function RevenueTab() {
	const [ data, setData ] = useState<FinanceSummary | null>( null );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		api
			.get<FinanceSummary>( '/financial/my-summary' )
			.then( setData )
			.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت اطلاعات مالی.' ) );
	}, [] );

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! data ) return <LoadingDots />;

	const { summary, outstanding, settlements } = data;

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>درآمد</h1>
			<p style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)', marginTop: -8, marginBottom: 20 } }>
				این مبالغ بر اساس سفارش‌های رزرو واقعی و پس از کسر کمیسیون پلتفرم محاسبه شده‌اند. تسویه هنوز به‌صورت دستی توسط تیم بیوکلیک انجام می‌شود.
			</p>

			<div style={ { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16, marginBottom: 24 } }>
				<StatCard label="مجموع مطالبات (خالص)" value={ `${ formatToman( summary.receivableNet ) } تومان` } />
				<StatCard label="تسویه‌شده" value={ `${ formatToman( summary.settled ) } تومان` } />
				<StatCard label="باقی‌مانده" value={ `${ formatToman( summary.outstanding ) } تومان` } />
			</div>

			<div className="bc-card" style={ { padding: 16, marginBottom: 24 } }>
				<h3 style={ { marginTop: 0, fontSize: 15 } }>سفارش‌های در انتظار تسویه</h3>
				{ outstanding.length === 0 ? (
					<EmptyState title="در حال حاضر سفارشی در انتظار تسویه نیست." />
				) : (
					<div style={ { overflowX: 'auto' } }>
						<table style={ { width: '100%', borderCollapse: 'collapse', fontSize: 13 } }>
							<thead>
								<tr style={ { textAlign: 'start', color: 'var(--bc-color-ink-faint)' } }>
									<th style={ { padding: '8px 4px' } }>شماره سفارش</th>
									<th style={ { padding: '8px 4px' } }>مبلغ باقی‌مانده</th>
								</tr>
							</thead>
							<tbody>
								{ outstanding.map( ( o ) => (
									<tr key={ o.orderId } style={ { borderTop: '1px solid var(--bc-color-line)' } }>
										<td style={ { padding: '8px 4px' } } className="bc-numeric">#{ toPersianDigits( o.orderId ) }</td>
										<td style={ { padding: '8px 4px' } } className="bc-numeric">{ formatToman( o.outstanding ) } تومان</td>
									</tr>
								) ) }
							</tbody>
						</table>
					</div>
				) }
			</div>

			<div className="bc-card" style={ { padding: 16 } }>
				<h3 style={ { marginTop: 0, fontSize: 15 } }>تاریخچه تسویه</h3>
				{ settlements.length === 0 ? (
					<EmptyState title="هنوز تسویه‌ای ثبت نشده است." />
				) : (
					<div style={ { overflowX: 'auto' } }>
						<table style={ { width: '100%', borderCollapse: 'collapse', fontSize: 13 } }>
							<thead>
								<tr style={ { textAlign: 'start', color: 'var(--bc-color-ink-faint)' } }>
									<th style={ { padding: '8px 4px' } }>مبلغ</th>
									<th style={ { padding: '8px 4px' } }>روش</th>
									<th style={ { padding: '8px 4px' } }>وضعیت</th>
								</tr>
							</thead>
							<tbody>
								{ settlements.map( ( s ) => (
									<tr key={ s.id } style={ { borderTop: '1px solid var(--bc-color-line)' } }>
										<td style={ { padding: '8px 4px' } } className="bc-numeric">{ formatToman( s.amount ) } تومان</td>
										<td style={ { padding: '8px 4px' } }>{ s.method ?? '—' }</td>
										<td style={ { padding: '8px 4px' } }>{ STATUS_LABELS[ s.status ] ?? s.status }</td>
									</tr>
								) ) }
							</tbody>
						</table>
					</div>
				) }
			</div>
		</div>
	);
}
