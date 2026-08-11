import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatToman, toPersianDigits } from '@/lib/format';
import { Button, Input, LoadingDots, EmptyState } from '@/design-system';
import type { MyService } from './types';

export function ServicesTab() {
	const [ services, setServices ] = useState<MyService[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ adding, setAdding ] = useState( false );
	const [ form, setForm ] = useState( { name: '', durationMinutes: '', price: '' } );

	function load() {
		api.get<MyService[]>( '/marketplace/my/services' ).then( setServices ).catch( () => setError( 'خطا در دریافت خدمات.' ) );
	}

	useEffect( load, [] );

	async function submit( e: React.FormEvent ) {
		e.preventDefault();
		try {
			await api.post( '/marketplace/my/services', {
				name: form.name,
				duration_minutes: Number( form.durationMinutes ) || 0,
				price: Number( form.price ) || 0,
			} );
			setForm( { name: '', durationMinutes: '', price: '' } );
			setAdding( false );
			load();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ایجاد خدمت ناموفق بود.' );
		}
	}

	async function remove( id: number ) {
		try {
			await api.del( `/marketplace/my/services/${ id }` );
			load();
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'حذف خدمت ناموفق بود.' );
		}
	}

	if ( error ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! services ) return <LoadingDots />;

	return (
		<div>
			<div style={ { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 } }>
				<h1 style={ { fontSize: 22, margin: 0 } }>خدمات</h1>
				<Button variant="primary" onClick={ () => setAdding( ( v ) => ! v ) }>{ adding ? 'انصراف' : '+ خدمت جدید' }</Button>
			</div>

			{ adding && (
				<form onSubmit={ submit } className="bc-card" style={ { padding: 16, marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap' } }>
					<Input aria-label="نام خدمت (الزامی)" placeholder="نام خدمت *" value={ form.name } onChange={ ( e ) => setForm( { ...form, name: e.target.value } ) } required style={ { flex: '1 1 160px' } } />
					<Input aria-label="مدت به دقیقه" placeholder="مدت (دقیقه)" type="number" value={ form.durationMinutes } onChange={ ( e ) => setForm( { ...form, durationMinutes: e.target.value } ) } style={ { flex: '1 1 120px' } } />
					<Input aria-label="قیمت به تومان" placeholder="قیمت (تومان)" type="number" value={ form.price } onChange={ ( e ) => setForm( { ...form, price: e.target.value } ) } style={ { flex: '1 1 120px' } } />
					<Button variant="primary" type="submit">ثبت</Button>
				</form>
			) }

			{ services.length === 0 && <EmptyState title="هنوز خدمتی ثبت نشده است." /> }

			<div style={ { display: 'flex', flexDirection: 'column', gap: 10 } }>
				{ services.map( ( s ) => (
					<div key={ s.id } className="bc-card" style={ { padding: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }>
						<div>
							<strong>{ s.name }</strong>
							<p style={ { margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-faint)' } } className="bc-numeric">
								{ toPersianDigits( s.durationMinutes ) } دقیقه · { formatToman( s.price ) } تومان
							</p>
						</div>
						<Button variant="ghost" onClick={ () => remove( s.id ) }>حذف</Button>
					</div>
				) ) }
			</div>
		</div>
	);
}
