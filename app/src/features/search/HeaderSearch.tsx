import { useEffect, useMemo, useState } from 'react';
import { Modal, Chip, Input, LoadingDots, EmptyState } from '@/design-system';
import { api, ApiError } from '@/lib/api';

interface Specialty {
	id: number;
	name: string;
}

interface City {
	id: number;
	name_fa: string;
	is_launched: boolean;
}

/**
 * V2.3 UI/branding pass — the header's magnifying-glass button (`⌕` in
 * header.php) previously had no click handler, no associated UI, and no
 * target at all; clicking it did nothing. The overlay itself reuses the
 * two small, real discovery reference endpoints — specialties
 * (`GET /marketplace/specialties`) and launched cities
 * (`GET /locations/cities?launched=true`) — filtered client-side (plain
 * substring match) as you type, so a matching specialty/city chip goes
 * straight to `/marketplace/?specialty_id=`/`?city_id=`.
 *
 * V2.3 Step 20 (MKT-02) closed the real gap this component's own docblock
 * used to name here: `MarketplaceController::browse()` now has a real `q`
 * free-text param (name+bio, see MarketplaceController.php). When the typed
 * text isn't an exact specialty/city name, submitting (or the "جستجو در
 * بین همه متخصصان" fallback button) now goes to a real
 * `/marketplace/?q=<query>` search instead of doing nothing — this
 * component no longer has a dead-end state.
 */
export function HeaderSearch( { open, onClose }: { open: boolean; onClose: () => void } ) {
	const [ specialties, setSpecialties ] = useState<Specialty[] | null>( null );
	const [ cities, setCities ] = useState<City[] | null>( null );
	const [ error, setError ] = useState<string | null>( null );
	const [ query, setQuery ] = useState( '' );

	useEffect( () => {
		if ( ! open || specialties !== null ) return;
		setError( null );
		Promise.all( [
			api.get<Specialty[]>( '/marketplace/specialties' ),
			api.get<City[]>( '/locations/cities?launched=true' ),
		] )
			.then( ( [ s, c ] ) => {
				setSpecialties( s );
				setCities( c );
			} )
			.catch( ( e ) => setError( e instanceof ApiError ? e.message : 'خطا در دریافت اطلاعات جستجو.' ) );
	}, [ open, specialties ] );

	// Reset the typed query each time the overlay is reopened, so a
	// previous search doesn't linger stale the next time it's opened.
	useEffect( () => {
		if ( open ) setQuery( '' );
	}, [ open ] );

	const needle = query.trim();

	const matchedSpecialties = useMemo(
		() => filterByName( specialties ?? [], needle, ( s ) => s.name ),
		[ specialties, needle ]
	);
	const matchedCities = useMemo(
		() => filterByName( cities ?? [], needle, ( c ) => c.name_fa ),
		[ cities, needle ]
	);

	function goToMarketplace( params: Record<string, number | string> = {} ) {
		const url = new URL( '/marketplace/', window.location.origin );
		for ( const [ key, value ] of Object.entries( params ) ) {
			url.searchParams.set( key, String( value ) );
		}
		window.location.href = url.toString();
	}

	function onSubmit( e: React.FormEvent ) {
		e.preventDefault();
		if ( '' === needle ) {
			goToMarketplace();
			return;
		}
		// A single unambiguous specialty/city match on submit goes straight
		// there; several matches are left for the user to pick a specific
		// chip below rather than guessing which one they meant. Anything
		// else (no chip match, or an ambiguous multi-match) falls back to a
		// real free-text search (V2.3 Step 20) rather than doing nothing.
		if ( 1 === matchedSpecialties.length && 0 === matchedCities.length ) {
			goToMarketplace( { specialty_id: matchedSpecialties[ 0 ].id } );
			return;
		}
		if ( 0 === matchedSpecialties.length && 1 === matchedCities.length ) {
			goToMarketplace( { city_id: matchedCities[ 0 ].id } );
			return;
		}
		if ( 0 === matchedSpecialties.length && 0 === matchedCities.length ) {
			goToMarketplace( { q: needle } );
		}
	}

	const loading = open && null === specialties && ! error;
	const showResults = '' !== needle;
	const noMatches = showResults && 0 === matchedSpecialties.length && 0 === matchedCities.length;

	return (
		<Modal open={ open } onClose={ onClose } variant="centered" labelledBy="bc-header-search-title">
			<div style={ { padding: 20, minWidth: 0 } }>
				<h2 id="bc-header-search-title" style={ { margin: '0 0 12px', fontSize: 18 } }>جستجو در بیوکلیک</h2>

				<form onSubmit={ onSubmit } role="search">
					<Input
						aria-label="جستجوی تخصص یا شهر"
						placeholder="مثلاً: میکاپ یا یزد…"
						value={ query }
						onChange={ ( e ) => setQuery( e.target.value ) }
						autoFocus
					/>
				</form>

				<div style={ { marginTop: 16, maxHeight: '55vh', overflowY: 'auto' } }>
					{ loading && <LoadingDots /> }
					{ error && <p role="alert" style={ { color: 'var(--bc-color-error)', fontSize: 13 } }>{ error }</p> }

					{ ! loading && ! error && noMatches && (
						<EmptyState title="تخصص یا شهری با این نام پیدا نشد." />
					) }

					{ ! loading && ! error && noMatches && (
						<div style={ { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } }>
							<button type="button" className="bc-btn bc-btn--primary" onClick={ () => goToMarketplace( { q: needle } ) }>
								جستجوی «{ needle }» در بین متخصصان
							</button>
							<button type="button" className="bc-btn bc-btn--outline" onClick={ () => goToMarketplace() }>
								مشاهده همه متخصصان
							</button>
						</div>
					) }

					{ ! loading && ! error && ! noMatches && (
						<>
							{ ( showResults ? matchedSpecialties : specialties ?? [] ).length > 0 && (
								<div style={ { marginBottom: 16 } }>
									<h3 style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)', margin: '0 0 8px' } }>تخصص‌ها</h3>
									<div style={ { display: 'flex', flexWrap: 'wrap', gap: 8 } }>
										{ ( showResults ? matchedSpecialties : specialties ?? [] ).map( ( s ) => (
											<Chip key={ s.id } onClick={ () => goToMarketplace( { specialty_id: s.id } ) }>{ s.name }</Chip>
										) ) }
									</div>
								</div>
							) }

							{ showResults && matchedCities.length > 0 && (
								<div>
									<h3 style={ { fontSize: 13, color: 'var(--bc-color-ink-faint)', margin: '0 0 8px' } }>شهرها</h3>
									<div style={ { display: 'flex', flexWrap: 'wrap', gap: 8 } }>
										{ matchedCities.map( ( c ) => (
											<Chip key={ c.id } accent="accent" onClick={ () => goToMarketplace( { city_id: c.id } ) }>{ c.name_fa }</Chip>
										) ) }
									</div>
								</div>
							) }
						</>
					) }
				</div>
			</div>
		</Modal>
	);
}

function filterByName<T>( items: T[], needle: string, getName: ( item: T ) => string ): T[] {
	if ( '' === needle ) return [];
	const lower = needle.toLowerCase();
	return items.filter( ( item ) => getName( item ).toLowerCase().includes( lower ) );
}
