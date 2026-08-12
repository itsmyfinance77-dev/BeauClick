import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatFullJalaliDate, toPersianDigits } from '@/lib/format';
import { Modal, Button, Badge, LoadingDots } from '@/design-system';
import type { VerificationSummary } from './types';

const STATUS_LABELS: Record<string, string> = {
	unverified: 'بدون درخواست تأیید',
	pending: 'در انتظار بررسی',
	verified: 'تأییدشده',
	rejected: 'ردشده',
	suspended: 'معلق‌شده',
	revoked: 'لغوشده',
};

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
	identity: 'مدرک هویتی',
	certificate: 'گواهینامه',
	license: 'مجوز کسب‌وکار',
	portfolio: 'نمونه‌کار',
	other: 'سایر',
};

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp,application/pdf';

function jalali( iso: string | null ): string {
	return iso ? formatFullJalaliDate( new Date( iso.replace( ' ', 'T' ) ) ) : '—';
}

function formatFileSize( bytes: number ): string {
	if ( bytes < 1024 * 1024 ) return `${ toPersianDigits( Math.round( bytes / 1024 ) ) } کیلوبایت`;
	return `${ toPersianDigits( ( bytes / ( 1024 * 1024 ) ).toFixed( 1 ) ) } مگابایت`;
}

interface QueuedFile {
	type: string;
	file: File;
}

