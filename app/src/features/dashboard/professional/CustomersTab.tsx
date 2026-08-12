import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatFullJalaliDate, toPersianDigits } from '@/lib/format';
import { Button, Chip, Input, Modal, Badge, EmptyState, LoadingDots } from '@/design-system';

interface CustomerListItem {
	customerId: number;
	name: string;
	email: string;
	phone: string | null;
	totalBookings: number;
	completedCount: number;
	lastVisit: string | null;
	nextBooking: string | null;
	reviewCount: number;
	notesCount: number;
}

interface CustomerBooking {
	id: number;
	slotStart: string;
	slotEnd: string;
	status: string;
}

interface CustomerReview {
	id: number;
	rating: number;
	body: string | null;
	response: string | null;
	createdAt: string;
}

interface CustomerNote {
	id: number;
	note: string;
	authorName: string;
	createdAt: string;
}

interface CustomerDetail {
	customer: { id: number; name: string; email: string; phone: string | null };
	overview: { totalBookings: number; completedCount: number; lastVisit: string | null; nextBooking: string | null; firstBookingAt: string };
	bookings: CustomerBooking[];
	reviews: CustomerReview[];
	conversation: { conversationId: number; lastMessageAt: string | null; unreadCount: number } | null;
	notes: CustomerNote[];
}

const STATUS_LABELS: Record<string, string> = {
	pending: 'در انتظار پرداخت',
	confirmed: 'تأیید‌شده',
	completed: 'انجام‌شده',
	cancelled: 'لغو‌شده',
	no_show: 'عدم حضور',
};

const FILTERS: { id: string; label: string }[] = [
	{ id: 'all', label: 'همه' },
	{ id: 'new', label: 'مشتری جدید' },
	{ id: 'returning', label: 'بازگشتی' },
	{ id: 'upcoming', label: 'نوبت آینده' },
	{ id: 'has_review', label: 'دارای نظر' },
	{ id: 'inactive', label: 'غیرفعال' },
];

function jalaliDate( iso: string | null ): string {
	return iso ? formatFullJalaliDate( new Date( iso.replace( ' ', 'T' ) ) ) : '—';
}

