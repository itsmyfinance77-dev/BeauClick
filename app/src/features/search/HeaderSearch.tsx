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
 * target at all; clicking it did nothing. This is the real fix: an
 * accessible search overlay that reuses the ONLY real discovery data this
 * platform's marketplace actually supports today — specialties
 * (`GET /marketplace/specialties`) and launched cities
 * (`GET /locations/cities?launched=true`), both real, already-existing,
 * read-only reference endpoints.
 *
 * Deliberately NOT a new free-text marketplace search backend: there is no
 * `q`/free-text parameter on `MarketplaceController::browse()` today (its
 * own docblock names this a distinct, deliberately-deferred gap, MKT-02),
 * and building one is explicitly out of this task's scope (a future,
 * separately-scoped V2.3 step). Typing here filters the two small,
 * already-fetched, real reference lists client-side (plain substring
 * match, not fuzzy) — never a network call per keystroke, never invented
 * data. Selecting a match, or submitting, navigates via a real GET request
 * to `/marketplace/?specialty_id=`/`?city_id=` — the exact same query
 * parameters `page-marketplace.php` already reads today. An empty submit
 * falls back to the plain `/marketplace/` listing, the platform's own
 * documented real discovery entry point (`MarketplaceController::browse()`'s
 * own comment) — the button always goes somewhere real, never nothing.
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

	function goToMarketplace( params: Record<string, number> = {} ) {
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
		// A single unambiguous match on submit goes straight there; several
		// matches are left for the user to pick a specific chip/link below
		// rather than guessing which one they meant.
		if ( 1 === matchedSpecialties.length && 0 === matchedCities.length ) {
			goToMarketplace( { specialty_id: matchedSpecialties[ 0 ].id } );
			return;
		}
		if ( 0 === matchedSpecialties.length && 1 === matchedCities.length ) {
			goToMarketplace( { city_id: matchedCities[ 0 ].id } );
			return;
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
						<EmptyState title="نتیجه‌ای پیدا نشد. می‌توانید همه متخصصان را ببینید." />
					) }

					{ ! loading && ! error && noMatches && (
						<button type="button" className="bc-btn bc-btn--outline" onClick={ () => goToMarketplace() } style={ { marginTop: 12 } }>
							مشاهده همه متخصصان
						</button>
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
