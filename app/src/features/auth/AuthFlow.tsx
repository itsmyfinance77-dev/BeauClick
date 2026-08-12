import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { toPersianDigits } from '@/lib/format';
import { Button, Input } from '@/design-system';

type Step = 'phone' | 'otp';

const RESEND_COOLDOWN_DISPLAY_SECONDS = 60;

interface RequestOtpResponse {
	sent: boolean;
	expiresInSeconds: number;
}

interface VerifyOtpResponse {
	isNewAccount: boolean;
	redirectUrl: string;
}

/**
 * BeauClick's own sign-in/sign-up experience -- combined into one
 * mobile-first flow (design brief §18/§2: the user doesn't declare
 * "I'm new" or "I already have an account", the OTP verification result
 * decides that server-side). Replaces wp-login.php for every normal
 * customer/professional/business account; WordPress's own login screen
 * remains the administrator path, untouched by this component or the
 * beauclick-auth plugin behind it.
 */
export function AuthFlow() {
	const [ step, setStep ] = useState<Step>( 'phone' );
	const [ phone, setPhone ] = useState( '' );
	const [ code, setCode ] = useState( '' );
	const [ error, setError ] = useState<string | null>( null );
	const [ sending, setSending ] = useState( false );
	const [ verifying, setVerifying ] = useState( false );
	const [ cooldown, setCooldown ] = useState( 0 );
	const codeInputRef = useRef<HTMLInputElement>( null );

	useEffect( () => {
		if ( cooldown <= 0 ) return;
		const timer = setInterval( () => setCooldown( ( s ) => Math.max( 0, s - 1 ) ), 1000 );
		return () => clearInterval( timer );
	}, [ cooldown ] );

	useEffect( () => {
		if ( step === 'otp' ) codeInputRef.current?.focus();
	}, [ step ] );

	async function requestOtp() {
		if ( ! phone.trim() ) {
			setError( 'لطفاً شماره موبایل را وارد کنید.' );
			return;
		}
		setSending( true );
		setError( null );
		try {
			await api.post<RequestOtpResponse>( '/auth/request-otp', { phone: phone.trim() } );
			setStep( 'otp' );
			setCooldown( RESEND_COOLDOWN_DISPLAY_SECONDS );
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'در ارسال کد تأیید مشکلی پیش آمد. لطفاً دوباره تلاش کنید.' );
		} finally {
			setSending( false );
		}
	}

	async function verifyOtp() {
		if ( ! code.trim() ) {
			setError( 'لطفاً کد تأیید را وارد کنید.' );
			return;
		}
		setVerifying( true );
		setError( null );
		try {
			const result = await api.post<VerifyOtpResponse>( '/auth/verify-otp', { phone: phone.trim(), code: code.trim() } );
			window.location.href = result.redirectUrl;
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'در تأیید کد مشکلی پیش آمد. لطفاً دوباره تلاش کنید.' );
			setVerifying( false );
		}
	}

	return (
		<div className="bc-card" style={ { maxWidth: 400, margin: '0 auto', padding: 28 } }>
			<h1 style={ { fontSize: 22, marginTop: 0, textAlign: 'center' } }>ورود یا ثبت‌نام</h1>

			{ step === 'phone' && (
				<form
					onSubmit={ ( e ) => { e.preventDefault(); requestOtp(); } }
					style={ { display: 'flex', flexDirection: 'column', gap: 16 } }
				>
					<p style={ { margin: 0, fontSize: 14, color: 'var(--bc-color-ink-soft)', textAlign: 'center' } }>
						شماره موبایل خود را وارد کنید
					</p>
					<Input
						type="tel"
						inputMode="numeric"
						autoComplete="tel"
						dir="ltr"
						style={ { textAlign: 'center', fontSize: 18 } }
						placeholder="۰۹۱۲۱۲۳۴۵۶۷"
						aria-label="شماره موبایل"
						value={ phone }
						onChange={ ( e ) => setPhone( e.target.value ) }
						disabled={ sending }
						autoFocus
					/>
					{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13, margin: 0, textAlign: 'center' } }>{ error }</p> }
					<Button type="submit" variant="primary" disabled={ sending } style={ { width: '100%' } }>
						{ sending ? 'در حال ارسال…' : 'دریافت کد تأیید' }
					</Button>
					<p style={ { margin: 0, fontSize: 12, color: 'var(--bc-color-ink-faint)', textAlign: 'center' } }>
						با ادامه، از نحوه استفاده BeauClick از اطلاعات شما در{ ' ' }
						<a href="/privacy-policy/" style={ { color: 'var(--bc-color-primary)' } }>حریم خصوصی</a> مطلع می‌شوید.
					</p>
				</form>
			) }

			{ step === 'otp' && (
				<form
					onSubmit={ ( e ) => { e.preventDefault(); verifyOtp(); } }
					style={ { display: 'flex', flexDirection: 'column', gap: 16 } }
				>
					<p style={ { margin: 0, fontSize: 14, color: 'var(--bc-color-ink-soft)', textAlign: 'center' } }>
						کد تأیید ارسال‌شده به { phone } را وارد کنید
					</p>
					<Input
						ref={ codeInputRef }
						type="tel"
						inputMode="numeric"
						autoComplete="one-time-code"
						dir="ltr"
						maxLength={ 6 }
						style={ { textAlign: 'center', fontSize: 24, letterSpacing: 8 } }
						placeholder="------"
						aria-label="کد تأیید"
						value={ code }
						onChange={ ( e ) => setCode( e.target.value.replace( /\D/g, '' ) ) }
						disabled={ verifying }
					/>
					{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13, margin: 0, textAlign: 'center' } }>{ error }</p> }
					<Button type="submit" variant="primary" disabled={ verifying } style={ { width: '100%' } }>
						{ verifying ? 'در حال بررسی…' : 'تأیید' }
					</Button>
					<div style={ { display: 'flex', justifyContent: 'space-between', fontSize: 13 } }>
						<button
							type="button"
							onClick={ () => { setStep( 'phone' ); setCode( '' ); setError( null ); } }
							className="bc-link"
							style={ { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bc-color-primary)', padding: 0 } }
						>
							ویرایش شماره موبایل
						</button>
						{ cooldown > 0 ? (
							<span className="bc-numeric" style={ { color: 'var(--bc-color-ink-faint)' } }>
								ارسال دوباره کد تا { toPersianDigits( cooldown ) } ثانیه دیگر
							</span>
						) : (
							<button
								type="button"
								onClick={ requestOtp }
								disabled={ sending }
								className="bc-link"
								style={ { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--bc-color-primary)', padding: 0 } }
							>
								ارسال دوباره کد
							</button>
						) }
					</div>
				</form>
			) }
		</div>
	);
}
