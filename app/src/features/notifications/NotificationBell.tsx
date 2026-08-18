import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Modal, Button, EmptyState, LoadingDots } from '@/design-system';
import { formatFullJalaliDate } from '@/lib/format';
import type { NotificationRecord } from './types';

const CATEGORY_LABELS: Record<string, string> = {
	reminder: 'یادآوری نوبت',
	waitlist: 'لیست انتظار',
	rebooking: 'پیشنهاد رزرو دوباره',
	retention: 'یادآوری بازگشت',
	referral: 'معرفی دوستان',
};

function jalali( iso: string ): string {
	return formatFullJalaliDate( new Date( iso.replace( ' ', 'T' ) ) );
}

/**
 * V2.4 Step 24 (Notification & Communication Improvements): the in-app
 * notification center NotificationsList.tsx's own docblock explicitly
 * deferred as "a later, separate UI decision" — reads the same
 * `wp_bc_notifications` delivery-history table that already existed, adds
 * only the read/unread half (id/isRead, unread-count, mark-read) that
 * table never had. Reuses the cart drawer's own Modal `drawer-end`
 * pattern rather than inventing a new anchored-dropdown primitive, for
 * visual/interaction consistency with the rest of the design system.
 */
export function NotificationBell( { open, onClose }: { open: boolean; onClose: () => void } ) {
	const [ items, setItems ] = useState<NotificationRecord[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		if ( ! open ) return;
		setError( null );
		api.get<NotificationRecord[]>( '/notifications/mine' )
			.then( setItems )
			.catch( () => setError( 'خطا در دریافت اعلان‌ها.' ) );
	}, [ open ] );

	function markRead( id: number ) {
		setItems( ( prev ) => prev?.map( ( n ) => ( n.id === id ? { ...n, isRead: true } : n ) ) ?? prev );
		api.post( `/notifications/${ id }/read` ).then( updateBadgeFromServer ).catch( () => {} );
	}

	function markAllRead() {
		setItems( ( prev ) => prev?.map( ( n ) => ( { ...n, isRead: true } ) ) ?? prev );
		api.post( '/notifications/mark-all-read' ).then( updateBadgeFromServer ).catch( () => {} );
	}

	const hasUnread = !! items?.some( ( n ) => ! n.isRead );

	return (
		<Modal open={ open } onClose={ onClose } variant="drawer-end" labelledBy="bc-notifications-title">
			<div style={ { padding: 20, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 } }>
				<div style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }>
					<h2 id="bc-notifications-title" style={ { margin: 0, fontSize: 18 } }>اعلان‌ها</h2>
					{ hasUnread && (
						<Button variant="outline" onClick={ markAllRead } style={ { fontSize: 12, padding: '4px 10px' } }>
							علامت‌گذاری همه به‌عنوان خوانده‌شده
						</Button>
					) }
				</div>

				{ ! items && ! error && <LoadingDots /> }
				{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
				{ items && 0 === items.length && <EmptyState title="اعلانی برای شما ثبت نشده است." /> }

				{ items && items.length > 0 && (
					<div style={ { display: 'flex', flexDirection: 'column', gap: 6 } }>
						{ items.map( ( n ) => (
							<button
								key={ n.id }
								type="button"
								onClick={ () => ! n.isRead && markRead( n.id ) }
								style={ {
									display: 'flex',
									justifyContent: 'space-between',
									alignItems: 'center',
									gap: 8,
									textAlign: 'start',
									fontSize: 13,
									padding: '10px 8px',
									borderRadius: 12,
									border: 'none',
									cursor: n.isRead ? 'default' : 'pointer',
									background: n.isRead ? 'transparent' : 'var(--bc-color-primary-soft)',
									color: 'var(--bc-color-ink)',
								} }
							>
								<span style={ { display: 'flex', alignItems: 'center', gap: 8 } }>
									{ ! n.isRead && (
										<span aria-hidden="true" style={ { width: 8, height: 8, borderRadius: '50%', background: 'var(--bc-color-accent)', flexShrink: 0 } } />
									) }
									{ CATEGORY_LABELS[ n.category ] ?? n.category }
								</span>
								<span className="bc-numeric" style={ { color: 'var(--bc-color-ink-faint)', fontSize: 11 } }>
									{ jalali( n.createdAt ) }
								</span>
							</button>
						) ) }
					</div>
				) }
			</div>
		</Modal>
	);
}

function updateBadgeFromServer(): void {
	api.get<{ count: number }>( '/notifications/unread-count' )
		.then( ( { count } ) => window.dispatchEvent( new CustomEvent( 'bc:notifications-count', { detail: count } ) ) )
		.catch( () => {} );
}
