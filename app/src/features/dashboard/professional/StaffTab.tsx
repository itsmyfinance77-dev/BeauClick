import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatFullJalaliDate } from '@/lib/format';
import { Button, Input, LoadingDots, EmptyState } from '@/design-system';

interface StaffMember {
	userId: number;
	name: string;
	email: string;
	role: string;
	addedAt: string;
}

/**
 * V2.2 Step 16 — a deliberately minimal staff model: owner-only management,
 * one flat "staff" role, added by phone number (reusing the platform's own
 * OTP-authentication phone identity, never a new invite/email flow). Only
 * the genuine business owner can reach this — an authorized staff member
 * gets a real, server-enforced 403 (StaffController::can_manage_staff()),
 * surfaced here as a plain, honest error rather than hidden client-side.
 */
export function StaffTab() {
	const [ staff, setStaff ] = useState<StaffMember[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ phone, setPhone ] = useState( '' );
	const [ submitting, setSubmitting ] = useState( false );
	const [ addError, setAddError ] = useState<string | null>( null );

	function load() {
		api.get<StaffMember[]>( '/marketplace/my/staff' ).then( setStaff ).catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت فهرست کارکنان.' ) );
	}
	useEffect( load, [] );

	async function addStaff() {
		if ( ! phone.trim() ) return;
		setSubmitting( true );
		setAddError( null );
		try {
			await api.post( '/marketplace/my/staff', { phone: phone.trim() } );
			setPhone( '' );
			load();
		} catch ( e ) {
			setAddError( e instanceof ApiError ? e.message : 'افزودن کارمند با خطا مواجه شد.' );
		} finally {
			setSubmitting( false );
		}
	}

	async function removeStaff( userId: number ) {
		try {
			await api.del( `/marketplace/my/staff/${ userId }` );
			load();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'حذف کارمند با خطا مواجه شد.' );
		}
	}

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! staff ) return <LoadingDots />;

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>کارکنان</h1>
			<p style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>
				کارکنانی که اضافه می‌کنید می‌توانند به بخش «مشتریان» و «آمار و تحلیل» شما دسترسی داشته باشند.
			</p>

			<div className="bc-card" style={ { padding: 16, marginBottom: 16 } }>
				<h3 style={ { marginTop: 0, fontSize: 15 } }>افزودن کارمند جدید</h3>
				{ addError && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ addError }</p> }
				<div style={ { display: 'flex', gap: 8, flexWrap: 'wrap' } }>
					<Input
						type="tel"
						value={ phone }
						onChange={ ( e ) => setPhone( e.target.value ) }
						placeholder="شماره موبایل کارمند (مثلاً ۰۹۱۲۱۲۳۴۵۶۷)"
						aria-label="شماره موبایل کارمند"
						style={ { flex: 1, minWidth: 220 } }
					/>
					<Button variant="primary" disabled={ submitting || ! phone.trim() } onClick={ addStaff }>
						{ submitting ? 'در حال افزودن…' : 'افزودن' }
					</Button>
				</div>
				<p style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)', marginBottom: 0 } }>
					کارمند باید از قبل با همین شماره در BeauClick ثبت‌نام کرده باشد.
				</p>
			</div>

			{ staff.length === 0 ? (
				<EmptyState title="هنوز کارمندی اضافه نکرده‌اید." />
			) : (
				<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
					{ staff.map( ( s ) => (
						<div key={ s.userId } className="bc-card" style={ { padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 } }>
							<div>
								<strong>{ s.name }</strong>
								<p style={ { margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>
									{ s.email } · افزوده‌شده در { formatFullJalaliDate( new Date( s.addedAt.replace( ' ', 'T' ) ) ) }
								</p>
							</div>
							<Button variant="outline" onClick={ () => removeStaff( s.userId ) }>حذف از تیم</Button>
						</div>
					) ) }
				</div>
			) }
		</div>
	);
}
