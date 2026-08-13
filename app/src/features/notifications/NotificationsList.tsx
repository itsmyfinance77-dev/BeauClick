import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { LoadingDots, EmptyState } from '@/design-system';
import { formatFullJalaliDate } from '@/lib/format';
import type { NotificationRecord } from './types';

const CATEGORY_LABELS: Record<string, string> = {
	reminder: 'یادآوری نوبت',
	waitlist: 'لیست انتظار',
	rebooking: 'پیشنهاد رزرو دوباره',
	retention: 'یادآوری بازگشت',
};

const STATUS_LABELS: Record<string, string> = {
	pending: 'در انتظار',
	sent: 'ارسال‌شده',
	failed: 'ناموفق',
	suppressed: 'غیرفعال (طبق تنظیمات شما)',
	duplicate: 'تکراری',
};

function jalali( iso: string ): string {
	return formatFullJalaliDate( new Date( iso.replace( ' ', 'T' ) ) );
}

/** V2.1 Step 10 (NOTIF-04 backend foundation) — a simple recent-activity list, not a full bell/notification-center product; that remains a later, separate UI decision. */
export function NotificationsList() {
	const [ items, setItems ] = useState<NotificationRecord[] | null>( null );

	useEffect( () => {
		api.get<NotificationRecord[]>( '/notifications/mine' ).then( setItems ).catch( () => setItems( [] ) );
	}, [] );

	if ( ! items ) return <LoadingDots />;
	if ( items.length === 0 ) return <EmptyState title="اعلانی برای شما ثبت نشده است." />;

	return (
		<div style={ { display: 'flex', flexDirection: 'column', gap: 6 } }>
			{ items.map( ( n, i ) => (
				<div key={ i } style={ { display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '6px 0', borderBottom: '1px solid var(--bc-color-line)' } }>
					<span>{ CATEGORY_LABELS[ n.category ] ?? n.category }</span>
					<span className="bc-numeric" style={ { color: 'var(--bc-color-ink-faint)' } }>
						{ STATUS_LABELS[ n.status ] ?? n.status } · { jalali( n.createdAt ) }
					</span>
				</div>
			) ) }
		</div>
	);
}
