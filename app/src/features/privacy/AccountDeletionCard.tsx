import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatFullJalaliDate } from '@/lib/format';
import { Button, Modal, LoadingDots } from '@/design-system';
import type { DeletionRequest, DeletionRequestResult } from './types';

const STATUS_LABELS: Record<string, string> = {
	pending: 'درخواست شما در انتظار بررسی مدیر است.',
	approved: 'درخواست شما تأیید شده و به‌زودی پردازش می‌شود.',
	processing: 'حساب شما در حال حذف است.',
	completed: 'حساب شما حذف شده است.',
	rejected: 'درخواست شما رد شده است.',
	blocked: 'در حال حاضر امکان حذف حساب وجود ندارد.',
	cancelled: 'درخواست حذف حساب توسط شما لغو شد.',
};

function jalali( iso: string | null ): string {
	return iso ? formatFullJalaliDate( new Date( iso.replace( ' ', 'T' ) ) ) : '—';
}

type ModalStep = 'sending' | 'awaiting-code' | 'submitting' | 'result';

/**
 * V2.2 Step 14 (§5/§8) — self-service deletion REQUEST only. Per the
 * architecture plan's own explicit design decision, this never deletes the
 * account itself — it creates a request an administrator must review and
 * approve (see PrivacyRequestsPage), the same "no ordinary-user write path
 * to anything requiring careful handling" discipline already applied
 * elsewhere in this codebase. OTP re-confirmation reuses beauclick-auth's
 * existing infrastructure (no password exists to re-enter on this
 * product), not a second authentication mechanism.
 */
export function AccountDeletionCard() {
	const [ request, setRequest ] = useState<DeletionRequest | null | undefined>( undefined );
	const [ error, setError ] = useState<string | null>( null );
	const [ modalOpen, setModalOpen ] = useState( false );

	function load() {
		api
			.get<DeletionRequest | null>( '/privacy/deletion/status' )
			.then( setRequest )
			.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت وضعیت درخواست.' ) );
	}

	useEffect( load, [] );

	async function handleCancel() {
		if ( ! request ) return;
		try {
			await api.post( '/privacy/deletion/cancel', { requestId: request.id } );
			load();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'لغو درخواست ناموفق بود.' );
		}
	}

	const canRequestNew = ! request || [ 'rejected', 'cancelled', 'blocked' ].includes( request.status );

	return (
		<div className="bc-card" style={ { padding: 16, borderColor: 'var(--bc-color-error)' } }>
			<h3 style={ { marginTop: 0, fontSize: 15 } }>حذف حساب</h3>
			<p style={ { margin: '0 0 8px', fontSize: 13, fontWeight: 700 } }>این اقدام قابل بازگشت نیست.</p>
			<p style={ { margin: '0 0 12px', fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>
				با حذف حساب، اطلاعات هویتی شما (نام، ایمیل، شماره موبایل) از سیستم پاک می‌شود و امکان ورود دوباره به این حساب وجود نخواهد داشت.
				تاریخچهٔ نوبت‌ها و نظرات شما — برای حفظ صحت سوابق متخصصان — بدون اطلاعات هویتی نگه‌داری می‌شود.
				درخواست شما پیش از اجرا توسط تیم BeauClick بررسی می‌شود.
			</p>

			{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13, margin: '0 0 8px' } }>{ error }</p> }

			{ request === undefined && <LoadingDots /> }

			{ request !== undefined && (
				<div style={ { display: 'flex', flexDirection: 'column', gap: 8 } }>
					{ request && (
						<div aria-live="polite">
							<p style={ { fontSize: 13, margin: 0, fontWeight: 700 } }>{ STATUS_LABELS[ request.status ] ?? request.status }</p>
							{ request.reason && <p style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)', margin: '4px 0 0' } }>{ request.reason }</p> }
							<p className="bc-numeric" style={ { fontSize: 11, color: 'var(--bc-color-ink-faint)', margin: '4px 0 0' } }>
								تاریخ درخواست: { jalali( request.requestedAt ) }
							</p>
						</div>
					) }

					<div style={ { display: 'flex', gap: 8, flexWrap: 'wrap' } }>
						{ request?.status === 'pending' && (
							<Button variant="outline" onClick={ handleCancel }>
								انصراف از درخواست
							</Button>
						) }
						{ canRequestNew && (
							<Button variant="outline" style={ { color: 'var(--bc-color-error)', borderColor: 'var(--bc-color-error)' } } onClick={ () => setModalOpen( true ) }>
								درخواست حذف حساب
							</Button>
						) }
					</div>
				</div>
			) }

			<DeletionConfirmModal
				open={ modalOpen }
				onClose={ () => setModalOpen( false ) }
				onDone={ () => {
					setModalOpen( false );
					load();
				} }
			/>
		</div>
	);
}