export function VerificationModal( { open, onClose }: { open: boolean; onClose: () => void } ) {
	const [ summary, setSummary ] = useState<VerificationSummary | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ queue, setQueue ] = useState<QueuedFile[]>( [] );
	const [ pendingType, setPendingType ] = useState( 'identity' );
	const [ fileError, setFileError ] = useState<string | null>( null );
	const [ submitting, setSubmitting ] = useState( false );
	const [ submitError, setSubmitError ] = useState<string | null>( null );

	function load() {
		api
			.get<VerificationSummary>( '/marketplace/verification/me' )
			.then( setSummary )
			.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت وضعیت تأیید.' ) );
	}

	useEffect( () => {
		if ( ! open ) return;
		setError( null );
		setSummary( null );
		setQueue( [] );
		setSubmitError( null );
		load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ open ] );

	function addFile( file: File | undefined ) {
		setFileError( null );
		if ( ! file ) return;
		if ( file.size > MAX_FILE_BYTES ) {
			setFileError( 'حجم فایل نباید بیشتر از ۸ مگابایت باشد.' );
			return;
		}
		setQueue( ( q ) => [ ...q, { type: pendingType, file } ] );
	}

	function removeQueued( index: number ) {
		setQueue( ( q ) => q.filter( ( _, i ) => i !== index ) );
	}

	async function handleSubmit() {
		if ( queue.length === 0 ) return;
		setSubmitting( true );
		setSubmitError( null );
		try {
			const formData = new FormData();
			queue.forEach( ( q ) => {
				formData.append( 'evidence[]', q.file );
				formData.append( 'evidenceTypes[]', q.type );
			} );
			await api.upload( '/marketplace/verification/submit', formData );
			setQueue( [] );
			load();
		} catch ( e ) {
			setSubmitError( e instanceof ApiError ? e.message : 'ثبت درخواست تأیید ناموفق بود.' );
		} finally {
			setSubmitting( false );
		}
	}

	return (
		<Modal open={ open } onClose={ onClose } labelledBy="bc-verification-title">
			{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
			{ ! error && ! summary && <LoadingDots /> }

			{ summary && (
				<div style={ { display: 'flex', flexDirection: 'column', gap: 20, padding: 4 } }>
					<div>
						<h2 id="bc-verification-title" style={ { margin: 0, fontSize: 20 } }>تأیید پروفایل</h2>
						<div style={ { marginTop: 8 } }>
							<Badge variant={ summary.status === 'verified' ? 'verified' : summary.status === 'pending' || summary.status === 'unverified' ? 'warning' : 'error' }>
								{ STATUS_LABELS[ summary.status ] ?? summary.status }
							</Badge>
						</div>
					</div>

					{ summary.latestRequest && (
						<p className="bc-numeric" style={ { fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: 0 } }>
							تاریخ ثبت آخرین درخواست: { jalali( summary.latestRequest.submittedAt ) }
							{ summary.latestRequest.decidedAt && <> · تاریخ بررسی: { jalali( summary.latestRequest.decidedAt ) }</> }
						</p>
					) }

					{ summary.status === 'rejected' && summary.latestRequest?.decisionReason && (
						<div style={ { padding: 10, background: 'var(--bc-color-surface-tint)', borderRadius: 12 } }>
							<strong style={ { fontSize: 13 } }>دلیل رد درخواست:</strong>
							<p style={ { margin: '4px 0 0', fontSize: 13 } }>{ summary.latestRequest.decisionReason }</p>
						</div>
					) }

					{ ( summary.status === 'suspended' || summary.status === 'revoked' ) && summary.history[ 0 ]?.reason && (
						<div style={ { padding: 10, background: 'var(--bc-color-surface-tint)', borderRadius: 12 } }>
							<strong style={ { fontSize: 13 } }>دلیل:</strong>
							<p style={ { margin: '4px 0 0', fontSize: 13 } }>{ summary.history[ 0 ].reason }</p>
						</div>
					) }

					{ summary.evidence.length > 0 && (
						<section>
							<h3 style={ { fontSize: 15, margin: '0 0 8px' } }>مدارک ارسالی</h3>
							<div style={ { display: 'flex', flexDirection: 'column', gap: 6 } }>
								{ summary.evidence.map( ( e ) => (
									<div key={ e.id } style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, gap: 8 } }>
										<span>{ EVIDENCE_TYPE_LABELS[ e.evidenceType ] ?? e.evidenceType } — { e.originalFilename } ({ formatFileSize( e.sizeBytes ) })</span>
										<a href={ api.urlWithNonce( `/marketplace/verification/evidence/${ e.id }` ) } target="_blank" rel="noopener noreferrer" style={ { color: 'var(--bc-color-primary)', fontWeight: 700, whiteSpace: 'nowrap' } }>
											مشاهده
										</a>
									</div>
								) ) }
							</div>
						</section>
					) }

					{ summary.status === 'pending' && (
						<p style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)', margin: 0 } }>
							درخواست شما در صف بررسی تیم BeauClick قرار دارد. پس از بررسی، نتیجه اینجا نمایش داده می‌شود.
						</p>
					) }

					{ summary.canSubmit && (
						<section>
							<h3 style={ { fontSize: 15, margin: '0 0 8px' } }>
								{ summary.status === 'unverified' ? 'ثبت درخواست تأیید' : 'ارسال دوباره درخواست' }
							</h3>
							<p style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)', margin: '0 0 10px' } }>
								مدارک را انتخاب کنید (تصویر jpg، png، webp یا فایل PDF — حداکثر ۸ مگابایت هر فایل).
							</p>

							<div style={ { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' } }>
								<select className="bc-input" value={ pendingType } onChange={ ( e ) => setPendingType( e.target.value ) } aria-label="نوع مدرک" style={ { flex: '1 1 160px' } }>
									{ Object.entries( EVIDENCE_TYPE_LABELS ).map( ( [ value, label ] ) => (
										<option key={ value } value={ value }>{ label }</option>
									) ) }
								</select>
								<input
									type="file"
									accept={ ACCEPTED_TYPES }
									aria-label="انتخاب فایل مدرک"
									onChange={ ( e ) => {
										addFile( e.target.files?.[ 0 ] );
										e.target.value = '';
									} }
								/>
							</div>
							{ fileError && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 12 } }>{ fileError }</p> }

							{ queue.length > 0 && (
								<div style={ { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 } }>
									{ queue.map( ( q, i ) => (
										<div key={ i } style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, background: 'var(--bc-color-surface-tint)', borderRadius: 10, padding: '6px 10px' } }>
											<span>{ EVIDENCE_TYPE_LABELS[ q.type ] } — { q.file.name }</span>
											<button type="button" onClick={ () => removeQueued( i ) } aria-label="حذف این فایل" style={ { border: 'none', background: 'none', color: 'var(--bc-color-error)', cursor: 'pointer', font: 'inherit' } }>
												حذف
											</button>
										</div>
									) ) }
								</div>
							) }

							{ submitError && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 12 } }>{ submitError }</p> }
							<Button variant="primary" disabled={ submitting || queue.length === 0 } onClick={ handleSubmit }>
								{ submitting ? 'در حال ارسال…' : 'ثبت درخواست تأیید' }
							</Button>
						</section>
					) }

					{ summary.history.length > 0 && (
						<section>
							<h3 style={ { fontSize: 15, margin: '0 0 8px' } }>تاریخچه</h3>
							<div style={ { display: 'flex', flexDirection: 'column', gap: 6 } }>
								{ summary.history.map( ( h, i ) => (
									<div key={ i } style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>
										<span className="bc-numeric">{ jalali( h.createdAt ) }</span> — از «{ STATUS_LABELS[ h.fromStatus ] ?? h.fromStatus }» به «{ STATUS_LABELS[ h.toStatus ] ?? h.toStatus }»
									</div>
								) ) }
							</div>
						</section>
					) }
				</div>
			) }
		</Modal>
	);
}
