import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatToman, formatShortDate, toPersianDigits } from '@/lib/format';
import { LoadingDots, EmptyState } from '@/design-system';
import type { MyOrder } from './types';

const STATUS_LABELS: Record<string, string> = {
	pending: 'در انتظار پرداخت',
	processing: 'در حال پردازش',
	'on-hold': 'در انتظار',
	completed: 'تکمیل‌شده',
	cancelled: 'لغو‌شده',
	refunded: 'مسترد‌شده',
	failed: 'ناموفق',
};

export function OrdersTab() {
	const [ orders, setOrders ] = useState<MyOrder[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		api.get<MyOrder[]>( '/payments/my/orders' ).then( setOrders ).catch( () => setError( 'خطا در دریافت سفارش‌ها.' ) );
	}, [] );

	if ( error ) return <p style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! orders ) return <LoadingDots />;
	if ( orders.length === 0 ) return <EmptyState title="هنوز سفارشی ثبت نشده است." />;

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>سفارش‌های من</h1>
			<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
				{ orders.map( ( o ) => (
					<a key={ o.id } href={ o.viewUrl } className="bc-card" style={ { padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, textDecoration: 'none', color: 'inherit' } }>
						<div>
							<strong className="bc-numeric">#{ toPersianDigits( o.number ) }</strong>
							<p style={ { margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>
								{ o.date ? formatShortDate( new Date( o.date.replace( ' ', 'T' ) ) ).weekday : '' } · { toPersianDigits( o.itemCount ) } کالا
							</p>
						</div>
						<div style={ { textAlign: 'end' } }>
							<strong className="bc-numeric">{ formatToman( o.total ) } تومان</strong>
							<p style={ { margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>{ STATUS_LABELS[ o.status ] ?? o.status }</p>
						</div>
					</a>
				) ) }
			</div>
		</div>
	);
}