function DeletionConfirmModal( { open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void } ) {
	const [ step, setStep ] = useState<ModalStep>( 'sending' );
	const [ code, setCode ] = useState( '' );
	const [ phoneMasked, setPhoneMasked ] = useState( '' );
	const [ error, setError ] = useState<string | null>( null );
	const [ result, setResult ] = useState<DeletionRequestResult | null>( null );

	useEffect( () => {
		if ( ! open ) return;
		setStep( 'sending' );
		setCode( '' );
		setError( null );
		setResult( null );

		api
			.post<{ sent: boolean; phoneMasked: string }>( '/privacy/deletion/otp/request' )
			.then( ( res ) => {
				setPhoneMasked( res.phoneMasked );
				setStep( 'awaiting-code' );
			} )
			.catch( ( e ) => {
				setError( e instanceof ApiError ? e.message : 'ارسال کد تأیید ناموفق بود.' );
				setStep( 'awaiting-code' );
			} );
	}, [ open ] );

	async function handleConfirm() {
		if ( '' === code.trim() ) return;
		setStep( 'submitting' );
		setError( null );
		try {
			const res = await api.post<DeletionRequestResult>( '/privacy/deletion/request', { code: code.trim() } );
			setResult( res );
			setStep( 'result' );
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ثبت درخواست ناموفق بود.' );
			setStep( 'awaiting-code' );
		}
	}

	return (
		<Modal open={ open } onClose={ onClose } labelledBy="bc-deletion-confirm-title">
			<div style={ { display: 'flex', flexDirection: 'column', gap: 16, padding: 4 } }>
				<h2 id="bc-deletion-confirm-title" style={ { margin: 0, fontSize: 18 } }>تأیید درخواست حذف حساب</h2>

				{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13, margin: 0 } }>{ error }</p> }

				{ step === 'sending' && <LoadingDots /> }

				{ ( step === 'awaiting-code' || step === 'submitting' ) && (
					<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
						{ phoneMasked && (
							<p style={ { fontSize: 13, margin: 0 } } className="bc-numeric">
								کد تأیید به شمارهٔ { phoneMasked } پیامک شد.
							</p>
						) }
						<label htmlFor="bc-deletion-otp" style={ { fontSize: 13, fontWeight: 700 } }>
							کد تأیید
						</label>
						<input
							id="bc-deletion-otp"
							className="bc-input"
							inputMode="numeric"
							autoComplete="one-time-code"
							value={ code }
							onChange={ ( e ) => setCode( e.target.value ) }
							disabled={ step === 'submitting' }
						/>
						<Button
							variant="primary"
							style={ { background: 'var(--bc-color-error)' } }
							disabled={ step === 'submitting' || '' === code.trim() }
							onClick={ handleConfirm }
						>
							{ step === 'submitting' ? 'در حال ثبت…' : 'تأیید و ثبت درخواست حذف حساب' }
						</Button>
					</div>
				) }

				{ step === 'result' && result && (
					<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
						{ result.status === 'blocked' && result.reasons ? (
							<>
								<p style={ { fontSize: 13, margin: 0, fontWeight: 700 } }>در حال حاضر امکان حذف حساب وجود ندارد:</p>
								<ul style={ { margin: 0, paddingInlineStart: 20, fontSize: 13 } }>
									{ result.reasons.map( ( r, i ) => <li key={ i }>{ r }</li> ) }
								</ul>
							</>
						) : (
							<p style={ { fontSize: 13, margin: 0 } }>درخواست حذف حساب شما ثبت شد و در انتظار بررسی تیم BeauClick است.</p>
						) }
						<Button variant="outline" onClick={ onDone }>
							بستن
						</Button>
					</div>
				) }
			</div>
		</Modal>
	);
}
