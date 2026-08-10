import { useState } from 'react';
import {
	Button,
	Card,
	Chip,
	Badge,
	Modal,
	Input,
	PlaceholderImage,
	RatingStars,
	PriceTag,
	EmptyState,
	LoadingDots,
} from '@/design-system';
import { color } from '@/design-system/tokens.generated';
import './App.css';

/**
 * Local-only style-guide preview (Vite `main` entry, never enqueued by the
 * WordPress theme) — lets design-system work be checked visually against
 * docs/design/DESIGN_HANDOFF.md without a PHP/MySQL environment running.
 */
export function App() {
	const [ specialty, setSpecialty ] = useState( 'میکاپ' );
	const [ city, setCity ] = useState( 'یزد' );
	const [ modalOpen, setModalOpen ] = useState( false );
	const [ showEmpty, setShowEmpty ] = useState( false );

	return (
		<div className="bc-container" style={ { paddingBlock: 40 } }>
			<header style={ { marginBottom: 40 } }>
				<div className="bc-style-guide__logo" style={ { background: 'var(--bc-gradient-brand)' } }>BC</div>
				<h1 style={ { fontSize: 32, fontWeight: 800, margin: '16px 0 4px' } }>BeauClick — راهنمای سیستم طراحی</h1>
				<p style={ { color: 'var(--bc-color-ink-soft)', margin: 0 } }>
					پیش‌نمایش محلی برای بررسی وفاداری بصری نسبت به سند تحویل طراحی — بدون نیاز به WordPress.
				</p>
			</header>

			<section style={ { marginBottom: 40 } }>
				<h2 style={ { fontSize: 20, fontWeight: 800 } }>رنگ‌ها</h2>
				<div style={ { display: 'flex', flexWrap: 'wrap', gap: 12 } }>
					{ Object.entries( color ).map( ( [ name, value ] ) => (
						<div key={ name } style={ { textAlign: 'center' } }>
							<div style={ { width: 64, height: 64, borderRadius: 14, background: value as string, border: '1px solid var(--bc-color-line)' } } />
							<div style={ { fontSize: 11, marginTop: 4, color: 'var(--bc-color-ink-faint)' } }>{ name }</div>
						</div>
					) ) }
				</div>
			</section>

			<section style={ { marginBottom: 40 } }>
				<h2 style={ { fontSize: 20, fontWeight: 800 } }>دکمه‌ها</h2>
				<div style={ { display: 'flex', gap: 12, flexWrap: 'wrap' } }>
					<Button variant="primary">رزرو نوبت</Button>
					<Button variant="outline">مشاهده پروفایل</Button>
					<Button variant="ghost">لغو</Button>
					<div style={ { background: 'var(--bc-color-ink)', padding: 16, borderRadius: 12 } }>
						<Button variant="light">مشاهده کاتالوگ عمده</Button>
					</div>
				</div>
			</section>

			<section style={ { marginBottom: 40 } }>
				<h2 style={ { fontSize: 20, fontWeight: 800 } }>فیلترها (چیپ)</h2>
				<p style={ { color: 'var(--bc-color-ink-faint)', fontSize: 13 } }>تخصص (بنفش) در برابر شهر (رز) — دو محور فیلتر مجزا</p>
				<div style={ { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' } }>
					{ [ 'میکاپ', 'ناخن', 'پوست و مو', 'رنگ مو' ].map( ( s ) => (
						<Chip key={ s } accent="primary" active={ specialty === s } onClick={ () => setSpecialty( s ) }>{ s }</Chip>
					) ) }
				</div>
				<div style={ { display: 'flex', gap: 8, flexWrap: 'wrap' } }>
					{ [ 'همه شهرها', 'یزد', 'تهران', 'اصفهان' ].map( ( c ) => (
						<Chip key={ c } accent="accent" active={ city === c } onClick={ () => setCity( c ) }>{ c }</Chip>
					) ) }
				</div>
			</section>

			<section style={ { marginBottom: 40 } }>
				<h2 style={ { fontSize: 20, fontWeight: 800 } }>نشان‌ها</h2>
				<div style={ { display: 'flex', gap: 8, flexWrap: 'wrap' } }>
					<Badge variant="verified">تایید‌شده</Badge>
					<Badge variant="discount">۲۰٪ تخفیف</Badge>
					<Badge variant="recommended">پیشنهادی</Badge>
					<Badge variant="success">تأیید‌شده</Badge>
					<Badge variant="warning">در انتظار</Badge>
					<Badge variant="error">لغو‌شده</Badge>
				</div>
			</section>

			<section style={ { marginBottom: 40 } }>
				<h2 style={ { fontSize: 20, fontWeight: 800 } }>کارت متخصص (نمونه)</h2>
				<div style={ { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20, maxWidth: 760 } }>
					<Card hoverable>
						<PlaceholderImage caption="تصویر متخصص" hue={ 290 } />
						<div style={ { padding: 16 } }>
							<div style={ { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } }>
								<strong>سارا احمدی</strong>
								<Badge variant="verified">✓</Badge>
							</div>
							<p style={ { fontSize: 13, color: 'var(--bc-color-ink-soft)', margin: '0 0 8px' } }>میکاپ‌آرتیست</p>
							<RatingStars rating={ 4.8 } reviewCount={ 126 } />
							<p style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)', margin: '8px 0' } }>یزد، صفائیه</p>
							<PriceTag amount={ 350000 } prefix="شروع از" />
							<div style={ { marginTop: 12 } }>
								<Button variant="primary" style={ { width: '100%' } }>رزرو نوبت</Button>
							</div>
						</div>
					</Card>
					<Card hoverable>
						<PlaceholderImage caption="تصویر محصول" hue={ 335 } />
						<div style={ { padding: 16 } }>
							<p style={ { fontSize: 12, color: 'var(--bc-color-ink-faint)', margin: '0 0 4px' } }>لافارر</p>
							<strong>سرم ویتامین C</strong>
							<div style={ { margin: '8px 0' } }>
								<PriceTag amount={ 480000 } oldAmount={ 600000 } />
							</div>
							<Button variant="outline" style={ { width: '100%' } }>افزودن به سبد</Button>
						</div>
					</Card>
				</div>
			</section>

			<section style={ { marginBottom: 40 } }>
				<h2 style={ { fontSize: 20, fontWeight: 800 } }>حالت‌های خالی و بارگذاری</h2>
				<div style={ { display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' } }>
					<Button variant="outline" onClick={ () => setShowEmpty( ( v ) => ! v ) }>نمایش/مخفی کردن حالت خالی</Button>
					<LoadingDots />
				</div>
				{ showEmpty && (
					<div style={ { marginTop: 16, maxWidth: 420 } }>
						<EmptyState title="متخصصی با این فیلتر پیدا نشد…" action={ <Button variant="outline">پاک کردن فیلترها</Button> } />
					</div>
				) }
			</section>

			<section>
				<h2 style={ { fontSize: 20, fontWeight: 800 } }>مودال / شیت رزرو</h2>
				<Button variant="primary" onClick={ () => setModalOpen( true ) }>باز کردن مودال رزرو</Button>
				<Modal open={ modalOpen } onClose={ () => setModalOpen( false ) } labelledBy="demo-modal-title">
					<div style={ { padding: 24 } }>
						<h3 id="demo-modal-title" style={ { marginTop: 0 } }>انتخاب خدمت</h3>
						<Input placeholder="جستجوی خدمت…" style={ { marginBottom: 16 } } />
						<Button variant="primary" onClick={ () => setModalOpen( false ) }>بستن</Button>
					</div>
				</Modal>
			</section>
		</div>
	);
}
