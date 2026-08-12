import { useState } from 'react';
import { Button, Input, JalaliDateInput } from '@/design-system';
import { api, ApiError } from '@/lib/api';
import type { BeautyGoal } from './types';

interface Specialty {
	id: number;
	name: string;
}

export function GoalForm( { specialties, onCreated, onCancel }: { specialties: Specialty[]; onCreated: ( goal: BeautyGoal ) => void; onCancel: () => void } ) {
	const [ title, setTitle ] = useState( '' );
	const [ specialtyId, setSpecialtyId ] = useState( '' );
	const [ budget, setBudget ] = useState( '' );
	const [ targetDate, setTargetDate ] = useState( '' );
	const [ error, setError ] = useState<string | null>( null );
	const [ busy, setBusy ] = useState( false );

	async function submit( e: React.FormEvent ) {
		e.preventDefault();
		if ( ! title.trim() || busy ) return;
		setBusy( true );
		setError( null );
		try {
			const goal = await api.post<BeautyGoal>( '/journey/goals', {
				title: title.trim(),
				specialty_id: specialtyId ? Number( specialtyId ) : undefined,
				budget: budget ? Number( budget ) : undefined,
				target_date: targetDate || undefined,
			} );
			onCreated( goal );
		} catch ( err ) {
			setError( err instanceof ApiError ? err.message : 'ثبت هدف ناموفق بود.' );
		} finally {
			setBusy( false );
		}
	}

	return (
		<form onSubmit={ submit } className="bc-card" style={ { padding: 16, display: 'flex', flexDirection: 'column', gap: 10 } }>
			<Input aria-label="عنوان هدف" placeholder="مثلاً: آماده شدن برای عروسی" value={ title } onChange={ ( e ) => setTitle( e.target.value ) } />

			<select
				value={ specialtyId }
				onChange={ ( e ) => setSpecialtyId( e.target.value ) }
				style={ { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--bc-color-line)', fontSize: 14, background: 'var(--bc-color-surface)', color: 'inherit' } }
			>
				<option value="">حوزه مرتبط (اختیاری)</option>
				{ specialties.map( ( s ) => <option key={ s.id } value={ s.id }>{ s.name }</option> ) }
			</select>

			<Input aria-label="بودجه (تومان)" placeholder="بودجه (تومان)" type="number" value={ budget } onChange={ ( e ) => setBudget( e.target.value ) } />

			{ /* BeauClick is Jalali-first: this renders day/month/year as Persian
			     Jalali selects, but still stores/sends a plain Gregorian
			     YYYY-MM-DD (targetDate) -- the same internal representation the
			     API and every other date on this endpoint already uses. Native
			     <input type="date"> was deliberately NOT used here since every
			     mainstream browser only ever renders it as a Gregorian picker. */ }
			<JalaliDateInput ariaLabel="تاریخ هدف" value={ targetDate } onChange={ setTargetDate } />

			{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13, margin: 0 } }>{ error }</p> }

			<div style={ { display: 'flex', gap: 8 } }>
				<Button type="submit" variant="primary" disabled={ busy || ! title.trim() }>ثبت هدف</Button>
				<Button type="button" variant="outline" onClick={ onCancel }>انصراف</Button>
			</div>
		</form>
	);
}
