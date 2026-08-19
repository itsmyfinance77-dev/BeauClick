import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Input, Chip, LoadingDots, EmptyState } from '@/design-system';

interface MyProfile {
	id: number;
	name: string;
	bio: string;
	status: string;
	cityId: number | null;
	districtId: number | null;
	verified: boolean;
	specialtyIds: number[];
}

interface Specialty {
	id: number;
	name: string;
}

interface PortfolioItem {
	id: number;
	title: string;
	image: string | null;
}

/**
 * V2.4 Step 22: name/bio/specialties (`/marketplace/my/profile`, already
 * existed on the backend before this step -- only the frontend was
 * missing) plus real portfolio image management
 * (`/marketplace/my/portfolio`, new this step). City/district editing is
 * deliberately out of scope here -- neither the task nor the existing
 * placeholder named it, and it would need a real cascading city→district
 * picker this codebase doesn't have anywhere yet; a contained follow-up,
 * not an oversight.
 */
export function ProfileTab() {
	const [ profile, setProfile ] = useState<MyProfile | null>( null );
	const [ specialties, setSpecialties ] = useState<Specialty[] | null>( null );
	const [ portfolio, setPortfolio ] = useState<PortfolioItem[] | null>( null );
	const [ name, setName ] = useState( '' );
	const [ bio, setBio ] = useState( '' );
	const [ selectedSpecialtyIds, setSelectedSpecialtyIds ] = useState<number[]>( [] );
	const [ saving, setSaving ] = useState( false );
	const [ saved, setSaved ] = useState( false );
	const [ error, setError ] = useState<string | null>( null );
	const [ portfolioTitle, setPortfolioTitle ] = useState( '' );
	const [ portfolioFile, setPortfolioFile ] = useState<File | null>( null );
	const [ uploading, setUploading ] = useState( false );
	const [ portfolioError, setPortfolioError ] = useState<string | null>( null );

	function loadPortfolio() {
		api.get<PortfolioItem[]>( '/marketplace/my/portfolio' ).then( setPortfolio ).catch( () => setPortfolioError( 'خطا در دریافت نمونه‌کارها.' ) );
	}

	useEffect( () => {
		api.get<MyProfile>( '/marketplace/my/profile' ).then( ( p ) => {
			setProfile( p );
			setName( p.name );
			setBio( p.bio );
			setSelectedSpecialtyIds( p.specialtyIds );
		} ).catch( () => setError( 'خطا در دریافت پروفایل.' ) );
		api.get<Specialty[]>( '/marketplace/specialties' ).then( setSpecialties ).catch( () => undefined );
		loadPortfolio();
	}, [] );

	function toggleSpecialty( id: number ) {
		setSelectedSpecialtyIds( ( prev ) => ( prev.includes( id ) ? prev.filter( ( x ) => x !== id ) : [ ...prev, id ] ) );
	}

	async function save() {
		setSaving( true );
		setSaved( false );
		setError( null );
		try {
			await api.patch( '/marketplace/my/profile', { name, bio, specialty_ids: selectedSpecialtyIds } );
			setSaved( true );
		} catch ( e ) {
			setError( e instanceof ApiError ? e.message : 'ذخیره پروفایل ناموفق بود.' );
		} finally {
			setSaving( false );
		}
	}

	async function addPortfolioItem( e: React.FormEvent ) {
		e.preventDefault();
		if ( ! portfolioFile ) return;
		setUploading( true );
		setPortfolioError( null );
		try {
			const formData = new FormData();
			formData.append( 'image', portfolioFile );
			formData.append( 'title', portfolioTitle );
			await api.upload( '/marketplace/my/portfolio', formData );
			setPortfolioTitle( '' );
			setPortfolioFile( null );
			loadPortfolio();
		} catch ( e ) {
			setPortfolioError( e instanceof ApiError ? e.message : 'بارگذاری نمونه‌کار ناموفق بود.' );
		} finally {
			setUploading( false );
		}
	}

	async function removePortfolioItem( id: number ) {
		setPortfolio( ( prev ) => ( prev ? prev.filter( ( item ) => item.id !== id ) : prev ) );
		try {
			await api.del( `/marketplace/my/portfolio/${ id }` );
		} catch {
			loadPortfolio();
		}
	}

	if ( error && ! profile ) return <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p>;
	if ( ! profile ) return <LoadingDots />;

	return (
		<div style={ { display: 'flex', flexDirection: 'column', gap: 24 } }>
			<div>
				<h1 style={ { fontSize: 22, marginTop: 0 } }>پروفایل</h1>
				<div className="bc-card" style={ { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } }>
					<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 } }>
						نام
						<Input value={ name } onChange={ ( e ) => setName( e.target.value ) } aria-label="نام" />
					</label>
					<label style={ { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 } }>
						درباره
						<textarea
							value={ bio }
							onChange={ ( e ) => setBio( e.target.value ) }
							aria-label="درباره"
							rows={ 4 }
							style={ { fontFamily: 'inherit', fontSize: 14, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--bc-color-line)', resize: 'vertical' } }
						/>
					</label>

					{ specialties && specialties.length > 0 && (
						<div>
							<p style={ { margin: '0 0 6px', fontSize: 13, color: 'var(--bc-color-ink-soft)' } }>تخصص‌ها</p>
							<div style={ { display: 'flex', flexWrap: 'wrap', gap: 6 } }>
								{ specialties.map( ( s ) => (
									<Chip key={ s.id } active={ selectedSpecialtyIds.includes( s.id ) } onClick={ () => toggleSpecialty( s.id ) }>
										{ s.name }
									</Chip>
								) ) }
							</div>
						</div>
					) }

					{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13, margin: 0 } }>{ error }</p> }
					{ saved && <p role="status" style={ { color: 'var(--bc-color-success, green)', fontSize: 13, margin: 0 } }>پروفایل ذخیره شد.</p> }

					<div>
						<Button variant="primary" disabled={ saving } onClick={ save }>{ saving ? 'در حال ذخیره…' : 'ذخیره تغییرات' }</Button>
					</div>
				</div>
			</div>

			<div>
				<h2 style={ { fontSize: 18, marginBottom: 12 } }>نمونه‌کار</h2>

				<form onSubmit={ addPortfolioItem } className="bc-card" style={ { padding: 16, marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } }>
					<Input aria-label="عنوان نمونه‌کار" placeholder="عنوان (اختیاری)" value={ portfolioTitle } onChange={ ( e ) => setPortfolioTitle( e.target.value ) } style={ { flex: '1 1 160px' } } />
					<input
						type="file"
						accept="image/*"
						aria-label="انتخاب تصویر"
						onChange={ ( e ) => setPortfolioFile( e.target.files?.[ 0 ] ?? null ) }
					/>
					<Button variant="primary" type="submit" disabled={ uploading || ! portfolioFile }>{ uploading ? 'در حال بارگذاری…' : 'افزودن' }</Button>
				</form>

				{ portfolioError && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ portfolioError }</p> }

				{ ! portfolio && ! portfolioError && <LoadingDots /> }
				{ portfolio && portfolio.length === 0 && <EmptyState title="هنوز نمونه‌کاری اضافه نکرده‌اید." /> }
				{ portfolio && portfolio.length > 0 && (
					<div style={ { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 } }>
						{ portfolio.map( ( item ) => (
							<div key={ item.id } className="bc-card" style={ { overflow: 'hidden' } }>
								{ item.image && <img src={ item.image } alt={ item.title } style={ { width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' } } /> }
								<div style={ { padding: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 } }>
									<span style={ { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }>{ item.title }</span>
									<Button variant="ghost" onClick={ () => removePortfolioItem( item.id ) } aria-label={ `حذف ${ item.title }` }>حذف</Button>
								</div>
							</div>
						) ) }
					</div>
				) }
			</div>
		</div>
	);
}
