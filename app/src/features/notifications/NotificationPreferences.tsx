import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Chip, LoadingDots } from '@/design-system';
import type { NotificationCategory, NotificationPreferences as Prefs } from './types';

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
	reminder: 'یادآوری نوبت',
	waitlist: 'اطلاع‌رسانی لیست انتظار',
	rebooking: 'پیشنهاد رزرو دوباره',
	retention: 'یادآوری بازگشت (تبلیغاتی)',
};

const CATEGORY_HINTS: Record<NotificationCategory, string> = {
	reminder: 'پیامک/ایمیل یادآوری ۲۴ ساعت قبل از نوبت.',
	waitlist: 'وقتی زمان درخواستی شما در لیست انتظار باز شود، به شما اطلاع می‌دهیم.',
	rebooking: 'پیشنهاد رزرو دوباره پس از گذشت مدتی از آخرین نوبت شما.',
	retention: 'یادآوری دوستانه اگر مدتی است از BeauClick استفاده نکرده‌اید.',
};

/**
 * V2.1 Step 10 (NOTIF-06/PROF-02). Real booking confirmation/cancellation
 * email is NOT listed here -- it is the one "legally/operationally
 * required transactional message" the task explicitly says must never be
 * disableable, so there is no toggle for it at all.
 */
export function NotificationPreferences() {
	const [ prefs, setPrefs ] = useState<Prefs | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ savingKey, setSavingKey ] = useState<NotificationCategory | null>( null );

	useEffect( () => {
		api.get<Prefs>( '/notifications/preferences' ).then( setPrefs ).catch( () => setError( 'خطا در دریافت تنظیمات اعلان‌ها.' ) );
	}, [] );

	async function toggle( category: NotificationCategory ) {
		if ( ! prefs ) return;
		const next = ! prefs[ category ];
		setSavingKey( category );
		setPrefs( { ...prefs, [ category ]: next } );
		try {
			const updated = await api.patch<Prefs>( '/notifications/preferences', { [ category ]: next } );
			setPrefs( updated );
		} catch ( e ) {
			setPrefs( prefs ); // revert on failure
			setError( e instanceof ApiError ? e.message : 'ذخیره تنظیمات ناموفق بود.' );
		} finally {
			setSavingKey( null );
		}
	}

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! prefs ) return <LoadingDots />;

	return (
		<div className="bc-card" style={ { padding: 16 } }>
			<h3 style={ { marginTop: 0, fontSize: 15 } }>تنظیمات اعلان‌ها</h3>
			<p style={ { margin: '0 0 12px', fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>
				پیام‌های ضروری رزرو (تأیید و لغو نوبت) همیشه ارسال می‌شوند. اعلان‌های زیر اختیاری‌اند.
			</p>
			<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
				{ ( Object.keys( CATEGORY_LABELS ) as NotificationCategory[] ).map( ( category ) => (
					<div key={ category } style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }>
						<div>
							<strong style={ { fontSize: 13 } }>{ CATEGORY_LABELS[ category ] }</strong>
							<p style={ { margin: '2px 0 0', fontSize: 11, color: 'var(--bc-color-ink-faint)' } }>{ CATEGORY_HINTS[ category ] }</p>
						</div>
						<Chip
							active={ prefs[ category ] }
							onClick={ () => toggle( category ) }
							aria-label={ `${ CATEGORY_LABELS[ category ] }: ${ prefs[ category ] ? 'فعال' : 'غیرفعال' }` }
						>
							{ savingKey === category ? '...' : ( prefs[ category ] ? 'فعال' : 'غیرفعال' ) }
						</Chip>
					</div>
				) ) }
			</div>
		</div>
	);
}
