import { useEffect, useState } from 'react';
import { Modal, Button, LoadingDots } from '@/design-system';
import { api, ApiError } from '@/lib/api';
import { formatToman } from '@/lib/format';

interface ReceiptItem {
	name: string;
	// null for a fee/discount line item (e.g. membership or campaign
	// discount) — those have no meaningful "quantity", unlike a real
	// product line item.
	quantity: number | null;
	total: number;
}

interface Receipt {
	orderId: number | null;
	orderNumber: string | null;
	status: string | null;
	items: ReceiptItem[];
	subtotal: number | null;
	discountTotal: number | null;
	total: number | null;
	currency: string | null;
	createdAt: string | null;
	createdAtJalali: string | null;
	customerName: string | null;
	bookingId?: number;
	bookingStatus?: string;
	providerName?: string | null;
	serviceName?: string | null;
	appointmentAt?: string;
	appointmentAtJalali?: string;
}

const ORDER_STATUS_LABELS: Record<string, string> = {
	pending: 'در انتظار پرداخت',
	processing: 'در حال پردازش',
	completed: 'پرداخت‌شده',
	cancelled: 'لغو‌شده',
	refunded: 'بازگشت‌شده',
	failed: 'ناموفق',
};

/**
 * A real receipt document read from the authoritative WooCommerce order
 * (§24/§25 of the task -- "receipt values must come from authoritative
 * sources... never recalculate independently") -- never a second, printed
 * PDF pipeline. `window.print()` + a scoped print stylesheet is the "first
 * safe scope" the task explicitly names as sufficient, rather than
 * introducing new PDF infrastructure.
 */
export function ReceiptView( { open, onClose, bookingId, orderId }: {
	open: boolean;
	onClose: () => void;
	bookingId?: number;
	orderId?: number;
} ) {
	const [ receipt, setReceipt ] = useState<Receipt | null>( null );
	const [ error, setError ] = useState<string | null>( null );

	useEffect( () => {
		if ( ! open ) return;
		setReceipt( null );
		setError( null );
		const path = bookingId
			? `/payments/bookings/${ bookingId }/receipt`
			: `/payments/orders/${ orderId }/receipt`;
		api.get<Receipt>( path )
			.then( setReceipt )
			.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت رسید.' ) );
	}, [ open, bookingId, orderId ] );

	return (
		<Modal open={ open } onClose={ onClose } labelledBy="bc-receipt-title">
			<div id="bc-receipt-printable" style={ { padding: 24, minWidth: 320, maxWidth: 420 } }>
				<style>{ `
					@media print {
						body * { visibility: hidden; }
						#bc-receipt-printable, #bc-receipt-printable * { visibility: visible; }
						#bc-receipt-printable { position: absolute; inset: 0; padding: 24px; }
						.bc-receipt__no-print { display: none !important; }
					}
				` }</style>

				<h3 id="bc-receipt-title" style={ { marginTop: 0 } }>رسید</h3>

				{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
				{ ! receipt && ! error && <LoadingDots /> }

				{ receipt && (
					<>
						{ receipt.bookingId && (
							<div style={ { marginBottom: 12 } }>
								<p style={ { margin: '0 0 4px', fontWeight: 700 } }>{ receipt.serviceName ?? 'خدمت' }</p>
								<p style={ { margin: '0 0 4px', fontSize: 13, color: 'var(--bc-color-ink-soft)' } }>متخصص: { receipt.providerName ?? '—' }</p>
								<p style={ { margin: 0, fontSize: 13, color: 'var(--bc-color-ink-soft)' } }>زمان نوبت: { receipt.appointmentAtJalali ?? '—' }</p>
							</div>
						) }

						<div style={ { borderTop: '1px solid var(--bc-color-line)', borderBottom: '1px solid var(--bc-color-line)', padding: '12px 0', margin: '12px 0' } }>
							{ receipt.items.length === 0 && <p style={ { color: 'var(--bc-color-ink-faint)', fontSize: 13 } }>هنوز سفارشی برای این رزرو ثبت نشده است.</p> }
							{ receipt.items.map( ( item, i ) => (
								<div key={ i } style={ { display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 4 } }>
									<span>{ item.name }{ item.quantity !== null && item.quantity > 1 ? ` × ${ item.quantity }` : '' }</span>
									<span className="bc-numeric">{ item.total < 0 ? '−' : '' }{ formatToman( Math.abs( item.total ) ) } تومان</span>
								</div>
							) ) }
						</div>

						{ typeof receipt.total === 'number' && (
							<div style={ { display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 16, marginBottom: 12 } }>
								<span>مبلغ نهایی</span>
								<span className="bc-numeric">{ formatToman( receipt.total ) } تومان</span>
							</div>
						) }

						<dl style={ { fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: 0 } }>
							{ receipt.orderNumber && (
								<div style={ { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } }>
									<dt>شماره سفارش</dt>
									<dd className="bc-numeric" style={ { margin: 0 } }>{ receipt.orderNumber }</dd>
								</div>
							) }
							{ receipt.status && (
								<div style={ { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } }>
									<dt>وضعیت پرداخت</dt>
									<dd style={ { margin: 0 } }>{ ORDER_STATUS_LABELS[ receipt.status ] ?? receipt.status }</dd>
								</div>
							) }
							{ receipt.createdAtJalali && (
								<div style={ { display: 'flex', justifyContent: 'space-between' } }>
									<dt>تاریخ صدور</dt>
									<dd className="bc-numeric" style={ { margin: 0 } }>{ receipt.createdAtJalali }</dd>
								</div>
							) }
						</dl>

						<div className="bc-receipt__no-print" style={ { display: 'flex', justifyContent: 'space-between', marginTop: 24 } }>
							<Button variant="ghost" onClick={ onClose }>بستن</Button>
							<Button variant="primary" onClick={ () => window.print() }>چاپ رسید</Button>
						</div>
					</>
				) }
			</div>
		</Modal>
	);
}