export function CustomersTab() {
	const [ customers, setCustomers ] = useState<CustomerListItem[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ search, setSearch ] = useState( '' );
	const [ filter, setFilter ] = useState( 'all' );
	const [ openCustomerId, setOpenCustomerId ] = useState<number | null>( null );

	useEffect( () => {
		const timeout = setTimeout( () => {
			setError( null );
			api
				.get<CustomerListItem[]>( `/booking/crm/customers?search=${ encodeURIComponent( search ) }&filter=${ filter }&per_page=50` )
				.then( setCustomers )
				.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت فهرست مشتریان.' ) );
		}, 300 );
		return () => clearTimeout( timeout );
	}, [ search, filter ] );

	return (
		<div>
			<h1 style={ { fontSize: 22, marginTop: 0 } }>مشتریان</h1>

			<div style={ { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 } }>
				<Input
					type="search"
					value={ search }
					onChange={ ( e ) => setSearch( e.target.value ) }
					placeholder="جست‌وجو بر اساس نام، ایمیل یا شماره تماس…"
					aria-label="جست‌وجوی مشتری"
				/>
				<div style={ { display: 'flex', gap: 8, flexWrap: 'wrap' } }>
					{ FILTERS.map( ( f ) => (
						<Chip key={ f.id } active={ filter === f.id } onClick={ () => setFilter( f.id ) }>
							{ f.label }
						</Chip>
					) ) }
				</div>
			</div>

			{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
			{ ! error && ! customers && <LoadingDots /> }
			{ ! error && customers && customers.length === 0 && (
				<EmptyState title={ search || filter !== 'all' ? 'مشتری‌ای با این مشخصات پیدا نشد.' : 'هنوز مشتری‌ای ثبت نشده است.' } />
			) }

			{ customers && customers.length > 0 && (
				<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
					{ customers.map( ( c ) => (
						<button
							key={ c.customerId }
							type="button"
							onClick={ () => setOpenCustomerId( c.customerId ) }
							className="bc-card"
							style={ {
								padding: 14,
								display: 'flex',
								justifyContent: 'space-between',
								alignItems: 'center',
								flexWrap: 'wrap',
								gap: 8,
								width: '100%',
								textAlign: 'start',
								cursor: 'pointer',
								border: 'none',
								font: 'inherit',
							} }
						>
							<div>
								<strong>{ c.name }</strong>
								<p style={ { margin: '4px 0 0', fontSize: 12, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">
									{ c.nextBooking ? `نوبت بعدی: ${ jalaliDate( c.nextBooking ) }` : `آخرین مراجعه: ${ jalaliDate( c.lastVisit ) }` }
								</p>
							</div>
							<div style={ { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } }>
								<Badge variant="success">{ toPersianDigits( c.completedCount ) } نوبت انجام‌شده</Badge>
								{ c.reviewCount > 0 && <Badge variant="recommended">{ toPersianDigits( c.reviewCount ) } نظر</Badge> }
								{ c.notesCount > 0 && <Badge variant="warning">{ toPersianDigits( c.notesCount ) } یادداشت</Badge> }
							</div>
						</button>
					) ) }
				</div>
			) }

			{ openCustomerId !== null && (
				<CustomerDetailModal customerId={ openCustomerId } onClose={ () => setOpenCustomerId( null ) } />
			) }
		</div>
	);
}

function CustomerDetailModal( { customerId, onClose }: { customerId: number; onClose: () => void } ) {
	const [ detail, setDetail ] = useState<CustomerDetail | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ noteText, setNoteText ] = useState( '' );
	const [ savingNote, setSavingNote ] = useState( false );
	const [ noteError, setNoteError ] = useState<string | null>( null );

	function load() {
		api
			.get<CustomerDetail>( `/booking/crm/customers/${ customerId }` )
			.then( setDetail )
			.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت اطلاعات مشتری.' ) );
	}

	useEffect( load, [ customerId ] );

	async function saveNote() {
		if ( ! noteText.trim() ) return;
		setSavingNote( true );
		setNoteError( null );
		try {
			await api.post( `/booking/crm/customers/${ customerId }/notes`, { note: noteText.trim() } );
			setNoteText( '' );
			load();
		} catch ( e ) {
			setNoteError( e instanceof ApiError ? e.message : 'ثبت یادداشت ناموفق بود.' );
		} finally {
			setSavingNote( false );
		}
	}

	return (
		<Modal open onClose={ onClose } labelledBy="bc-crm-customer-title">
			{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }
			{ ! error && ! detail && <LoadingDots /> }

			{ detail && (
				<div style={ { display: 'flex', flexDirection: 'column', gap: 20, padding: 4 } }>
					<div>
						<h2 id="bc-crm-customer-title" style={ { margin: 0, fontSize: 20 } }>{ detail.customer.name }</h2>
						<p style={ { margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-soft)' } }>
							{ detail.customer.email }{ detail.customer.phone ? ` · ${ toPersianDigits( detail.customer.phone ) }` : '' }
						</p>
					</div>

					<div style={ { display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 } } className="bc-numeric">
						<span>مراجعه اول: { jalaliDate( detail.overview.firstBookingAt ) }</span>
						<span>آخرین مراجعه: { jalaliDate( detail.overview.lastVisit ) }</span>
						<span>نوبت بعدی: { jalaliDate( detail.overview.nextBooking ) }</span>
						<span>{ toPersianDigits( detail.overview.completedCount ) } از { toPersianDigits( detail.overview.totalBookings ) } نوبت انجام‌شده</span>
					</div>

					{ detail.conversation && (
						<p style={ { fontSize: 13, color: 'var(--bc-color-ink-soft)' } } className="bc-numeric">
							گفت‌وگو: آخرین پیام { jalaliDate( detail.conversation.lastMessageAt ) }
							{ detail.conversation.unreadCount > 0 && ` · ${ toPersianDigits( detail.conversation.unreadCount ) } پیام خوانده‌نشده` }
						</p>
					) }

					<section>
						<h3 style={ { fontSize: 15, margin: '0 0 8px' } }>تاریخچه نوبت‌ها</h3>
						{ detail.bookings.length === 0 ? (
							<p style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>نوبتی ثبت نشده است.</p>
						) : (
							<div style={ { display: 'flex', flexDirection: 'column', gap: 6 } }>
								{ detail.bookings.map( ( b ) => (
									<div key={ b.id } style={ { display: 'flex', justifyContent: 'space-between', fontSize: 13 } } className="bc-numeric">
										<span>{ jalaliDate( b.slotStart ) }</span>
										<span style={ { color: 'var(--bc-color-ink-faint)' } }>{ STATUS_LABELS[ b.status ] ?? b.status }</span>
									</div>
								) ) }
							</div>
						) }
					</section>

					<section>
						<h3 style={ { fontSize: 15, margin: '0 0 8px' } }>نظرات</h3>
						{ detail.reviews.length === 0 ? (
							<p style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>هنوز نظری ثبت نکرده است.</p>
						) : (
							<div style={ { display: 'flex', flexDirection: 'column', gap: 8 } }>
								{ detail.reviews.map( ( r ) => (
									<div key={ r.id } style={ { fontSize: 13 } }>
										<strong className="bc-numeric">★ { toPersianDigits( r.rating ) }</strong>
										{ r.body && <span> — { r.body }</span> }
									</div>
								) ) }
							</div>
						) }
					</section>

					<section>
						<h3 style={ { fontSize: 15, margin: '0 0 8px' } }>یادداشت‌های شما</h3>
						<p style={ { margin: '0 0 8px', fontSize: 12, color: 'var(--bc-color-ink-faint)' } }>
							این یادداشت‌ها فقط برای شما قابل مشاهده است و برای مشتری نمایش داده نمی‌شود.
						</p>
						{ detail.notes.length > 0 && (
							<div style={ { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 } }>
								{ detail.notes.map( ( n ) => (
									<div key={ n.id } style={ { padding: 10, background: 'var(--bc-color-surface-tint)', borderRadius: 12 } }>
										<p style={ { margin: 0, fontSize: 13 } }>{ n.note }</p>
										<p style={ { margin: '4px 0 0', fontSize: 11, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">
											{ n.authorName } · { jalaliDate( n.createdAt ) }
										</p>
									</div>
								) ) }
							</div>
						) }
						{ noteError && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 12 } }>{ noteError }</p> }
						<textarea
							className="bc-input"
							rows={ 2 }
							value={ noteText }
							onChange={ ( e ) => setNoteText( e.target.value ) }
							placeholder="یادداشتی درباره این مشتری بنویسید…"
							aria-label="یادداشت جدید"
							style={ { resize: 'vertical', width: '100%' } }
						/>
						<Button variant="primary" style={ { marginTop: 8 } } disabled={ savingNote || ! noteText.trim() } onClick={ saveNote }>
							{ savingNote ? 'در حال ثبت…' : 'ثبت یادداشت' }
						</Button>
					</section>
				</div>
			) }
		</Modal>
	);
}
