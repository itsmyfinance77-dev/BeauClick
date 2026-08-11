/**
 * Thin wrapper around the beauclick/v1 REST API. Auth is cookie + REST
 * nonce (architecture doc §19) — same-origin, no token storage — so every
 * mutating request needs the nonce WordPress localizes onto
 * `window.BeauClick` (see functions.php's inline bootstrap script).
 */

declare global {
	interface Window {
		BeauClick?: {
			restUrl: string;
			nonce: string;
			isLoggedIn: boolean;
			currentUserId: number;
		};
	}
}

export interface ApiEnvelope<T> {
	data: T;
	meta: { pagination?: { total: number; page: number; per_page: number; pages: number } };
	error: { code: string; message: string; details?: unknown } | null;
}

export class ApiError extends Error {
	constructor( public code: string, message: string, public status: number ) {
		super( message );
	}
}

function baseUrl(): string {
	return window.BeauClick?.restUrl ?? '/wp-json/beauclick/v1';
}

/**
 * Naive `${baseUrl()}${path}` string concatenation breaks under WordPress's
 * plain-permalink structure: there, rest_url() returns
 * `/?rest_route=/beauclick/v1` (a query string, not a clean path), so
 * appending a path that has its OWN `?provider_id=...` produces a second
 * literal `?` that becomes part of the rest_route value instead of
 * starting real query params — the request silently 404s. Building the
 * URL properly (merging into rest_route when present, or appending to the
 * pathname otherwise) works under both plain and pretty permalinks.
 * Caught by live testing against this dev environment's plain permalinks,
 * not by anything that would have shown up in isolated component code.
 */
function buildUrl( path: string ): string {
	const base = new URL( baseUrl(), window.location.origin );
	const [ pathPart, queryPart ] = path.split( '?' );
	const extraParams = new URLSearchParams( queryPart );

	if ( base.searchParams.has( 'rest_route' ) ) {
		base.searchParams.set( 'rest_route', base.searchParams.get( 'rest_route' ) + pathPart );
	} else {
		base.pathname = base.pathname.replace( /\/$/, '' ) + pathPart;
	}

	extraParams.forEach( ( value, key ) => base.searchParams.append( key, value ) );

	return base.toString();
}

async function request<T>( path: string, options: RequestInit = {} ): Promise<T> {
	const res = await fetch( buildUrl( path ), {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...( window.BeauClick?.nonce ? { 'X-WP-Nonce': window.BeauClick.nonce } : {} ),
			...options.headers,
		},
		credentials: 'same-origin',
	} );

	const body: ApiEnvelope<T> = await res.json();

	if ( ! res.ok || body.error ) {
		throw new ApiError( body.error?.code ?? 'bc_unknown_error', body.error?.message ?? res.statusText, res.status );
	}

	return body.data;
}

export const api = {
	get: <T,>( path: string ) => request<T>( path ),
	post: <T,>( path: string, payload?: unknown ) => request<T>( path, { method: 'POST', body: payload ? JSON.stringify( payload ) : undefined } ),
};
