import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatFullJalaliDate } from '@/lib/format';
import { Button, LoadingDots } from '@/design-system';
import type { ExportRequest } from './types';

const STATUS_LABELS: Record<string, string> = {
	pending: 'در حال آماده‌سازی…',
	ready: 'آماده دانلود',
	expired: 'منقضی‌شده — می‌توانید دوباره درخواست دهید',
	failed: 'آماده‌سازی ناموفق بود — لطفاً دوباره تلاش کنید',
};

function jalali( iso: string | null ): string {
	return iso ? formatFullJalaliDate( new Date( iso.replace( ' ', 'T' ) ) ) : '—';
}

/**
 * V2.2 Step 14 — self-service data export. Generation is synchronous
 * server-side (see ExportService's own docblock for why), so this
 * component's own loading state covers the whole request→ready round trip,
 * not a separate polling loop.
 */
export function DataExportCard() {
	const [ request, setRequest ] = useState<ExportRequest | null | undefined>( undefined );
	const [ requesting, setRequesting ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );

	function load() {
		api
			.get<ExportRequest | null>( '/privacy/export/status' )
			.then( setRequest )
			.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت وضعیت درخواست.' ) );
	}

	useEffect( load, [] );

	async function handleRequest() {
		setRequesting( true );
		setError( null );
		try {
			const result = await api.post<ExportRequest>( '/privacy/export/request' );
			setRequest( result );
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ثبت درخواست ناموفق بود. لطفاً دوباره تلاش کنید.' );
		} finally {
			setRequesting( false );
		}
	}

	return (
		<div className="bc-card" style={ { padding: 16 } }>
			<h3 style={ { marginTop: 0, fontSize: 15 } }>دریافت اطلاعات من</h3>
			<p style={ { margin: '0 0 12px', fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>
				یک نسخهٔ کامل از اطلاعاتی که BeauClick دربارهٔ حساب شما نگه‌داری می‌کند (نوبت‌ها، سفارش‌ها، نظرات، مسیر زیبایی، وفاداری و موارد مشابه) در یک فایل فشرده آماده می‌شود.
			</p>

			{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13, margin: '0 0 8px' } }>{ error }</p> }

			{ request === undefined && <LoadingDots /> }

			{ request !== undefined && (
				<div style={ { display: 'flex', flexDirection: 'column', gap: 8 } }>
					{ request && (
						<p style={ { fontSize: 13, margin: 0 } } aria-live="polite">
							<strong>وضعیت:</strong> { STATUS_LABELS[ request.status ] ?? request.status }
							{ request.status === 'ready' && request.expiresAt && (
								<> — تا <span className="bc-numeric">{ jalali( request.expiresAt ) }</span> قابل دانلود است</>
							) }
						</p>
					) }

					<div style={ { display: 'flex', gap: 8, flexWrap: 'wrap' } }>
						{ request?.status === 'ready' && request.downloadPath && (
							<a href={ api.urlWithNonce( request.downloadPath ) } className="bc-btn bc-btn--primary">
								دانلود فایل اطلاعات
							</a>
						) }
						{ ( ! request || request.status === 'expired' || request.status === 'failed' ) && (
							<Button variant={ request ? 'outline' : 'primary' } disabled={ requesting } onClick={ handleRequest }>
								{ requesting ? 'در حال آماده‌سازی…' : 'درخواست دریافت اطلاعات' }
							</Button>
						) }
					</div>
				</div>
			) }
		</div>
	);
}
